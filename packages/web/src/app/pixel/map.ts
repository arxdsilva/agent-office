// The 2D world at GBA scale (plan "2D at GBA scale" §2): every placement's module-local floor plan,
// rotated by its yaw and translated, becomes pixel geometry at 16 px/m. Rooms, walls and furniture
// are px rects at their exact plan positions (never snapped to tiles); collision uses the same rects
// (`solids`, indexed in 32 px buckets). Floors stay 16 px tiles = 1 m cells.
// Pure and deterministic. Floor tile ids come from an injected `TileResolver` (atlas-backed).
import { hash32, parseAnchorId, toWorld } from '../building.ts'
import type { Manifest } from '../manifest.ts'
import type { BuildingLayout, ModulePlacement, ThemeId, Vec2 } from '../office-types.ts'
import { dir4, projectionFor } from './project.ts'
import {
  PX_PER_M,
  TILE_PX,
  WALL_PX,
  type MapObject,
  type MapWall,
  type ModulePlan,
  type PixelMap,
  type PixelRoom,
  type PlanByModule,
  type PlanFurniture,
  type PxRect,
  type SolidIndex,
  type SpriteFoot,
  type TilePos,
} from './types.ts'

/** Wall direction on the map: horizontal (east–west) or vertical (north–south). */
export type TileEdge = 'h' | 'v'

/**
 * What tile to draw. `floor`: kind = the plan room's floor material, else 'street' / 'default'.
 * `wall` / `overhead`: kept for renderers that draw wall art from tiles.
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

export type SizeClass = 'fixed' | 'strip' | 'area'
export interface SizeSpec {
  class: SizeClass
  /** Canonical metres [w, d] ('h' orientation). */
  m?: [number, number]
  /** Art base [w, h] px ('h' orientation). */
  base?: [number, number]
  /** Strips: px across the long axis, and the repeat length along it. */
  thickness?: number
  unit?: number
  /** Px drawn above the base. */
  overhang: number
  /** Has vertical art. */
  v?: boolean
}

/**
 * Canonical 2D sizes, a copy of `assets/pixel/src/sizes.json` `kinds` (the web package can't read
 * assets; `assets/pixel/map-invariants.test.ts` fails when the two drift).
 */
export const SIZES: Readonly<Record<string, SizeSpec>> = {
  desk: { class: 'fixed', m: [1.6, 0.8], base: [26, 13], overhang: 12 },
  chair: { class: 'fixed', m: [0.55, 0.55], base: [10, 10], overhang: 10 },
  'meeting-table': { class: 'fixed', m: [2.4, 1.1], base: [38, 18], overhang: 8, v: true },
  'reading-table': { class: 'fixed', m: [2, 1], base: [32, 16], overhang: 8 },
  booth: { class: 'fixed', m: [1.4, 1.4], base: [22, 22], overhang: 22 },
  station: { class: 'fixed', m: [1.68, 0.4], base: [27, 7], overhang: 18 },
  'core-rack': { class: 'fixed', m: [0.96, 0.96], base: [15, 15], overhang: 20 },
  board: { class: 'fixed', m: [0.98, 0.1], base: [16, 4], overhang: 18 },
  'notebook-rack': { class: 'fixed', m: [2.96, 0.66], base: [47, 11], overhang: 14 },
  sofa: { class: 'fixed', m: [2.75, 0.92], base: [44, 15], overhang: 8 },
  armchair: { class: 'fixed', m: [0.82, 0.82], base: [13, 13], overhang: 8 },
  beanbag: { class: 'fixed', m: [0.84, 0.84], base: [13, 13], overhang: 4 },
  fridge: { class: 'fixed', m: [0.7, 0.65], base: [11, 10], overhang: 20 },
  'coffee-machine': { class: 'fixed', m: [0.5, 0.38], base: [8, 6], overhang: 8 },
  island: { class: 'fixed', m: [2.64, 1.05], base: [42, 17], overhang: 10 },
  'reception-desk': { class: 'fixed', m: [4.36, 1.64], base: [70, 26], overhang: 14 },
  pingpong: { class: 'fixed', m: [2.74, 1.52], base: [44, 24], overhang: 6, v: true },
  arcade: { class: 'fixed', m: [0.8, 0.7], base: [13, 11], overhang: 18 },
  'cafe-table': { class: 'fixed', m: [1, 1], base: [16, 16], overhang: 8 },
  tv: { class: 'fixed', m: [1.6, 0.1], base: [26, 4], overhang: 14 },
  sign: { class: 'strip', thickness: 4, unit: 26, overhang: 8 },
  plant: { class: 'fixed', m: [0.5, 0.5], base: [8, 8], overhang: 14 },
  bench: { class: 'strip', thickness: 7, unit: 24, overhang: 6, v: true },
  planter: { class: 'strip', thickness: 8, unit: 16, overhang: 8 },
  'kitchen-counter': { class: 'strip', thickness: 10, unit: 32, overhang: 12 },
  'cafe-bar': { class: 'strip', thickness: 11, unit: 32, overhang: 12 },
  bookshelf: { class: 'strip', thickness: 7, unit: 32, overhang: 24 },
  'led-wall': { class: 'strip', thickness: 4, unit: 48, overhang: 26 },
  rug: { class: 'area', overhang: 0 },
  elevator: { class: 'area', overhang: 0 },
  'elevator-door': { class: 'fixed', m: [2, 0.25], base: [32, 4], overhang: 28 },
  door: { class: 'fixed', m: [1, 0.25], base: [16, 4], overhang: 26 },
  window: { class: 'fixed', m: [2, 0.25], base: [32, 4], overhang: 12 },
  'booth-lamp': { class: 'fixed', m: [1.4, 1.4], base: [22, 22], overhang: 22 },
  'stats-board': { class: 'fixed', m: [4, 0.25], base: [64, 4], overhang: 26 },
}

