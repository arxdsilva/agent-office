// 2D map invariants on the REAL manifest and atlas, at GBA scale (plan "2D at GBA scale" §2):
// G-1 drawn = solid · G-2 approach points free · G-3 agent routes passable (within 0.25 m) · G-4 objects inside their
// rooms, wall-mounted art never crosses a wall · G-5 no overlapping furniture · G-6 left and right
// wings alike · G-7 art drawn at the plan's size. Built with the real planBuilding, buildPixelMap and
// the atlas-backed SpriteFoot, at 3 and 6 providers. Plus: map.ts's SIZES table matches sizes.json.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { spriteFootOf, type ArtAtlas } from '../../packages/web/src/adapters/pixel/object-art.ts'
import { planBuilding, toWorld } from '../../packages/web/src/app/building.ts'
import { parseManifest } from '../../packages/web/src/app/manifest.ts'
import type { BuildingLayout, ModulePlacement } from '../../packages/web/src/app/office-types.ts'
import {
  SIZES,
  buildPixelMap,
  plansOf,
  type TileQuery,
} from '../../packages/web/src/app/pixel/map.ts'
import {
  PX_PER_M,
  type PixelMap,
  type PlanFurniture,
  type PxRect,
} from '../../packages/web/src/app/pixel/types.ts'
import { PLAYER_RADIUS, blocked } from '../../packages/web/src/app/pixel/walk.ts'

const PUBLIC = join(import.meta.dirname, '../../packages/web/public/assets')
const manifest = parseManifest(JSON.parse(readFileSync(join(PUBLIC, 'manifest.json'), 'utf8')))
const atlas = JSON.parse(readFileSync(join(PUBLIC, 'pixel/atlas.json'), 'utf8')) as ArtAtlas & {
  pxPerMetre?: number
}
const sizes = JSON.parse(readFileSync(join(import.meta.dirname, 'src/sizes.json'), 'utf8')) as {
  kinds: Record<string, unknown>
}
const plans = plansOf(manifest)
/** The atlas base in px once it is drawn at 16 px/m; before that, plan-footprint fallbacks. */
const feet = atlas.pxPerMetre ? spriteFootOf(atlas) : null

/** Any resolver works: the invariants read geometry, not art. */
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
  return { layout, map: buildPixelMap(layout, plans, resolver(), undefined, feet) }
}

const THREE = ['claude-code', 'langgraph', 'openai-agents']
const SIX = [...THREE, 'crewai', 'autogen', 'llamaindex']
/** G-3: no route check this close (m) to a seat or spot (agents step onto the furniture there). */
const ANCHOR_SLACK_M = 0.35
/** G-3: pieces are rounded to whole px, so a route may graze one by up to half a pixel. */
const ROUTE_RADIUS = PLAYER_RADIUS - 0.5 / PX_PER_M
/**
 * G-3: 3D routes may brush furniture (agents have no radius; the lounge loop passes 0.04 m from an
 * armchair). The player follows a route within this much to either side (the doorway assist
 * and per-axis sliding take it there).
 */
const LATERAL_STEPS = [0.05, 0.1, 0.15, 0.2, 0.25]
/** G-4 / G-5 tolerance (px). */
const TOL_PX = 2
/** G-7: art may differ from the plan footprint by 25% per axis, or 4 px (a wall) for thin pieces. */
const ART_TOL = 0.25
// Approved deviation: G-7's thin-axis tolerance is 4 px (a wall): pieces thinner than that draw at 4 px.
const ART_TOL_PX = 4

const key = (r: PxRect) => `${r.x},${r.y},${r.w},${r.h}`
const fmt = (r: PxRect) => `${r.x},${r.y} ${r.w}×${r.h}`
const overlapLen = (a0: number, a1: number, b0: number, b1: number) =>
  Math.min(a1, b1) - Math.max(a0, b0)
const intersects = (a: PxRect, b: PxRect, by = 0) =>
  overlapLen(a.x, a.x + a.w, b.x, b.x + b.w) > by && overlapLen(a.y, a.y + a.h, b.y, b.y + b.h) > by
const inside = (a: PxRect, b: PxRect, tol: number) =>
  a.x >= b.x - tol && a.y >= b.y - tol && a.x + a.w <= b.x + b.w + tol && a.y + a.h <= b.y + b.h + tol

