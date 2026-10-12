import { describe, expect, it } from 'vitest'
import { fixtureManifest } from '../__fixtures__/manifest.ts'
import { planBuilding } from '../building.ts'
import type { BuildingLayout } from '../office-types.ts'
import {
  buildPixelMap,
  capabilitySlot,
  plansOf,
  tileIndex,
  type TileQuery,
  type TileResolver,
} from './map.ts'
import { toTile } from './project.ts'
import type { ModulePlan, PlanByModule } from './types.ts'

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

/** World tile for a module-local point in a placement. */
function tileAt(
  layout: BuildingLayout,
  placement: string,
  x: number,
  z: number,
  map: { originM: { x: number; z: number } },
) {
  const p = layout.placements.find((q) => q.id === placement)!
  const c = Math.cos(p.yaw)
  const s = Math.sin(p.yaw)
  return toTile({ x: x * c + z * s + p.position.x, z: -x * s + z * c + p.position.z }, map)
}

describe('buildPixelMap (MAP)', () => {
  // MAP-1: a solid wall becomes wall tiles; its opening becomes passable door tiles.
  it('turns walls into wall tiles and openings into door tiles', () => {
    const layout = layoutFor(['p'])
    const r = fakeResolver()
    const m = buildPixelMap(layout, wingPlan(), r)
    const wall = (x: number) => tileIndex(m, tileAt(layout, 'wing:p:0', x, 0.01, m))
    // Solid part of the wall (0..1 m and 2..4 m).
    for (const x of [0.25, 0.75, 2.25, 3.75]) {
      expect(m.solid[wall(x)]).toBe(1)
      expect(idOf(r, 'wall:solid')).toContain(m.layers.walls[wall(x)])
    }
    // The opening (1..2 m) is a door: not solid, door tile, and a door object.
    for (const x of [1.25, 1.75]) {
      expect(m.solid[wall(x)]).toBe(0)
      expect(idOf(r, 'wall:door')).toContain(m.layers.walls[wall(x)])
    }
    expect(m.objects.filter((o) => o.kind === 'door')).toHaveLength(1)
  })

  // MAP-2: glass walls use the window tile; they still block the player.
  it('uses window tiles for glass walls', () => {
    const layout = layoutFor(['p'])
    const r = fakeResolver()
    const m = buildPixelMap(
      layout,
      wingPlan({ walls: [{ a: [0, 3], b: [4, 3], kind: 'glass' }] }),
      r,
    )
    const i = tileIndex(m, tileAt(layout, 'wing:p:0', 2.25, 3.01, m))
    expect(idOf(r, 'wall:glass')).toContain(m.layers.walls[i])
    expect(m.solid[i]).toBe(1)
  })

  // Chairs sit on anchor approach lanes at tile resolution (0.5 m), so the player walks past them
  // (agents sit on them; they're drawn y-sorted). Without this, real approaches land on solid tiles.
  it('keeps chairs walkable for the player', () => {
    const layout = layoutFor(['p'])
    const plan = wingPlan()
    plan.wing!.furniture.push({ kind: 'chair', x: 6, z: 2, w: 0.6, d: 0.6, yaw: 0 })
    const m = buildPixelMap(layout, plan, fakeResolver())
    const chair = m.objects.find((o) => o.kind === 'chair')!
    expect(chair.solid).toBe(false)
  })

  // MAP-3: furniture footprints are solid, rugs are not; objects carry kind, sortY and facing.
  it('marks furniture footprints solid except rugs', () => {
    const layout = layoutFor(['p'])
    const m = buildPixelMap(layout, wingPlan(), fakeResolver())
    const desk = m.objects.find((o) => o.kind === 'desk')!
    const rug = m.objects.find((o) => o.kind === 'rug')!
    expect(desk.solid).toBe(true)
    expect(rug.solid).toBe(false)
    expect(desk.rect.tw).toBe(4) // 1.6 m at 0.5 m per tile, rounded out
    expect(desk.rect.th).toBe(2)
    expect(desk.sortY).toBe((desk.rect.ty + desk.rect.th) * 16)
    expect(desk.facing).toBe('s')
    expect(m.solid[tileIndex(m, tileAt(layout, 'wing:p:0', 2, 4, m))]).toBe(1)
    expect(m.solid[tileIndex(m, tileAt(layout, 'wing:p:0', 1, 2, m))]).toBe(0)
  })

  // MAP-4: the same plan in a left wing (yaw π) lands rotated, not mirrored.
  it('rotates module plans by the placement yaw', () => {
    const layout = layoutFor(['p', 'q'])
    const m = buildPixelMap(layout, wingPlan(), fakeResolver())
    const left = layout.placements.find((p) => p.kind === 'wing' && p.side === 'L')!
    expect(left.yaw).toBeCloseTo(Math.PI)
    const desks = m.objects.filter((o) => o.kind === 'desk')
    expect(desks).toHaveLength(2)
    const t = tileAt(layout, left.id, 2, 4, m)
    const d = desks.find((o) => o.id.startsWith(left.id))!
    expect(t.tx).toBeGreaterThanOrEqual(d.rect.tx)
    expect(t.tx).toBeLessThan(d.rect.tx + d.rect.tw)
    expect(t.ty).toBeGreaterThanOrEqual(d.rect.ty)
    expect(t.ty).toBeLessThan(d.rect.ty + d.rect.th)
    expect(d.facing).toBe('n')
  })

  // MAP-5: plan rooms become world tile rects with the placement's theme and provider.
  it('turns plan rooms into tile rects', () => {
    const layout = layoutFor(['p'])
    const r = fakeResolver()
    const m = buildPixelMap(layout, wingPlan(), r)
    const room = m.rooms.find((x) => x.placement === 'wing:p:0')!
    expect(room).toMatchObject({ id: 'wing:p:0/pod-1', name: 'Pod 1', provider: 'p' })
    expect(room.rect.tw).toBe(8)
    expect(room.rect.th).toBe(12)
    expect(room.theme).toBe(layout.placements.find((p) => p.id === 'wing:p:0')!.theme)
    const floor = m.layers.floor[tileIndex(m, { tx: room.rect.tx + 1, ty: room.rect.ty + 1 })]
    expect(idOf(r, 'floor:wood')).toContain(floor)
  })

  // MAP-det: the same layout and plan give the same bytes.
  it('is deterministic', () => {
    const layout = layoutFor(['p', 'q'])
    const a = buildPixelMap(layout, wingPlan(), fakeResolver())
    const b = buildPixelMap(layout, wingPlan(), fakeResolver())
    expect(Buffer.from(a.solid.buffer).equals(Buffer.from(b.solid.buffer))).toBe(true)
    expect(Buffer.from(a.layers.floor.buffer).equals(Buffer.from(b.layers.floor.buffer))).toBe(true)
    expect(Buffer.from(a.layers.walls.buffer).equals(Buffer.from(b.layers.walls.buffer))).toBe(true)
    expect(JSON.stringify(a.objects)).toBe(JSON.stringify(b.objects))
    expect(a.key).toBe(b.key)
  })

  // MAP-7: an unchanged layout key and plan reuse the previous map object.
  it('reuses the map when nothing changed', () => {
    const layout = layoutFor(['p'])
    const r = fakeResolver()
    const a = buildPixelMap(layout, wingPlan(), r)
    expect(buildPixelMap({ ...layout }, wingPlan(), r, a)).toBe(a)
    const other = buildPixelMap(layout, wingPlan({ furniture: [] }), r, a)
    expect(other).not.toBe(a)
    expect(other.key).not.toBe(a.key)
  })

  // MAP-8: a new provider re-renders only the modules that changed (chunk dirty list).
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
    expect(m.objects.find((o) => o.kind === 'elevator')!.interact).toEqual({
      kind: 'object',
      object: 'elevator',
    })
    expect(m.objects.find((o) => o.kind === 'led-wall')!.interact).toMatchObject({
      object: 'stats-board',
    })
    expect(m.objects.find((o) => o.kind === 'sign')).toMatchObject({
      solid: false,
      interact: { object: 'sign', label: 'p' },
    })
    // Booth spots get a lamp object (lit by the renderer while a waiting agent sits there).
    expect(m.objects.some((o) => o.kind === 'booth-lamp')).toBe(true)
  })

  it('keeps modules without a plan empty and puts wall tops on the overhead layer', () => {
    const layout = layoutFor(['p'])
    const r = fakeResolver()
    const m = buildPixelMap(layout, wingPlan(), r)
    expect(m.rooms.every((x) => x.placement.startsWith('wing:'))).toBe(true)
    const above = tileAt(layout, 'wing:p:0', 0.25, -0.49, m)
    expect(idOf(r, 'overhead:')).toContain(m.layers.overhead[tileIndex(m, above)])
    expect(m.widthTiles * m.heightTiles).toBe(m.solid.length)
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
    expect(m.objects.filter((o) => capabilitySlot(o)).length).toBeGreaterThan(0)
    expect(blocked(m, spawnPoint(m, layout))).toBe(false)
  })
})
