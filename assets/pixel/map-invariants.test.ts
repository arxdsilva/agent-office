// 2D map invariants on the REAL manifest and atlas (plan §2, §2d): what's drawn is exactly what blocks.
// INV-1 no invisible barriers · INV-2 no walk-through drawings · INV-3 vertical art for vertical pieces ·
// INV-4 agents' routes are passable for the player (within half a tile of the route) · INV-5 left and right wings collide alike ·
// INV-6 every desk has the same size · INV-7 objects stay inside their rooms, wall-mounted art never
// crosses a wall. Built with the real planBuilding, buildPixelMap and atlas-backed SpriteFoot.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  objectArt,
  spriteFootOf,
  type ArtAtlas,
} from '../../packages/web/src/adapters/pixel/object-art.ts'
import { planBuilding, toWorld } from '../../packages/web/src/app/building.ts'
import { parseManifest } from '../../packages/web/src/app/manifest.ts'
import type { BuildingLayout, ModulePlacement } from '../../packages/web/src/app/office-types.ts'
import * as mapModule from '../../packages/web/src/app/pixel/map.ts'
import { buildPixelMap, plansOf, type TileQuery } from '../../packages/web/src/app/pixel/map.ts'
import { toTile } from '../../packages/web/src/app/pixel/project.ts'
import type {
  MapObject,
  PixelMap,
  PlanFurniture,
  TileRect,
} from '../../packages/web/src/app/pixel/types.ts'
import { blocked } from '../../packages/web/src/app/pixel/walk.ts'

const PUBLIC = join(import.meta.dirname, '../../packages/web/public/assets')
const manifest = parseManifest(JSON.parse(readFileSync(join(PUBLIC, 'manifest.json'), 'utf8')))
const raw = JSON.parse(readFileSync(join(PUBLIC, 'pixel/atlas.json'), 'utf8')) as ArtAtlas & { frames?: Record<string, { ay?: number }> }
const plans = plansOf(manifest)
const feet = spriteFootOf(raw)

/** Stable ids per tile query (any resolver works: the invariants read solid/walls, not art). */
function resolver() {
  const ids = new Map<string, number>()
  return {
    tile(q: TileQuery) {
      const k = `${q.layer}:${q.kind}:${q.theme ?? ''}:${q.edge ?? ''}`
      if (!ids.has(k)) ids.set(k, ids.size + 1)
      return ids.get(k)!
    },
  }
}

function build(providers: string[]): { layout: BuildingLayout; map: PixelMap } {
  const layout = planBuilding(
    providers.map((provider) => ({ provider, agents: 4 })),
    manifest,
    undefined,
    0,
  )
  // The 5th argument is the injected SpriteFoot (plan §1.1).
  const map = (buildPixelMap as (...a: unknown[]) => PixelMap)(
    layout,
    plans,
    resolver(),
    undefined,
    feet,
  )
  return { layout, map }
}

const THREE = ['claude-code', 'langgraph', 'openai-agents']
const SIX = [...THREE, 'crewai', 'autogen', 'llamaindex']
const WALL_MOUNTED = new Set([
  'kitchen-counter',
  'bookshelf',
  'board',
  'tv',
  'led-wall',
  'sign',
  'notebook-rack',
])
/** INV-4: lateral slack (m) for tile quantization, at most half a tile. */
const LATERAL_STEPS = [0.05, 0.1, 0.15, 0.2, 0.25]
const NAMED: Record<string, string> = { 'booth-lamp': 'off', 'elevator-door': 'closed' }

const idx = (m: PixelMap, tx: number, ty: number) => ty * m.widthTiles + tx
const inMap = (m: PixelMap, tx: number, ty: number) =>
  tx >= 0 && ty >= 0 && tx < m.widthTiles && ty < m.heightTiles
