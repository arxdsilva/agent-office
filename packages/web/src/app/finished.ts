// Recently finished agents the core already dropped (docs/minimal-mode.md). View state only.
import type { Agent } from '@agent-office/shared'
import type { FinishedEntry, FinishedStore } from './hierarchy-types.ts'

const MAX_AGE_MS = 30 * 60_000
const MAX_PER_PARENT = 5
const MAX_TOTAL = 50

const newest = (a: FinishedEntry, b: FinishedEntry) =>
  b.at - a.at || (a.agent.id < b.agent.id ? -1 : a.agent.id > b.agent.id ? 1 : 0)

/** Remember agents that finished and vanished; forget revived, stale or surplus ones. */
export function rememberFinished(
  store: FinishedStore,
  prev: Agent[],
  next: Agent[],
  now: number,
): FinishedStore {
  const live = new Map(next.map((a) => [a.id, a]))
  const map = new Map(store)
  let changed = false
  const drop = (id: string) => {
    map.delete(id)
    changed = true
  }

  for (const id of store.keys()) if (live.has(id)) drop(id)
  for (const a of prev) {
    if (live.has(a.id) || !(a.ended || a.status === 'done')) continue
    const old = map.get(a.id)
    if (old && old.agent === a) continue
    map.set(a.id, { agent: a, at: a.endedAt ?? a.lastSeen })
    changed = true
  }
  for (const [id, e] of map) if (now - e.at > MAX_AGE_MS) drop(id)

  const seen = new Map<string, number>()
  let total = 0
  for (const e of [...map.values()].sort(newest)) {
    const key = e.agent.parentId ?? ''
    const n = seen.get(key) ?? 0
    if (n >= MAX_PER_PARENT || total >= MAX_TOTAL) {
      drop(e.agent.id)
      continue
    }
    seen.set(key, n + 1)
    total++
  }
  return changed ? map : store
}
