// Directory (plan §9): wings → topics → agents, with a search filter. Pure.
import type { Agent, Grouping } from '@agent-office/shared'
import type { BuildingLayout } from '../office-types.ts'
import type { OfficeState } from '../state.ts'
import type { DirectoryVM } from './types.ts'

type Wing = DirectoryVM['wings'][number]
const byName = (a: Agent, b: Agent) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1)

export function directoryVM(
  state: OfficeState,
  layout: BuildingLayout | undefined,
  grouping: Grouping,
  query: string,
): DirectoryVM {
  const q = query.trim().toLowerCase()
  const hit = (s: string) => s.toLowerCase().includes(q)
  const zones = new Map<string, Map<string, Agent[]>>()
  for (const a of state.agents.values()) {
    const { zone, row } = grouping(a, (id) => state.agents.get(id))
    const rows = zones.get(zone) ?? new Map<string, Agent[]>()
    rows.set(row, [...(rows.get(row) ?? []), a])
    zones.set(zone, rows)
  }
  const wings: Wing[] = []
  for (const p of layout?.placements ?? []) {
    if (p.kind !== 'wing' || (p.annex ?? 0) !== 0 || !p.provider) continue
    const label = p.label ?? p.provider
    const rows = zones.get(p.provider)
    if (!rows) continue
    const wingHit = !q || hit(label)
    const topics = [...rows.keys()]
      .sort((a, b) => a.localeCompare(b))
      .map((t) => {
        const all = [...rows.get(t)!].sort(byName)
        const agents = wingHit || hit(t) ? all : all.filter((a) => hit(a.name))
        return {
          label: t,
          agents: agents.map((a) => ({ id: a.id, name: a.name, status: a.status })),
        }
      })
      .filter((t) => t.agents.length)
    if (topics.length) wings.push({ viewId: `wing:${p.provider}:0`, label, topics })
  }
  return { query, wings }
}
