import { describe, expect, it } from 'vitest'
import { frameSurfaces, type FrameInput } from './framing.ts'
import type { Vec3 } from './office-types.ts'

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a.x, a.y, a.z)
  return { x: a.x / l, y: a.y / l, z: a.z / l }
}

/** True when `p` is inside a perspective frustum at `pose` (vertical fov, aspect). */
function inFrustum(
  pose: { position: Vec3; target: Vec3 },
  p: Vec3,
  fovDeg: number,
  aspect: number,
) {
  const fwd = norm(sub(pose.target, pose.position))
  const right = norm(cross(fwd, { x: 0, y: 1, z: 0 }))
  const up = cross(right, fwd)
  const v = sub(p, pose.position)
  const z = dot(v, fwd)
  const tanV = Math.tan((fovDeg * Math.PI) / 360)
  return z > 0 && Math.abs(dot(v, up)) <= z * tanV && Math.abs(dot(v, right)) <= z * tanV * aspect
}

// A shelf wall along x at z = 0, the room on the +z side.
const shelf: Vec3[] = Array.from({ length: 12 }, (_, i) => ({
  x: -2 + i * 0.35,
  y: 1 + (i % 3) * 0.4,
  z: 0,
}))
const base: FrameInput = { surfaces: shelf, inside: { x: 0, z: 3 }, fovDeg: 45, aspect: 16 / 9 }
const centroid = (s: Vec3[]) => ({
  x: s.reduce((a, p) => a + p.x, 0) / s.length,
  y: s.reduce((a, p) => a + p.y, 0) / s.length,
  z: s.reduce((a, p) => a + p.z, 0) / s.length,
})

describe('frameSurfaces', () => {
  it('FR-1: the camera stands on the inside of the surfaces, looking at their centre', () => {
    const pose = frameSurfaces(base)
    const c = centroid(shelf)
    expect(pose.target).toEqual(c)
    const toCam = sub(pose.position, c)
    expect(toCam.x * (0 - c.x) + toCam.z * (3 - c.z)).toBeGreaterThan(0)
    expect(pose.position.y).toBeCloseTo(c.y + 0.35)
    // Seen from the other side, the camera flips.
    expect(frameSurfaces({ ...base, inside: { x: 0, z: -3 } }).position.z).toBeLessThan(0)
  })

  it('FR-2: every surface falls inside the frustum with the margin', () => {
    for (const aspect of [16 / 9, 1, 0.6]) {
      const pose = frameSurfaces({ ...base, aspect, maxDist: 50 })
      for (const p of shelf) expect(inFrustum(pose, p, 45, aspect)).toBe(true)
    }
    // Surfaces on two walls (an L-shaped room): the nearer wall still fits.
    const lShape = [...shelf, { x: 2, y: 1.2, z: 1.5 }, { x: 2, y: 1.2, z: 2.5 }]
    const pose = frameSurfaces({ ...base, surfaces: lShape, inside: { x: 0, z: 4 }, maxDist: 50 })
    for (const p of lShape) expect(inFrustum(pose, p, 45, 16 / 9)).toBe(true)
  })

  it('FR-3: the distance is clamped to [minDist, maxDist]', () => {
    const far = frameSurfaces({ ...base, maxDist: 2 })
    expect(Math.hypot(far.position.x - far.target.x, far.position.z - far.target.z)).toBeCloseTo(2)
    const near = frameSurfaces({ ...base, surfaces: [shelf[0]!, shelf[1]!], minDist: 3 })
    expect(
      Math.hypot(near.position.x - near.target.x, near.position.z - near.target.z),
    ).toBeCloseTo(3)
    // Defaults: 1.2 m … 6 m.
    const d = frameSurfaces(base)
    expect(Math.hypot(d.position.x - d.target.x, d.position.z - d.target.z)).toBeLessThanOrEqual(6)
  })

  it('FR-4: a single surface close-up is at most 2.2 m away (readable spine text)', () => {
    const one = frameSurfaces({ ...base, surfaces: [shelf[4]!], minDist: 0.9, maxDist: 2.2 })
    const dist = Math.hypot(one.position.x - one.target.x, one.position.z - one.target.z)
    expect(dist).toBeLessThanOrEqual(2.2)
    expect(dist).toBeGreaterThanOrEqual(0.9)
  })

  it('takes an explicit eye height, and faces +z when the inside point is the centre itself', () => {
    const c = centroid(shelf)
    const pose = frameSurfaces({ ...base, inside: { x: c.x, z: c.z }, eyeHeight: 1.6 })
    expect(pose.position.y).toBe(1.6)
    expect(pose.position.x).toBeCloseTo(c.x)
    expect(pose.position.z).toBeGreaterThan(c.z)
  })

  it('an empty surface list gives a pose at the inside point', () => {
    const pose = frameSurfaces({ ...base, surfaces: [] })
    expect(pose.target).toEqual({ x: 0, y: 1.2, z: 3 })
  })
})
