// The stand-in Night City manifest: valid, complete (R1 anchors) and walkable end to end.
import { describe, expect, it } from 'vitest'
import { astar } from '../../app/navigation.ts'
import { buildSpecialWorld, parseSpecialManifest } from '../../app/special/world.ts'
import { DEPARTMENT_RECTS, fixtureManifest } from './manifest.ts'

const world = buildSpecialWorld(parseSpecialManifest(fixtureManifest()))
const locals = [...world.layout.anchors.values()].map((a) => a.local)
const count = (re: RegExp) => locals.filter((l) => re.test(l)).length

describe('fixture manifest', () => {
  it('has the R1 anchors: 6 departments × 24 workstations, 4 booths, 2 × 6 meeting seats', () => {
    expect(DEPARTMENT_RECTS).toHaveLength(6)
    expect(count(/^ws:/)).toBe(144)
    expect(count(/^booth:/)).toBe(4)
    expect(count(/^meet:A:/)).toBe(6)
    expect(count(/^meet:B:/)).toBe(6)
    expect(count(/^spot:elevator:/)).toBe(4)
    expect(count(/^seat:lounge:/)).toBe(8)
    expect(world.interactables.map((i) => i.kind).sort()).toEqual([
      'command-display',
      'project-directory',
      'provider-terminal',
      'provider-terminal',
    ])
    expect(world.spawn.pos).toEqual({ x: -15.6, z: 0 })
  })

  it('every anchor is reachable from the elevators over one connected nav graph', () => {
    const start = world.layout.anchors.get('hq-atrium/spot:elevator:0')!.navNode!
    const unreachable = [...world.layout.anchors.values()].filter(
      (a) => a.navNode && !astar(world.layout.nav, start, a.navNode),
    )
    expect(unreachable.map((a) => a.id)).toEqual([])
  })

  it('approach points are not inside furniture or walls', () => {
    const inside = [...world.layout.anchors.values()].filter((a) =>
      world.colliders.some(
        (c) =>
          c.maxY > 0.3 &&
          a.approach.x > c.minX &&
          a.approach.x < c.maxX &&
          a.approach.z > c.minZ &&
          a.approach.z < c.maxZ,
      ),
    )
    expect(inside.map((a) => a.id)).toEqual([])
  })

  it('names the rooms the HUD shows', () => {
    expect(world.rooms.map((r) => r.name)).toContain('Meridian Atrium')
    expect(world.rooms.map((r) => r.name)).toContain('Project Command Center')
    expect(world.rooms.map((r) => r.name)).toContain('Meeting Room A')
  })
})
