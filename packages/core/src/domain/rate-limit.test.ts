import { describe, expect, it } from 'vitest'
import { RateWindow } from './rate-limit.ts'

describe('RateWindow', () => {
  it('allows N per rolling second per key', () => {
    const w = new RateWindow(2)
    expect(w.allow('a', 0)).toBe(true)
    expect(w.allow('a', 100)).toBe(true)
    expect(w.allow('a', 200)).toBe(false)
    expect(w.allow('b', 200)).toBe(true)
    expect(w.allow('a', 1001)).toBe(true)
  })
})