/** Pieces hung on or pushed against a wall: within `WALL_GAP_M` their back edge meets the wall. */
export const WALL_MOUNTED = new Set<string>([
  'kitchen-counter',
  'bookshelf',
  'board',
  'tv',
  'led-wall',
  'sign',
  'notebook-rack',
])
/** Furniture the player can walk over (chairs stay walkable: agents sit on them, y-sorted). */
const WALKABLE = new Set<string>(['rug', 'sign', 'chair'])
/** `ref`s that point at a capability surface slot. */
const SLOT_REF = /^(station|book|board|notebook):\d+$/
/** A wall-mounted piece this close to a wall (m) sits against it. */
export const WALL_GAP_M = 0.3
/** Collinear walls this close (m) are one wall (glass next to solid). */
const MERGE_M = 0.1
/** Gaps narrower than this (m) between wall runs are joints, not doors. */
const MIN_DOOR_M = 0.5
/** Planters and benches at least this deep (m) are areas (garden pools, bleachers). */
const AREA_DEPTH_M = 2
/** Share of a piece's footprint on a larger piece that makes it stacked (non-solid). */
const STACKED = 0.5
/** Bucket size of `PixelMap.solidIndex`. */
export const SOLID_CELL_PX = 32
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

/** The size class of a piece (planters and benches ≥ 2 m deep become areas). */
export function sizeClassOf(kind: string, shortSideM: number): SizeClass {
  if ((kind === 'planter' || kind === 'bench') && shortSideM >= AREA_DEPTH_M - EPS) return 'area'
  return SIZES[kind]?.class ?? 'fixed'
}

// ── Solid index ──────────────────────────────────────────────────────────────────────────────
/** Buckets `solids` into a `SOLID_CELL_PX` grid covering widthPx × heightPx. */
export function indexSolids(
  solids: readonly PxRect[],
  widthPx: number,
  heightPx: number,
): SolidIndex {
  const cellPx = SOLID_CELL_PX
  const cols = Math.max(1, Math.ceil(widthPx / cellPx))
  const rows = Math.max(1, Math.ceil(heightPx / cellPx))
  const buckets: number[][] = Array.from({ length: cols * rows }, () => [])
  solids.forEach((r, i) =>
    forBuckets(cols, rows, cellPx, r.x, r.y, r.x + r.w, r.y + r.h, (b) => buckets[b]!.push(i)),
  )
  return { cellPx, cols, rows, buckets }
}

