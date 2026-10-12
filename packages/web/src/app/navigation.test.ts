import { describe, expect, it } from 'vitest'
import { fixtureManifest } from './__fixtures__/manifest.ts'
import { planBuilding } from './building.ts'
import { parseManifest, type Manifest } from './manifest.ts'
import {
  APPROACH_DIST,
  LANE_OFFSET,
  WALK_ACCEL,
  WALK_SPEED,
  astar,
  distanceToRoute,
  nearestNode,
  needsTurnInPlace,
  planRoute,
  routeToPath,
  sampleAt,
  smooth,
  timePath,
  type Route,
} from './navigation.ts'
import type { BuildingLayout, NavGraph, Vec2 } from './office-types.ts'

/** Builds a NavGraph from [id, x, z] nodes and edges. */
function graph(nodes: [string, number, number, number?][], edges: [string, string][]): NavGraph {
  const g: NavGraph = { nodes: new Map(), adj: new Map() }
  for (const [id, x, z, w] of nodes) (g.nodes.set(id, { id, pos: { x, z }, width: w ?? 1 }), g.adj.set(id, []))
  for (const [a, b] of edges) (g.adj.get(a)!.push(b), g.adj.get(b)!.push(a))
  return g
}

/** Dijkstra cost, as the reference for A* optimality. */
function dijkstra(g: NavGraph, from: string, to: string): number {
  const dist = new Map([[from, 0]])
  const done = new Set<string>()
  while (true) {
    let cur: string | undefined
    for (const [id, d] of dist) if (!done.has(id) && (cur === undefined || d < dist.get(cur)!)) cur = id
    if (cur === undefined) return Infinity
    if (cur === to) return dist.get(cur)!
    done.add(cur)
    for (const n of g.adj.get(cur)!) {
      const a = g.nodes.get(cur)!.pos
      const b = g.nodes.get(n)!.pos
      const nd = dist.get(cur)! + Math.hypot(a.x - b.x, a.z - b.z)
      if (nd < (dist.get(n) ?? Infinity)) dist.set(n, nd)
    }
  }
}

const cost = (g: NavGraph, ids: string[]) =>
  ids.slice(1).reduce((s, id, i) => {
    const a = g.nodes.get(ids[i]!)!.pos
    const b = g.nodes.get(id)!.pos
    return s + Math.hypot(a.x - b.x, a.z - b.z)
  }, 0)

const office = (m: Manifest): BuildingLayout =>
  planBuilding(
    [
      { provider: 'claude-code', agents: 30 },
      { provider: 'langgraph', agents: 3 },
      { provider: 'openai-agents', agents: 2 },
    ],
    m,
    undefined,
    0,
  )
const L = office(fixtureManifest)
const anchorsOf = (l: BuildingLayout, re: RegExp) => [...l.anchors.values()].filter((a) => re.test(a.local))

describe('astar', () => {
  it('finds the optimal path where a greedy walk would not', () => {
    // s → a looks closer to t, but the a-branch is a long detour.
    const g = graph(
      [
        ['s', 0, 0],
        ['a', 4, 0],
        ['a2', 4, 10],
        ['b', 0, 3],
        ['t', 6, 3],
      ],
      [
        ['s', 'a'],
        ['a', 'a2'],
        ['a2', 't'],
        ['s', 'b'],
        ['b', 't'],
      ],
    )
    expect(astar(g, 's', 't')).toEqual(['s', 'b', 't'])
    expect(astar(g, 's', 's')).toEqual(['s'])
    expect(astar(g, 's', 'missing')).toBeUndefined()
  })

  it('matches Dijkstra on the fixture building', () => {
    const ids = [...L.nav.nodes.keys()]
    for (let i = 0; i < 25; i++) {
      const a = ids[(i * 7919) % ids.length]!
      const b = ids[(i * 104729 + 13) % ids.length]!
      const path = astar(L.nav, a, b)!
      expect(cost(L.nav, path)).toBeCloseTo(dijkstra(L.nav, a, b), 9)
    }
  })

  it('returns undefined when the goal is unreachable', () => {
    const g = graph(
      [
        ['a', 0, 0],
        ['b', 5, 0],
      ],
      [],
    )
    expect(astar(g, 'a', 'b')).toBeUndefined()
    expect(planRoute(g, { x: 0, z: 0 }, { x: 5, z: 0 }, { fromNode: 'a', toNode: 'b' })).toBeUndefined()
    expect(nearestNode(graph([], []), { x: 0, z: 0 })).toBeUndefined()
    expect(planRoute(graph([], []), { x: 0, z: 0 }, { x: 1, z: 0 })).toBeUndefined()
  })
})