const isWall = (m: PixelMap, i: number) => m.layers.walls[i]! > 0 && m.solid[i] === 1
const tilesOf = (r: TileRect) => {
  const out: [number, number][] = []
  for (let ty = r.ty; ty < r.ty + r.th; ty++)
    for (let tx = r.tx; tx < r.tx + r.tw; tx++) out.push([tx, ty])
  return out
}
const inside = (a: TileRect, b: TileRect) =>
  a.tx >= b.tx && a.ty >= b.ty && a.tx + a.tw <= b.tx + b.tw && a.ty + a.th <= b.ty + b.th
const fmt = (r: TileRect) => `${r.tx},${r.ty} ${r.tw}×${r.th}`

/** The art the renderer draws for an object (null: the procedural fallback fills `rect`). */
const artOf = (o: MapObject) => objectArt(raw, o.kind, o.facing, o.orientation, NAMED[o.kind])

/** The tiles an object's drawing covers on the floor (its footprint, without the ¾ overhang). */
function drawnFoot(o: MapObject): TileRect {
  if (o.fill === 'repeat' || o.fill === 'area') return o.rect
  const art = artOf(o)
  return art ? { tx: o.rect.tx, ty: o.rect.ty, tw: art.foot[0], th: art.foot[1] } : o.rect
}

/** The tiles a drawing reaches, ¾ overhang included (the renderer clips it to `drawBounds`). */
function drawnReach(o: MapObject, theme?: string): TileRect {
  const foot = drawnFoot(o)
  const db = (mapModule as { drawBounds?: (o: MapObject) => TileRect }).drawBounds
  if (db) {
    const b = db(o)
    const ty = Math.max(b.ty, foot.ty - 1)
    return { tx: foot.tx, ty, tw: foot.tw, th: foot.ty + foot.th - ty }
  }
  const art = artOf(o)
  const f = art && (raw.frames?.[`${art.frame}@${theme}`] ?? raw.frames?.[art.frame])
  const up = f?.ay ? Math.ceil(f.ay / 16) : 0
  return { ...foot, ty: foot.ty - up, th: foot.th + up }
}

/** Map object id → its plan furniture and placement. */
function furnitureIndex(layout: BuildingLayout) {
  const out = new Map<string, { p: ModulePlacement; f: PlanFurniture }>()
  for (const p of layout.placements)
    plans[p.kind]?.furniture.forEach((f, i) =>
      out.set(`${p.id}/${f.ref ?? `${f.kind}:${i}`}`, { p, f }),
    )
  return out
}

interface Report {
  count: number
  examples: string[]
}
const report = (): Report => ({ count: 0, examples: [] })
const add = (r: Report, s: string) => {
  r.count++
  if (r.examples.length < 8) r.examples.push(s)
}

function inv1(m: PixelMap): Report {
  const covered = new Uint8Array(m.solid.length)
  for (const o of m.objects)
    if (o.solid)
      for (const [tx, ty] of tilesOf(drawnFoot(o))) if (inMap(m, tx, ty)) covered[idx(m, tx, ty)] = 1
  const r = report()
  for (let i = 0; i < m.solid.length; i++)
    if (m.solid[i] && !covered[i] && !isWall(m, i))
      add(r, `tile ${i % m.widthTiles},${Math.floor(i / m.widthTiles)}`)
  return r
}

function inv2(m: PixelMap): Report {
  const r = report()
  const seen = new Set<number>()
  for (const o of m.objects)
    if (o.solid)
      for (const [tx, ty] of tilesOf(drawnFoot(o))) {
        const i = idx(m, tx, ty)
        if (inMap(m, tx, ty) && !m.solid[i] && !seen.has(i)) {
          seen.add(i)
          add(r, `${o.id} at ${tx},${ty}`)
        }
      }
  return r
}

function inv3(layout: BuildingLayout, m: PixelMap): Report {
  const r = report()
  const index = furnitureIndex(layout)
  for (const o of m.objects) {
    if (!['meeting-table', 'pingpong', 'bench', 'planter'].includes(o.kind)) continue
    const src = index.get(o.id)
    if (!src) continue
    const yaw = src.p.yaw + src.f.yaw
    const c = Math.abs(Math.cos(yaw))
    const s = Math.abs(Math.sin(yaw))
    const hx = src.f.w * c + src.f.d * s
    const hz = src.f.w * s + src.f.d * c
    if (hz <= hx + 1e-6) continue
    const ok =
      o.orientation === 'v' ||
      o.fill === 'area' ||
      (o.fill === 'repeat' && o.rect.th > o.rect.tw)
    if (!ok) add(r, `${o.id} ${fmt(o.rect)} orientation=${o.orientation} fill=${o.fill}`)
  }
  return r
}