function forBuckets(
  cols: number,
  rows: number,
  cell: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  fn: (bucket: number) => void,
) {
  const c0 = Math.max(0, Math.floor(x0 / cell))
  const r0 = Math.max(0, Math.floor(y0 / cell))
  const c1 = Math.min(cols - 1, Math.floor((x1 - EPS) / cell))
  const r1 = Math.min(rows - 1, Math.floor((y1 - EPS) / cell))
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) fn(r * cols + c)
}

/** Indices into `solids` of the rects in the buckets `box` touches (ascending, unique). */
export function solidsNear(map: Pick<PixelMap, 'solids' | 'solidIndex'>, box: PxRect): number[] {
  const { cellPx, cols, rows, buckets } = map.solidIndex
  const seen = new Set<number>()
  forBuckets(cols, rows, cellPx, box.x, box.y, box.x + box.w, box.y + box.h, (b) => {
    for (const i of buckets[b]!) seen.add(i)
  })
  return [...seen].sort((a, b) => a - b)
}

// ── Build ────────────────────────────────────────────────────────────────────────────────────
const signature = (p: ModulePlacement) =>
  `${p.id}@${p.position.x},${p.position.z},${p.yaw}#${p.theme ?? ''}${p.dimmed ? '~' : ''}`

interface Origin {
  originM: Vec2
}
const toPx = (v: number, o: number) => (v - o) * PX_PER_M

/** The px rect (edges rounded) of a world AABB. */
function boxOf(minX: number, minZ: number, maxX: number, maxZ: number, at: Origin): PxRect {
  const x = Math.round(toPx(minX, at.originM.x))
  const y = Math.round(toPx(minZ, at.originM.z))
  return {
    x,
    y,
    w: Math.max(1, Math.round(toPx(maxX, at.originM.x)) - x),
    h: Math.max(1, Math.round(toPx(maxZ, at.originM.z)) - y),
  }
}
/** A w × h px rect centred on a world point, rounded to whole px. */
function centred(c: Vec2, w: number, h: number, at: Origin): PxRect {
  const W = Math.max(1, Math.round(w))
  const H = Math.max(1, Math.round(h))
  return {
    x: Math.round(toPx(c.x, at.originM.x) - W / 2),
    y: Math.round(toPx(c.z, at.originM.z) - H / 2),
    w: W,
    h: H,
  }
}
/** World AABB of a module-local rect. */
function worldRect(p: ModulePlacement, x0: number, z0: number, x1: number, z1: number) {
  const a = toWorld({ x: x0, z: z0 }, p)
  const b = toWorld({ x: x1, z: z1 }, p)
  return [Math.min(a.x, b.x), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.z, b.z)] as const
}
const overlap = (a0: number, a1: number, b0: number, b1: number) =>
  Math.min(a1, b1) - Math.max(a0, b0)

