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
  type PlanWall,
  type SpriteFoot,
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

/**
 * Size classes (plan §1.1). Kinds not listed are **fixed**: the render rect is the sprite foot
 * centred on the piece. **strip**: the size-stable footprint along the long axis, the sprite's
 * thickness across (the renderer repeats the sprite). Strip kinds and the elevator become **area**
 * (a 9-slice fill) when the footprint is ≥ 3 tiles on both axes (garden pool, bleachers, the bank).
 */
export const SIZE_CLASS: Partial<Record<string, 'strip' | 'area'>> = {
  bench: 'strip',
  planter: 'strip',
  'kitchen-counter': 'strip',
  'cafe-bar': 'strip',
  bookshelf: 'strip',
  'notebook-rack': 'strip',
  'led-wall': 'strip',
  elevator: 'area',
}
/** Pieces hung on or pushed against a wall: their back edge snaps to the wall tile (plan §2d). */
export const WALL_MOUNTED = new Set<string>([
  'kitchen-counter',
  'bookshelf',
  'board',
  'tv',
  'led-wall',
  'sign',
  'notebook-rack',
])
/** A piece whose back edge is this close to a wall line (m) sits against it. */
const WALL_GAP = 0.3
/** Walls this close to a piece (m) push it off their tile when they overlap. */
const NEAR_WALL = 1
/** Thin walls whose body is this close to a tile boundary (m) go to the module-interior tile. */
const THIN_WALL = 0.2
const NEAR_BOUNDARY = 0.05
/** The ¾ art may rise this many tiles above an object's rect (never further: walls stay clean). */
export const OVERHANG_TILES = 1

/** Pixel-space limits of an object's drawing: its rect plus at most one tile of ¾ overhang. */
export function drawBounds(o: Pick<MapObject, 'rect'>): TileRect {
  const ty = Math.max(0, o.rect.ty - OVERHANG_TILES)
  return { tx: o.rect.tx, ty, tw: o.rect.tw, th: o.rect.ty + o.rect.th - ty }
}

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

/**
 * Builds the tile world; returns `prev` itself when neither the layout nor the plan changed.
 * `feet` sizes objects from their art (the atlas); without it objects use size-stable footprints.
 */
export function buildPixelMap(
  layout: BuildingLayout,
  plans: PlanByModule,
  tiles: TileResolver,
  prev?: PixelMap,
  feet?: SpriteFoot | null,
): PixelMap {
  const key = `${layout.key}#${hash32(JSON.stringify(plans))}${feet ? '#art' : ''}`
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

  // Pass 2: walls (doors win over wall samples in the same tile, so openings stay passable). Each
  // sample sits on the wall's 3D body (offset by side · thick / 2), decided in module-local space so
  // mirrored wings agree.
  for (const { p, plan } of placed) {
    plan.walls.forEach((wall, wi) => {
      const prefer = wallPrefer(wall, plan)
      const len = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1])
      if (len < EPS) return
      const wa = toWorld({ x: wall.a[0], z: wall.a[1] }, p)
      const wb = toWorld({ x: wall.b[0], z: wall.b[1] }, p)
      const edge: TileEdge = Math.abs(wb.x - wa.x) >= Math.abs(wb.z - wa.z) ? 'h' : 'v'
      const n = Math.ceil(len / (TILE_M / 2))
      const kinds = new Map<number, { t: TilePos; door: boolean; opening: number }>()
      for (let i = 0; i < n; i++) {
        const t = ((i + 0.5) * len) / n
        const tile = toTile(toWorld(wallPoint(wall, t, prefer), p), map)
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
          orientation: rect.th > rect.tw ? 'v' : 'h',
          fill: 'repeat',
          ...(p.theme && { theme: p.theme }),
        })
      }
    })
  }

  // Pass 3: furniture footprints.
  for (const { p, plan } of placed)
    plan.furniture.forEach((f, fi) => {
      const o = furnitureObject(p, f, fi, map, feet ?? null, plan)
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
    // Drawn over the booth / the elevator car: the art's foot centred on the spot.
    const f = feet?.foot(kind, 'h')
    const rect = f ? centred(a.pos, f.tw, f.th, map) : { ...toTile(a.pos, map), tw: 1, th: 1 }
    map.objects.push({
      id: `${a.placement}/${kind}:${a.local.slice(a.local.lastIndexOf(':') + 1)}`,
      kind,
      rect,
      sortY: (rect.ty + rect.th) * TILE_PX,
      solid: false,
      facing: dir4(a.heading),
      orientation: 'h',
      fill: 'sprite',
    })
  }
  return remember(map, layout)
}

