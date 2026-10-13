// Ambient schedules (ads, neon flicker): deterministic per seed, so screenshots and tests repeat,
// and never tied to agent state.
import { describe, expect, it } from 'vitest'
import { AD_PERIOD_MS, ADS, adAt, adOrder, flickerAt, mulberry32 } from './env-schedule.ts'

describe('ads', () => {
  it('are original fictional brands, never agent-office projects or real trademarks', () => {
    expect(ADS.length).toBeGreaterThanOrEqual(6)
    for (const ad of ADS) {
      expect(ad.brand.length).toBeGreaterThan(2)
      expect(ad.lines.length).toBeGreaterThan(0)
      expect(ad.brand).not.toMatch(/arasaka|militech|kiroshi|cyberpunk|night city|agent-office/i)
    }
    expect(ADS.map((a) => a.brand)).toContain('Meridian Dynamics')
  })

  it('each screen gets its own deterministic order', () => {
    expect(adOrder(7, 3)).toEqual(adOrder(7, 3))
    expect(adOrder(7, 3)).not.toEqual(adOrder(7, 4))
    expect([...adOrder(1, 0)].sort((a, b) => a - b)).toEqual(ADS.map((_, i) => i))
  })

  it('rotates every 12 s per screen, offset so screens do not change together', () => {
    expect(AD_PERIOD_MS).toBe(12_000)
    const order = adOrder(1, 0)
    expect(adAt(1, 0, 0, true)).toBe(order[0])
    expect(adAt(1, 0, AD_PERIOD_MS * 1.01, true)).toBe(order[1])
    expect(adAt(1, 0, AD_PERIOD_MS * ADS.length + 1, true)).toBe(order[0])
    // Without rotation (reduced motion), the first ad holds.
    expect(adAt(1, 0, AD_PERIOD_MS * 5, false)).toBe(order[0])
  })
})

describe('flickerAt', () => {
  it('is mostly fully lit, sometimes dips, and is repeatable', () => {
    let dips = 0
    for (let t = 0; t < 60; t += 0.05) {
      const v = flickerAt(42, t)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
      if (v < 0.9) dips++
      expect(flickerAt(42, t)).toBe(v)
    }
    expect(dips).toBeGreaterThan(0)
    expect(dips).toBeLessThan(1200 * 0.2)
  })

  it('stays steady (1) when flicker is off', () => {
    expect(flickerAt(42, 3.21, false)).toBe(1)
  })
})

describe('mulberry32', () => {
  it('is a deterministic generator in [0, 1)', () => {
    const a = mulberry32(5)
    const b = mulberry32(5)
    for (let i = 0; i < 20; i++) {
      const v = a()
      expect(v).toBe(b())
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})