/**
 * Builds the world; returns `prev` itself when neither the layout nor the plan changed.
 * `feet` sizes objects from their art (the atlas base in px); without it, plan footprints.
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
  const at: Origin = { originM: proj.originM }
  const placed = layout.placements
    .map((p) => ({ p, plan: plans[p.kind] }))
    .filter((x): x is { p: ModulePlacement; plan: ModulePlan } => !!x.plan)

  const rooms: PixelRoom[] = []
  const floorOf: number[] = []
  for (const { p, plan } of placed)
    for (const room of plan.rooms) {
      const box = boxOf(...worldRect(p, ...room.rect), at)
      const tx = Math.floor(box.x / TILE_PX)
      const ty = Math.floor(box.y / TILE_PX)
      const r: PixelRoom = {
        id: `${p.id}/${room.id}`,
        name: room.name,
        box,
        rect: {
          tx,
          ty,
          tw: Math.ceil((box.x + box.w) / TILE_PX) - tx,
          th: Math.ceil((box.y + box.h) / TILE_PX) - ty,
        },
        placement: p.id,
      }
      if (p.theme) r.theme = p.theme
      if (p.provider) r.provider = p.provider
      rooms.push(r)
      floorOf.push(
        tiles.tile({
          layer: 'floor',
          kind: room.floor ?? (p.kind === 'street' ? 'street' : 'default'),
          ...(p.theme && { theme: p.theme }),
        }),
      )
    }

  const objects: MapObject[] = []
  const walls: MapWall[] = []
  for (const { p, plan } of placed) buildWalls(p, plan, at, walls, objects)
  for (const w of walls) if (w.box.w >= w.box.h) w.face = roomBelow(w.box, rooms) ? 's' : null

  for (const { p, plan } of placed) {
    const pieces = plan.furniture.map((f, i) =>
      furnitureObject(p, f, i, plan, at, feet ?? null, walls),
    )
    unstack(
      pieces,
      plan.furniture.map((f) => footprintOf(p, f)),
    )
    objects.push(...pieces)
  }
  for (const a of layout.anchors.values()) {
    const kind = /^spot:booth:\d+$/.test(a.local)
      ? 'booth-lamp'
      : /^spot:elevator:\d+$/.test(a.local)
        ? 'elevator-door'
        : undefined
    if (!kind) continue
    // Drawn over the booth / the elevator car: the art's base centred on the spot.
    const f = feet?.foot(kind, 'h')
    const base = SIZES[kind]!.base!
    const box = centred(a.pos, f?.w ?? base[0], f?.h ?? base[1], at)
    objects.push({
      id: `${a.placement}/${kind}:${a.local.slice(a.local.lastIndexOf(':') + 1)}`,
      kind,
      box,
      sortY: box.y + box.h,
      solid: false,
      facing: dir4(a.heading),
      orientation: 'h',
      fill: 'sprite',
    })
  }

  const widthPx = proj.widthTiles * TILE_PX
  const heightPx = proj.heightTiles * TILE_PX
  const solids = [...walls.map((w) => w.box), ...objects.filter((o) => o.solid).map((o) => o.box)]
  const map: PixelMap = {
    widthTiles: proj.widthTiles,
    heightTiles: proj.heightTiles,
    widthPx,
    heightPx,
    originM: proj.originM,
    layers: { floor: floorLayer(proj.widthTiles, proj.heightTiles, rooms, floorOf) },
    objects,
    walls,
    solids,
    solidIndex: indexSolids(solids, widthPx, heightPx),
    rooms,
    key,
    dirty: dirtyList(layout, proj, prev),
  }
  return remember(map, layout)
}

/** Floor tile per 1 m cell: the smallest room holding the cell centre, else the most overlap. */
function floorLayer(w: number, h: number, rooms: PixelRoom[], floorOf: number[]): Uint16Array {
  const floor = new Uint16Array(w * h)
  const best = new Float64Array(w * h).fill(Infinity)
  const part = new Float64Array(w * h)
  rooms.forEach((r, ri) => {
    const area = r.box.w * r.box.h
    for (let ty = Math.max(0, r.rect.ty); ty < Math.min(h, r.rect.ty + r.rect.th); ty++)
      for (let tx = Math.max(0, r.rect.tx); tx < Math.min(w, r.rect.tx + r.rect.tw); tx++) {
        const i = ty * w + tx
        const cx = (tx + 0.5) * TILE_PX
        const cy = (ty + 0.5) * TILE_PX
        const inside =
          cx >= r.box.x && cx < r.box.x + r.box.w && cy >= r.box.y && cy < r.box.y + r.box.h
        if (inside) {
          if (area < best[i]!) ((best[i] = area), (floor[i] = floorOf[ri]!))
          continue
        }
        if (best[i]! < Infinity) continue
        const o =
          overlap(tx * TILE_PX, (tx + 1) * TILE_PX, r.box.x, r.box.x + r.box.w) *
          overlap(ty * TILE_PX, (ty + 1) * TILE_PX, r.box.y, r.box.y + r.box.h)
        if (o > part[i]!) ((part[i] = o), (floor[i] = floorOf[ri]!))
      }
  })
  return floor
}

/** True when a room lies directly below a horizontal wall box (its 3/4 face is seen from there). */
function roomBelow(b: PxRect, rooms: readonly PixelRoom[]): boolean {
  const y = b.y + b.h + 1
  return rooms.some(
    (r) =>
      overlap(b.x, b.x + b.w, r.box.x, r.box.x + r.box.w) >= 1 &&
      y >= r.box.y &&
      y < r.box.y + r.box.h,
  )
}