function furnitureObject(
  p: ModulePlacement,
  f: PlanFurniture,
  i: number,
  at: Pick<PixelMap, 'originM'>,
  feet: SpriteFoot | null,
  plan: ModulePlan,
): MapObject {
  const yaw = p.yaw + f.yaw
  const c = Math.abs(Math.cos(yaw))
  const s = Math.abs(Math.sin(yaw))
  const hx = (f.w / 2) * c + (f.d / 2) * s
  const hz = (f.w / 2) * s + (f.d / 2) * c
  const orientation: 'h' | 'v' = hz > hx + EPS ? 'v' : 'h'
  const sized = sizeObject(f.kind, hx, hz, orientation, feet)
  const planRoom = roomOf(plan, f.x, f.z)
  const toward = planRoom
    ? { x: (planRoom.rect[0] + planRoom.rect[2]) / 2, z: (planRoom.rect[1] + planRoom.rect[3]) / 2 }
    : interiorOf(plan)
  const rect = placeLocal(p, f.x, f.z, sized.tw, sized.th, toward, at)
  const trimmed = snapToWall(rect, p, f, plan, at)
  // The room holding the piece (a sign hung outside a wall belongs to no room).
  const roomRect = planRoom && rectOf(corners(p, ...planRoom.rect), at)
  const room = roomRect && clampTo(rect, roomRect) ? planRoom : undefined
  // A piece cut down by a wall or its room no longer matches its art: fill the rect (9-slice).
  const fill = trimmed || rect.tw !== sized.tw || rect.th !== sized.th ? 'area' : sized.fill
  const o: MapObject = {
    id: `${p.id}/${f.ref ?? `${f.kind}:${i}`}`,
    kind: f.kind,
    rect,
    sortY: (rect.ty + rect.th) * TILE_PX,
    solid: !WALKABLE.has(f.kind),
    facing: dir4(yaw),
    orientation,
    fill,
  }
  if (room) o.room = `${p.id}/${room.id}`
  if (p.theme) o.theme = p.theme
  if (f.kind === 'elevator') o.interact = { kind: 'object', object: 'elevator' }
  else if (f.kind === 'led-wall') o.interact = { kind: 'object', object: 'stats-board' }
  else if (f.kind === 'sign') {
    const label = p.label ?? p.provider
    o.interact = { kind: 'object', object: 'sign', ...(label && { label }) }
  }
  return o
}

/** Render size (tiles, world axes) and fill for a piece (plan §1.1, the size classes). */
function sizeObject(
  kind: string,
  hx: number,
  hz: number,
  orientation: 'h' | 'v',
  feet: SpriteFoot | null,
): { tw: number; th: number; fill: NonNullable<MapObject['fill']> } {
  const sw = stableTiles(hx)
  const sh = stableTiles(hz)
  const cls = SIZE_CLASS[kind]
  if (cls && sw >= 3 && sh >= 3) return { tw: sw, th: sh, fill: 'area' }
  const foot = feet?.foot(kind, orientation) ?? null
  if (!foot) return { tw: sw, th: sh, fill: 'sprite' }
  if (cls === 'strip') {
    if (orientation === 'v' && sh > foot.th) return { tw: foot.tw, th: sh, fill: 'repeat' }
    if (orientation === 'h' && sw > foot.tw) return { tw: sw, th: foot.th, fill: 'repeat' }
  }
  return { tw: foot.tw, th: foot.th, fill: 'sprite' }
}

/** Size-stable tile count for a half extent (plan §1.2): max(1, round(2·half / TILE_M)). */
const stableTiles = (half: number) => Math.max(1, Math.round((2 * half) / TILE_M - EPS))

/**
 * A tw × th tile rect (world axes) centred on the module-local point (x, z), snapped to whole tiles
 * in module-local space, so a rotated wing gets the same tiles as an unrotated one. A half-tile tie
 * rounds toward `toward` (the room's centre), keeping pieces off the corridors around them.
 */
