import { describe, expect, it } from 'vitest'
import { clampTarget, isTypingTarget, orbitPan } from './orbit-keys.ts'

const keys = (...k: string[]) => new Set(k)
const pan = (k: string[], heading = 0, distance = 20, dt = 0.5, sprint = false) =>
  orbitPan({ keys: keys(...k), heading, distance, dt, sprint })

describe('orbitPan', () => {
  it('OK-1: heading 0 (camera looks toward +z): W forward, S back, D right (-x), A left (+x)', () => {
    const w = pan(['KeyW'])
    expect(w.dx).toBeCloseTo(0)
    expect(w.dz).toBeGreaterThan(0)
    const s = pan(['KeyS'])
    expect(s.dx).toBeCloseTo(0)
    expect(s.dz).toBeCloseTo(-w.dz)
    const d = pan(['KeyD'])
    expect(d.dx).toBeLessThan(0)
    expect(d.dz).toBeCloseTo(0)
    expect(pan(['KeyA']).dx).toBeCloseTo(-d.dx)
    // Arrow keys mirror WASD.
    expect(pan(['ArrowUp'])).toEqual(w)
    expect(pan(['ArrowDown'])).toEqual(s)
    expect(pan(['ArrowRight'])).toEqual(d)
    expect(pan(['ArrowLeft'])).toEqual(pan(['KeyA']))
  })

  it('OK-2: heading π/2 (camera looks toward +x): W moves +x, D moves +z', () => {
    const w = pan(['KeyW'], Math.PI / 2)
    expect(w.dx).toBeGreaterThan(0)
    expect(w.dz).toBeCloseTo(0)
    const d = pan(['KeyD'], Math.PI / 2)
    expect(d.dx).toBeCloseTo(0)
    expect(d.dz).toBeGreaterThan(0)
  })

  it('OK-3: diagonals are normalised; opposite keys cancel; no pan key is no move', () => {
    const one = pan(['KeyW'])
    const diag = pan(['KeyW', 'KeyD'])
    expect(Math.hypot(diag.dx, diag.dz)).toBeCloseTo(Math.hypot(one.dx, one.dz))
    expect(pan(['KeyW', 'KeyS'])).toEqual({ dx: 0, dz: 0 })
    expect(pan([])).toEqual({ dx: 0, dz: 0 })
    // Shift, E and Q are not pan keys.
    expect(pan(['ShiftLeft', 'KeyE', 'KeyQ'])).toEqual({ dx: 0, dz: 0 })
  })

  it('OK-4: speed is distance × 0.9 m/s, clamped to 4..60', () => {
    // 20 m away → 18 m/s, for 0.5 s → 9 m.
    expect(pan(['KeyW'], 0, 20, 0.5).dz).toBeCloseTo(9)
    // Close up → the 4 m/s floor.
    expect(pan(['KeyW'], 0, 1, 0.5).dz).toBeCloseTo(2)
    // Far out → the 60 m/s ceiling.
    expect(pan(['KeyW'], 0, 1000, 0.5).dz).toBeCloseTo(30)
  })

  it('OK-5: Shift sprints ×2.5; an `out` object is reused (allocation-free)', () => {
    expect(pan(['KeyW'], 0, 20, 0.5, true).dz).toBeCloseTo(22.5)
    const out = { dx: 1, dz: 1 }
    const r = orbitPan(
      { keys: keys('KeyD'), heading: 0, distance: 20, dt: 0.5, sprint: false },
      out,
    )
    expect(r).toBe(out)
    expect(out.dx).toBeCloseTo(-9)
    expect(orbitPan({ keys: keys(), heading: 0, distance: 20, dt: 0.5, sprint: false }, out)).toBe(
      out,
    )
    expect(out).toEqual({ dx: 0, dz: 0 })
  })
})

describe('clampTarget', () => {
  const b = { minX: -10, maxX: 10, minZ: 0, maxZ: 50 }
  it('keeps the target inside the bounds plus a 4 m margin', () => {
    expect(clampTarget({ x: 3, z: 20 }, b)).toEqual({ x: 3, z: 20 })
    expect(clampTarget({ x: -100, z: 100 }, b)).toEqual({ x: -14, z: 54 })
    expect(clampTarget({ x: 100, z: -100 }, b)).toEqual({ x: 14, z: -4 })
    expect(clampTarget({ x: 100, z: -100 }, b, 0)).toEqual({ x: 10, z: 0 })
  })
  it('writes into `out` when given', () => {
    const out = { x: 0, z: 0 }
    expect(clampTarget({ x: 99, z: 1 }, b, 4, out)).toBe(out)
    expect(out).toEqual({ x: 14, z: 1 })
  })
})

describe('isTypingTarget', () => {
  it('is true for input, textarea, select and contenteditable elements', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input'])
      expect(isTypingTarget({ tagName })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })
  it('is false for other elements, the window and null', () => {
    expect(isTypingTarget({ tagName: 'CANVAS' })).toBe(false)
    expect(isTypingTarget({ tagName: 'BUTTON', isContentEditable: false })).toBe(false)
    expect(isTypingTarget({})).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget(undefined)).toBe(false)
  })
})
