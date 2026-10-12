import { describe, expect, it } from 'vitest'
import { fixtureManifest } from '../__fixtures__/manifest.ts'
import { planBuilding } from '../building.ts'
import { PIXEL_COPY } from '../pixel-copy.ts'
import { buildPixelMap } from './map.ts'
import { toTile } from './project.ts'
import { placementAt, roomAt, roomLabel, viewIdAt, viewIdOf } from './rooms.ts'

const layout = planBuilding([{ provider: 'p', agents: 1 }], fixtureManifest, undefined, 0)
const map = buildPixelMap(
  layout,
  {
    wing: {
      rooms: [
        { id: 'wing', name: 'Open floor', rect: [0, -2, 20, 10] },
        { id: 'pod-2', name: 'Pod 2', rect: [2, 2, 6, 6] },
      ],
      walls: [],
      furniture: [],
    },
    atrium: {
      rooms: [{ id: 'cafe', name: 'Cafe', rect: [-4, -10, 4, -4] }],
      walls: [],
      furniture: [],
    },
  },
  { tile: () => 1 },
)
const wing = layout.placements.find((p) => p.id === 'wing:p:0')!
const world = (x: number, z: number) => ({ x: x + wing.position.x, z: z + wing.position.z })

describe('rooms (HUD-1)', () => {
  it('finds the innermost room at a tile', () => {
    expect(roomAt(map, toTile(world(3, 3), map))?.name).toBe('Pod 2')
    expect(roomAt(map, toTile(world(10, 8), map))?.name).toBe('Open floor')
    expect(roomAt(map, { tx: 0, ty: 0 })).toBeUndefined()
  })

  it('labels the room for the HUD with the wing sign, or the module name', () => {
    expect(roomLabel(map, layout, toTile(world(3, 3), map))).toBe('p · Pod 2')
    expect(roomLabel(map, layout, toTile({ x: 0, z: -6 }, map))).toBe('Cafe')
    expect(roomLabel(map, layout, { tx: 0, ty: 0 })).toBe('')
    const bare = buildPixelMap(
      layout,
      {
        atrium: {
          rooms: [{ id: 'x', name: '', rect: [-4, -10, 4, -4] }],
          walls: [],
          furniture: [],
        },
      },
      { tile: () => 1 },
    )
    expect(roomLabel(bare, layout, toTile({ x: 0, z: -6 }, bare))).toBe(PIXEL_COPY.hud.lobby)
  })

  it('maps placements and tiles to view-bar ids', () => {
    expect(viewIdOf(wing)).toBe('wing:p:0')
    expect(viewIdOf(layout.placements.find((p) => p.kind === 'atrium')!)).toBe('atrium')
    expect(viewIdOf(layout.placements.find((p) => p.kind === 'street')!)).toBe('street')
    expect(viewIdOf(layout.placements.find((p) => p.kind === 'cap')!)).toBe('overview')
    expect(viewIdAt(map, layout, toTile(world(3, 3), map))).toBe('wing:p:0')
    expect(viewIdAt(map, layout, { tx: 0, ty: 0 })).toBe('overview')
  })

  it('finds the placement under a world point', () => {
    expect(placementAt(layout, fixtureManifest, world(5, 0))?.id).toBe('wing:p:0')
    expect(placementAt(layout, fixtureManifest, { x: 0, z: -10 })?.id).toBe('atrium')
    expect(placementAt(layout, fixtureManifest, { x: 500, z: 0 })).toBeUndefined()
  })
})
