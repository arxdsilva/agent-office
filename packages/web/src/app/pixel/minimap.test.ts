import { STATUS_COLORS } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { fixtureManifest } from '../__fixtures__/manifest.ts'
import { planBuilding } from '../building.ts'
import { PIXEL_COPY } from '../pixel-copy.ts'
import { minimapLabels, minimapVM } from './minimap.ts'
import { projectionFor, toTile } from './project.ts'
import type { PlanByModule } from './types.ts'

const layout = planBuilding(
  [
    { provider: 'p', agents: 1 },
    { provider: 'q', agents: 1 },
  ],
  fixtureManifest,
  undefined,
  0,
)
const proj = projectionFor(layout.bounds)
const plans: PlanByModule = {
  wing: {
    rooms: [
      { id: 'hall', name: 'Hall', rect: [0, -2, 20, 10] },
      { id: 'kitchen', name: 'Kitchen', rect: [2, 2, 6, 6] },
      { id: 'meeting-A', name: 'Meeting room A', rect: [10, 2, 14, 6] },
      { id: 'pod-1', name: 'Pod 1', rect: [14, 2, 18, 6] },
    ],
    walls: [],
    furniture: [],
  },
  atrium: {
    rooms: [{ id: 'plaza', name: 'Plaza', rect: [-4, -10, 4, -4] }],
    walls: [],
    furniture: [],
  },
  street: {
    rooms: [{ id: 'street', name: 'Main Street', rect: [-3, 0, 3, 10] }],
    walls: [],
    furniture: [],
  },
}

describe('minimap VM (MM)', () => {
  // MM-1: one label per wing (its provider) and the major rooms; pods and halls stay unlabelled.
  it('labels wings and major rooms', () => {
    const labels = minimapLabels(layout, plans, proj)
    const wings = labels.filter((l) => l.kind === 'wing').map((l) => l.text)
    expect(wings.sort()).toEqual(['p', 'q'])
    const rooms = labels.filter((l) => l.kind === 'room').map((l) => l.text)
    expect(rooms.filter((t) => t === 'Kitchen')).toHaveLength(2)
    expect(rooms).toContain('Meeting A')
    expect(rooms).toContain(PIXEL_COPY.hud.lobby)
    expect(rooms.filter((t) => t === PIXEL_COPY.hud.street)).toHaveLength(1)
    expect(rooms).not.toContain('Pod 1')
    expect(rooms).not.toContain('Hall')
    // Labels sit at the room's centre, in tiles.
    const wing = layout.placements.find((p) => p.id === 'wing:p:0')!
    const kitchens = labels.filter((l) => l.text === 'Kitchen')
    const c = toTile({ x: wing.position.x + 4, z: wing.position.z + 4 }, proj)
    expect(kitchens.some((k) => Math.abs(k.tx - c.tx) <= 1 && Math.abs(k.ty - c.ty) <= 1)).toBe(
      true,
    )
    for (const l of labels) {
      expect(l.tx).toBeGreaterThanOrEqual(0)
      expect(l.ty).toBeGreaterThanOrEqual(0)
      expect(l.tx).toBeLessThan(proj.widthTiles)
      expect(l.ty).toBeLessThan(proj.heightTiles)
    }
    expect(minimapLabels(layout, {}, proj)).toEqual([])
  })

  // MM-2: the camera's viewport passes through, clamped to the map.
  it('carries the viewport rect', () => {
    const vm = minimapVM(proj, [], undefined, { viewport: { tx: -3, ty: 2, tw: 30, th: 17 } })
    expect(vm.viewport).toEqual({ tx: 0, ty: 2, tw: 27, th: 17 })
    const big = minimapVM(proj, [], undefined, {
      viewport: { tx: 0, ty: 0, tw: proj.widthTiles + 50, th: proj.heightTiles + 50 },
    })
    expect(big.viewport).toEqual({ tx: 0, ty: 0, tw: proj.widthTiles, th: proj.heightTiles })
    expect(minimapVM(proj, []).viewport).toBeUndefined()
  })

  // MM-3: waiting and error dots are flagged (drawn larger and pulsing).
  it('flags waiting and error agents', () => {
    const vm = minimapVM(
      proj,
      [
        { id: 'a', pos: { x: 0, z: 0 }, status: 'waiting' },
        { id: 'b', pos: { x: 0, z: 0 }, status: 'error' },
        { id: 'c', pos: { x: 0, z: 0 }, status: 'thinking' },
      ],
      undefined,
      { flags: true, labels: [{ text: 'p', tx: 1, ty: 1, kind: 'wing' }] },
    )
    expect(vm.dots.map((d) => [d.id, !!d.waiting, !!d.error])).toEqual([
      ['a', true, false],
      ['b', false, true],
      ['c', false, false],
    ])
    expect(vm.dots[2]).toEqual({
      id: 'c',
      ...toTile({ x: 0, z: 0 }, proj),
      color: STATUS_COLORS.thinking,
    })
    expect(vm.labels).toEqual([{ text: 'p', tx: 1, ty: 1, kind: 'wing' }])
  })

  // MM-4: the player's tile.
  it('marks the player tile', () => {
    const vm = minimapVM(proj, [], { x: 1, z: 2 }, { flags: true })
    expect(vm.player).toEqual(toTile({ x: 1, z: 2 }, proj))
  })
})
