// The Night City player (third/first person): movement relative to the camera, collision against
// the world's boxes with sliding and step-up, the spring arm and interaction reach. Pure.
import { describe, expect, it } from 'vitest'
import type { Collider } from './world.ts'
import {
  armLength,
  createPlayer,
  moveBasis,
  nearestInteraction,
  PLAYER,
  smoothArm,
  stepPlayer,
} from './player.ts'

const box = (minX: number, maxX: number, minZ: number, maxZ: number, maxY = 3): Collider => ({
  minX,
  maxX,
  minY: 0,
  maxY,
  minZ,
  maxZ,
})
const run = (
  p: ReturnType<typeof createPlayer>,
  input: Parameters<typeof stepPlayer>[1],
  s: number,
  boxes: Collider[] = [],
) => {
  for (let t = 0; t < s; t += 1 / 60) stepPlayer(p, input, 1 / 60, boxes)
}
const still = { forward: 0, right: 0, sprint: false, yaw: 0 }

describe('moveBasis', () => {
  it('forward follows the camera yaw; right is to the camera’s right', () => {
    const b = moveBasis(0)
    expect(b.fx).toBeCloseTo(0)
    expect(b.fz).toBeCloseTo(1)
    expect(b.rx).toBeCloseTo(-1)
    expect(b.rz).toBeCloseTo(0)
    const e = moveBasis(Math.PI / 2)
    expect(e.fx).toBeCloseTo(1)
    expect(e.rz).toBeCloseTo(1)
  })
})

describe('stepPlayer', () => {
  it('walks forward at walking speed and turns to face the way it moves', () => {
    const p = createPlayer({ x: 0, z: 0 }, 0)
    run(p, { ...still, forward: 1, yaw: Math.PI / 2 }, 1)
    expect(p.x).toBeGreaterThan(PLAYER.walk * 0.7)
    expect(Math.abs(p.z)).toBeLessThan(0.01)
    expect(p.heading).toBeCloseTo(Math.PI / 2, 1)
    expect(p.speed).toBeCloseTo(PLAYER.walk, 1)
  })

  it('sprints faster, and stops (decelerates) without input', () => {
    const a = createPlayer({ x: 0, z: 0 }, 0)
    const b = createPlayer({ x: 0, z: 0 }, 0)
    run(a, { ...still, forward: 1 }, 1)
    run(b, { ...still, forward: 1, sprint: true }, 1)
    expect(b.z).toBeGreaterThan(a.z * 1.4)
    run(a, still, 1)
    expect(a.speed).toBe(0)
  })

  it('normalizes diagonal input (no faster diagonals)', () => {
    const a = createPlayer({ x: 0, z: 0 }, 0)
    run(a, { ...still, forward: 1, right: 1 }, 1)
    expect(Math.hypot(a.x, a.z)).toBeLessThan(PLAYER.walk * 1.01)
  })

  it('stops at a wall and slides along it', () => {
    const p = createPlayer({ x: 0, z: 0 }, 0)
    const wall = box(-5, 5, 1, 1.3)
    run(p, { ...still, forward: 1, right: -1, yaw: 0 }, 2, [wall])
    expect(p.z).toBeLessThanOrEqual(1 - PLAYER.radius + 1e-6)
    expect(p.x).toBeGreaterThan(1)
  })

  it('steps up onto a low platform but not onto a desk', () => {
    const step = createPlayer({ x: 0, z: 0 }, 0)
    run(step, { ...still, forward: 1 }, 2, [box(-2, 2, 1, 10, 0.3)])
    expect(step.z).toBeGreaterThan(2)
    expect(step.y).toBeCloseTo(0.3, 1)
    const desk = createPlayer({ x: 0, z: 0 }, 0)
    run(desk, { ...still, forward: 1 }, 2, [box(-2, 2, 1, 10, 0.75)])
    expect(desk.z).toBeLessThan(1)
    expect(desk.y).toBe(0)
  })

  it('comes back down off a platform', () => {
    const p = createPlayer({ x: 0, z: 0 }, 0)
    p.y = 0.3
    run(p, still, 1)
    expect(p.y).toBe(0)
  })
})

describe('spring arm', () => {
  it('is full length in the open and shortens in front of a wall', () => {
    const pivot = { x: 0, y: 1.6, z: 0 }
    const back = { x: 0, y: 0, z: -1 }
    expect(armLength(pivot, back, 3.2, [])).toBe(3.2)
    const short = armLength(pivot, back, 3.2, [box(-5, 5, -2.2, -2)])
    expect(short).toBeCloseTo(2 - PLAYER.armMargin)
    // Never closer than the minimum (inside the head).
    expect(armLength(pivot, back, 3.2, [box(-5, 5, -0.3, -0.1)])).toBe(PLAYER.armMin)
  })

  it('pulls in at once and eases back out', () => {
    expect(smoothArm(3, 1, 1 / 60)).toBe(1)
    const out = smoothArm(1, 3, 1 / 60)
    expect(out).toBeGreaterThan(1)
    expect(out).toBeLessThan(1.2)
  })
})

describe('nearestInteraction', () => {
  it('picks the closest object within 1.6 m, else null', () => {
    const items = [
      { id: 'a', pos: { x: 1, z: 0 } },
      { id: 'b', pos: { x: 0.5, z: 0 } },
      { id: 'c', pos: { x: 5, z: 0 } },
    ]
    expect(nearestInteraction({ x: 0, z: 0 }, items)?.id).toBe('b')
    expect(nearestInteraction({ x: 3.3, z: 0 }, items)).toBeNull()
    expect(PLAYER.reach).toBe(1.6)
  })
})
