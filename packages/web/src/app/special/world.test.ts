// The Night City manifest (graphics contract §14) → a world: placements, anchors, merged nav,
// rooms, colliders and interaction points. Pure.
import { describe, expect, it } from 'vitest'
import { astar } from '../navigation.ts'
import {
  buildSpecialWorld,
  collidersFromPlan,
  parseSpecialManifest,
  roomAt,
  SpecialManifestError,
} from './world.ts'

const anchor = (x: number, z: number, heading = 0, pose = 'stand', extra = {}) => ({
  x,
  y: 0,
  z,
  heading,
  pose,
  approach: { x, z: z - 0.6 },
  ...extra,
})

/** Two modules: an atrium (z −10..10) and a command room attached north (local z −5..5). */
function manifest(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    set: 'special',
    hash: 't1',
    modules: {
      'hq-atrium': {
        file: 'hq-atrium.glb',
        bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
        anchors: {
          'player:spawn': anchor(-8, 0, Math.PI / 2),
          'spot:elevator:0': anchor(-9, 0, Math.PI / 2),
          'interact:project-directory:0': anchor(0, -5),
        },
        nav: {
          nodes: {
            a: { x: -8, z: 0, width: 1 },
            b: { x: 0, z: 0, width: 1 },
            c: { x: 0, z: 10, width: 1 },
          },
          edges: [
            ['a', 'b'],
            ['b', 'c'],
          ],
        },
        plan: {
          rooms: [{ id: 'lobby', name: 'Atrium', rect: [-10, -10, 10, 10] }],
          walls: [{ a: [-10, -10], b: [10, -10], kind: 'curtain', thick: 0.2, side: 1 }],
          furniture: [{ kind: 'reception-desk', x: -4, z: 0, w: 4, d: 1, yaw: 0 }],
        },
      },
      command: {
        bounds: { minX: -6, maxX: 6, minZ: -5, maxZ: 5 },
        anchors: {
          'ws:0:1:0': anchor(-2, 0, 0, 'sit', { screen: 'ws:0:1:0' }),
          'interact:command-display:0': anchor(0, 2),
        },
        nav: {
          // Its south node sits on the atrium's north node: the two graphs join there.
          nodes: { s: { x: 0, z: -5, width: 1 }, m: { x: 0, z: 0, width: 1 } },
          edges: [['s', 'm']],
        },
        plan: {
          rooms: [{ id: 'ops', name: 'Command Center', rect: [-6, -5, 6, 5] }],
          walls: [],
          furniture: [],
        },
      },
      ...over,
    },
  }
}

describe('parseSpecialManifest', () => {
  it('accepts the special set with its own module kinds and anchor grammar', () => {
    const m = parseSpecialManifest(manifest())
    expect(Object.keys(m.modules)).toEqual(['hq-atrium', 'command'])
    expect(m.modules.command!.anchors['ws:0:1:0']!.pose).toBe('sit')
  })

  it('rejects the classic set, unknown kinds and bad anchors, naming the path', () => {
    expect(() => parseSpecialManifest({ ...manifest(), set: 'classic' })).toThrow(/set/)
    expect(() => parseSpecialManifest(manifest({ wing: manifest().modules.command }))).toThrow(
      SpecialManifestError,
    )
    const bad = manifest()
    ;(bad.modules.command.anchors as Record<string, unknown>)['desk:0'] = anchor(0, 0)
    expect(() => parseSpecialManifest(bad)).toThrow(/anchors\["desk:0"\]/)
    const pose = manifest()
    ;(pose.modules.command.anchors['ws:0:1:0'] as { pose: string }).pose = 'fly'
    expect(() => parseSpecialManifest(pose)).toThrow(/pose/)
  })

  it('needs an hq-atrium and a nav graph whose edges name its nodes', () => {
    const { 'hq-atrium': _a, ...rest } = manifest().modules
    expect(() => parseSpecialManifest({ ...manifest(), modules: rest })).toThrow(/hq-atrium/)
    const edges = manifest()
    edges.modules.command.nav.edges = [['s', 'zz']]
    expect(() => parseSpecialManifest(edges)).toThrow(/edges/)
  })
})

describe('buildSpecialWorld', () => {
  const world = buildSpecialWorld(parseSpecialManifest(manifest()))

  it('attaches the command room north of the atrium and joins their nav graphs', () => {
    const cmd = world.layout.placements.find((p) => p.id === 'command')!
    expect(cmd.position).toEqual({ x: 0, z: 15 })
    const ws = world.layout.anchors.get('command/ws:0:1:0')!
    expect(ws.pos).toEqual({ x: -2, z: 15 })
    expect(ws.screen).toBe('ws:0:1:0')
    const from = world.layout.anchors.get('hq-atrium/spot:elevator:0')!.navNode!
    expect(astar(world.layout.nav, from, ws.navNode!)).toBeDefined()
    expect(world.layout.bounds).toEqual({ minX: -10, maxX: 10, minZ: -10, maxZ: 20 })
  })

  it('honours an explicit placement', () => {
    const m = manifest()
    ;(m.modules.command as Record<string, unknown>).placement = { x: 30, z: 0, yaw: 0 }
    const w = buildSpecialWorld(parseSpecialManifest(m))
    expect(w.layout.anchors.get('command/ws:0:1:0')!.pos).toEqual({ x: 28, z: 0 })
  })

  it('lists rooms, interaction points and the player spawn in world space', () => {
    expect(world.rooms.map((r) => r.name)).toEqual(['Atrium', 'Command Center'])
    expect(roomAt(world, { x: 1, z: 16 })?.name).toBe('Command Center')
    expect(roomAt(world, { x: 99, z: 0 })).toBeNull()
    expect(world.interactables.map((i) => [i.kind, i.pos])).toEqual([
      ['project-directory', { x: 0, z: -5 }],
      ['command-display', { x: 0, z: 17 }],
    ])
    expect(world.spawn).toEqual({ pos: { x: -8, z: 0 }, heading: Math.PI / 2 })
  })

  it('turns walls (minus openings) and furniture into colliders', () => {
    expect(world.colliders.length).toBe(2)
    const desk = world.colliders.find((c) => c.maxY < 2)!
    expect(desk).toMatchObject({ minX: -6, maxX: -2, minZ: -0.5, maxZ: 0.5 })
  })
})

describe('collidersFromPlan', () => {
  it('splits a wall at its openings, offsets its body to its side, and rotates furniture', () => {
    const boxes = collidersFromPlan(
      {
        rooms: [],
        walls: [{ a: [0, 0], b: [10, 0], kind: 'solid', openings: [[4, 6]], side: 1, thick: 0.2 }],
        furniture: [{ kind: 'desk', x: 0, z: 0, w: 2, d: 1, yaw: Math.PI / 2 }],
      },
      { position: { x: 0, z: 0 }, yaw: 0 },
      3,
    )
    const walls = boxes.filter((b) => b.maxY === 3)
    expect(walls.map((w) => [w.minX, w.maxX])).toEqual([
      [0, 4],
      [6, 10],
    ])
    // The body is offset by side · thick / 2 along the (−dz, dx) normal (+z for a wall along +x).
    expect(walls[0]!.minZ).toBeCloseTo(0)
    expect(walls[0]!.maxZ).toBeCloseTo(0.2)
    const desk = boxes.find((b) => b.maxY < 3)!
    expect(desk.maxX - desk.minX).toBeCloseTo(1)
    expect(desk.maxZ - desk.minZ).toBeCloseTo(2)
  })
})