// ── Walls ────────────────────────────────────────────────────────────────────────────────────
type Span = [number, number]
interface Seg {
  axis: 'h' | 'v'
  /** World coordinate across the wall of its body centre (z for 'h', x for 'v'). */
  across: number
  span: Span
  openings: { span: Span; wi: number; oi: number }[]
  /** Px thickness. */
  thick: number
  kind: 'solid' | 'glass'
}

/** Union of spans, sorted and merged. */
function union(spans: Span[]): Span[] {
  const s = [...spans].sort((a, b) => a[0] - b[0])
  const out: Span[] = []
  for (const x of s) {
    const last = out.at(-1)
    if (last && x[0] <= last[1] + EPS) last[1] = Math.max(last[1], x[1])
    else out.push([x[0], x[1]])
  }
  return out
}
/** `a` minus every span of `cut`. */
function subtract(a: Span[], cut: Span[]): Span[] {
  let out = a
  for (const [c0, c1] of cut)
    out = out.flatMap(([s0, s1]): Span[] => {
      if (c1 <= s0 + EPS || c0 >= s1 - EPS) return [[s0, s1]]
      const keep: Span[] = []
      if (c0 > s0 + EPS) keep.push([s0, c0])
      if (c1 < s1 - EPS) keep.push([c1, s1])
      return keep
    })
  return out
}

/** Module-local plan walls → world segments on their 3D body. */
function segmentsOf(p: ModulePlacement, plan: ModulePlan): Seg[] {
  const out: Seg[] = []
  plan.walls.forEach((wall, wi) => {
    const dx = wall.b[0] - wall.a[0]
    const dz = wall.b[1] - wall.a[1]
    const len = Math.hypot(dx, dz)
    if (len < EPS) return
    // The body: offset by side · thick / 2 along the (−dz, dx) normal (module-local).
    const off = wall.side ? (wall.side * (wall.thick ?? 0)) / 2 : 0
    const nx = (-dz / len) * off
    const nz = (dx / len) * off
    const at = (t: number) =>
      toWorld({ x: wall.a[0] + (dx * t) / len + nx, z: wall.a[1] + (dz * t) / len + nz }, p)
    const wa = at(0)
    const wb = at(len)
    const axis = Math.abs(wb.x - wa.x) >= Math.abs(wb.z - wa.z) ? 'h' : 'v'
    const along = (q: Vec2) => (axis === 'h' ? q.x : q.z)
    const span = (t0: number, t1: number): Span => {
      const u = along(at(t0))
      const v = along(at(t1))
      return [Math.min(u, v), Math.max(u, v)]
    }
    out.push({
      axis,
      across: axis === 'h' ? (wa.z + wb.z) / 2 : (wa.x + wb.x) / 2,
      span: span(0, len),
      openings: (wall.openings ?? []).map(([t0, t1], oi) => ({ span: span(t0, t1), wi, oi })),
      thick: Math.max(WALL_PX, Math.round((wall.thick ?? 0) * PX_PER_M)),
      kind: wall.kind === 'solid' ? 'solid' : 'glass',
    })
  })
  return out
}

/**
 * A placement's walls: collinear segments (within 0.1 m) merge into one line (solid wins where both
 * are, glass fills the rest), split at openings into `MapWall` runs. Openings left open are doors.
 */
