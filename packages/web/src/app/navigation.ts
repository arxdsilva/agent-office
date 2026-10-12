// Path finding and walking: A* over the merged nav graph, centripetal Catmull-Rom smoothing kept
// inside the corridors, lanes on long segments, and a trapezoidal speed profile. Pure; seconds.
import { normalizeAngle } from './building.ts'
import type { NavGraph, TimedPath, Vec2 } from './office-types.ts'

/** Cruise walking speed (m/s): the `Walk` clip is authored for it. */
export const WALK_SPEED = 1.4
/** Acceleration from rest (m/s²). */
export const WALK_ACCEL = 3.5
/** Agents slow down over the last 0.4 m. */
export const APPROACH_DIST = 0.4
/** Turns larger than this (degrees) happen in place before walking. */
export const TURN_IN_PLACE_DEG = 100
/** In-place turn rate: `TurnL90`/`TurnR90` is 20 frames at 30 fps for 90°. */
export const TURN_RATE = Math.PI / 2 / (20 / 30)
/** Walkers keep this far right of the corridor center on long segments. */
export const LANE_OFFSET = 0.35
/** Segments shorter than this (m) keep to the center. */
export const LANE_MIN_SEGMENT = 5
/** A corridor must be at least LANE_OFFSET + this wide (half-width) for lanes. */
export const LANE_MARGIN = 0.25
/** Spline samples are at most this far apart (m). */
export const SAMPLE_STEP = 0.12
/** When re-planning mid-walk the route first continues straight for this long (m). */
export const LEAD_DIST = 0.5

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z)

export function nearestNode(nav: NavGraph, p: Vec2): string | undefined {
  let best: string | undefined
  let bestD = Infinity
  for (const n of nav.nodes.values()) {
    const d = dist(n.pos, p)
    if (d < bestD) (bestD = d), (best = n.id)
  }
  return best
}

/** A* with the Euclidean heuristic. Returns node ids from `from` to `to`, or undefined. */
export function astar(nav: NavGraph, from: string, to: string): string[] | undefined {
  const goal = nav.nodes.get(to)
  if (!goal || !nav.nodes.has(from)) return undefined
  const h = (id: string) => dist(nav.nodes.get(id)!.pos, goal.pos)
  const g = new Map([[from, 0]])
  const came = new Map<string, string>()
  const heap: [number, string][] = [[h(from), from]]
  const closed = new Set<string>()
  while (heap.length) {
    const [, cur] = pop(heap)
    if (closed.has(cur)) continue
    if (cur === to) {
      const path = [cur]
      for (let c = cur; came.has(c); ) path.push((c = came.get(c)!))
      return path.reverse()
    }
    closed.add(cur)
    const p = nav.nodes.get(cur)!.pos
    for (const n of nav.adj.get(cur) ?? []) {
      if (closed.has(n)) continue
      const ng = g.get(cur)! + dist(p, nav.nodes.get(n)!.pos)
      if (ng < (g.get(n) ?? Infinity)) {
        g.set(n, ng)
        came.set(n, cur)
        push(heap, [ng + h(n), n])
      }
    }
  }
  return undefined
}

function push(heap: [number, string][], item: [number, string]) {
  heap.push(item)
  for (let i = heap.length - 1; i > 0; ) {
    const parent = (i - 1) >> 1
    if (heap[parent]![0] <= heap[i]![0]) break
    ;[heap[parent], heap[i]] = [heap[i]!, heap[parent]!]
    i = parent
  }
}

function pop(heap: [number, string][]): [number, string] {
  const top = heap[0]!
  const last = heap.pop()!
  if (heap.length) {
    heap[0] = last
    for (let i = 0; ; ) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l
      if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r
      if (m === i) break
      ;[heap[m], heap[i]] = [heap[i]!, heap[m]!]
      i = m
    }
  }
  return top
}

/** A polyline along corridor centers; `widths[i]` is the half-width of segment i → i+1. */
export interface Route {
  points: Vec2[]
  widths: number[]
}

export interface RouteOptions {
  /** Graph node to join from `from` (e.g. the current seat's approach node). Default: best nearby node. */
  fromNode?: string
  /** Graph node to leave the graph at (the target anchor's approach node). Default: nearest to `to`. */
  toNode?: string
  /** Continue straight along this unit direction first (re-planning mid-walk keeps velocity). */
  startDir?: Vec2
}

const pathCost = (nav: NavGraph, ids: string[]) =>
  ids.slice(1).reduce((s, id, i) => s + dist(nav.nodes.get(ids[i]!)!.pos, nav.nodes.get(id)!.pos), 0)

