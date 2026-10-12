// Adapter stations in a wing's Adapters room (docs/capabilities.md §5): fs, shell, web and
// subagents are pinned to 0–3, others fill in first-seen order; beyond 8, station 7 aggregates.
import type { Capability } from '@agent-office/shared'

export const STATION_COUNT = 8
export const PINNED_STATIONS: Readonly<Record<string, number>> = {
  fs: 0,
  shell: 1,
  web: 2,
  subagents: 3,
}
/** Free-station preference for unpinned adapters: 4–7, then pinned stations nobody uses. */
export const STATION_ORDER: readonly number[] = [4, 5, 6, 7, 3, 2, 1, 0]

/** Slot assignment shared by stations and the library. */
export interface SlotMap {
  /** id → slot. Overflowed ids map to the last slot (the "+N more" aggregate). */
  slot: Map<string, number>
  /** slot → the id shown there alone (undefined when free or when it is the aggregate). */
  occupant: (string | undefined)[]
  /** Ids shown on the aggregate in the last slot (empty when nothing overflowed). */
  overflow: string[]
}

export const emptySlots = (capacity: number): SlotMap => ({
  slot: new Map(),
  occupant: Array.from({ length: capacity }, () => undefined),
  overflow: [],
})

/**
 * Stable slot assignment: ids keep their slot while they exist; new ids take the first free slot
 * (pinned slot if free, else in `order`), in the order given. When ids don't fit, the last slot
 * becomes an aggregate holding its previous occupant plus every id that didn't fit.
 */
export function assignSlots(
  ids: string[],
  prev: SlotMap | undefined,
  capacity: number,
  opts: { pinned?: Readonly<Record<string, number>>; order?: readonly number[] } = {},
): SlotMap {
  const out = emptySlots(capacity)
  const order = opts.order ?? Array.from({ length: capacity }, (_, i) => i)
  const unplaced: string[] = []
  for (const id of ids) {
    const i = prev?.slot.get(id)
    if (i !== undefined && i < capacity && prev!.occupant[i] === id) out.occupant[i] = id
    else unplaced.push(id)
  }
  const rest: string[] = []
  for (const id of unplaced) {
    const p = opts.pinned?.[id]
    if (p !== undefined && p < capacity && out.occupant[p] === undefined) out.occupant[p] = id
    else rest.push(id)
  }
  for (const id of rest) {
    const free = order.find((i) => out.occupant[i] === undefined)
    if (free === undefined) out.overflow.push(id)
    else out.occupant[free] = id
  }
  if (out.overflow.length && capacity > 0) {
    const last = capacity - 1
    const was = out.occupant[last]
    if (was !== undefined) out.overflow.unshift(was)
    out.occupant[last] = undefined
  }
  out.occupant.forEach((id, i) => id !== undefined && out.slot.set(id, i))
  for (const id of out.overflow) out.slot.set(id, capacity - 1)
  return out
}

/** Stations for one provider's adapters (capabilities of other categories are ignored). */
export function assignStations(capabilities: Capability[], prev?: SlotMap): SlotMap {
  const ids = capabilities.filter((c) => c.category === 'adapter').map((c) => c.id)
  return assignSlots(ids, prev, STATION_COUNT, { pinned: PINNED_STATIONS, order: STATION_ORDER })
}