/** Every seat and spot must be reachable from every elevator spot. */
function checkReachability(l: BuildingLayout) {
  const elevators = anchorsOf(l, /^spot:elevator:/)
  expect(elevators.length).toBeGreaterThan(0)
  for (const e of elevators) {
    const seen = new Set([e.navNode!])
    const stack = [e.navNode!]
    while (stack.length) for (const n of l.nav.adj.get(stack.pop()!)!) if (!seen.has(n)) (seen.add(n), stack.push(n))
    for (const a of l.anchors.values()) expect(seen.has(a.navNode!), `${a.id} from ${e.id}`).toBe(true)
  }
}

describe('reachability', () => {
  it('reaches every seat and spot from every elevator spot (fixture)', () => {
    checkReachability(L)
  })

  // The real manifest is produced by the asset pipeline; check it whenever it exists.
  const real = import.meta.glob('../../public/assets/manifest.json', { eager: true, import: 'default' })
  const realJson = Object.values(real)[0]
  it.skipIf(!realJson)('reaches every seat and spot from every elevator spot (real manifest)', () => {
    checkReachability(office(parseManifest(realJson)))
  })
})

describe('planRoute + smooth', () => {
  const pairs = () => {
    const seats = anchorsOf(L, /^(seat|spot):/)
    return Array.from({ length: 30 }, (_, i) => [seats[(i * 37) % seats.length]!, seats[(i * 101 + 7) % seats.length]!] as const)
  }

  it('routes from anchor to anchor through their approach nodes', () => {
    const [a, b] = pairs()[3]!
    const r = planRoute(L.nav, a.pos, b.pos, { fromNode: a.navNode, toNode: b.navNode })!
    expect(r.points[0]).toEqual(a.pos)
    expect(r.points[1]).toEqual(L.nav.nodes.get(a.navNode!)!.pos)
    expect(r.points.at(-1)).toEqual(b.pos)
    expect(r.widths).toHaveLength(r.points.length - 1)
  })

  it('keeps the smoothed spline inside the corridor width', () => {
    for (const [a, b] of pairs()) {
      const r = planRoute(L.nav, a.pos, b.pos, { fromNode: a.navNode, toNode: b.navNode })!
      const pts = smooth(r)
      expect(pts[0]).toEqual(r.points[0])
      expect(pts.at(-1)).toEqual(r.points.at(-1))
      for (const p of pts) expect(distanceToRoute(r, p)).toBeLessThanOrEqual(1e-9 + maxWidth(r))
      for (let i = 1; i < pts.length; i++) expect(dist(pts[i - 1]!, pts[i]!)).toBeLessThanOrEqual(0.25 + 1e-9)
    }
  })

  it('stays within each segment’s own width', () => {
    for (const [a, b] of pairs()) {
      const r = planRoute(L.nav, a.pos, b.pos, { fromNode: a.navNode, toNode: b.navNode })!
      for (const p of smooth(r)) expect(withinCorridor(r, p)).toBe(true)
    }
  })

  it('picks a start node that avoids walking backwards mid-corridor', () => {
    const g = graph(
      [
        ['a', 0, 0],
        ['b', 10, 0],
        ['c', 20, 0],
      ],
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
    )
    // Standing at x = 4 (nearest node a), heading to c: the route should not go back to a.
    const r = planRoute(g, { x: 4, z: 0 }, { x: 20, z: 0 })!
    expect(r.points.some((p) => p.x === 0)).toBe(false)
  })

  it('starts along a given direction for continuity when re-planning mid-walk', () => {
    const g = graph(
      [
        ['a', 0, 0, 1.5],
        ['b', 0, 10, 1.5],
        ['c', 10, 10, 1.5],
      ],
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
    )
    const r = planRoute(g, { x: 0, z: 2 }, { x: 10, z: 10 }, { startDir: { x: 0, z: 1 } })!
    const pts = smooth(r)
    expect(pts[1]!.x).toBeCloseTo(0, 12)
    expect(pts[1]!.z).toBeGreaterThan(2)
  })

  it('keeps 0.35 m right of the corridor center on long segments', () => {
    const g = graph(
      [
        ['a', 0, 0, 1.5],
        ['b', 0, 20, 1.5],
      ],
      [['a', 'b']],
    )
    const north = smooth(planRoute(g, { x: 0, z: 0 }, { x: 0, z: 20 }, { fromNode: 'a', toNode: 'b' })!)
    const south = smooth(planRoute(g, { x: 0, z: 20 }, { x: 0, z: 0 }, { fromNode: 'b', toNode: 'a' })!)
    const mid = (pts: Vec2[]) => pts.reduce((best, p) => (Math.abs(p.z - 10) < Math.abs(best.z - 10) ? p : best))
    // Walking +z, the walker's right is −x; walking −z, it is +x.
    expect(mid(north).x).toBeCloseTo(-LANE_OFFSET, 6)
    expect(mid(south).x).toBeCloseTo(LANE_OFFSET, 6)
    // Endpoints stay on the nodes.
    expect(north[0]).toEqual({ x: 0, z: 0 })
    expect(north.at(-1)).toEqual({ x: 0, z: 20 })
  })

  it('skips the lane offset in corridors too narrow for it', () => {
    const g = graph(
      [
        ['a', 0, 0, 0.4],
        ['b', 0, 20, 0.4],
      ],
      [['a', 'b']],
    )
    for (const p of smooth(planRoute(g, { x: 0, z: 0 }, { x: 0, z: 20 }, { fromNode: 'a', toNode: 'b' })!))
      expect(p.x).toBeCloseTo(0, 9)
  })
})

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z)
const maxWidth = (r: Route) => Math.max(...r.widths)
function withinCorridor(r: Route, p: Vec2) {
  for (let i = 0; i + 1 < r.points.length; i++)
    if (segDist(r.points[i]!, r.points[i + 1]!, p) <= r.widths[i]! + 1e-9) return true
  return false
}
function segDist(a: Vec2, b: Vec2, p: Vec2) {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const l2 = dx * dx + dz * dz
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0
  return Math.hypot(a.x + t * dx - p.x, a.z + t * dz - p.z)
}

