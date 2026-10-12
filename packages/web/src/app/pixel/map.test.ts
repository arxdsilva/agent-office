import { describe, expect, it } from 'vitest'
import { fixtureManifest } from '../__fixtures__/manifest.ts'
import { planBuilding, toWorld } from '../building.ts'
import type { BuildingLayout } from '../office-types.ts'
import {
  SIZES,
  buildPixelMap,
  capabilitySlot,
  indexSolids,
  plansOf,
  solidsNear,
  tileIndex,
  type TileQuery,
  type TileResolver,
} from './map.ts'
import type { ModulePlan, PixelMap, PlanByModule, PxRect, SpriteFoot } from './types.ts'
import { PX_PER_M, WALL_PX } from './types.ts'

/** Tile ids from a readable table: every distinct query gets its own id, stable per test. */
function fakeResolver(): TileResolver & { ids: Map<string, number> } {
  const ids = new Map<string, number>()
  return {
    ids,
    tile(q: TileQuery) {
      const k = `${q.layer}:${q.kind}:${q.theme ?? '-'}:${q.edge ?? '-'}`
      if (!ids.has(k)) ids.set(k, ids.size + 1)
      return ids.get(k)!
    },
  }
}
const idOf = (r: ReturnType<typeof fakeResolver>, prefix: string) =>
  [...r.ids].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v)

const layoutFor = (providers: string[]): BuildingLayout =>
  planBuilding(
    providers.map((provider) => ({ provider, agents: 2 })),
    fixtureManifest,
    undefined,
    0,
  )

const wingPlan = (over: Partial<ModulePlan> = {}): PlanByModule => ({
  wing: {
    rooms: [{ id: 'pod-1', name: 'Pod 1', rect: [0, 0, 4, 6], floor: 'wood' }],
    walls: [{ a: [0, 0], b: [4, 0], kind: 'solid', openings: [[1, 2]] }],
    furniture: [
      { kind: 'desk', x: 2, z: 4, w: 1.6, d: 0.8, yaw: 0 },
      { kind: 'rug', x: 1, z: 2, w: 1, d: 1, yaw: 0 },
    ],
    ...over,
  },
})
const roomPlan = (over: Partial<ModulePlan>): PlanByModule => ({
  wing: {
    rooms: [{ id: 'pod-1', name: 'Pod 1', rect: [0, 0, 8, 8] }],
    walls: [],
    furniture: [],
    ...over,
  },
})

/** Map pixel of a module-local point in a placement (unrounded). */
function pxAt(layout: BuildingLayout, placement: string, x: number, z: number, m: PixelMap) {
  const p = layout.placements.find((q) => q.id === placement)!
  const w = toWorld({ x, z }, p)
  return { x: (w.x - m.originM.x) * PX_PER_M, y: (w.z - m.originM.z) * PX_PER_M }
}
const contains = (r: PxRect, x: number, y: number) =>
  x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h

/** Fake atlas feet in px: h art, swapped for v. */
const feet: SpriteFoot = {
  foot(kind, o) {
    const t: Record<string, [number, number]> = {
      desk: [26, 13],
      'kitchen-counter': [32, 10],
      planter: [16, 8],
      bookshelf: [32, 7],
      'booth-lamp': [22, 22],
    }
    const f = t[kind]
    if (!f) return null
    return o === 'v' ? { w: f[1], h: f[0] } : { w: f[0], h: f[1] }
  },
}

