import { describe, expect, it } from 'vitest'
import { isEmptyBox, ndcToClient, pointerToNdc } from './viewport.ts'

const box = { left: 232, top: 48, width: 800, height: 600 }

describe('viewport helpers', () => {
  it('maps the stage corners and centre to NDC, offset by the box origin', () => {
    expect(pointerToNdc(box, 232, 48)).toEqual({ x: -1, y: 1 })
    expect(pointerToNdc(box, 1032, 648)).toEqual({ x: 1, y: -1 })
    const c = pointerToNdc(box, 632, 348)
    expect(c.x).toBeCloseTo(0)
    expect(c.y).toBeCloseTo(0)
  })
  it('round-trips NDC and client px', () => {
    const n = pointerToNdc(box, 400, 100)
    const c = ndcToClient(box, n.x, n.y)
    expect(c.x).toBeCloseTo(400)
    expect(c.y).toBeCloseTo(100)
  })
  it('detects a hidden or collapsed box', () => {
    expect(isEmptyBox({ width: 0, height: 100 })).toBe(true)
    expect(isEmptyBox({ width: 100, height: 0 })).toBe(true)
    expect(isEmptyBox({ width: NaN, height: 5 })).toBe(true)
    expect(isEmptyBox(box)).toBe(false)
  })
})
