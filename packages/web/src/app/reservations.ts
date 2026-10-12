// Reservations of shared spaces (meeting rooms, booths, kitchen, lounge, cafe, ping-pong, reception,
// elevator). Pure and deterministic: the same requests in the same order give the same grants.
import type { AnchorId, BuildingLayout } from './office-types.ts'

export type ResourceKind =
  | 'meeting'
  | 'booth'
  | 'kitchen'
  | 'lounge'
  | 'cafe'
  | 'pingpong'
  | 'reception'
  | 'elevator'
  | 'station'
  | 'reading-seat'
  | 'shelf-spot'

/** How many people can hold one anchor at once (shelf spots: side by side, 0.6 m apart). */
export const SHARES: Readonly<Partial<Record<ResourceKind, number>>> = { 'shelf-spot': 2 }

/** Largest team a meeting room accepts (one team per room). */
export const MEETING_MAX_TEAM = 6

export interface ReservationRequest {
  kind: ResourceKind
  /** Agent id, or a group id such as `team:<parentId>` / `pingpong:<a>|<b>`. */
  holder: string
  /** Placement ids of the requester's wings, in preference order (wing-scoped kinds only). */
  wings?: string[]
  /** Team size for meetings (checked against the room size and MEETING_MAX_TEAM). */
  seats?: number
  /** Auto-expire after this many ms (see `expire`). */
  ttl?: number
  /** Only this anchor will do (e.g. the station of a given adapter, the shelf holding a book). */
  anchor?: AnchorId
}

export interface Reservation {
  holder: string
  /** Granted kind (may differ from the requested one: kitchen/lounge fall back to cafe). */
  kind: ResourceKind
  /** Unit id: `<placement>/<room>` for rooms and tables, else the anchor id. */
  room: string
  /** Meeting: every seat of the room (index order). Ping-pong: [A, B]. Otherwise one anchor. */
  anchors: AnchorId[]
  at: number
  expires?: number
  /** For shared anchors: which share (0 = on the spot, 1 = the offset place next to it). */
  share?: number
}

export interface ReservationState {
  byHolder: Map<string, Reservation>
  byAnchor: Map<AnchorId, string>
}

export const emptyReservations = (): ReservationState => ({
  byHolder: new Map(),
  byAnchor: new Map(),
})

interface Unit {
  room: string
  placement: string
  anchors: AnchorId[]
}

const PATTERNS: Record<ResourceKind, RegExp> = {
  meeting: /^seat:meeting:([A-Za-z]+):(\d+)$/,
  booth: /^spot:booth:(\d+)$/,
  kitchen: /^spot:kitchen:(\d+)$/,
  lounge: /^seat:lounge:(\d+)$/,
  cafe: /^seat:cafe:(\d+)$/,
  pingpong: /^spot:pingpong:(\d+):([AB])$/,
  reception: /^spot:reception:(\d+)$/,
  elevator: /^spot:elevator:(\d+)$/,
  station: /^spot:station:(\d+)$/,
  'reading-seat': /^seat:reading:(\d+)$/,
  'shelf-spot': /^spot:shelf:(\d+)$/,
}
const WING_SCOPED = new Set<ResourceKind>([
  'meeting',
  'booth',
  'kitchen',
  'lounge',
  'station',
  'reading-seat',
  'shelf-spot',
])
/** byAnchor key of share `k` of a shared anchor. */
const shareKey = (anchor: AnchorId, k: number) => (k ? `${anchor}#${k}` : anchor)
const keysOf = (r: Reservation) => r.anchors.map((a) => shareKey(a, r.share ?? 0))
const FALLBACK: Partial<Record<ResourceKind, ResourceKind>> = { kitchen: 'cafe', lounge: 'cafe' }

const unitCache = new WeakMap<BuildingLayout, Map<ResourceKind, Unit[]>>()

