// Night City presets (plan §5.6): the classic effective graphics plus the Night City settings →
// which features run. Every animated system is off with reduced motion.
import { GraphicsAdvancedSchema, SpecialSettingsSchema } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import type { Preset } from '../graphics-types.ts'
import { effectiveGraphics } from '../quality.ts'
import { MAX_DYNAMIC_LIGHTS, specialFeatures } from './special-quality.ts'

const eff = (preset: Preset, dpr = 2) =>
  effectiveGraphics({
    preset,
    advanced: GraphicsAdvancedSchema.parse({}),
    dpr,
    power: { focused: true, hidden: false, onBattery: false },
    saver: { blur: false, hidden: false, battery: 'off' },
  })
const settings = (patch: Partial<ReturnType<typeof SpecialSettingsSchema.parse>> = {}) => ({
  ...SpecialSettingsSchema.parse({}),
  ...patch,
})

describe('specialFeatures', () => {
  it('Low: baked only, no bloom, fog, rain or traffic, half resolution, 30 fps cap', () => {
    const f = specialFeatures(eff('low'), settings())
    expect(f).toMatchObject({
      bloom: false,
      fog: false,
      rain: false,
      traffic: false,
      probes: false,
    })
    expect(f.gfx.gtao).toBe('off')
    expect(f.gfx.resolutionScale).toBe(0.5)
    expect(f.gfx.fpsLimit).toBe(30)
    expect(f.animatedBands).toBe(0)
  })

  it('Minimal is treated as Low', () => {
    const f = specialFeatures(eff('minimal'), settings())
    expect(f.bloom).toBe(false)
    expect(f.gfx.fpsLimit).toBe(30)
  })

  it('Medium: selective bloom, height fog, rain, SMAA, one animated skyline band', () => {
    const f = specialFeatures(eff('medium'), settings())
    expect(f).toMatchObject({ bloom: true, fog: true, rain: true, rainGlass: true })
    expect(f.gfx.smaa).toBe(true)
    expect(f.animatedBands).toBe(1)
    expect(f.traffic).toBe(false)
    expect(f.gfx.resolutionScale).toBe(1)
  })

  it('High: reflection probes, traffic and three bands; no GTAO (the lightmaps carry the AO)', () => {
    const f = specialFeatures(eff('high'), settings())
    expect(f.gfx.gtao).toBe('off')
    expect(f).toMatchObject({ probes: true, traffic: true, animatedBands: 3 })
  })

  it('Ultra: native DPR, half GTAO, larger shadow maps, all atmosphere', () => {
    const f = specialFeatures(eff('ultra', 2), settings())
    expect(f.gfx.gtao).toBe('half')
    expect(f.gfx.pixelRatioCap).toBeGreaterThanOrEqual(2)
    expect(f.gfx.shadowMap).toBeGreaterThanOrEqual(2048)
    expect(f.shafts).toBe(true)
    expect(f.rainDrops).toBeGreaterThan(specialFeatures(eff('high'), settings()).rainDrops)
  })

  it('caps the pixel ratio per preset: Low 1× at half scale, Medium 1×, High 1.25×, Ultra native', () => {
    expect(specialFeatures(eff('low', 2), settings()).gfx.pixelRatioCap).toBe(1)
    expect(specialFeatures(eff('medium', 2), settings()).gfx.pixelRatioCap).toBe(1)
    expect(specialFeatures(eff('high', 2), settings()).gfx.pixelRatioCap).toBe(1.25)
    expect(specialFeatures(eff('ultra', 3), settings()).gfx.pixelRatioCap).toBe(3)
  })

  it('never more than four dynamic lights per room', () => {
    for (const p of ['minimal', 'low', 'medium', 'high', 'ultra'] as const)
      expect(specialFeatures(eff(p), settings()).dynamicLights).toBeLessThanOrEqual(
        MAX_DYNAMIC_LIGHTS,
      )
    expect(MAX_DYNAMIC_LIGHTS).toBe(4)
  })

  it('the atmosphere setting scales fog density and light shafts', () => {
    const low = specialFeatures(eff('high'), settings({ atmosphere: 'low' }))
    const high = specialFeatures(eff('high'), settings({ atmosphere: 'high' }))
    expect(low.shafts).toBe(false)
    expect(high.shafts).toBe(true)
    expect(high.fogDensity).toBeGreaterThan(low.fogDensity)
  })

  it('rain off removes rain and the rain-glass shader', () => {
    const f = specialFeatures(eff('ultra'), settings({ rain: false }))
    expect(f).toMatchObject({ rain: false, rainGlass: false, rainDrops: 0 })
  })

  it('reduced motion turns off every animated system, but keeps static lighting', () => {
    const f = specialFeatures(eff('ultra'), settings({ reducedMotion: true }))
    expect(f).toMatchObject({
      rain: false,
      rainGlass: false,
      traffic: false,
      animatedBands: 0,
      neonFlicker: false,
      adRotation: false,
      windowFlicker: false,
    })
    expect(f.bloom).toBe(true)
  })

  it('keeps a paused or slower classic frame limit (hidden window, power saver)', () => {
    expect(specialFeatures({ ...eff('high'), fpsLimit: 0 }, settings()).gfx.fpsLimit).toBe(0)
    expect(specialFeatures({ ...eff('low'), fpsLimit: 15 }, settings()).gfx.fpsLimit).toBe(15)
    expect(specialFeatures({ ...eff('high'), fpsLimit: 15 }, settings()).gfx.fpsLimit).toBe(15)
  })
})