export function planRoute(nav: NavGraph, from: Vec2, to: Vec2, opts: RouteOptions = {}): Route | undefined {
  const toNode = opts.toNode ?? nearestNode(nav, to)
  if (toNode === undefined) return undefined
  const lead = opts.startDir && { x: from.x + opts.startDir.x * LEAD_DIST, z: from.z + opts.startDir.z * LEAD_DIST }
  const origin = lead ?? from
  const n0 = opts.fromNode ?? nearestNode(nav, origin)!
  // Joining the graph at a neighbour of the nearest node avoids walking back to it mid-corridor.
  const candidates = opts.fromNode ? [n0] : [n0, ...(nav.adj.get(n0) ?? [])]
  let best: string[] | undefined
  let bestCost = Infinity
  for (const c of candidates) {
    const p = astar(nav, c, toNode)
    if (!p) continue
    const cost = dist(origin, nav.nodes.get(c)!.pos) + pathCost(nav, p)
    if (cost < bestCost - 1e-9) (bestCost = cost), (best = p)
  }
  if (!best) return undefined
  const nodes = best.map((id) => nav.nodes.get(id)!)
  const points: Vec2[] = [from]
  const widths: number[] = []
  const add = (p: Vec2, w: number) => {
    if (dist(points.at(-1)!, p) < 1e-6) {
      if (widths.length) widths[widths.length - 1] = Math.min(widths.at(-1)!, w)
      return
    }
    points.push(p)
    widths.push(w)
  }
  if (lead) add(lead, nodes[0]!.width)
  nodes.forEach((n, i) => add(n.pos, i ? Math.min(n.width, nodes[i - 1]!.width) : n.width))
  add(to, nodes.at(-1)!.width)
  return { points, widths }
}

function segDist(a: Vec2, b: Vec2, p: Vec2): { d: number; q: Vec2 } {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const l2 = dx * dx + dz * dz
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0
  const q = { x: a.x + t * dx, z: a.z + t * dz }
  return { d: dist(q, p), q }
}

/** Distance from `p` to the route polyline. */
export function distanceToRoute(r: Route, p: Vec2): number {
  let d = r.points.length === 1 ? dist(r.points[0]!, p) : Infinity
  for (let i = 0; i + 1 < r.points.length; i++) d = Math.min(d, segDist(r.points[i]!, r.points[i + 1]!, p).d)
  return d
}

/** Pulls `p` back inside the corridor of the nearest segment if it strayed out. */
function clampToCorridor(r: Route, p: Vec2): Vec2 {
  let best = { over: Infinity, q: p, w: 0, d: 0 }
  for (let i = 0; i + 1 < r.points.length; i++) {
    const { d, q } = segDist(r.points[i]!, r.points[i + 1]!, p)
    const w = r.widths[i]!
    if (d <= w) return p
    if (d - w < best.over) best = { over: d - w, q, w, d }
  }
  if (best.over === Infinity) return p
  const k = (best.w * 0.99) / best.d
  return { x: best.q.x + (p.x - best.q.x) * k, z: best.q.z + (p.z - best.q.z) * k }
}

/** Inserts lane points (right of travel) on long, wide segments; endpoints stay on the nodes. */
function withLanes(r: Route): Vec2[] {
  const out: Vec2[] = [r.points[0]!]
  for (let i = 0; i + 1 < r.points.length; i++) {
    const a = r.points[i]!
    const b = r.points[i + 1]!
    const len = dist(a, b)
    if (len >= LANE_MIN_SEGMENT && r.widths[i]! >= LANE_OFFSET + LANE_MARGIN) {
      const d = { x: (b.x - a.x) / len, z: (b.z - a.z) / len }
      // Right of the walking direction (forward × up), see contract §1.
      const right = { x: -d.z, z: d.x }
      for (const s of [1, 2, len - 2, len - 1])
        out.push({ x: a.x + d.x * s + right.x * LANE_OFFSET, z: a.z + d.z * s + right.z * LANE_OFFSET })
    }
    out.push(b)
  }
  return out
}

/** Replaces each corner with two points so the spline rounds it (radius ≤ width / 2). */
function cutCorners(pts: Vec2[], r: Route): Vec2[] {
  if (pts.length < 3) return pts
  const out: Vec2[] = [pts[0]!]
  for (let i = 1; i + 1 < pts.length; i++) {
    const p = pts[i]!
    const a = pts[i - 1]!
    const b = pts[i + 1]!
    const la = dist(a, p)
    const lb = dist(p, b)
    const din = { x: (p.x - a.x) / la, z: (p.z - a.z) / la }
    const dout = { x: (b.x - p.x) / lb, z: (b.z - p.z) / lb }
    const turn = Math.abs(Math.atan2(din.x * dout.z - din.z * dout.x, din.x * dout.x + din.z * dout.z))
    if (turn < 1e-3) {
      out.push(p)
      continue
    }
    const w = Math.min(...r.widths)
    const rad = Math.min(w / 2, 0.4 * la, 0.4 * lb)
    out.push({ x: p.x - din.x * rad, z: p.z - din.z * rad }, { x: p.x + dout.x * rad, z: p.z + dout.z * rad })
  }
  out.push(pts.at(-1)!)
  return out
}