function buildWalls(
  p: ModulePlacement,
  plan: ModulePlan,
  at: Origin,
  walls: MapWall[],
  objects: MapObject[],
) {
  const segs = segmentsOf(p, plan)
  const groups: Seg[][] = []
  for (const s of segs) {
    const g = groups.find(
      (x) => x[0]!.axis === s.axis && Math.abs(x[0]!.across - s.across) <= MERGE_M + EPS,
    )
    if (g) g.push(s)
    else groups.push([s])
  }
  const theme = p.theme ? { theme: p.theme } : {}
  for (const g of groups) {
    const axis = g[0]!.axis
    const line = (g.find((s) => s.kind === 'solid') ?? g[0]!).across
    const open = (s: Seg) => subtract([s.span], union(s.openings.map((o) => o.span)))
    const solid = union(g.filter((s) => s.kind === 'solid').flatMap(open))
    const glass = subtract(union(g.filter((s) => s.kind === 'glass').flatMap(open)), solid)
    const thickOf = (kind: Seg['kind'], [a, b]: Span) =>
      Math.max(
        ...g
          .filter((s) => s.kind === kind && overlap(s.span[0], s.span[1], a, b) > 0)
          .map((s) => s.thick),
        WALL_PX,
      )
    const runBox = ([a, b]: Span, thick: number): PxRect => {
      const c = toPx(line, axis === 'h' ? at.originM.z : at.originM.x)
      const o = axis === 'h' ? at.originM.x : at.originM.z
      const s0 = Math.round(toPx(a, o))
      const len = Math.max(1, Math.round(toPx(b, o)) - s0)
      const c0 = Math.round(c - thick / 2)
      return axis === 'h' ? { x: s0, y: c0, w: len, h: thick } : { x: c0, y: s0, w: thick, h: len }
    }
    const runs: { span: Span; kind: Seg['kind'] }[] = [
      ...solid.map((span) => ({ span, kind: 'solid' as const })),
      ...glass.map((span) => ({ span, kind: 'glass' as const })),
    ].sort((x, y) => x.span[0] - y.span[0])
    for (const r of runs)
      walls.push({
        box: runBox(r.span, thickOf(r.kind, r.span)),
        kind: r.kind,
        face: null,
        ...theme,
      })
    // Doors: what is left of each opening once every run on the line is drawn.
    const covered = union(runs.map((r) => r.span))
    for (const s of g)
      for (const o of s.openings) {
        const gaps = subtract([o.span], covered).filter(([a, b]) => b - a >= MIN_DOOR_M - EPS)
        gaps.forEach((gap, k) => {
          const box = runBox(gap, s.thick)
          objects.push({
            id: `${p.id}/door:${o.wi}:${o.oi}${k ? `.${k}` : ''}`,
            kind: 'door',
            box,
            sortY: box.y + box.h,
            solid: false,
            facing: axis === 'h' ? 's' : 'e',
            orientation: axis,
            fill: 'repeat',
            ...theme,
          })
        })
      }
  }
}

