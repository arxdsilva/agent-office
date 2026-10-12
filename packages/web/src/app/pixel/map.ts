// The 2D tile world (plan §3.2): every placement's module-local floor plan, rotated by its yaw and
// translated, rasterized into tile layers, a collision grid, rooms and interactive objects.
// Pure and deterministic: typed arrays, placements in layout order, three fixed passes.
// Tile ids come from an injected `TileResolver` (the pixel adapter backs it with atlas.json).
import { hash32, parseAnchorId, toWorld } from '../building.ts'
import type { Manifest } from '../manifest.ts'
import type { BuildingLayout, ModulePlacement, ThemeId, Vec2 } from '../office-types.ts'
import { dir4, projectionFor, toTile } from './project.ts'
import {
  TILE_M,
  TILE_PX,
  type MapObject,
  type ModulePlan,
  type PixelMap,
  type PixelRoom,
  type PlanByModule,
  type PlanFurniture,
  type TilePos,
  type TileRect,
  type WallKind,
} from './types.ts'

/** Wall direction on the map: horizontal (east–west) or vertical (north–south). */
export type TileEdge = 'h' | 'v'

/**
 * What tile to draw. `floor`: kind = the plan room's floor material, else 'street' / 'default'.
 * `wall`: kind = 'solid' | 'glass' | 'curtain' | 'door'. `overhead`: the same kinds, drawn on top of
 * characters one row above a horizontal wall (wall tops and door lintels).
 */
export interface TileQuery {
  layer: 'floor' | 'wall' | 'overhead'
  kind: string
  theme?: ThemeId
  edge?: TileEdge
}

/** Maps a tile query to an atlas tile id (> 0; 0 means empty). */
export interface TileResolver {
  tile(q: TileQuery): number
}

/** Furniture the player can walk over. */
// Chairs sit on anchor approach lanes at tile resolution; the player walks past them (y-sorted).
const WALKABLE = new Set<string>(['rug', 'sign', 'chair'])
/** `ref`s that point at a capability surface slot. */
const SLOT_REF = /^(station|book|board|notebook):\d+$/
const EPS = 1e-6

export const tileIndex = (m: Pick<PixelMap, 'widthTiles'>, t: TilePos) => t.ty * m.widthTiles + t.tx

/** Placement + surface slot of a capability object (`station:3`, `book:12`, …), else undefined. */
export function capabilitySlot(o: MapObject): { placement: string; slot: string } | undefined {
  const { placement, local } = parseAnchorId(o.id)
  return SLOT_REF.test(local) ? { placement, slot: local } : undefined
}

/** The floor plans a manifest carries (modules without one stay empty in 2D). */
export function plansOf(m: Manifest): PlanByModule {
  const out: PlanByModule = {}
  for (const k of ['atrium', 'street', 'wing', 'garden', 'cap'] as const) {
    const plan = m.modules[k].plan
    if (plan) out[k] = plan
  }
  return out
}

const signature = (p: ModulePlacement) =>
  `${p.id}@${p.position.x},${p.position.z},${p.yaw}#${p.theme ?? ''}${p.dimmed ? '~' : ''}`