function placeLocal(
  p: ModulePlacement,
  x: number,
  z: number,
  tw: number,
  th: number,
  toward: Vec2,
  at: Pick<PixelMap, 'originM'>,
): TileRect {
  const swap = Math.abs(Math.cos(p.yaw)) < Math.SQRT1_2
  const nx = swap ? th : tw
  const nz = swap ? tw : th
  const snap = (v: number, n: number, to: number) => {
    const s = v / TILE_M - n / 2
    const tie = Math.abs(s - Math.floor(s) - 0.5) < 1e-3
    return (tie ? (to < v ? Math.floor(s) : Math.ceil(s)) : Math.round(s)) * TILE_M
  }
  const x0 = snap(x, nx, toward.x)
  const z0 = snap(z, nz, toward.z)
  const r = rectOf(corners(p, x0, z0, x0 + nx * TILE_M, z0 + nz * TILE_M), at)
  return { tx: r.tx, ty: r.ty, tw, th }
}

/** A tw × th tile rect centred on a world point, snapped to whole tiles. */
function centred(c: Vec2, tw: number, th: number, at: Pick<PixelMap, 'originM'>): TileRect {
  return {
    tx: Math.round((c.x - at.originM.x) / TILE_M - tw / 2),
    ty: Math.round((c.z - at.originM.z) / TILE_M - th / 2),
    tw,
    th,
  }
}

/** Module-local centre of the plan's rooms: the side walls are pushed toward. */
function interiorOf(plan: ModulePlan): Vec2 {
  if (!plan.rooms.length) return { x: 0, z: 0 }
  const xs = plan.rooms.flatMap((r) => [r.rect[0], r.rect[2]])
  const zs = plan.rooms.flatMap((r) => [r.rect[1], r.rect[3]])
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 }
}

/**
 * Which side of a wall's (−dz, dx) normal a thin wall on a tile boundary takes (+1 / −1): the
 * module interior; when the wall runs through the middle of the module, the side with fewer
 * pieces standing against it (a shelf on a partition keeps its row). Module-local, so mirrored
 * wings agree.
 */
export function wallPrefer(wall: PlanWall, plan: ModulePlan): 1 | -1 {
  const dx = wall.b[0] - wall.a[0]
  const dz = wall.b[1] - wall.a[1]
  const len = Math.hypot(dx, dz)
  if (len < EPS) return 1
  const nx = -dz / len
  const nz = dx / len
  const c = interiorOf(plan)
  const d = (c.x - wall.a[0]) * nx + (c.z - wall.a[1]) * nz
  if (Math.abs(d) > EPS) return d > 0 ? 1 : -1
  let score = 0
  for (const f of plan.furniture) {
    const t = ((f.x - wall.a[0]) * dx + (f.z - wall.a[1]) * dz) / len
    const off = (f.x - wall.a[0]) * nx + (f.z - wall.a[1]) * nz
    if (t >= 0 && t <= len && Math.abs(off) <= 2 * TILE_M) score += Math.sign(off)
  }
  return score > 0 ? -1 : 1
}

/**
 * The module-local point `t` metres along a wall where its body is (plan §1.3): offset by
 * side · thick / 2 along the (−dz, dx) normal. A thin wall (≤ 0.2 m, or one without `side`: older
 * manifests) whose line lies within 5 cm of a tile boundary goes onto the tile on the `prefer` side
 * (`wallPrefer`), so it is one tile thick and mirrored wings agree.
 */
export function wallPoint(wall: PlanWall, t: number, prefer: 1 | -1): Vec2 {
  const dx = wall.b[0] - wall.a[0]
  const dz = wall.b[1] - wall.a[1]
  const len = Math.hypot(dx, dz)
  const nx = -dz / len
  const nz = dx / len
  const off = wall.side ? (wall.side * (wall.thick ?? 0)) / 2 : 0
  const line = { x: wall.a[0] + (dx * t) / len, z: wall.a[1] + (dz * t) / len }
  const p = { x: line.x + nx * off, z: line.z + nz * off }
  if (wall.side && (wall.thick ?? 0) > THIN_WALL) return p
  // Axis-aligned walls only: the coordinate across the wall.
  const across: 'x' | 'z' | null =
    Math.abs(nx) > 1 - EPS ? 'x' : Math.abs(nz) > 1 - EPS ? 'z' : null
  if (!across) return p
  const v = line[across]
  const edge = Math.round(v / TILE_M) * TILE_M
  if (Math.abs(v - edge) > NEAR_BOUNDARY) return p
  const n = across === 'x' ? nx : nz
  return { ...p, [across]: edge + (prefer * n * TILE_M) / 2 }
}