// ── Furniture ────────────────────────────────────────────────────────────────────────────────
function furnitureObject(
  p: ModulePlacement,
  f: PlanFurniture,
  i: number,
  plan: ModulePlan,
  at: Origin,
  feet: SpriteFoot | null,
  walls: readonly MapWall[],
): MapObject {
  const yaw = p.yaw + f.yaw
  const c = Math.abs(Math.cos(yaw))
  const s = Math.abs(Math.sin(yaw))
  const hx = (f.w / 2) * c + (f.d / 2) * s
  const hz = (f.w / 2) * s + (f.d / 2) * c
  const orientation: 'h' | 'v' = hz > hx + EPS ? 'v' : 'h'
  const centre = toWorld({ x: f.x, z: f.z }, p)
  const plan2 = boxOf(centre.x - hx, centre.z - hz, centre.x + hx, centre.z + hz, at)
  const cls = sizeClassOf(f.kind, 2 * Math.min(hx, hz))
  let box: PxRect
  if (cls === 'area') box = plan2
  else if (cls === 'strip') {
    const art = feet?.foot(f.kind, orientation)
    const thick = art
      ? orientation === 'v'
        ? art.w
        : art.h
      : (SIZES[f.kind]?.thickness ?? Math.round(2 * Math.min(hx, hz) * PX_PER_M))
    box =
      orientation === 'v'
        ? { ...centred(centre, thick, 1, at), y: plan2.y, h: plan2.h }
        : { ...centred(centre, 1, thick, at), x: plan2.x, w: plan2.w }
  } else {
    const art = feet?.foot(f.kind, orientation)
    box = art ? centred(centre, art.w, art.h, at) : plan2
  }
  const mounted = WALL_MOUNTED.has(f.kind) && mountOnWall(box, plan2, walls)
  const o: MapObject = {
    id: `${p.id}/${f.ref ?? `${f.kind}:${i}`}`,
    kind: f.kind,
    box,
    sortY: box.y + box.h,
    solid: !WALKABLE.has(f.kind),
    facing: dir4(yaw),
    orientation,
    fill: cls === 'area' ? 'area' : cls === 'strip' ? 'repeat' : 'sprite',
  }
  if (mounted) o.wallMounted = true
  // The room holding the piece (a sign hung outside a wall belongs to no room).
  const planRoom = roomOf(plan, f.x, f.z)
  if (planRoom) {
    const rb = boxOf(...worldRect(p, ...planRoom.rect), at)
    if (
      overlap(box.x, box.x + box.w, rb.x, rb.x + rb.w) > 0 &&
      overlap(box.y, box.y + box.h, rb.y, rb.y + rb.h) > 0
    )
      o.room = `${p.id}/${planRoom.id}`
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

/** World AABB [minX, minZ, maxX, maxZ] (m) of a plan piece. */
function footprintOf(p: ModulePlacement, f: PlanFurniture): [number, number, number, number] {
  const yaw = p.yaw + f.yaw
  const c = Math.abs(Math.cos(yaw))
  const s = Math.abs(Math.sin(yaw))
  const hx = (f.w / 2) * c + (f.d / 2) * s
  const hz = (f.w / 2) * s + (f.d / 2) * c
  const w = toWorld({ x: f.x, z: f.z }, p)
  return [w.x - hx, w.z - hz, w.x + hx, w.z + hz]
}

/**
 * Pieces standing on another (coffee machines on a counter, an LED wall over the bar): when at least
 * `STACKED` of a solid piece's plan footprint lies on a larger solid piece, it stops blocking (the
 * piece below does), so solid bases never overlap.
 */
function unstack(objects: MapObject[], plan: [number, number, number, number][]) {
  const area = (r: (typeof plan)[number]) => (r[2] - r[0]) * (r[3] - r[1])
  const solid = objects.map((o) => o.solid)
  objects.forEach((o, i) => {
    if (!solid[i]) return
    const a = plan[i]!
    const on = plan.some(
      (b, j) =>
        j !== i &&
        solid[j] &&
        area(b) > area(a) &&
        Math.max(0, overlap(a[0], a[2], b[0], b[2])) *
          Math.max(0, overlap(a[1], a[3], b[1], b[3])) >=
          STACKED * area(a),
    )
    if (on) o.solid = false
  })
}

/**
 * Wall-mounted pieces: when the plan footprint's edge is within `WALL_GAP_M` of a wall run alongside
 * it, the piece's back edge moves onto the wall's inner face (in place). True when mounted.
 */
function mountOnWall(box: PxRect, footprint: PxRect, walls: readonly MapWall[]): boolean {
  const gapPx = WALL_GAP_M * PX_PER_M
  let best: { gap: number; apply: () => void } | undefined
  const cx = footprint.x + footprint.w / 2
  const cy = footprint.y + footprint.h / 2
  for (const w of walls) {
    const b = w.box
    const horizontal = b.w >= b.h
    if (horizontal) {
      if (overlap(footprint.x, footprint.x + footprint.w, b.x, b.x + b.w) <= 0) continue
      const north = b.y + b.h / 2 < cy
      const gap = north ? footprint.y - (b.y + b.h) : b.y - (footprint.y + footprint.h)
      if (gap > gapPx || gap < -footprint.h) continue
      if (!best || gap < best.gap)
        best = { gap, apply: () => (box.y = north ? b.y + b.h : b.y - box.h) }
    } else {
      if (overlap(footprint.y, footprint.y + footprint.h, b.y, b.y + b.h) <= 0) continue
      const west = b.x + b.w / 2 < cx
      const gap = west ? footprint.x - (b.x + b.w) : b.x - (footprint.x + footprint.w)
      if (gap > gapPx || gap < -footprint.w) continue
      if (!best || gap < best.gap)
        best = { gap, apply: () => (box.x = west ? b.x + b.w : b.x - box.w) }
    }
  }
  best?.apply()
  return !!best
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

// ── Chunk invalidation ───────────────────────────────────────────────────────────────────────
/** Placements whose geometry changed: all when the grid moved, else added, moved or removed ones. */
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

function remember(map: PixelMap, layout: BuildingLayout) {
  prevSignatures.set(map, new Map(layout.placements.map((p) => [p.id, signature(p)])))
  return map
}