describe('buildPixelMap: rooms and floors (MAP-RM)', () => {
  // MAP-RM1: a plan room becomes its exact px box, the 1 m cells it covers, and floor tiles.
  it('turns plan rooms into px boxes and 1 m cells', () => {
    const layout = layoutFor(['p'])
    const r = fakeResolver()
    const m = buildPixelMap(layout, wingPlan(), r)
    const room = m.rooms.find((x) => x.placement === 'wing:p:0')!
    expect(room).toMatchObject({ id: 'wing:p:0/pod-1', name: 'Pod 1', provider: 'p' })
    expect(room.box.w).toBe(4 * PX_PER_M)
    expect(room.box.h).toBe(6 * PX_PER_M)
    const tl = pxAt(layout, 'wing:p:0', 0, 0, m)
    expect(room.box.x).toBe(Math.round(tl.x))
    expect(room.rect.tw).toBeGreaterThanOrEqual(4)
    expect(room.rect.th).toBeGreaterThanOrEqual(6)
    expect(room.theme).toBe(layout.placements.find((p) => p.id === 'wing:p:0')!.theme)
    // The cell whose centre lies in the room takes its floor.
    const c = pxAt(layout, 'wing:p:0', 1.5, 1.5, m)
    const floor =
      m.layers.floor[tileIndex(m, { tx: Math.floor(c.x / 16), ty: Math.floor(c.y / 16) })]
    expect(idOf(r, 'floor:wood')).toContain(floor)
    expect(m.layers.floor).toHaveLength(m.widthTiles * m.heightTiles)
    expect(m.widthPx).toBe(m.widthTiles * 16)
    expect(m.heightPx).toBe(m.heightTiles * 16)
  })

  // MAP-RM2: modules without a plan stay empty.
  it('keeps modules without a plan empty', () => {
    const m = buildPixelMap(layoutFor(['p']), wingPlan(), fakeResolver())
    expect(m.rooms.every((x) => x.placement.startsWith('wing:'))).toBe(true)
  })
})

describe('buildPixelMap: walls (MAP-W)', () => {
  // MAP-W1: a wall minus its opening becomes two runs at least WALL_PX thick; the opening is a
  // door object of its exact width, not solid.
  it('splits walls at openings and makes doors of the exact width', () => {
    const layout = layoutFor(['p'])
    const m = buildPixelMap(layout, wingPlan(), fakeResolver())
    expect(m.walls).toHaveLength(2)
    for (const w of m.walls) {
      expect(w.kind).toBe('solid')
      expect(w.box.h).toBe(WALL_PX)
    }
    const widths = m.walls.map((w) => w.box.w).sort((a, b) => a - b)
    expect(widths).toEqual([16, 32])
    const door = m.objects.find((o) => o.kind === 'door')!
    expect(door).toMatchObject({ solid: false, fill: 'repeat', orientation: 'h' })
    expect(door.box.w).toBe(16)
    // The door gap is not in solids; the runs are.
    const mid = pxAt(layout, 'wing:p:0', 1.5, 0, m)
    expect(m.solids.some((s) => contains(s, mid.x, mid.y))).toBe(false)
    const run = pxAt(layout, 'wing:p:0', 3, 0, m)
    expect(m.solids.some((s) => contains(s, run.x, run.y))).toBe(true)
  })

  // MAP-W2: a wall sits on its 3D body (offset by side · thick / 2), as thick as the body.
  it('centres walls on their body by side and thickness', () => {
    const layout = layoutFor(['p'])
    const at = (side: -1 | 1) =>
      buildPixelMap(
        layout,
        roomPlan({ walls: [{ a: [0, 3], b: [4, 3], kind: 'solid', side, thick: 0.4 }] }),
        fakeResolver(),
      ).walls[0]!
    const m = buildPixelMap(layout, roomPlan({}), fakeResolver())
    // (−dz, dx) of a→b is +z: side +1 puts the body on z 3…3.4, side −1 on z 2.6…3.
    const below = pxAt(layout, 'wing:p:0', 2, 3.2, m)
    const above = pxAt(layout, 'wing:p:0', 2, 2.8, m)
    expect(at(1).box.h).toBe(Math.round(0.4 * PX_PER_M))
    expect(contains(at(1).box, below.x, below.y)).toBe(true)
    expect(contains(at(1).box, above.x, above.y)).toBe(false)
    expect(contains(at(-1).box, above.x, above.y)).toBe(true)
    expect(contains(at(-1).box, below.x, below.y)).toBe(false)
  })

  // MAP-W3: glass collinear with a solid wall (within 0.1 m) merges into it: solid wins where both
  // are, glass fills the rest, and a glassed opening is no door.
  it('merges collinear glass and solid walls', () => {
    const layout = layoutFor(['p'])
    const m = buildPixelMap(
      layout,
      roomPlan({
        walls: [
          { a: [0, 2], b: [8, 2], kind: 'solid', openings: [[2, 6]] },
          { a: [1, 2.05], b: [7, 2.05], kind: 'glass' },
        ],
      }),
      fakeResolver(),
    )
    const solid = m.walls.filter((w) => w.kind === 'solid')
    const glass = m.walls.filter((w) => w.kind === 'glass')
    expect(solid.map((w) => w.box.w).sort((a, b) => a - b)).toEqual([32, 32])
    expect(glass).toHaveLength(1)
    expect(glass[0]!.box.w).toBe(64)
    // One line: the glass run sits where the solid wall is.
    expect(glass[0]!.box.y).toBe(solid[0]!.box.y)
    expect(m.objects.some((o) => o.kind === 'door')).toBe(false)
  })

  // MAP-W4: a horizontal wall with a room right below it shows its south face; vertical walls and
  // walls with no room below don't. Curtain walls are glass.
  it('marks the south face only when a room lies below', () => {
    const layout = layoutFor(['p'])
    const m = buildPixelMap(
      layout,
      roomPlan({
        walls: [
          { a: [0, 0], b: [8, 0], kind: 'solid' },
          { a: [0, 8], b: [8, 8], kind: 'curtain' },
          { a: [8, 0], b: [8, 8], kind: 'solid' },
        ],
      }),
      fakeResolver(),
    )
    const top = pxAt(layout, 'wing:p:0', 4, 0, m)
    const bottom = pxAt(layout, 'wing:p:0', 4, 8, m)
    const at = (p: { x: number; y: number }) =>
      m.walls.find((w) => Math.abs(w.box.y + w.box.h / 2 - p.y) <= 2 && w.box.w > w.box.h)!
    expect(at(top).face).toBe('s')
    expect(at(bottom)).toMatchObject({ face: null, kind: 'glass' })
    expect(m.walls.find((w) => w.box.h > w.box.w)!.face).toBeNull()
  })
})