describe('timePath + sampleAt', () => {
  const straight = (len: number): Vec2[] => Array.from({ length: Math.round(len / 0.2) + 1 }, (_, i) => ({ x: 0, z: i * 0.2 }))

  it('respects vMax and accel, and stops at the end', () => {
    for (const len of [0.5, 3, 20]) {
      const tp = timePath(straight(len), { endHeading: 0 })
      expect(tp.totalLength).toBeCloseTo(len)
      let prevV = 0
      const dt = 0.01
      for (let t = 0; t <= tp.duration; t += dt) {
        const s = sampleAt(tp, t)
        expect(s.speed).toBeLessThanOrEqual(WALK_SPEED + 1e-9)
        expect(Math.abs(s.speed - prevV) / dt).toBeLessThanOrEqual(WALK_ACCEL + 1e-6)
        prevV = s.speed
      }
      const end = sampleAt(tp, tp.duration)
      expect(end.phase).toBe('arrived')
      expect(end.speed).toBe(0)
      expect(end.pos.z).toBeCloseTo(len)
    }
    // A long walk reaches cruise speed.
    const long = timePath(straight(20), { endHeading: 0 })
    expect(sampleAt(long, long.duration / 2).speed).toBeCloseTo(WALK_SPEED)
    expect(sampleAt(long, long.duration / 2).phase).toBe('walk')
  })

  it('slows down over the last 0.4 m (approach phase)', () => {
    const tp = timePath(straight(10), { endHeading: 0 })
    const t = tp.duration - 0.1
    const s = sampleAt(tp, t)
    expect(s.phase).toBe('approach')
    expect(10 - s.pos.z).toBeLessThan(APPROACH_DIST)
    expect(s.speed).toBeLessThan(WALK_SPEED)
  })

  it('keeps the start speed when re-planned mid-walk, and handles a too-short stop', () => {
    const tp = timePath(straight(10), { endHeading: 0, startSpeed: 1.2 })
    expect(sampleAt(tp, 0).speed).toBeCloseTo(1.2, 12)
    const short = timePath(straight(0.2), { endHeading: 0, startSpeed: 1.4 })
    expect(sampleAt(short, 0).speed).toBeCloseTo(1.4, 12)
    expect(sampleAt(short, short.duration).pos.z).toBeCloseTo(0.2)
    expect(sampleAt(short, short.duration / 2).speed).toBeLessThan(1.4)
  })

  it('turns in place first when the path starts more than 100° off', () => {
    const behind = timePath(straight(5), { endHeading: 0, startHeading: Math.PI })
    expect(behind.turnDuration).toBeGreaterThan(0)
    const s = sampleAt(behind, behind.turnDuration! / 2)
    expect(s.phase).toBe('turn')
    expect(s.speed).toBe(0)
    expect(s.pos).toEqual({ x: 0, z: 0 })
    expect(sampleAt(behind, behind.turnDuration! + 0.01).phase).toBe('walk')
    const side = timePath(straight(5), { endHeading: 0, startHeading: Math.PI / 2 })
    expect(side.turnDuration ?? 0).toBe(0)
    // Already walking: never turn in place.
    expect(timePath(straight(5), { endHeading: 0, startHeading: Math.PI, startSpeed: 1 }).turnDuration ?? 0).toBe(0)
    expect(needsTurnInPlace(0, (101 * Math.PI) / 180)).toBe(true)
    expect(needsTurnInPlace(0, (99 * Math.PI) / 180)).toBe(false)
    expect(needsTurnInPlace(3, -3)).toBe(false)
  })

  it('reports heading along the path and handles degenerate paths', () => {
    const tp = timePath(
      [
        { x: 0, z: 0 },
        { x: 5, z: 0 },
      ],
      { endHeading: 1 },
    )
    expect(sampleAt(tp, 0.5).heading).toBeCloseTo(Math.PI / 2)
    const empty = timePath([{ x: 1, z: 1 }], { endHeading: 2 })
    expect(empty.duration).toBe(0)
    expect(sampleAt(empty, 0)).toMatchObject({ pos: { x: 1, z: 1 }, heading: 2, speed: 0, phase: 'arrived' })
    expect(sampleAt(tp, -1).pos).toEqual({ x: 0, z: 0 })
  })

  it('routeToPath plans, smooths and times a walk between anchors', () => {
    const [a, b] = [L.anchors.get('wing:claude-code:0/seat:desk:1:0')!, L.anchors.get('atrium/spot:elevator:0')!]
    const tp = routeToPath(L.nav, a.pos, b, { startHeading: a.heading })!
    expect(tp.points[0]).toEqual(a.pos)
    expect(tp.points.at(-1)).toEqual(b.pos)
    expect(tp.endHeading).toBe(b.heading)
    expect(tp.duration).toBeGreaterThan(tp.totalLength / WALK_SPEED)
    expect(routeToPath(graph([], []), a.pos, b)).toBeUndefined()
  })
})
