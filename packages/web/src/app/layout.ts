import { groupAgents, type Agent, type Grouping } from '@agent-office/shared'

/** Distance between desks in a row (world units). */
export const DESK_SPACING = 3
/** Distance between rows inside a zone. */
export const ROW_SPACING = 6
/** Gap between zones. */
export const AISLE = 8
const ZONE_PADDING = 2.5
const MIN_COLS = 3

/** Where each agent sits, kept between layouts so desks stay stable. */
export type LayoutState = Map<string, { zone: string; row: string; col: number }>

export interface RowLayout {
  name: string
  z: number
}

export interface ZoneLayout {
  name: string
  x0: number
  x1: number
  z0: number
  z1: number
  rows: RowLayout[]
}

export interface Seat {
  x: number
  z: number
}

/**
 * Pure office layout. Zones come from the grouping strategy and sit side by side along x; rows
 * stack along z. Agents keep their desk column while they stay in the same row; newcomers take
 * the lowest free column, and subagents take the free column nearest their parent.
 */
export function layoutOffice(agents: Agent[], grouping: Grouping, prev: LayoutState) {
  const zones = groupAgents(agents, grouping)
  const state: LayoutState = new Map()

  for (const zone of zones) {
    for (const row of zone.rows) {
      const taken = new Set<number>()
      const keep = (a: Agent) => {
        const p = prev.get(a.id)
        if (p && p.zone === zone.name && p.row === row.name && !taken.has(p.col)) {
          taken.add(p.col)
          state.set(a.id, p)
          return true
        }
        return false
      }
      const fresh = row.agents.filter((a) => !keep(a)).sort((a, b) => a.since - b.since)
      const seat = (a: Agent, col: number) => {
        taken.add(col)
        state.set(a.id, { zone: zone.name, row: row.name, col })
      }
      const firstFree = (from = 0) => {
        let c = from
        while (taken.has(c)) c++
        return c
      }
      // Each parent is followed by its subagents, so they sit beside it.
      const inRow = (id: string | undefined) => !!id && row.agents.some((p) => p.id === id)
      const seatNearParent = (a: Agent) => seat(a, nearestFree(state.get(a.parentId!)!.col, taken))
      for (const a of fresh.filter((a) => !inRow(a.parentId))) {
        seat(a, firstFree())
        for (const child of fresh.filter((c) => c.parentId === a.id)) seatNearParent(child)
      }
      // Subagents whose parent already had a desk.
      for (const a of fresh.filter((a) => inRow(a.parentId) && !state.has(a.id))) seatNearParent(a)
    }
  }

  const layouts: ZoneLayout[] = []
  let cursor = 0
  for (const zone of zones) {
    const cols = Math.max(
      MIN_COLS,
      ...zone.rows.flatMap((r) => r.agents.map((a) => state.get(a.id)!.col + 1)),
    )
    const width = (cols - 1) * DESK_SPACING + ZONE_PADDING * 2
    const depth = (zone.rows.length - 1) * ROW_SPACING + ZONE_PADDING * 2
    layouts.push({
      name: zone.name,
      x0: cursor,
      x1: cursor + width,
      z0: 0,
      z1: depth,
      rows: zone.rows.map((r, i) => ({ name: r.name, z: ZONE_PADDING + i * ROW_SPACING })),
    })
    cursor += width + AISLE
  }

  // Center the office on the origin.
  const totalW = layouts.length ? layouts[layouts.length - 1]!.x1 : 0
  const totalD = Math.max(0, ...layouts.map((z) => z.z1))
  for (const z of layouts) {
    z.x0 -= totalW / 2
    z.x1 -= totalW / 2
    z.z0 -= totalD / 2
    z.z1 -= totalD / 2
    for (const r of z.rows) r.z -= totalD / 2
  }

  const slots = new Map<string, Seat>()
  for (const [id, s] of state) {
    const zone = layouts.find((z) => z.name === s.zone)!
    const row = zone.rows.find((r) => r.name === s.row)!
    slots.set(id, { x: zone.x0 + ZONE_PADDING + s.col * DESK_SPACING, z: row.z })
  }
  return { zones: layouts, slots, state }
}

/** Free column closest to `col`, preferring the right side; never negative. */
function nearestFree(col: number, taken: Set<number>): number {
  for (let d = 1; ; d++) {
    if (!taken.has(col + d)) return col + d
    if (col - d >= 0 && !taken.has(col - d)) return col - d
  }
}
