// WASD / arrow-key panning for the 3D orbit view (plan §4c). Pure: the camera director feeds it
// the held keys, the camera's heading and distance, and applies the floor-plane move.
import type { AABB } from './office-types.ts'

export interface PanInput {
  /** Held `KeyboardEvent.code`s. */
  keys: ReadonlySet<string>
  /** Camera yaw on the floor plane (rad): forward is (sin h, cos h) in (x, z). */
  heading: number
  /** Camera distance to the orbit target (m). */
  distance: number
  /** Seconds since the last frame. */
  dt: number
  sprint: boolean
}

export interface Pan {
  dx: number
  dz: number
}

const SPEED_PER_METRE = 0.9
const MIN_SPEED = 4
const MAX_SPEED = 60
const SPRINT = 2.5

const has = (k: ReadonlySet<string>, a: string, b: string) => k.has(a) || k.has(b)

/**
 * The floor-plane move for one frame: W/↑ forward (away from the camera), S/↓ back, A/← left,
 * D/→ right; diagonals normalised; `clamp(distance·0.9, 4, 60)` m/s, ×2.5 with sprint.
 * Writes into `out` when given so the render loop doesn't allocate.
 */
export function orbitPan(input: PanInput, out: Pan = { dx: 0, dz: 0 }): Pan {
  const { keys } = input
  const f = (has(keys, 'KeyW', 'ArrowUp') ? 1 : 0) - (has(keys, 'KeyS', 'ArrowDown') ? 1 : 0)
  const r = (has(keys, 'KeyD', 'ArrowRight') ? 1 : 0) - (has(keys, 'KeyA', 'ArrowLeft') ? 1 : 0)
  if (!f && !r) {
    out.dx = 0
    out.dz = 0
    return out
  }
  const speed =
    Math.min(MAX_SPEED, Math.max(MIN_SPEED, input.distance * SPEED_PER_METRE)) *
    (input.sprint ? SPRINT : 1)
  const step = (speed * input.dt) / Math.hypot(f, r)
  const fx = Math.sin(input.heading)
  const fz = Math.cos(input.heading)
  // Right = forward × up (y up) = (-fz, fx).
  out.dx = (f * fx - r * fz) * step
  out.dz = (f * fz + r * fx) * step
  return out
}

/** Keeps the orbit target within the layout bounds plus `margin` metres. */
export function clampTarget(
  t: { x: number; z: number },
  b: AABB,
  margin = 4,
  out: { x: number; z: number } = { x: 0, z: 0 },
): { x: number; z: number } {
  out.x = Math.min(b.maxX + margin, Math.max(b.minX - margin, t.x))
  out.z = Math.min(b.maxZ + margin, Math.max(b.minZ - margin, t.z))
  return out
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/** True when keys typed at `el` are text input (so they must not move the camera). */
export function isTypingTarget(
  el: { tagName?: string; isContentEditable?: boolean } | null | undefined,
): boolean {
  if (!el) return false
  if (el.isContentEditable) return true
  return typeof el.tagName === 'string' && TYPING_TAGS.has(el.tagName.toUpperCase())
}