function inv4(layout: BuildingLayout, m: PixelMap): Report {
  const r = report()
  const seats = [...layout.anchors.values()]
    .filter((a) => a.local.startsWith('seat:') || a.local.startsWith('spot:'))
    .map((a) => a.pos)
  const nearSeat = (p: { x: number; z: number }) =>
    seats.some((s) => Math.hypot(s.x - p.x, s.z - p.z) <= 0.35)
  const done = new Set<string>()
  for (const [a, list] of layout.nav.adj)
    for (const b of list) {
      const k = a < b ? `${a}|${b}` : `${b}|${a}`
      if (done.has(k)) continue
      done.add(k)
      const pa = layout.nav.nodes.get(a)?.pos
      const pb = layout.nav.nodes.get(b)?.pos
      if (!pa || !pb) continue
      const len = Math.hypot(pb.x - pa.x, pb.z - pa.z)
      const n = Math.max(1, Math.ceil(len / 0.25))
      // Tiles quantize walls and furniture by up to half a tile: the player may follow the route
      // within half a tile of it (as the doorway assist does).
      const side = len > 1e-9 ? { x: -(pb.z - pa.z) / len, z: (pb.x - pa.x) / len } : { x: 0, z: 0 }
      const along = { x: side.z, z: -side.x }
      const free = (p: { x: number; z: number }) =>
        !blocked(m, p, 0.22) ||
        LATERAL_STEPS.some((d) =>
          [side, along].some((u) =>
            [d, -d].some((k) => !blocked(m, { x: p.x + u.x * k, z: p.z + u.z * k }, 0.22)),
          ),
        )
      for (let i = 0; i <= n; i++) {
        const p = { x: pa.x + ((pb.x - pa.x) * i) / n, z: pa.z + ((pb.z - pa.z) * i) / n }
        if (nearSeat(p) || free(p)) continue
        add(r, `${k} at ${p.x.toFixed(2)},${p.z.toFixed(2)}`)
        break
      }
    }
  return r
}

/** Module-local solid pattern of a wing (tile centres, one tile of margin around the module). */
function wingPattern(p: ModulePlacement, m: PixelMap): string {
  const plan = plans.wing!
  const xs = plan.rooms.flatMap((q) => [q.rect[0], q.rect[2]])
  const zs = plan.rooms.flatMap((q) => [q.rect[1], q.rect[3]])
  let out = ''
  for (let z = Math.min(...zs) - 0.25; z <= Math.max(...zs) + 0.25; z += 0.5)
    for (let x = Math.min(...xs) - 0.25; x <= Math.max(...xs) + 0.25; x += 0.5) {
      const t = toTile(toWorld({ x, z }, p), m)
      out += inMap(m, t.tx, t.ty) && m.solid[idx(m, t.tx, t.ty)] ? '#' : '.'
    }
  return out
}

function inv5(layout: BuildingLayout, m: PixelMap): Report {
  const r = report()
  const wings = layout.placements.filter((p) => p.kind === 'wing')
  const right = wings.find((p) => p.side === 'R')
  if (!right) return r
  const base = wingPattern(right, m)
  for (const w of wings.filter((p) => p.side === 'L')) {
    const other = wingPattern(w, m)
    let diff = 0
    for (let i = 0; i < base.length; i++) if (base[i] !== other[i]) diff++
    if (diff) add(r, `${w.id} vs ${right.id}: ${diff} tiles differ`)
  }
  return r
}