/** Map object id → its plan furniture and placement. */
function furnitureIndex(layout: BuildingLayout) {
  const out = new Map<string, { p: ModulePlacement; f: PlanFurniture }>()
  for (const p of layout.placements)
    plans[p.kind]?.furniture.forEach((f, i) =>
      out.set(`${p.id}/${f.ref ?? `${f.kind}:${i}`}`, { p, f }),
    )
  return out
}

/** A plan piece's size in px on the map, to the nearest quarter turn (unrounded). */
function planPx(p: ModulePlacement, f: PlanFurniture) {
  const turned = Math.abs(Math.round((p.yaw + f.yaw) / (Math.PI / 2))) % 2 === 1
  const [w, d] = turned ? [f.d, f.w] : [f.w, f.d]
  return { w: w * PX_PER_M, h: d * PX_PER_M }
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

/** G-1: `solids` is exactly the wall boxes plus the solid object bases, and fixed art is its box. */
function g1(m: PixelMap): Report {
  const r = report()
  const drawn = new Map<string, number>()
  const bump = (b: PxRect) => drawn.set(key(b), (drawn.get(key(b)) ?? 0) + 1)
  for (const w of m.walls) bump(w.box)
  for (const o of m.objects) if (o.solid) bump(o.box)
  const solid = new Map<string, number>()
  for (const s of m.solids) solid.set(key(s), (solid.get(key(s)) ?? 0) + 1)
  for (const [k, n] of solid)
    if ((drawn.get(k) ?? 0) !== n) add(r, `solid ${k} ×${n} is drawn ×${drawn.get(k) ?? 0}`)
  for (const [k, n] of drawn)
    if ((solid.get(k) ?? 0) !== n) add(r, `drawn ${k} ×${n} is solid ×${solid.get(k) ?? 0}`)
  if (feet)
    for (const o of m.objects) {
      if (o.fill !== 'sprite' || !o.orientation) continue
      const art = feet.foot(o.kind, o.orientation)
      if (art && (art.w !== o.box.w || art.h !== o.box.h))
        add(r, `${o.id} box ${fmt(o.box)} is not its art base ${art.w}×${art.h}`)
    }
  return r
}

/** G-2: every seat or spot approach point has room for the player's circle. */
function g2(layout: BuildingLayout, m: PixelMap): Report {
  const r = report()
  for (const a of layout.anchors.values()) {
    if (!a.local.startsWith('seat:') && !a.local.startsWith('spot:')) continue
    if (blocked(m, a.approach, PLAYER_RADIUS))
      add(r, `${a.placement}/${a.local} approach ${a.approach.x.toFixed(2)},${a.approach.z.toFixed(2)}`)
  }
  return r
}

/** G-3: every nav edge, every 0.1 m, is free for the player (except right at a seat or spot). */
// Approved deviation: G-3 allows ≤ 0.5 px rounding and ≤ 0.25 m sideways slack (3D routes brush furniture).
function g3(layout: BuildingLayout, m: PixelMap): Report {
  const r = report()
  const seats = [...layout.anchors.values()]
    .filter((a) => a.local.startsWith('seat:') || a.local.startsWith('spot:'))
    .map((a) => a.pos)
  const nearSeat = (p: { x: number; z: number }) =>
    seats.some((s) => Math.hypot(s.x - p.x, s.z - p.z) <= ANCHOR_SLACK_M)
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
      const n = Math.max(1, Math.ceil(len / 0.1))
      const side = len > 1e-9 ? { x: -(pb.z - pa.z) / len, z: (pb.x - pa.x) / len } : { x: 0, z: 0 }
      const free = (p: { x: number; z: number }) =>
        [0, ...LATERAL_STEPS.flatMap((d) => [d, -d])].some(
          (d) => !blocked(m, { x: p.x + side.x * d, z: p.z + side.z * d }, ROUTE_RADIUS),
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

/** True when every px of `a` lies in some room of `rooms` (open-plan rooms share edges). */
function covered(a: PxRect, rooms: readonly PxRect[], tol: number) {
  for (let y = a.y; y < a.y + a.h; y++)
    for (let x = a.x; x < a.x + a.w; x++)
      if (!rooms.some((b) => x >= b.x - tol && x < b.x + b.w + tol && y >= b.y - tol && y < b.y + b.h + tol))
        return false
  return true
}

/**
 * G-4: furniture lies inside its room (±2 px); a piece across an open room edge (a planter between
 * two zones, a plant on a pod corner) must stay on its module's floor and off every wall.
 * Wall-mounted pieces never cross a wall.
 */
// Approved deviation: G-4 accepts a piece across an open room edge if it stays on its module's floor, off every wall.
function g4(m: PixelMap): Report {
  const r = report()
  const rooms = new Map(m.rooms.map((q) => [q.id, q]))
  for (const o of m.objects) {
    const room = o.room && rooms.get(o.room)
    if (!room) continue
    const floor = m.rooms.filter((q) => q.placement === room.placement).map((q) => q.box)
    const open =
      covered(o.box, floor, TOL_PX) && (!o.solid || !m.walls.some((w) => intersects(o.box, w.box)))
    if (!inside(o.box, room.box, TOL_PX) && !open)
      add(r, `${o.id} ${fmt(o.box)} outside ${room.id} ${fmt(room.box)}`)
    if (o.wallMounted)
      for (const w of m.walls)
        if (intersects(o.box, w.box)) add(r, `${o.id} ${fmt(o.box)} crosses wall ${fmt(w.box)}`)
  }
  return r
}

// Approved deviation: pieces mostly on a larger one (coffee machines, the LED wall) aren't solid, so G-5 skips them.
/** G-5: no two solid furniture bases overlap by more than 2 px. */
function g5(m: PixelMap): Report {
  const r = report()
  const solid = m.objects.filter((o) => o.solid)
  for (let i = 0; i < solid.length; i++)
    for (let j = i + 1; j < solid.length; j++)
      if (intersects(solid[i]!.box, solid[j]!.box, TOL_PX))
        add(r, `${solid[i]!.id} ${fmt(solid[i]!.box)} × ${solid[j]!.id} ${fmt(solid[j]!.box)}`)
  return r
}

/** A wing's solid geometry in module-local px (objects by id, walls whose centre is in the wing). */
function wingLocal(p: ModulePlacement, m: PixelMap): PxRect[] {
  const b = manifest.modules.wing.bounds
  const toLocal = (x: number, z: number) => {
    // Inverse of toWorld (yaw 0 or π only for wings).
    const c = Math.cos(p.yaw)
    const dx = x - p.position.x
    const dz = z - p.position.z
    return { x: dx * c, z: dz * c }
  }
  const local = (r: PxRect): PxRect => {
    const a = toLocal(r.x / PX_PER_M + m.originM.x, r.y / PX_PER_M + m.originM.z)
    const c = toLocal((r.x + r.w) / PX_PER_M + m.originM.x, (r.y + r.h) / PX_PER_M + m.originM.z)
    return {
      x: Math.round(Math.min(a.x, c.x) * PX_PER_M),
      y: Math.round(Math.min(a.z, c.z) * PX_PER_M),
      w: r.w,
      h: r.h,
    }
  }
  const out: PxRect[] = []
  for (const o of m.objects) if (o.solid && o.id.startsWith(`${p.id}/`)) out.push(local(o.box))
  for (const w of m.walls) {
    const c = toLocal(
      (w.box.x + w.box.w / 2) / PX_PER_M + m.originM.x,
      (w.box.y + w.box.h / 2) / PX_PER_M + m.originM.z,
    )
    const e = 1e-6
    if (c.x >= b.minX - e && c.x <= b.maxX + e && c.z >= b.minZ - e && c.z <= b.maxZ + e)
      out.push(local(w.box))
  }
  // A wall on the boundary with the next bay can be counted by both wings: keep it once.
  const seen = new Set<string>()
  return out.filter((q) => !seen.has(key(q)) && !!seen.add(key(q))).sort((x, y) => x.x - y.x || x.y - y.y || x.w - y.w || x.h - y.h)
}

/** G-6: every left wing has the right wing's solid geometry (module-local, ±1 px). */
function g6(layout: BuildingLayout, m: PixelMap): Report {
  const r = report()
  const wings = layout.placements.filter((p) => p.kind === 'wing' && !p.annex)
  const right = wings.find((p) => p.side === 'R')
  if (!right) return r
  const base = wingLocal(right, m)
  const near = (a: PxRect, b: PxRect) =>
    Math.abs(a.x - b.x) <= 1 &&
    Math.abs(a.y - b.y) <= 1 &&
    Math.abs(a.w - b.w) <= 1 &&
    Math.abs(a.h - b.h) <= 1
  for (const w of wings.filter((p) => p.side === 'L')) {
    const other = wingLocal(w, m)
    const left = [...other]
    for (const a of base) {
      const i = left.findIndex((b) => near(a, b))
      if (i < 0) add(r, `${w.id} lacks ${fmt(a)} of ${right.id}`)
      else left.splice(i, 1)
    }
    for (const b of left) add(r, `${w.id} has extra ${fmt(b)}`)
  }
  return r
}

/** G-7: each fixed piece's art base is its plan footprint, within 25% (or 3 px) per axis. */
function g7(layout: BuildingLayout, m: PixelMap): Report {
  const r = report()
  const index = furnitureIndex(layout)
  for (const o of m.objects) {
    const src = index.get(o.id)
    if (!src || o.fill !== 'sprite' || !o.orientation) continue
    const art = feet?.foot(o.kind, o.orientation)
    if (!art) continue
    const plan = planPx(src.p, src.f)
    const off = (a: number, p: number) => Math.abs(a - p) > Math.max(ART_TOL * p, ART_TOL_PX)
    if (off(art.w, plan.w) || off(art.h, plan.h))
      add(r, `${o.id} art ${art.w}×${art.h} vs plan ${plan.w.toFixed(1)}×${plan.h.toFixed(1)}`)
  }
  return r
}

function summary(name: string, r: Report) {
  if (r.count) console.log(`${name}: ${r.count} violation(s)\n  ${r.examples.join('\n  ')}`)
  return r.count
}

describe('2D map invariants on the real assets (G)', () => {
  const runs = { 3: build(THREE), 6: build(SIX) }

  it('SIZES in map.ts matches assets/pixel/src/sizes.json', () => {
    expect(SIZES).toEqual(sizes.kinds)
  })

  for (const [n, { layout, map }] of Object.entries(runs)) {
    describe(`${n} providers`, () => {
      it('G-1: solids are exactly the drawn walls and solid bases', () => {
        expect(map.solids.length).toBeGreaterThan(100)
        expect(summary(`G-1/${n}`, g1(map))).toBe(0)
      })

      it('G-2: every seat and spot approach point is free for the 0.22 m player', () => {
        expect(summary(`G-2/${n}`, g2(layout, map))).toBe(0)
      })

      it('G-3: every nav edge is passable for the player (seats and spots excepted)', () => {
        expect(summary(`G-3/${n}`, g3(layout, map))).toBe(0)
      })

      it('G-4: objects stay inside their rooms; wall-mounted pieces never cross a wall', () => {
        expect(map.objects.some((o) => o.wallMounted)).toBe(true)
        expect(summary(`G-4/${n}`, g4(map))).toBe(0)
      })

      it('G-5: no two solid bases overlap by more than 2 px', () => {
        expect(summary(`G-5/${n}`, g5(map))).toBe(0)
      })

      it('G-6: left and right wings have the same solid geometry', () => {
        expect(layout.placements.some((p) => p.kind === 'wing' && p.side === 'L')).toBe(true)
        expect(summary(`G-6/${n}`, g6(layout, map))).toBe(0)
      })

      // Runs once the atlas is drawn at 16 px/m (pxPerMetre); the old atlas is double size.
      it.skipIf(!atlas.pxPerMetre)('G-7: fixed art matches its plan footprint (±25%)', () => {
        expect(summary(`G-7/${n}`, g7(layout, map))).toBe(0)
      })
    })
  }

  it('builds six themed wings', () => {
    const themes = new Set(
      runs[6].layout.placements.filter((p) => p.kind === 'wing').map((p) => p.theme),
    )
    expect(themes.size).toBe(6)
    // Module-local transform sanity: a wing's origin maps to its placement.
    const w = runs[6].layout.placements.find((p) => p.kind === 'wing')!
    expect(toWorld({ x: 0, z: 0 }, w)).toEqual(w.position)
  })
})
