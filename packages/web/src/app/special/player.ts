// The Night City player avatar (third and first person): camera-relative movement with
// acceleration, per-axis collision against the world's boxes (slide along walls, step onto low
// platforms), the spring arm that keeps the third-person camera out of walls, and interaction reach.
// Pure; `stepPlayer` mutates the state in place so the frame loop stays allocation-free.
import type { Vec2, Vec3 } from '../office-types.ts'
import type { Collider } from './world.ts'

export const PLAYER = {
  radius: 0.3,
  /** m/s */
  walk: 2.2,
  sprint: 4.2,
  /** m/s² */
  accel: 12,
  /** Boxes up to this high above the feet are stepped onto. */
  stepUp: 0.35,
  /** Body height for collision. */
  height: 1.75,
  /** Heading spring (rad/s-ish). */
  turn: 12,
  fall: 6,
  /** Spring arm. */
  arm: 3.2,
  armMin: 0.6,
  armMargin: 0.25,
  /** E reaches objects this close (interaction contract). */
  reach: 1.6,
} as const

export interface PlayerState {
  x: number
  /** Feet height (0 = floor). */
  y: number
  z: number
  heading: number
  speed: number
  /** Current velocity (m/s). */
  vx: number
  vz: number
}

export interface PlayerInput {
  /** −1…1 */
  forward: number
  right: number
  sprint: boolean
  /** Camera yaw in the heading convention (forward = (sin, cos)). */
  yaw: number
}

export const createPlayer = (pos: Vec2, heading: number): PlayerState => ({
  x: pos.x,
  y: 0,
  z: pos.z,
  heading,
  speed: 0,
  vx: 0,
  vz: 0,
})

const basis = { fx: 0, fz: 1, rx: -1, rz: 0 }
/** Forward and right on the floor for a camera yaw (shared scratch object). */
export function moveBasis(yaw: number): typeof basis {
  basis.fx = Math.sin(yaw)
  basis.fz = Math.cos(yaw)
  basis.rx = -Math.cos(yaw)
  basis.rz = Math.sin(yaw)
  return basis
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

function overlaps(c: Collider, x: number, z: number, r: number): boolean {
  return x + r > c.minX && x - r < c.maxX && z + r > c.minZ && z - r < c.maxZ
}

/** True when a box blocks the body at (x, z) standing at height y. */
function blocks(boxes: readonly Collider[], x: number, y: number, z: number): boolean {
  for (const c of boxes) {
    if (c.maxY < 0.3 || c.maxY <= y + PLAYER.stepUp || c.minY > y + PLAYER.height) continue
    if (overlaps(c, x, z, PLAYER.radius)) return true
  }
  return false
}

/** Highest walkable surface under (x, z) reachable from height y (0 = the floor). */
function groundAt(boxes: readonly Collider[], x: number, y: number, z: number): number {
  let g = 0
  for (const c of boxes)
    if (c.maxY <= y + PLAYER.stepUp && c.maxY > g && overlaps(c, x, z, PLAYER.radius * 0.5))
      g = c.maxY
  return g
}

export function stepPlayer(
  s: PlayerState,
  input: PlayerInput,
  dt: number,
  boxes: readonly Collider[],
): void {
  const b = moveBasis(input.yaw)
  let mx = b.fx * input.forward + b.rx * input.right
  let mz = b.fz * input.forward + b.rz * input.right
  const len = Math.hypot(mx, mz)
  if (len > 1) ((mx /= len), (mz /= len))
  const top = input.sprint ? PLAYER.sprint : PLAYER.walk
  // Accelerate toward the wanted velocity (and brake to a stop without input).
  const tx = mx * top
  const tz = mz * top
  const dvx = tx - s.vx
  const dvz = tz - s.vz
  const dv = Math.hypot(dvx, dvz)
  const step = PLAYER.accel * dt
  if (dv <= step) ((s.vx = tx), (s.vz = tz))
  else ((s.vx += (dvx / dv) * step), (s.vz += (dvz / dv) * step))
  // Per axis, so the body slides along walls instead of sticking.
  const nx = s.x + s.vx * dt
  if (!blocks(boxes, nx, s.y, s.z)) s.x = nx
  else s.vx = 0
  const nz = s.z + s.vz * dt
  if (!blocks(boxes, s.x, s.y, nz)) s.z = nz
  else s.vz = 0
  s.speed = Math.hypot(s.vx, s.vz)
  if (s.speed < 1e-3) ((s.speed = 0), (s.vx = 0), (s.vz = 0))
  // Step up at once; fall back down smoothly (but land exactly).
  const g = groundAt(boxes, s.x, s.y, s.z)
  if (g >= s.y) s.y = g
  else s.y = Math.max(g, s.y - PLAYER.fall * dt)
  if (s.speed > 0.05) {
    const want = Math.atan2(s.vx, s.vz)
    const k = 1 - Math.exp(-PLAYER.turn * dt)
    s.heading = wrap(s.heading + wrap(want - s.heading) * k)
  }
}

/** Distance along a unit ray from `o` to the first box face, or Infinity. */
function rayBox(o: Vec3, d: Vec3, c: Collider): number {
  let t0 = 0
  let t1 = Infinity
  const axes: [number, number, number, number][] = [
    [o.x, d.x, c.minX, c.maxX],
    [o.y, d.y, c.minY, c.maxY],
    [o.z, d.z, c.minZ, c.maxZ],
  ]
  for (const [p, v, lo, hi] of axes) {
    if (Math.abs(v) < 1e-9) {
      if (p < lo || p > hi) return Infinity
      continue
    }
    let a = (lo - p) / v
    let bb = (hi - p) / v
    if (a > bb) [a, bb] = [bb, a]
    t0 = Math.max(t0, a)
    t1 = Math.min(t1, bb)
    if (t0 > t1) return Infinity
  }
  return t0
}

/** The spring arm's length: `length`, shortened to stay `armMargin` in front of the first box. */
export function armLength(
  pivot: Vec3,
  dir: Vec3,
  length: number,
  boxes: readonly Collider[],
): number {
  let hit = length + PLAYER.armMargin
  for (const c of boxes) {
    if (c.maxY < 0.3) continue
    const t = rayBox(pivot, dir, c)
    if (t < hit) hit = t
  }
  return Math.max(PLAYER.armMin, Math.min(length, hit - PLAYER.armMargin))
}

/** Arm smoothing: pull in at once (never clip a wall), ease back out over ~0.4 s. */
export function smoothArm(current: number, target: number, dt: number): number {
  if (target <= current) return target
  return current + (target - current) * (1 - Math.exp(-dt / 0.4))
}

/** The closest item within `reach` of `p`, or null. */
export function nearestInteraction<T extends { pos: Vec2 }>(
  p: Vec2,
  items: readonly T[],
  reach: number = PLAYER.reach,
): T | null {
  let best: T | null = null
  let bestD = reach
  for (const it of items) {
    const d = Math.hypot(it.pos.x - p.x, it.pos.z - p.z)
    if (d <= bestD) ((bestD = d), (best = it))
  }
  return best
}