/** Builds the tile world; returns `prev` itself when neither the layout nor the plan changed. */
export function buildPixelMap(
  layout: BuildingLayout,
  plans: PlanByModule,
  tiles: TileResolver,
  prev?: PixelMap,
): PixelMap {
  const key = `${layout.key}#${hash32(JSON.stringify(plans))}`
  if (prev && prev.key === key) return prev
  const proj = projectionFor(layout.bounds)
  const w = proj.widthTiles
  const h = proj.heightTiles
  const size = w * h
  const map: PixelMap = {
    widthTiles: w,
    heightTiles: h,
    originM: proj.originM,
    layers: {
      floor: new Uint16Array(size),
      walls: new Uint16Array(size),
      overhead: new Uint16Array(size),
    },
    objects: [],
    solid: new Uint8Array(size),
    rooms: [],
    key,
    dirty: dirtyList(layout, proj, prev),
  }
  const inside = (t: TilePos) => t.tx >= 0 && t.ty >= 0 && t.tx < w && t.ty < h
  const set = (layer: Uint16Array, t: TilePos, id: number) => {
    if (inside(t)) layer[t.ty * w + t.tx] = id
  }
  const placed = layout.placements
    .map((p) => ({ p, plan: plans[p.kind] }))
    .filter((x): x is { p: ModulePlacement; plan: ModulePlan } => !!x.plan)

  // Pass 1: room floors.
  for (const { p, plan } of placed)
    for (const room of plan.rooms) {
      const [x0, z0, x1, z1] = room.rect
      const rect = rectOf(corners(p, x0, z0, x1, z1), map)
      const floor = tiles.tile({
        layer: 'floor',
        kind: room.floor ?? (p.kind === 'street' ? 'street' : 'default'),
        ...(p.theme && { theme: p.theme }),
      })
      forTiles(rect, (t) => set(map.layers.floor, t, floor))
      const r: PixelRoom = { id: `${p.id}/${room.id}`, name: room.name, rect, placement: p.id }
      if (p.theme) r.theme = p.theme
      if (p.provider) r.provider = p.provider
      map.rooms.push(r)
    }

  // Pass 2: walls (doors win over wall samples in the same tile, so openings stay passable).
  for (const { p, plan } of placed)
    plan.walls.forEach((wall, wi) => {
      const a = toWorld({ x: wall.a[0], z: wall.a[1] }, p)
      const b = toWorld({ x: wall.b[0], z: wall.b[1] }, p)
      const len = Math.hypot(b.x - a.x, b.z - a.z)
      if (len < EPS) return
      const edge: TileEdge = Math.abs(b.x - a.x) >= Math.abs(b.z - a.z) ? 'h' : 'v'
      const n = Math.ceil(len / (TILE_M / 2))
      const kinds = new Map<number, { t: TilePos; door: boolean; opening: number }>()
      for (let i = 0; i < n; i++) {
        const t = ((i + 0.5) * len) / n
        const pt = { x: a.x + ((b.x - a.x) * t) / len, z: a.z + ((b.z - a.z) * t) / len }
        const tile = toTile(pt, map)
        if (!inside(tile)) continue
        const opening = (wall.openings ?? []).findIndex(([t0, t1]) => t > t0 + EPS && t < t1 - EPS)
        const k = tile.ty * w + tile.tx
        const cur = kinds.get(k)
        if (!cur || (!cur.door && opening >= 0))
          kinds.set(k, { t: tile, door: opening >= 0, opening })
      }
      const doors = new Map<number, TilePos[]>()
      for (const [k, { t, door, opening }] of kinds) {
        const kind: WallKind | 'door' = door ? 'door' : wall.kind
        const theme = p.theme ? { theme: p.theme } : {}
        map.layers.walls[k] = tiles.tile({ layer: 'wall', kind, edge, ...theme })
        map.solid[k] = door ? 0 : 1
        if (edge === 'h' && t.ty > 0)
          set(
            map.layers.overhead,
            { tx: t.tx, ty: t.ty - 1 },
            tiles.tile({ layer: 'overhead', kind, edge, ...theme }),
          )
        if (door) doors.set(opening, [...(doors.get(opening) ?? []), t])
      }
      for (const [opening, ts] of [...doors].sort((x, y) => x[0] - y[0])) {
        const rect = boundsOf(ts)
        map.objects.push({
          id: `${p.id}/door:${wi}:${opening}`,
          kind: 'door',
          rect,
          sortY: (rect.ty + rect.th) * TILE_PX,
          solid: false,
          facing: edge === 'h' ? 's' : 'e',
          ...(p.theme && { theme: p.theme }),
        })
      }
    })

  // Pass 3: furniture footprints.
  for (const { p, plan } of placed)
    plan.furniture.forEach((f, fi) => {
      const o = furnitureObject(p, f, fi, map)
      if (o.solid) forTiles(o.rect, (t) => inside(t) && (map.solid[t.ty * w + t.tx] = 1))
      map.objects.push(o)
    })

  // Anchor-driven objects: booth lamps and elevator doors (never solid).
  for (const a of layout.anchors.values()) {
    const kind = /^spot:booth:\d+$/.test(a.local)
      ? 'booth-lamp'
      : /^spot:elevator:\d+$/.test(a.local)
        ? 'elevator-door'
        : undefined
    if (!kind) continue
    const t = toTile(a.pos, map)
    map.objects.push({
      id: `${a.placement}/${kind}:${a.local.slice(a.local.lastIndexOf(':') + 1)}`,
      kind,
      rect: { tx: t.tx, ty: t.ty, tw: 1, th: 1 },
      sortY: (t.ty + 1) * TILE_PX,
      solid: false,
      facing: dir4(a.heading),
    })
  }
  return remember(map, layout)
}