describe('buildPixelMap: objects (MAP-O)', () => {
  // MAP-O1: fixed pieces take the art base (px), centred on the plan centre; v art for vertical
  // pieces; without art, the plan footprint.
  it('sizes fixed pieces by their art base and orientation', () => {
    const layout = layoutFor(['p'])
    const plan = roomPlan({
      furniture: [
        { kind: 'desk', x: 2, z: 2, w: 1.6, d: 0.8, yaw: 0 },
        { kind: 'desk', x: 6, z: 5, w: 1.6, d: 0.8, yaw: Math.PI / 2 },
      ],
    })
    const m = buildPixelMap(layout, plan, fakeResolver(), undefined, feet)
    const [h, v] = m.objects.filter((o) => o.kind === 'desk')
    expect(h).toMatchObject({ orientation: 'h', fill: 'sprite', solid: true, facing: 's' })
    expect(h!.box).toMatchObject({ w: 26, h: 13 })
    expect(v).toMatchObject({ orientation: 'v', box: { w: 13, h: 26 } })
    const c = pxAt(layout, 'wing:p:0', 2, 2, m)
    expect(Math.abs(h!.box.x + h!.box.w / 2 - c.x)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(h!.box.y + h!.box.h / 2 - c.y)).toBeLessThanOrEqual(0.5)
    expect(h!.sortY).toBe(h!.box.y + h!.box.h)
    expect(h!.room).toBe('wing:p:0/pod-1')
    // No art: the plan footprint (1.6 × 0.8 m ≈ 26 × 13 px).
    const bare = buildPixelMap(layout, plan, fakeResolver()).objects.find((o) => o.kind === 'desk')!
    expect(Math.abs(bare.box.w - 25.6)).toBeLessThanOrEqual(1)
    expect(Math.abs(bare.box.h - 12.8)).toBeLessThanOrEqual(1)
  })

  // MAP-O2: strips run the plan length at the art's thickness (sizes.json without art); planters and
  // benches 2 m deep or more, rugs and the elevator are areas (the plan box).
  it('makes strips and areas', () => {
    const layout = layoutFor(['p'])
    const plan = roomPlan({
      furniture: [
        { kind: 'kitchen-counter', x: 3, z: 4, w: 4.4, d: 0.65, yaw: 0 },
        { kind: 'planter', x: 7, z: 4, w: 5.84, d: 0.94, yaw: Math.PI / 2 },
        { kind: 'planter', x: 2, z: 6.5, w: 2, d: 2, yaw: 0 },
        { kind: 'rug', x: 5, z: 1.5, w: 2, d: 1, yaw: 0 },
      ],
    })
    const m = buildPixelMap(layout, plan, fakeResolver(), undefined, feet)
    const [counter, strip, pool, rug] = m.objects
    expect(counter).toMatchObject({ fill: 'repeat', orientation: 'h', box: { h: 10 } })
    expect(Math.abs(counter!.box.w - 4.4 * 16)).toBeLessThanOrEqual(1)
    expect(strip).toMatchObject({ fill: 'repeat', orientation: 'v', box: { w: 8 } })
    expect(Math.abs(strip!.box.h - 5.84 * 16)).toBeLessThanOrEqual(1)
    expect(pool).toMatchObject({ fill: 'area', box: { w: 32, h: 32 } })
    expect(rug).toMatchObject({ fill: 'area', solid: false, box: { w: 32, h: 16 } })
    // Without art, strips take their sizes.json thickness.
    const bare = buildPixelMap(layout, plan, fakeResolver()).objects[0]!
    expect(bare.box.h).toBe(SIZES['kitchen-counter']!.thickness)
  })

  // MAP-O3: a wall-mounted piece within 0.3 m of a wall puts its back edge on the wall's inner face.
  it('puts wall-mounted pieces against the wall', () => {
    const layout = layoutFor(['p'])
    const m = buildPixelMap(
      layout,
      roomPlan({
        walls: [{ a: [0, 2], b: [8, 2], kind: 'solid', side: 1, thick: 0.15 }],
        furniture: [
          { kind: 'bookshelf', x: 2, z: 2.6, w: 3, d: 0.4, yaw: 0 },
          { kind: 'board', x: 5, z: 1.7, w: 1, d: 0.1, yaw: Math.PI },
          { kind: 'bookshelf', x: 6, z: 4, w: 1, d: 0.4, yaw: 0 },
        ],
      }),
      fakeResolver(),
      undefined,
      feet,
    )
    const wall = m.walls[0]!
    const [shelf, board, far] = m.objects
    expect(shelf).toMatchObject({ wallMounted: true })
    expect(shelf!.box.y).toBe(wall.box.y + wall.box.h)
    expect(board).toMatchObject({ wallMounted: true })
    expect(board!.box.y + board!.box.h).toBe(wall.box.y)
    expect(far!.wallMounted).toBeUndefined()
  })

  // MAP-O4: chairs, rugs and signs are drawn but never block; everything else is solid.
  it('keeps chairs, rugs and signs walkable', () => {
    const layout = layoutFor(['p'])
    const m = buildPixelMap(
      layout,
      roomPlan({
        furniture: [
          { kind: 'chair', x: 1, z: 1, w: 0.6, d: 0.6, yaw: 0 },
          { kind: 'sign', x: 3, z: 1, w: 1, d: 0.1, yaw: 0 },
          { kind: 'rug', x: 5, z: 5, w: 2, d: 2, yaw: 0 },
          { kind: 'plant', x: 7, z: 7, w: 0.5, d: 0.5, yaw: 0 },
        ],
      }),
      fakeResolver(),
    )
    expect(m.objects.slice(0, 4).map((o) => [o.kind, o.solid])).toEqual([
      ['chair', false],
      ['sign', false],
      ['rug', false],
      ['plant', true],
    ])
    expect(m.solids).toHaveLength(1)
    expect(m.solids[0]).toEqual(m.objects[3]!.box)
  })

  // MAP-O7: a piece standing on another (coffee machines on a counter, an LED wall over the bar)
  // doesn't block: the piece below does. A coffee machine on the floor still blocks.
  it('makes pieces stacked on another piece non-solid', () => {
    const layout = layoutFor(['p'])
    const m = buildPixelMap(
      layout,
      roomPlan({
        furniture: [
          { kind: 'kitchen-counter', x: 3, z: 4, w: 4.4, d: 0.65, yaw: 0 },
          { kind: 'coffee-machine', x: 3.2, z: 4, w: 0.38, d: 0.4, yaw: 0 },
          { kind: 'led-wall', x: 3, z: 4.25, w: 4, d: 0.1, yaw: 0 },
          { kind: 'coffee-machine', x: 7, z: 7, w: 0.38, d: 0.4, yaw: 0 },
        ],
      }),
      fakeResolver(),
    )
    expect(m.objects.slice(0, 4).map((o) => o.solid)).toEqual([true, false, false, true])
    expect(m.solids).toHaveLength(2)
  })

  // MAP-O5: the same plan in a left wing (yaw π) lands rotated, not mirrored.
  it('rotates module plans by the placement yaw', () => {
    const layout = layoutFor(['p', 'q'])
    const m = buildPixelMap(layout, wingPlan(), fakeResolver())
    const left = layout.placements.find((p) => p.kind === 'wing' && p.side === 'L')!
    expect(left.yaw).toBeCloseTo(Math.PI)
    const d = m.objects.find((o) => o.kind === 'desk' && o.id.startsWith(left.id))!
    const c = pxAt(layout, left.id, 2, 4, m)
    expect(contains(d.box, c.x, c.y)).toBe(true)
    expect(d.facing).toBe('n')
  })

  // MAP-O6: booth lamps take their art base (else the sizes.json base) centred on the booth spot.
  it('sizes anchor objects by their art', () => {
    const layout = layoutFor(['p'])
    const lamp = buildPixelMap(layout, roomPlan({}), fakeResolver(), undefined, feet).objects.find(
      (o) => o.kind === 'booth-lamp',
    )!
    expect(lamp.box).toMatchObject({ w: 22, h: 22 })
    const door = buildPixelMap(layout, roomPlan({}), fakeResolver()).objects.find(
      (o) => o.kind === 'elevator-door',
    )!
    expect(door.box).toMatchObject({ w: SIZES['elevator-door']!.base![0] })
    expect(buildPixelMap(layout, roomPlan({}), fakeResolver(), undefined, feet).key).not.toBe(
      buildPixelMap(layout, roomPlan({}), fakeResolver()).key,
    )
  })

  it('links interactive furniture to anchors, objects and capability slots', () => {
    const layout = layoutFor(['p'])
    const m = buildPixelMap(
      layout,
      {
        ...wingPlan({
          furniture: [
            { kind: 'station', x: 1, z: 1, w: 1, d: 1, yaw: 0, ref: 'station:3' },
            { kind: 'bookshelf', x: 3, z: 1, w: 2, d: 0.5, yaw: 0, ref: 'book:0' },
            { kind: 'sign', x: 0.5, z: 5, w: 1, d: 0.2, yaw: 0 },
          ],
        }),
        atrium: {
          rooms: [{ id: 'lobby', name: 'Lobby', rect: [-6, -20, 6, 0] }],
          walls: [],
          furniture: [
            { kind: 'elevator', x: 0, z: -18, w: 2, d: 1, yaw: 0 },
            { kind: 'led-wall', x: 3, z: -10, w: 2, d: 0.3, yaw: 0 },
          ],
        },
      },
      fakeResolver(),
    )
    const station = m.objects.find((o) => o.kind === 'station')!
    expect(capabilitySlot(station)).toEqual({ placement: 'wing:p:0', slot: 'station:3' })
    expect(capabilitySlot(m.objects.find((o) => o.kind === 'sign')!)).toBeUndefined()
    expect(m.objects.find((o) => o.kind === 'elevator')).toMatchObject({
      fill: 'area',
      interact: { kind: 'object', object: 'elevator' },
    })
    expect(m.objects.find((o) => o.kind === 'led-wall')!.interact).toMatchObject({
      object: 'stats-board',
    })
    expect(m.objects.find((o) => o.kind === 'sign')).toMatchObject({
      solid: false,
      interact: { object: 'sign', label: 'p' },
    })
    expect(m.objects.some((o) => o.kind === 'booth-lamp')).toBe(true)
  })
})