/** Units per kind, ordered by placement (layout order) then unit number. Rooms and tables group their anchors. */
function units(layout: BuildingLayout): Map<ResourceKind, Unit[]> {
  const hit = unitCache.get(layout)
  if (hit) return hit
  const placementIndex = new Map(layout.placements.map((p, i) => [p.id, i]))
  const out = new Map<ResourceKind, Unit[]>()
  for (const kind of Object.keys(PATTERNS) as ResourceKind[]) {
    const rooms = new Map<
      string,
      { unit: Unit; order: string | number; members: [number, AnchorId][] }
    >()
    for (const a of layout.anchors.values()) {
      const m = PATTERNS[kind].exec(a.local)
      if (!m) continue
      const [room, order, member] =
        kind === 'meeting'
          ? [`${a.placement}/meeting-${m[1]}`, m[1]!, Number(m[2])]
          : kind === 'pingpong'
            ? [`${a.placement}/pingpong-${m[1]}`, Number(m[1]), m[2] === 'B' ? 1 : 0]
            : [a.id, Number(m[1]), 0]
      const r = rooms.get(room) ?? {
        unit: { room, placement: a.placement, anchors: [] },
        order,
        members: [],
      }
      r.members.push([member, a.id])
      rooms.set(room, r)
    }
    const list = [...rooms.values()].sort(
      (x, y) =>
        (placementIndex.get(x.unit.placement) ?? 0) - (placementIndex.get(y.unit.placement) ?? 0) ||
        (x.order < y.order ? -1 : x.order > y.order ? 1 : 0),
    )
    for (const r of list) r.unit.anchors = r.members.sort((x, y) => x[0] - y[0]).map(([, id]) => id)
    out.set(
      kind,
      list.map((r) => r.unit),
    )
  }
  unitCache.set(layout, out)
  return out
}

export const holderOf = (s: ReservationState, anchor: AnchorId) => s.byAnchor.get(anchor)
export const reservationOf = (s: ReservationState, holder: string) => s.byHolder.get(holder)

/**
 * Reserves a resource. Returns the new state and the granted anchors (undefined when nothing is
 * free: meetings and booths have no fallback; kitchen/lounge fall back to the atrium cafe).
 */
export function reserve(
  state: ReservationState,
  layout: BuildingLayout,
  req: ReservationRequest,
  now: number,
): { state: ReservationState; grant?: AnchorId[]; kind?: ResourceKind; share?: number } {
  const held = state.byHolder.get(req.holder)
  const tooBig = req.kind === 'meeting' && (req.seats ?? 1) > MEETING_MAX_TEAM
  const same =
    held &&
    (held.kind === req.kind || held.kind === FALLBACK[req.kind]) &&
    (!req.anchor || held.anchors.includes(req.anchor))
  if (held && same && !tooBig) {
    const res: { state: ReservationState; grant: AnchorId[]; kind: ResourceKind; share?: number } =
      {
        state,
        grant: held.anchors,
        kind: held.kind,
      }
    if (held.share !== undefined) res.share = held.share
    return res
  }
  const base = held ? release(state, req.holder) : state
  if (tooBig) return { state: base }

  const all = units(layout)
  const shares = SHARES[req.kind] ?? 1
  const freeShare = (u: Unit) => {
    for (let k = 0; k < shares; k++)
      if (u.anchors.every((a) => !base.byAnchor.has(shareKey(a, k)))) return k
    return -1
  }
  const isFree = (u: Unit) => (!req.anchor || u.anchors.includes(req.anchor)) && freeShare(u) >= 0
  const fits = (u: Unit) => req.kind !== 'meeting' || (req.seats ?? 1) <= u.anchors.length
  const pick = (kind: ResourceKind): Unit | undefined => {
    const list = all.get(kind)!
    if (!WING_SCOPED.has(kind)) return list.find((u) => isFree(u) && fits(u))
    for (const w of req.wings ?? []) {
      const u = list.find((x) => x.placement === w && isFree(x) && fits(x))
      if (u) return u
    }
    return undefined
  }
  let kind = req.kind
  let unit = pick(kind)
  const fb = FALLBACK[kind]
  if (!unit && fb) unit = pick((kind = fb))
  if (!unit) return { state: base }

  const r: Reservation = {
    holder: req.holder,
    kind,
    room: unit.room,
    anchors: unit.anchors,
    at: now,
  }
  if (req.ttl !== undefined) r.expires = now + req.ttl
  if (shares > 1) r.share = freeShare(unit)
  const byHolder = new Map(base.byHolder).set(req.holder, r)
  const byAnchor = new Map(base.byAnchor)
  for (const k of keysOf(r)) byAnchor.set(k, req.holder)
  const out: { state: ReservationState; grant: AnchorId[]; kind: ResourceKind; share?: number } = {
    state: { byHolder, byAnchor },
    grant: unit.anchors,
    kind,
  }
  if (r.share !== undefined) out.share = r.share
  return out
}

export function release(state: ReservationState, holder: string): ReservationState {
  const r = state.byHolder.get(holder)
  if (!r) return state
  const byHolder = new Map(state.byHolder)
  byHolder.delete(holder)
  const byAnchor = new Map(state.byAnchor)
  for (const k of keysOf(r)) byAnchor.delete(k)
  return { byHolder, byAnchor }
}

/** Drops reservations whose `ttl` ran out. */
export function expire(state: ReservationState, now: number): ReservationState {
  let s = state
  for (const r of state.byHolder.values())
    if (r.expires !== undefined && r.expires <= now) s = release(s, r.holder)
  return s
}