function furnitureObject(
  p: ModulePlacement,
  f: PlanFurniture,
  i: number,
  at: Pick<PixelMap, 'originM'>,
): MapObject {
  const yaw = p.yaw + f.yaw
  const c = Math.abs(Math.cos(yaw))
  const s = Math.abs(Math.sin(yaw))
  const hx = (f.w / 2) * c + (f.d / 2) * s
  const hz = (f.w / 2) * s + (f.d / 2) * c
  const center = toWorld({ x: f.x, z: f.z }, p)
  const rect = footprintOf(center, hx, hz, at)
  const o: MapObject = {
    id: `${p.id}/${f.ref ?? `${f.kind}:${i}`}`,
    kind: f.kind,
    rect,
    sortY: (rect.ty + rect.th) * TILE_PX,
    solid: !WALKABLE.has(f.kind),
    facing: dir4(yaw),
  }
  if (p.theme) o.theme = p.theme
  if (f.kind === 'elevator') o.interact = { kind: 'object', object: 'elevator' }
  else if (f.kind === 'led-wall') o.interact = { kind: 'object', object: 'stats-board' }
  else if (f.kind === 'sign') {
    const label = p.label ?? p.provider
    o.interact = { kind: 'object', object: 'sign', ...(label && { label }) }
  }
  return o
}

/** Module-local rect corners → world points. */
function corners(p: ModulePlacement, x0: number, z0: number, x1: number, z1: number): Vec2[] {
  return [toWorld({ x: x0, z: z0 }, p), toWorld({ x: x1, z: z1 }, p)]
}

/** Tile rect covering the world AABB of `pts` (rounded outward, edges on the grid stay put). */
function rectOf(pts: Vec2[], at: Pick<PixelMap, 'originM'>): TileRect {
  const xs = pts.map((q) => (q.x - at.originM.x) / TILE_M)
  const zs = pts.map((q) => (q.z - at.originM.z) / TILE_M)
  const tx = Math.floor(Math.min(...xs) + EPS)
  const ty = Math.floor(Math.min(...zs) + EPS)
  return {
    tx,
    ty,
    tw: Math.max(1, Math.ceil(Math.max(...xs) - EPS) - tx),
    th: Math.max(1, Math.ceil(Math.max(...zs) - EPS) - ty),
  }
}

/**
 * Tiles whose centres lie inside a furniture footprint (so a 0.5 m chair takes one tile, not
 * four); a piece smaller than a tile still takes the tile under its centre.
 */
function footprintOf(c: Vec2, hx: number, hz: number, at: Pick<PixelMap, 'originM'>): TileRect {
  const span = (mid: number, half: number, origin: number) => {
    const lo = Math.ceil((mid - half - origin) / TILE_M - 0.5 - EPS)
    const hi = Math.floor((mid + half - origin) / TILE_M - 0.5 + EPS)
    return hi >= lo ? [lo, hi - lo + 1] : [Math.floor((mid - origin) / TILE_M + EPS), 1]
  }
  const [tx, tw] = span(c.x, hx, at.originM.x) as [number, number]
  const [ty, th] = span(c.z, hz, at.originM.z) as [number, number]
  return { tx, ty, tw, th }
}

function boundsOf(ts: TilePos[]): TileRect {
  const tx = Math.min(...ts.map((t) => t.tx))
  const ty = Math.min(...ts.map((t) => t.ty))
  return {
    tx,
    ty,
    tw: Math.max(...ts.map((t) => t.tx)) - tx + 1,
    th: Math.max(...ts.map((t) => t.ty)) - ty + 1,
  }
}

function forTiles(r: TileRect, fn: (t: TilePos) => void) {
  for (let ty = r.ty; ty < r.ty + r.th; ty++)
    for (let tx = r.tx; tx < r.tx + r.tw; tx++) fn({ tx, ty })
}

/** Placements whose tiles changed: all when the grid moved, else added, moved or removed ones. */
function dirtyList(
  layout: BuildingLayout,
  proj: ReturnType<typeof projectionFor>,
  prev: PixelMap | undefined,
): string[] {
  const now = layout.placements.map((p) => p.id)
  if (
    !prev ||
    prev.originM.x !== proj.originM.x ||
    prev.originM.z !== proj.originM.z ||
    prev.widthTiles !== proj.widthTiles ||
    !prevSignatures.has(prev)
  ) {
    return now
  }
  const before = prevSignatures.get(prev)!
  const after = new Map(layout.placements.map((p) => [p.id, signature(p)]))
  const out = now.filter((id) => before.get(id) !== after.get(id))
  for (const id of before.keys()) if (!after.has(id)) out.push(id)
  return out
}

/** Placement signatures each map was built from (kept off the public shape). */
const prevSignatures = new WeakMap<PixelMap, Map<string, string>>()

/** Remembers the signatures a map was built from (called by `buildPixelMap`). */
function remember(map: PixelMap, layout: BuildingLayout) {
  prevSignatures.set(map, new Map(layout.placements.map((p) => [p.id, signature(p)])))
  return map
}