describe('buildPixelMap: collision data and caching (MAP-C)', () => {
  // MAP-C1: solids are the wall boxes plus the solid object boxes; the 32 px bucket index finds them.
  it('collects solids and indexes them in 32 px buckets', () => {
    const layout = layoutFor(['p'])
    const m = buildPixelMap(layout, wingPlan(), fakeResolver(), undefined, feet)
    const desk = m.objects.find((o) => o.kind === 'desk')!
    expect(m.solids).toHaveLength(m.walls.length + 1)
    expect(m.solids).toContainEqual(desk.box)
    for (const w of m.walls) expect(m.solids).toContainEqual(w.box)
    expect(m.solidIndex.cellPx).toBe(32)
    expect(m.solidIndex.cols).toBe(Math.ceil(m.widthPx / 32))
    expect(m.solidIndex.buckets).toHaveLength(m.solidIndex.cols * m.solidIndex.rows)
    const near = solidsNear(m, { x: desk.box.x - 1, y: desk.box.y - 1, w: 2, h: 2 })
    expect(near.map((i) => m.solids[i])).toContainEqual(desk.box)
    expect(solidsNear(m, { x: -100, y: -100, w: 10, h: 10 })).toEqual([])
  })

  // MAP-C2: a rect spanning buckets is listed in each, once; queries return each index once.
  it('indexes rects across bucket edges', () => {
    const idx = indexSolids([{ x: 30, y: 30, w: 4, h: 4 }], 64, 64)
    expect(idx.buckets.map((b) => b.length)).toEqual([1, 1, 1, 1])
    const map = { solids: [{ x: 30, y: 30, w: 4, h: 4 }], solidIndex: idx }
    expect(solidsNear(map, { x: 0, y: 0, w: 64, h: 64 })).toEqual([0])
  })

  // MAP-det: the same layout and plan give the same map.
  it('is deterministic', () => {
    const layout = layoutFor(['p', 'q'])
    const a = buildPixelMap(layout, wingPlan(), fakeResolver(), undefined, feet)
    const b = buildPixelMap(layout, wingPlan(), fakeResolver(), undefined, feet)
    expect(Buffer.from(a.layers.floor.buffer).equals(Buffer.from(b.layers.floor.buffer))).toBe(true)
    expect(JSON.stringify([a.objects, a.walls, a.solids, a.rooms])).toBe(
      JSON.stringify([b.objects, b.walls, b.solids, b.rooms]),
    )
    expect(a.key).toBe(b.key)
  })

  // MAP-C3: an unchanged layout key and plan reuse the previous map object.
  it('reuses the map when nothing changed', () => {
    const layout = layoutFor(['p'])
    const r = fakeResolver()
    const a = buildPixelMap(layout, wingPlan(), r)
    expect(buildPixelMap({ ...layout }, wingPlan(), r, a)).toBe(a)
    const other = buildPixelMap(layout, wingPlan({ furniture: [] }), r, a)
    expect(other).not.toBe(a)
    expect(other.key).not.toBe(a.key)
  })

  // MAP-C4: a new provider re-renders only the modules that changed (chunk dirty list).
  it('lists only changed placements as dirty', () => {
    const r = fakeResolver()
    const one = layoutFor(['p', 'q'])
    const a = buildPixelMap(one, wingPlan(), r)
    expect(a.dirty).toEqual(one.placements.map((p) => p.id))
    const two = planBuilding(
      ['p', 'q', 'r'].map((provider) => ({ provider, agents: 2 })),
      fixtureManifest,
      one,
      1,
    )
    const b = buildPixelMap(two, wingPlan(), r, a)
    expect(b.originM).toEqual(a.originM)
    expect(b.dirty).toContain('wing:r:0')
    expect(b.dirty).not.toContain('wing:p:0')
    expect(b.dirty).not.toContain('wing:q:0')
    expect(b.dirty).not.toContain('atrium')
  })
})

