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