function inv6(m: PixelMap): Report {
  const r = report()
  const desks = m.objects.filter((o) => o.kind === 'desk')
  const size = (o: MapObject) =>
    `${Math.max(o.rect.tw, o.rect.th)}×${Math.min(o.rect.tw, o.rect.th)}`
  const counts = new Map<string, number>()
  for (const d of desks) counts.set(size(d), (counts.get(size(d)) ?? 0) + 1)
  const common = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
  for (const d of desks) if (size(d) !== common) add(r, `${d.id} ${size(d)} (most are ${common})`)
  return r
}

function inv7(layout: BuildingLayout, m: PixelMap): Report {
  const r = report()
  const rooms = new Map(m.rooms.map((q) => [q.id, q]))
  const index = furnitureIndex(layout)
  for (const o of m.objects) {
    const src = index.get(o.id)
    if (!src) continue
    // The object's room: the plan room holding its centre (map.ts sets `room`; the test recomputes).
    const room =
      o.fill !== undefined // the new map sets `room` (absent: outside every room)
        ? o.room && rooms.get(o.room)
        :
      m.rooms
        .filter((q) => q.placement === src.p.id)
        .find((q) => {
          const pr = plans[src.p.kind]!.rooms.find((x) => `${src.p.id}/${x.id}` === q.id)!
          return (
            src.f.x >= pr.rect[0] && src.f.x <= pr.rect[2] && src.f.z >= pr.rect[1] && src.f.z <= pr.rect[3]
          )
        })
    if (!room) continue
    if (!inside(o.rect, room.rect)) add(r, `${o.id} ${fmt(o.rect)} outside ${room.id} ${fmt(room.rect)}`)
    if (o.solid && tilesOf(o.rect).some(([tx, ty]) => inMap(m, tx, ty) && isWall(m, idx(m, tx, ty))))
      add(r, `${o.id} ${fmt(o.rect)} overlaps a wall tile`)
    if (WALL_MOUNTED.has(o.kind)) {
      // The ¾ art may cover the wall's face tile it hangs on, never anything past it.
      const reach = drawnReach(o, src.p.theme)
      const crosses = tilesOf(reach).some(
        ([tx, ty]) =>
          !inside({ tx, ty, tw: 1, th: 1 }, room.rect) &&
          !(inMap(m, tx, ty) && isWall(m, idx(m, tx, ty))),
      )
      if (crosses)
        add(r, `${o.id} draws ${fmt(reach)} across the edge of ${room.id} ${fmt(room.rect)}`)
    }
  }
  return r
}

function summary(name: string, r: Report) {
  if (r.count) console.log(`${name}: ${r.count} violation(s)\n  ${r.examples.join('\n  ')}`)
  return r.count
}

describe('2D map invariants on the real assets', () => {
  const three = build(THREE)

  it('INV-1: every solid tile is drawn (an object footprint or a wall)', () => {
    expect(summary('INV-1', inv1(three.map))).toBe(0)
  })

  it('INV-2: every drawn tile of a solid object is solid', () => {
    expect(summary('INV-2', inv2(three.map))).toBe(0)
  })

  it('INV-3: vertical tables, ping-pong, benches and planters use vertical art', () => {
    expect(summary('INV-3', inv3(three.layout, three.map))).toBe(0)
  })

  it('INV-4: every nav edge is passable for the 0.22 m player (seats and spots excepted)', () => {
    expect(summary('INV-4', inv4(three.layout, three.map))).toBe(0)
  })

  it('INV-5: left and right wings have the same solid grid', () => {
    expect(three.layout.placements.some((p) => p.kind === 'wing' && p.side === 'L')).toBe(true)
    expect(summary('INV-5', inv5(three.layout, three.map))).toBe(0)
  })

  it('INV-6: every desk has the same tile size', () => {
    expect(summary('INV-6', inv6(three.map))).toBe(0)
  })

  it('INV-7: objects stay in their rooms and wall-mounted art never crosses a wall (6 themes)', () => {
    const six = build(SIX)
    const themes = new Set(six.layout.placements.filter((p) => p.kind === 'wing').map((p) => p.theme))
    expect(themes.size).toBe(6)
    expect(summary('INV-7', inv7(six.layout, six.map))).toBe(0)
  })
})