/** Centripetal Catmull-Rom (α = 0.5) point on span p1 → p2 at u ∈ [0, 1]. */
function catmullRom(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, u: number): Vec2 {
  const t0 = 0
  const t1 = t0 + Math.sqrt(dist(p0, p1))
  const t2 = t1 + Math.sqrt(dist(p1, p2))
  const t3 = t2 + Math.sqrt(dist(p2, p3))
  const t = t1 + (t2 - t1) * u
  const lerp = (a: Vec2, b: Vec2, ta: number, tb: number) => {
    const k = (t - ta) / (tb - ta)
    return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k }
  }
  const a1 = lerp(p0, p1, t0, t1)
  const a2 = lerp(p1, p2, t1, t2)
  const a3 = lerp(p2, p3, t2, t3)
  const b1 = lerp(a1, a2, t0, t2)
  const b2 = lerp(a2, a3, t1, t3)
  return lerp(b1, b2, t1, t2)
}

/**
 * Smooths a route: lanes, rounded corners, centripetal Catmull-Rom sampled every ≤ SAMPLE_STEP,
 * then clamped inside the corridor. The first span stays straight when the route has a lead point
 * (re-planning mid-walk), so the heading at t = 0 is unchanged.
 */
export function smooth(r: Route, opts: { straightStart?: boolean } = {}): Vec2[] {
  if (r.points.length < 2) return [...r.points]
  const c = cutCorners(withLanes(r), r)
  const n = c.length
  const at = (i: number): Vec2 =>
    i < 0
      ? { x: 2 * c[0]!.x - c[1]!.x, z: 2 * c[0]!.z - c[1]!.z }
      : i >= n
        ? { x: 2 * c[n - 1]!.x - c[n - 2]!.x, z: 2 * c[n - 1]!.z - c[n - 2]!.z }
        : c[i]!
  const out: Vec2[] = [c[0]!]
  for (let i = 0; i + 1 < n; i++) {
    const steps = Math.max(1, Math.ceil(dist(c[i]!, c[i + 1]!) / SAMPLE_STEP))
    const linear = i === 0 && opts.straightStart
    for (let k = 1; k <= steps; k++) {
      const u = k / steps
      const p =
        k === steps
          ? c[i + 1]!
          : linear
            ? { x: c[i]!.x + (c[i + 1]!.x - c[i]!.x) * u, z: c[i]!.z + (c[i + 1]!.z - c[i]!.z) * u }
            : catmullRom(at(i - 1), c[i]!, c[i + 1]!, at(i + 2), u)
      out.push(clampToCorridor(r, p))
    }
  }
  return out
}

export interface TimeOptions {
  endHeading: number
  vMax?: number
  accel?: number
  decel?: number
  startSpeed?: number
  startHeading?: number
}

const headingOf = (a: Vec2, b: Vec2) => Math.atan2(b.x - a.x, b.z - a.z)

export function needsTurnInPlace(from: number, to: number): boolean {
  return Math.abs(normalizeAngle(to - from)) > (TURN_IN_PLACE_DEG * Math.PI) / 180
}

/** Times a smoothed path with a trapezoidal profile (accelerate, cruise, slow down over the last 0.4 m). */
export function timePath(points: Vec2[], o: TimeOptions): TimedPath {
  const vMax = o.vMax ?? WALK_SPEED
  const accel = o.accel ?? WALK_ACCEL
  const decel = o.decel ?? Math.min(accel, (vMax * vMax) / (2 * APPROACH_DIST))
  const lengths = [0]
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1]! + dist(points[i - 1]!, points[i]!))
  const totalLength = lengths.at(-1)!
  const startSpeed = o.startSpeed ?? 0
  let turnDuration = 0
  if (startSpeed <= 0 && o.startHeading !== undefined && totalLength > 0) {
    const h0 = headingOf(points[0]!, points[1]!)
    if (needsTurnInPlace(o.startHeading, h0)) turnDuration = Math.abs(normalizeAngle(h0 - o.startHeading)) / TURN_RATE
  }
  const tp: TimedPath = { points, lengths, totalLength, vMax, accel, duration: 0, endHeading: o.endHeading, startSpeed, decel, turnDuration }
  if (o.startHeading !== undefined) tp.startHeading = o.startHeading
  tp.duration = turnDuration + profile(tp).total
  return tp
}

interface Profile {
  v0: number
  vp: number
  a: number
  d: number
  t1: number
  t2: number
  t3: number
  s1: number
  s2: number
  total: number
}

