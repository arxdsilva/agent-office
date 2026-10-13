// Camera framing for capability rooms (low-spec plan §B3). Pure: a pose that shows a group of
// surfaces (book spines, rule boards, stations) head-on from inside their room, close enough to read.
import type { Vec2, Vec3 } from './office-types.ts'

export interface FrameInput {
  /** Port positions (port:book:*, port:board:*, port:station:*). */
  surfaces: Vec3[]
  /** A point inside the room (centroid of its reading seats / shelf or station spots). */
  inside: Vec2
  /** Vertical field of view (degrees) and aspect ratio of the camera. */
  fovDeg: number
  aspect: number
  /** Extra room around the surfaces (default 1.15). */
  margin?: number
  /** Distance clamp (m), default 1.2 … 6. */
  minDist?: number
  maxDist?: number
  /** Camera height; default the surfaces' centroid height + 0.35 m. */
  eyeHeight?: number
}

export interface CameraPose {
  position: Vec3
  target: Vec3
}

export const FRAME_DEFAULTS = { margin: 1.15, minDist: 1.2, maxDist: 6, eyeLift: 0.35 } as const
/** Target height when there is nothing to frame. */
const EMPTY_Y = 1.2

export function frameSurfaces(i: FrameInput): CameraPose {
  const margin = i.margin ?? FRAME_DEFAULTS.margin
  const minDist = i.minDist ?? FRAME_DEFAULTS.minDist
  const maxDist = Math.max(minDist, i.maxDist ?? FRAME_DEFAULTS.maxDist)
  const n = i.surfaces.length
  const c: Vec3 = n
    ? {
        x: i.surfaces.reduce((s, p) => s + p.x, 0) / n,
        y: i.surfaces.reduce((s, p) => s + p.y, 0) / n,
        z: i.surfaces.reduce((s, p) => s + p.z, 0) / n,
      }
    : { x: i.inside.x, y: EMPTY_Y, z: i.inside.z }
  // Facing: from the surfaces towards the inside of the room (horizontal).
  let fx = i.inside.x - c.x
  let fz = i.inside.z - c.z
  const len = Math.hypot(fx, fz)
  if (len < 1e-6) [fx, fz] = [0, 1]
  else [fx, fz] = [fx / len, fz / len]
  // Fit: each surface needs depth ≥ its offset / tan(half fov) × margin, measured from the camera.
  const tanV = Math.tan((i.fovDeg * Math.PI) / 360)
  const tanH = tanV * i.aspect
  let dist = 0
  for (const p of i.surfaces) {
    const dx = p.x - c.x
    const dz = p.z - c.z
    const along = dx * fx + dz * fz
    const lateral = Math.abs(dx * fz - dz * fx)
    const vertical = Math.abs(p.y - c.y)
    dist = Math.max(dist, along + margin * Math.max(lateral / tanH, vertical / tanV))
  }
  dist = Math.min(maxDist, Math.max(minDist, dist))
  return {
    position: {
      x: c.x + fx * dist,
      y: i.eyeHeight ?? c.y + FRAME_DEFAULTS.eyeLift,
      z: c.z + fz * dist,
    },
    target: c,
  }
}

export interface AgentFrameInput {
  /** Floor positions (m) of the agents to show. */
  positions: Vec2[]
  fovDeg: number
  aspect: number
  /** Extra room around the group (default 1.25). */
  margin?: number
  /** Elevation above the floor plane in degrees (default 50). */
  elevationDeg?: number
  /** Horizontal viewing direction, from the group towards the camera (default +z). */
  from?: Vec2
  /** Distance clamp (m), default 7 … 45. */
  minDist?: number
  maxDist?: number
}

export const AGENT_FRAME_DEFAULTS = {
  margin: 1.25,
  elevationDeg: 50,
  minDist: 7,
  maxDist: 45,
  targetY: 1,
  pad: 1.5,
} as const

/** Centroid of floor positions, or null when there are none. */
export function centroid(positions: readonly Vec2[]): Vec2 | null {
  if (!positions.length) return null
  return {
    x: positions.reduce((s, p) => s + p.x, 0) / positions.length,
    z: positions.reduce((s, p) => s + p.z, 0) / positions.length,
  }
}

/**
 * Orbit-style pose that shows a group of agents from above at an angle, as close as fits (focus
 * mode, plan §8). Null when there is nobody to frame.
 */
export function frameAgents(i: AgentFrameInput): CameraPose | null {
  const c = centroid(i.positions)
  if (!c) return null
  const margin = i.margin ?? AGENT_FRAME_DEFAULTS.margin
  const minDist = i.minDist ?? AGENT_FRAME_DEFAULTS.minDist
  const maxDist = Math.max(minDist, i.maxDist ?? AGENT_FRAME_DEFAULTS.maxDist)
  const radius =
    Math.max(0, ...i.positions.map((p) => Math.hypot(p.x - c.x, p.z - c.z))) +
    AGENT_FRAME_DEFAULTS.pad
  // The limiting field of view is the narrower of the vertical and horizontal ones.
  const tanV = Math.tan((i.fovDeg * Math.PI) / 360)
  const tan = Math.min(tanV, tanV * i.aspect)
  const dist = Math.min(maxDist, Math.max(minDist, (radius * margin) / tan))
  let fx = i.from?.x ?? 0
  let fz = i.from?.z ?? 1
  const len = Math.hypot(fx, fz)
  if (len < 1e-6) [fx, fz] = [0, 1]
  else [fx, fz] = [fx / len, fz / len]
  const el = ((i.elevationDeg ?? AGENT_FRAME_DEFAULTS.elevationDeg) * Math.PI) / 180
  const target: Vec3 = { x: c.x, y: AGENT_FRAME_DEFAULTS.targetY, z: c.z }
  return {
    target,
    position: {
      x: c.x + fx * Math.cos(el) * dist,
      y: target.y + Math.sin(el) * dist,
      z: c.z + fz * Math.cos(el) * dist,
    },
  }
}
