import { describe, expect, it } from 'vitest'
import type { Manifest } from './manifest.ts'
import type { ModulePlacement } from './office-types.ts'
import type { ModulePlan } from './pixel/types.ts'
import {
  hoverWall,
  nextWallMode,
  occluders,
  wallMid,
  WALL_FADED,
  WallFader,
  wallBases,
  wallBoxes,
  type WallBox,
} from './walls.ts'

// A wing-like plan: a 10 m wall along x (body on +z, 0.2 m), and a glass wall along z with a door.
const wingPlan: ModulePlan = {
  rooms: [],
  furniture: [],
  walls: [
    { a: [0, 0], b: [10, 0], kind: 'solid', side: 1, thick: 0.2, id: 1, h: 3 },
    { a: [5, 0], b: [5, 6], kind: 'glass', openings: [[2, 3]], side: 1, thick: 0.1, id: 2, h: 3 },
  ],
}
const atriumPlan: ModulePlan = {
  rooms: [],
  furniture: [],
  walls: [{ a: [-5, 0], b: [5, 0], kind: 'solid', side: -1, thick: 0.2 }],
}
const manifest = {
  modules: {
    atrium: { plan: atriumPlan },
    street: { plan: { rooms: [], walls: [], furniture: [] } },
    garden: {},
    cap: {},
    wing: { plan: wingPlan },
  },
} as unknown as Manifest

const at = (id: string, kind: ModulePlacement['kind'], x: number, z: number, yaw = 0) =>
  ({ id, kind, position: { x, z }, yaw }) as ModulePlacement

const placements = [
  at('atrium', 'atrium', 0, 0),
  at('street:0', 'street', 0, 0),
  at('wing:a:0', 'wing', 3, 0, Math.PI / 2),
]

describe('wallBoxes', () => {
  it('numbers walls globally in placement order and records each module base', () => {
    const boxes = wallBoxes(manifest, placements)
    expect(boxes.map((b) => [b.id, b.module, b.local])).toEqual([
      [1, 'atrium', 1],
      [2, 'wing:a:0', 1],
      [3, 'wing:a:0', 2],
    ])
    expect(wallBases(manifest, placements)).toEqual({
      bases: new Map([
        ['atrium', 0],
        ['wing:a:0', 1],
      ]),
      total: 3,
    })
  })

  it('offsets the box to the side its body is on, then places it with the module yaw', () => {
    const [atrium, wing] = wallBoxes(manifest, placements)
    // Atrium: side −1 → the body centre is 0.1 m towards −z.
    expect(atrium!.a).toEqual({ x: -5, z: -0.1 })
    expect(atrium!.b).toEqual({ x: 5, z: -0.1 })
    expect(atrium!.h).toBe(3.6) // no h in the plan: the default storey height
    // Wing at x = 3, yaw π/2 (local +x → world −z): (0, 0.1) → (3.1, 0), (10, 0.1) → (3.1, −10).
    expect(wing!.a.x).toBeCloseTo(3.1)
    expect(wing!.a.z).toBeCloseTo(0)
    expect(wing!.b.x).toBeCloseTo(3.1)
    expect(wing!.b.z).toBeCloseTo(-10)
    expect(wing!.yaw).toBeCloseTo(Math.PI / 2)
    expect(wing!.thick).toBe(0.2)
    expect(wing!.y0).toBe(0)
  })

  it('returns no boxes without plans', () => {
    const bare = { modules: { atrium: {}, street: {}, garden: {}, cap: {}, wing: {} } }
    expect(wallBoxes(bare as unknown as Manifest, placements)).toEqual([])
  })
})

// One wall at z = 0 from x = 0 to 10 (body centred), 3 m high, with a door at x ∈ [4, 5].
const wall: WallBox = {
  id: 1,
  module: 'm',
  local: 1,
  a: { x: 0, z: 0 },
  b: { x: 10, z: 0 },
  thick: 0.2,
  y0: 0,
  h: 3,
  yaw: 0,
  openings: [[4, 5]],
}
const far: WallBox = { ...wall, id: 2, a: { x: 0, z: -4 }, b: { x: 10, z: -4 }, openings: [] }