function profile(tp: TimedPath): Profile {
  const L = tp.totalLength
  const v0 = tp.startSpeed ?? 0
  const a = tp.accel
  let d = tp.decel ?? a
  if (L <= 0) return { v0, vp: 0, a, d, t1: 0, t2: 0, t3: 0, s1: 0, s2: 0, total: 0 }
  if ((v0 * v0) / (2 * d) >= L) {
    // Too close to stop at the usual rate: brake harder.
    d = (v0 * v0) / (2 * L)
    return { v0, vp: v0, a, d, t1: 0, t2: 0, t3: v0 / d, s1: 0, s2: 0, total: v0 / d }
  }
  const peak = Math.sqrt((L + (v0 * v0) / (2 * a)) / (1 / (2 * a) + 1 / (2 * d)))
  const vp = Math.min(Math.max(tp.vMax, v0), peak)
  const t1 = Math.max(0, (vp - v0) / a)
  const s1 = Math.max(0, (vp * vp - v0 * v0) / (2 * a))
  const s3 = (vp * vp) / (2 * d)
  const s2 = Math.max(0, L - s1 - s3)
  const t2 = s2 / vp
  const t3 = vp / d
  return { v0, vp, a, d, t1, t2, t3, s1, s2, total: t1 + t2 + t3 }
}

export interface PathSample {
  pos: Vec2
  heading: number
  speed: number
  phase: 'turn' | 'walk' | 'approach' | 'arrived'
}

/** Position, heading, speed and phase `t` seconds into a timed path. */
export function sampleAt(tp: TimedPath, t: number): PathSample {
  const pts = tp.points
  const turn = tp.turnDuration ?? 0
  const t0 = Math.max(0, t)
  if (pts.length < 2 || tp.totalLength <= 0)
    return { pos: { ...pts[0]! }, heading: tp.startHeading ?? tp.endHeading, speed: 0, phase: 'arrived' }
  const h0 = headingOf(pts[0]!, pts[1]!)
  if (t0 < turn) {
    const from = tp.startHeading ?? h0
    return { pos: { ...pts[0]! }, heading: normalizeAngle(from + normalizeAngle(h0 - from) * (t0 / turn)), speed: 0, phase: 'turn' }
  }
  const p = profile(tp)
  const tau = t0 - turn
  if (tau >= p.total) {
    const n = pts.length
    return { pos: { ...pts[n - 1]! }, heading: headingOf(pts[n - 2]!, pts[n - 1]!), speed: 0, phase: 'arrived' }
  }
  let s: number
  let v: number
  if (tau < p.t1) (v = p.v0 + p.a * tau), (s = p.v0 * tau + 0.5 * p.a * tau * tau)
  else if (tau < p.t1 + p.t2) (v = p.vp), (s = p.s1 + p.vp * (tau - p.t1))
  else {
    const u = tau - p.t1 - p.t2
    v = Math.max(0, p.vp - p.d * u)
    s = p.s1 + p.s2 + p.vp * u - 0.5 * p.d * u * u
  }
  s = Math.min(Math.max(s, 0), tp.totalLength)
  // Binary search the segment containing s.
  let lo = 0
  let hi = tp.lengths.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (tp.lengths[mid]! <= s) lo = mid
    else hi = mid
  }
  const a = pts[lo]!
  const b = pts[hi]!
  const segLen = tp.lengths[hi]! - tp.lengths[lo]!
  const k = segLen > 0 ? (s - tp.lengths[lo]!) / segLen : 0
  return {
    pos: { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k },
    heading: headingOf(a, b),
    speed: v,
    phase: tp.totalLength - s <= APPROACH_DIST ? 'approach' : 'walk',
  }
}

/** Plans, smooths and times a walk from `from` to an anchor-like target. */
export function routeToPath(
  nav: NavGraph,
  from: Vec2,
  to: { pos: Vec2; heading: number; navNode?: string },
  opts: { fromNode?: string; startHeading?: number; startSpeed?: number } = {},
): TimedPath | undefined {
  const moving = (opts.startSpeed ?? 0) > 0 && opts.startHeading !== undefined
  const ro: RouteOptions = {}
  if (opts.fromNode !== undefined) ro.fromNode = opts.fromNode
  if (to.navNode !== undefined) ro.toNode = to.navNode
  if (moving) ro.startDir = { x: Math.sin(opts.startHeading!), z: Math.cos(opts.startHeading!) }
  const r = planRoute(nav, from, to.pos, ro)
  if (!r) return undefined
  const to2: TimeOptions = { endHeading: to.heading }
  if (opts.startSpeed !== undefined) to2.startSpeed = opts.startSpeed
  if (opts.startHeading !== undefined) to2.startHeading = opts.startHeading
  return timePath(smooth(r, { straightStart: moving }), to2)
}
