// Desk assignment (replaces layout.ts): topic → pod in the provider's wing(s), subagents next to
// their parent, seats stable for an agent's lifetime, freed seats reusable after 10 s.
import { byProviderAndTopic, type Agent, type Grouping } from '@agent-office/shared'
import type { AnchorId, BuildingLayout, Seating, Vec2, WorldAnchor } from './office-types.ts'

/** A freed desk stays blocked this long, so the walk-out can finish. */
export const SEAT_REUSE_MS = 10_000
const MAX_PARENT_DEPTH = 10

export interface SeatingState {
  /** agentId → desk seat anchor id. */
  seats: Seating
  /** Recently freed seat → time it was freed (ms). */
  freed: Map<AnchorId, number>
}

export const emptySeating = (): SeatingState => ({ seats: new Map(), freed: new Map() })

const DESK = /^seat:desk:(\d+):(\d+)$/

/** Parses a world desk anchor id ("wing:a:0/seat:desk:3:2"). */
export function deskOf(
  id: AnchorId,
): { placement: string; pod: number; index: number } | undefined {
  const i = id.lastIndexOf('/')
  const m = DESK.exec(id.slice(i + 1))
  return m ? { placement: id.slice(0, i), pod: Number(m[1]), index: Number(m[2]) } : undefined
}

interface Pod {
  key: string
  wingIndex: number
  pod: number
  seats: WorldAnchor[]
  center: Vec2
}

const podCache = new WeakMap<BuildingLayout, Map<string, Pod[]>>()

/** Pods of each provider's wings, main wing first, pods by number, seats by index. */
function podsByProvider(layout: BuildingLayout): Map<string, Pod[]> {
  const hit = podCache.get(layout)
  if (hit) return hit
  const out = new Map<string, Pod[]>()
  for (const [provider, wings] of layout.wingsByProvider) {
    const pods = new Map<string, Pod>()
    for (const a of layout.anchors.values()) {
      const d = deskOf(a.id)
      const wingIndex = wings.indexOf(a.placement)
      if (!d || wingIndex < 0) continue
      const key = `${a.placement}#${d.pod}`
      const p = pods.get(key) ?? { key, wingIndex, pod: d.pod, seats: [], center: { x: 0, z: 0 } }
      p.seats.push(a)
      pods.set(key, p)
    }
    for (const p of pods.values()) {
      p.seats.sort((a, b) => deskOf(a.id)!.index - deskOf(b.id)!.index)
      p.center = {
        x: p.seats.reduce((s, a) => s + a.pos.x, 0) / p.seats.length,
        z: p.seats.reduce((s, a) => s + a.pos.z, 0) / p.seats.length,
      }
    }
    out.set(
      provider,
      [...pods.values()].sort((a, b) => a.wingIndex - b.wingIndex || a.pod - b.pod),
    )
  }
  podCache.set(layout, out)
  return out
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z)

/**
 * Assigns a desk to every agent that can have one. Agents of a provider without a wing (or whose
 * wings are full) stay unseated: `seats` has no entry for them.
 */
export function assignDesks(
  agents: Agent[],
  layout: BuildingLayout,
  prev: SeatingState,
  now: number,
  grouping: Grouping = byProviderAndTopic,
): SeatingState {
  const byId = new Map(agents.map((a) => [a.id, a]))
  const group = new Map(agents.map((a) => [a.id, grouping(a, (id) => byId.get(id))]))
  const pods = podsByProvider(layout)
  const seats: Seating = new Map()
  const taken = new Set<AnchorId>()
  const freed = new Map<AnchorId, number>()
  for (const [seat, at] of prev.freed) if (now - at < SEAT_REUSE_MS) freed.set(seat, at)
  const isFree = (seat: AnchorId) => !taken.has(seat) && !freed.has(seat)
  const occupant = new Map<AnchorId, string>()
  const take = (id: string, seat: AnchorId) => (
    seats.set(id, seat),
    taken.add(seat),
    occupant.set(seat, id)
  )
  const podOfSeat = (provider: string, seat: AnchorId) =>
    pods.get(provider)?.find((p) => p.seats.some((s) => s.id === seat))

  const ordered = [...agents].sort(
    (a, b) => a.since - b.since || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  // 1. Keep every desk that is still valid (same provider's wings, still in the layout).
  for (const a of ordered) {
    const p = prev.seats.get(a.id)
    if (p && !taken.has(p) && podOfSeat(group.get(a.id)!.zone, p)) take(a.id, p)
  }

  // 2. Newcomers: parents before their subagents.
  const depth = (a: Agent) => {
    let d = 0
    for (let cur = a; d < MAX_PARENT_DEPTH && cur.parentId && byId.has(cur.parentId); d++)
      cur = byId.get(cur.parentId)!
    return d
  }
  const fresh = ordered.filter((a) => !seats.has(a.id)).sort((a, b) => depth(a) - depth(b))
  for (const a of fresh) {
    const { zone, row } = group.get(a.id)!
    const mine = pods.get(zone) ?? []
    const seat =
      (a.parentId && seats.get(a.parentId) && nearParent(seats.get(a.parentId)!)) || byTopic()
    if (seat) take(a.id, seat)

    function nearParent(parentSeat: AnchorId): AnchorId | undefined {
      const parentPos = layout.anchors.get(parentSeat)!.pos
      const home = podOfSeat(zone, parentSeat)
      const nearest = (cands: WorldAnchor[]) =>
        cands
          .filter((s) => isFree(s.id))
          .sort((x, y) => dist(x.pos, parentPos) - dist(y.pos, parentPos))[0]?.id
      return nearest(home?.seats ?? []) ?? nearest(mine.flatMap((p) => p.seats))
    }

    function byTopic(): AnchorId | undefined {
      const members = (p: Pod) =>
        p.seats.filter((s) => {
          const who = occupant.get(s.id)
          return who !== undefined && group.get(who)!.row === row
        }).length
      const firstFree = (p: Pod) => p.seats.find((s) => isFree(s.id))?.id
      const topicPods = mine.filter((p) => members(p) > 0).sort((x, y) => members(y) - members(x))
      for (const p of topicPods) {
        const s = firstFree(p)
        if (s) return s
      }
      const origin = topicPods[0]?.center
      const byDistance = (x: Pod, y: Pod) =>
        x.wingIndex - y.wingIndex ||
        (origin ? dist(x.center, origin) - dist(y.center, origin) : 0) ||
        x.pod - y.pod
      const empty = mine.filter((p) => p.seats.every((s) => isFree(s.id))).sort(byDistance)
      const any = mine.filter((p) => firstFree(p)).sort(byDistance)
      const pod = empty[0] ?? any[0]
      return pod && firstFree(pod)
    }
  }

  // 3. Seats given up this update start their reuse timer.
  const held = new Set(seats.values())
  for (const seat of prev.seats.values())
    if (!held.has(seat) && !freed.has(seat)) freed.set(seat, now)
  return { seats, freed }
}