describe('hoverWall', () => {
  it('returns the nearest wall the ray hits', () => {
    const ray = { o: { x: 2, y: 1.5, z: 5 }, d: { x: 0, y: 0, z: -1 } }
    expect(hoverWall([far, wall], ray)).toBe(1)
  })

  it('misses above the wall top and beside its ends', () => {
    expect(hoverWall([wall], { o: { x: 2, y: 3.5, z: 5 }, d: { x: 0, y: 0, z: -1 } })).toBeNull()
    expect(hoverWall([wall], { o: { x: 11, y: 1, z: 5 }, d: { x: 0, y: 0, z: -1 } })).toBeNull()
    // Pointing away.
    expect(hoverWall([wall], { o: { x: 2, y: 1, z: 5 }, d: { x: 0, y: 0, z: 1 } })).toBeNull()
  })

  it('hits a wall seen from above (orbit view) through its top', () => {
    const d = { x: 0, y: -1, z: 0 }
    expect(hoverWall([wall], { o: { x: 3, y: 20, z: 0.05 }, d })).toBe(1)
  })
})

describe('occluders', () => {
  const cam = { x: 2, y: 8, z: 12 }
  it('lists the walls between the camera and a target', () => {
    const target = { x: 2, y: 1, z: -2 }
    expect([...occluders([wall, far], cam, [target])]).toEqual([1])
  })

  it('ignores a target in front of the wall and the camera above every wall', () => {
    expect(occluders([wall], cam, [{ x: 2, y: 1, z: 2 }]).size).toBe(0)
    expect(occluders([wall], { x: 2, y: 30, z: -2.5 }, [{ x: 2, y: 1, z: -2 }]).size).toBe(0)
  })

  it('counts a sight line that grazes the wall within the pad', () => {
    // Passes 0.1 m beyond the wall's end (x = 10): a hit with the 0.15 m pad, a miss with none.
    const target = { x: 10.1, y: 1, z: -2 }
    const c = { x: 10.1, y: 1, z: 6 }
    expect(occluders([wall], c, [target]).has(1)).toBe(true)
    expect(occluders([wall], c, [target], 0).has(1)).toBe(false)
  })

  it('looks through a door opening below the lintel', () => {
    const c = { x: 4.5, y: 1, z: 6 }
    expect(occluders([wall], c, [{ x: 4.5, y: 1, z: -2 }]).size).toBe(0)
  })

  it('does not count a wall the target stands against on the camera side', () => {
    expect(occluders([wall], cam, [{ x: 2, y: 1, z: 0.35 }]).size).toBe(0)
  })
})

