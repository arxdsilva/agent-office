import { describe, expect, it } from 'vitest'
import { createPacer } from './frame-pacer.ts'

/** Which of `n` frames, `step` ms apart, the pacer renders under `limit`. */
const frames = (limit: number | null, step: number, n: number, p = createPacer()) =>
  Array.from({ length: n }, (_, i) => p.shouldRender(1000 + i * step, limit))

describe('createPacer', () => {
  it('FP-1: a null limit renders every animation frame', () => {
    expect(frames(null, 16.7, 6)).toEqual([true, true, true, true, true, true])
  })

  it('FP-2: a 30 fps limit at 60 Hz renders every other frame', () => {
    expect(frames(30, 16.7, 6)).toEqual([true, false, true, false, true, false])
  })

  it('FP-3: vsync jitter within 1.5 ms still renders at the limit', () => {
    expect(frames(60, 16.4, 4)).toEqual([true, true, true, true])
    expect(frames(60, 8.3, 4)).toEqual([true, false, true, false])
  })

  it('FP-4: a 0 limit pauses; reset() after a pause renders at once', () => {
    const p = createPacer()
    expect(p.shouldRender(0, 15)).toBe(true)
    expect(p.shouldRender(10, 0)).toBe(false)
    expect(p.shouldRender(20, 15)).toBe(false)
    p.reset()
    expect(p.shouldRender(30, 15)).toBe(true)
  })
})