// The published manifest (agent BL's export): the real plans build a walkable world.
describe('buildPixelMap with the published manifest', () => {
  const real = import.meta.glob('../../../public/assets/manifest.json', {
    eager: true,
    import: 'default',
  })
  const realJson = Object.values(real)[0]
  it.skipIf(!realJson)('builds rooms, doors and a free spawn from the real plans', async () => {
    const { parseManifest } = await import('../manifest.ts')
    const { spawnPoint, blocked } = await import('./walk.ts')
    const manifest = parseManifest(realJson)
    const plans = plansOf(manifest)
    expect(Object.keys(plans).sort()).toEqual(['atrium', 'cap', 'garden', 'street', 'wing'])
    const layout = planBuilding(
      ['claude-code', 'langgraph'].map((provider) => ({ provider, agents: 4 })),
      manifest,
      undefined,
      0,
    )
    const m = buildPixelMap(layout, plans, fakeResolver())
    expect(m.rooms.length).toBeGreaterThan(20)
    expect(m.objects.some((o) => o.kind === 'door')).toBe(true)
    expect(m.walls.some((w) => w.face === 's')).toBe(true)
    expect(m.objects.filter((o) => capabilitySlot(o)).length).toBeGreaterThan(0)
    expect(blocked(m, spawnPoint(m, layout))).toBe(false)
  })
})