describe('WallFader', () => {
  const opts = { fadeMs: 200, occludeInMs: 80, occludeOutMs: 250, hoverGraceMs: 150 }
  const none = new Set<number>()

  it('Up: the hovered wall eases to the faded alpha over 200 ms, then back', () => {
    const f = new WallFader(opts)
    f.resize(2)
    expect(f.step(0, { mode: 'up', hovered: 1, occluding: none }).alpha[1]).toBe(1)
    const mid = f.step(100, { mode: 'up', hovered: 1, occluding: none })
    expect(mid.alpha[1]).toBeCloseTo(1 - (1 - WALL_FADED) / 2, 5)
    expect(mid.changed).toBe(true)
    expect(f.step(200, { mode: 'up', hovered: 1, occluding: none }).alpha[1]).toBeCloseTo(
      WALL_FADED,
    )
    expect(f.step(250, { mode: 'up', hovered: 1, occluding: none }).changed).toBe(false)
    // Occluders don't matter in Up.
    expect(f.step(500, { mode: 'up', hovered: 1, occluding: new Set([2]) }).alpha[2]).toBe(1)
  })

  it('keeps a wall faded for the hover grace after the pointer leaves', () => {
    const f = new WallFader(opts)
    f.resize(1)
    f.step(0, { mode: 'up', hovered: 1, occluding: none })
    f.step(300, { mode: 'up', hovered: 1, occluding: none })
    expect(f.step(400, { mode: 'up', hovered: null, occluding: none }).alpha[1]).toBeCloseTo(
      WALL_FADED,
    )
    expect(f.step(440, { mode: 'up', hovered: null, occluding: none }).alpha[1]).toBeCloseTo(
      WALL_FADED,
    )
    // Grace over at 450: the fade back starts, and takes 200 ms.
    expect(f.step(460, { mode: 'up', hovered: null, occluding: none }).alpha[1]).toBeCloseTo(
      WALL_FADED,
    )
    expect(f.step(560, { mode: 'up', hovered: null, occluding: none }).alpha[1]).toBeCloseTo(
      0.54,
      2,
    )
    expect(f.step(660, { mode: 'up', hovered: null, occluding: none }).alpha[1]).toBe(1)
  })

  it('Cutaway: occlusion fades in after 80 ms and out after 250 ms (no flicker)', () => {
    const f = new WallFader(opts)
    f.resize(1)
    const occ = new Set([1])
    const s = (now: number, o: Set<number>) =>
      f.step(now, { mode: 'cutaway', hovered: null, occluding: o }).alpha[1]
    expect(s(0, occ)).toBe(1)
    expect(s(50, none)).toBe(1) // a 50 ms blip never starts a fade
    expect(s(60, occ)).toBe(1)
    expect(s(130, occ)).toBe(1) // 70 ms continuous: still waiting
    expect(s(140, occ)).toBe(1) // 80 ms: the fade starts now
    expect(s(340, occ)).toBeCloseTo(WALL_FADED)
    expect(s(400, none)).toBeCloseTo(WALL_FADED) // gaps shorter than 250 ms keep it faded
    expect(s(500, occ)).toBeCloseTo(WALL_FADED)
    expect(s(600, none)).toBeCloseTo(WALL_FADED)
    expect(s(849, none)).toBeCloseTo(WALL_FADED)
    expect(s(850, none)).toBeCloseTo(WALL_FADED) // 250 ms clear: the fade back starts
    expect(s(1050, none)).toBe(1)
  })

  it('Cutaway: the hovered wall fades too', () => {
    const f = new WallFader(opts)
    f.resize(1)
    f.step(0, { mode: 'cutaway', hovered: 1, occluding: none })
    expect(f.step(200, { mode: 'cutaway', hovered: 1, occluding: none }).alpha[1]).toBeCloseTo(
      WALL_FADED,
    )
  })

  it('Down: every wall is lowered, nothing fades, hover does nothing', () => {
    const f = new WallFader(opts)
    f.resize(3)
    const r = f.step(0, { mode: 'down', hovered: 2, occluding: new Set([1]) })
    expect([...r.lowered]).toEqual([0, 1, 1, 1])
    expect(r.changed).toBe(true)
    const later = f.step(300, { mode: 'down', hovered: 2, occluding: new Set([1]) })
    expect([...later.alpha]).toEqual([1, 1, 1, 1])
    expect(later.changed).toBe(false)
    expect([...f.step(400, { mode: 'up', hovered: null, occluding: none }).lowered]).toEqual([
      0, 0, 0, 0,
    ])
  })

  it('resizes to a new wall count with every wall solid and reports a change', () => {
    const f = new WallFader(opts)
    f.resize(1)
    f.step(0, { mode: 'up', hovered: 1, occluding: none })
    f.step(300, { mode: 'up', hovered: 1, occluding: none })
    f.resize(2)
    const r = f.step(310, { mode: 'up', hovered: null, occluding: none })
    expect(r.alpha.length).toBe(3)
    expect(r.alpha[1]).toBe(1)
    expect(r.changed).toBe(true)
    // Ids out of range are ignored.
    expect(() =>
      f.step(320, { mode: 'cutaway', hovered: 9, occluding: new Set([7]) }),
    ).not.toThrow()
  })

  it('is active while any wall is faded, fading or lowered (the shader compiles the cut in only then)', () => {
    const f = new WallFader(opts)
    f.resize(2)
    expect(f.step(0, { mode: 'up', hovered: null, occluding: none }).active).toBe(false)
    // The target changes on this step: active at once, before the alpha moves.
    expect(f.step(10, { mode: 'up', hovered: 1, occluding: none }).active).toBe(true)
    f.step(300, { mode: 'up', hovered: null, occluding: none })
    expect(f.step(450, { mode: 'up', hovered: null, occluding: none }).active).toBe(true)
    expect(f.step(700, { mode: 'up', hovered: null, occluding: none }).active).toBe(false)
    expect(f.step(710, { mode: 'down', hovered: null, occluding: none }).active).toBe(true)
  })

  it('handles a clock that jumps backwards', () => {
    const f = new WallFader(opts)
    f.resize(1)
    f.step(1000, { mode: 'up', hovered: 1, occluding: none })
    expect(f.step(500, { mode: 'up', hovered: 1, occluding: none }).alpha[1]).toBe(1)
  })
})

describe('nextWallMode and wallMid', () => {
  it('cycles Up → Cutaway → Down → Up', () => {
    expect(['up', 'cutaway', 'down'].map((m) => nextWallMode(m as 'up'))).toEqual([
      'cutaway',
      'down',
      'up',
    ])
  })
  it('puts the mid-point at the wall centre, half its (capped) height', () => {
    expect(wallMid(wall)).toEqual({ x: 5, y: 1.5, z: 0 })
    expect(new WallFader().total).toBe(0)
  })
})