/**
 * Pieces against a wall (plan §2d): wall-mounted kinds whose back edge is within 30 cm of the
 * nearest wall line sit on the tile next to the wall, on the piece's side. Any other piece that
 * overlaps a wall tile is trimmed back to its side (moved when it is one tile thick), so walls stay
 * one clean tile and nothing is drawn across them. True when the piece was trimmed.
 */
function snapToWall(
  rect: TileRect,
  p: ModulePlacement,
  f: PlanFurniture,
  plan: ModulePlan,
  at: Pick<PixelMap, 'originM'>,
): boolean {
  const c = Math.abs(Math.cos(f.yaw))
  const s = Math.abs(Math.sin(f.yaw))
  const hx = (f.w / 2) * c + (f.d / 2) * s
  const hz = (f.w / 2) * s + (f.d / 2) * c
  const near: { wall: PlanWall; t: number; gap: number }[] = []
  for (const wall of plan.walls) {
    const dx = wall.b[0] - wall.a[0]
    const dz = wall.b[1] - wall.a[1]
    const len = Math.hypot(dx, dz)
    if (len < EPS) continue
    const t = ((f.x - wall.a[0]) * dx + (f.z - wall.a[1]) * dz) / len
    if (t < 0 || t > len) continue
    const dist = Math.abs((f.x - wall.a[0]) * (-dz / len) + (f.z - wall.a[1]) * (dx / len))
    const half = Math.abs(dz / len) * hx + Math.abs(dx / len) * hz
    if (dist - half <= NEAR_WALL) near.push({ wall, t, gap: dist - half })
  }
  near.sort((x, y) => x.gap - y.gap)
  let trimmed = false
  near.forEach(({ wall, t, gap }, i) => {
    const wp = wallPoint(wall, t, wallPrefer(wall, plan))
    const wt = toTile(toWorld(wp, p), at)
    // A tile on the piece's side of the wall (decided in module-local space).
    const len = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1])
    const nx = -(wall.b[1] - wall.a[1]) / len
    const nz = (wall.b[0] - wall.a[0]) / len
    const sign = (f.x - wall.a[0]) * nx + (f.z - wall.a[1]) * nz >= 0 ? 1 : -1
    const side = toTile(
      toWorld({ x: wp.x + sign * nx * TILE_M, z: wp.z + sign * nz * TILE_M }, p),
      at,
    )
    const mount = i === 0 && gap <= WALL_GAP && WALL_MOUNTED.has(f.kind)
    const h = side.ty !== wt.ty
    if (!h && side.tx === wt.tx) return
    const k = h ? 'ty' : 'tx'
    const n = h ? 'th' : 'tw'
    const w = wt[k]
    const after = side[k] > w
    if (mount) {
      rect[k] = after ? w + 1 : w - rect[n]
      return
    }
    if (w < rect[k] || w >= rect[k] + rect[n]) return
    // Overlapping the wall: trim the piece back to its side (a thin piece moves instead).
    const keep = after ? rect[k] + rect[n] - (w + 1) : w - rect[k]
    if (keep >= 1) {
      rect[n] = keep
      if (after) rect[k] = w + 1
      trimmed = true
    } else rect[k] = after ? w + 1 : w - rect[n]
  })
  return trimmed
}

/** The innermost plan room holding a module-local point. */
function roomOf(plan: ModulePlan, x: number, z: number) {
  let best: ModulePlan['rooms'][number] | undefined
  let area = Infinity
  for (const r of plan.rooms) {
    const [x0, z0, x1, z1] = r.rect
    if (x < x0 - EPS || x > x1 + EPS || z < z0 - EPS || z > z1 + EPS) continue
    const a = (x1 - x0) * (z1 - z0)
    if (a < area) ((best = r), (area = a))
  }
  return best
}

/**
 * Shrinks `r` (in place) to lie inside `room` (a piece longer than its room stops at the wall);
 * false when they don't meet.
 */
function clampTo(r: TileRect, room: TileRect): boolean {
  const x0 = Math.max(r.tx, room.tx)
  const y0 = Math.max(r.ty, room.ty)
  const x1 = Math.min(r.tx + r.tw, room.tx + room.tw)
  const y1 = Math.min(r.ty + r.th, room.ty + room.th)
  if (x1 <= x0 || y1 <= y0) return false
  r.tx = x0
  r.ty = y0
  r.tw = x1 - x0
  r.th = y1 - y0
  return true
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
