import { describe, expect, it } from 'vitest'
import { GraphicsAdvancedSchema } from '@agent-office/shared'
import type { EffectiveInput } from './graphics-types.ts'
import {
  AUTO_MAX,
  createGovernor,
  effectiveGraphics,
  PRESET_ORDER,
  PRESETS,
  pixelRatioFor,
  presetPixelRatio,
  resolvePreset,
} from './quality.ts'

/** Feeds `seconds` of frames at a steady `fps` in 0.5 s windows; returns every preset change. */
function run(
  g: ReturnType<typeof createGovernor>,
  fps: number,
  seconds: number,
  limit?: number | null,
) {
  const changes: string[] = []
  for (let t = 0; t < seconds; t += 0.5) {
    const c = g.sample(fps, 0.5, limit)
    if (c) changes.push(c)
  }
  return changes
}

describe('quality presets', () => {
  it('follow the plan table (§4.2), with GTAO moved up a tier', () => {
    expect(PRESETS.low).toMatchObject({ shadowMap: 0, gtao: 'off', bloom: false, smaa: false })
    // GTAO re-renders the whole scene for normals; the lightmaps already carry baked AO, so it is
    // reserved for the top presets (measured: it doubled draw calls and triangles at Medium).
    expect(PRESETS.medium).toMatchObject({ shadowMap: 1024, gtao: 'off', bloom: true, smaa: true })
    expect(PRESETS.high).toMatchObject({ shadowMap: 2048, gtao: 'half', bloom: true, smaa: true })
    expect(PRESETS.ultra).toMatchObject({ shadowMap: 4096, gtao: 'full', bloom: true, smaa: true })
    expect(PRESETS.low.lod).toEqual([8, 20])
    expect(PRESETS.medium.lod).toEqual([15, 35])
    expect(PRESETS.high.lod).toEqual([20, 45])
    expect(PRESETS.ultra.lod).toEqual([30, 60])
    expect([60, 120, 150, 250]).toEqual(
      (['low', 'medium', 'high', 'ultra'] as const).map((p) => PRESETS[p].maxAnimated),
    )
  })

  it('Q-min: Minimal is the lightest preset (plan §2.2)', () => {
    expect(PRESET_ORDER[0]).toBe('minimal')
    expect(PRESETS.minimal).toMatchObject({
      resolutionScale: 0.75,
      maxPixelRatio: 1,
      fpsLimit: 30,
      shadows: 'off',
      shadowMap: 0,
      gtao: 'off',
      bloom: false,
      smaa: false,
      lod: [6, 12],
      maxAnimated: 24,
      labels: { mode: 'nearby', nearbyM: 15 },
      links: 'static',
      detailCullM: 16,
      lightmapTier: 'quarter',
      envMap: false,
      hover: false,
      powerPreference: 'low-power',
    })
  })

  it('the new per-preset levers follow §2.2', () => {
    const pick = (p: keyof typeof PRESETS) => {
      const s = PRESETS[p]
      return [
        s.fpsLimit,
        s.shadows,
        s.labels.mode,
        s.links,
        s.detailCullM,
        s.lightmapTier,
        s.envMap,
      ]
    }
    expect(pick('low')).toEqual([60, 'contact', 'nearby', 'static', 24, 'half', true])
    expect(PRESETS.low.labels.nearbyM).toBe(30)
    expect(pick('medium')).toEqual([60, 'full', 'all', 'animated', 32, 'half', true])
    expect(pick('high')).toEqual([null, 'full', 'all', 'animated', 32, 'full', true])
    expect(pick('ultra')).toEqual([null, 'full', 'all', 'animated', 48, 'full', true])
    expect(PRESETS.low.powerPreference).toBe('low-power')
    expect(PRESETS.medium.powerPreference).toBe('default')
    expect(PRESETS.high.powerPreference).toBe('high-performance')
  })

  it('caps the pixel ratio per preset', () => {
    expect(presetPixelRatio('minimal', 2)).toBe(0.75)
    expect(presetPixelRatio('high', 3)).toBe(2)
    expect(pixelRatioFor('low', 3)).toBe(1)
    expect(pixelRatioFor('medium', 3)).toBe(1.5)
    expect(pixelRatioFor('medium', 1)).toBe(1)
    expect(pixelRatioFor('high', 3)).toBe(2)
    expect(pixelRatioFor('ultra', 3)).toBe(3)
  })

  it('resolves auto to the governor preset and fixed settings to themselves', () => {
    expect(resolvePreset('auto', 'medium')).toBe('medium')
    expect(resolvePreset('low', 'high')).toBe('low')
  })
})

describe('auto quality governor', () => {
  it('starts at High', () => {
    expect(createGovernor().preset).toBe('high')
  })

  it('steps down after 3 s below 50 fps, one level at a time', () => {
    const g = createGovernor()
    expect(run(g, 40, 2.5)).toEqual([])
    expect(run(g, 40, 0.5)).toEqual(['medium'])
    expect(run(g, 40, 3)).toEqual(['low'])
    expect(run(g, 20, 10)).toEqual([]) // nothing below Low
    expect(g.preset).toBe('low')
  })

  it('a good window resets the slow-frame timer (short dips are absorbed)', () => {
    const g = createGovernor()
    for (let i = 0; i < 10; i++) {
      expect(run(g, 40, 2)).toEqual([])
      expect(run(g, 55, 0.5)).toEqual([])
    }
    expect(g.preset).toBe('high')
  })

  it('steps back up after 10 s above 58 fps, but never past High in Auto', () => {
    const g = createGovernor()
    run(g, 40, 6)
    expect(g.preset).toBe('low')
    expect(run(g, 60, 9.5)).toEqual([])
    expect(run(g, 60, 0.5)).toEqual(['medium'])
    expect(run(g, 60, 10)).toEqual(['high'])
    expect(run(g, 60, 60)).toEqual([])
    expect(g.preset).toBe(AUTO_MAX)
  })

  it('fps between the thresholds holds the current preset', () => {
    const g = createGovernor()
    run(g, 40, 3)
    expect(run(g, 54, 60)).toEqual([])
    expect(g.preset).toBe('medium')
  })

  it('stops climbing back to a level that failed twice (no oscillation)', () => {
    const g = createGovernor()
    expect(run(g, 40, 3)).toEqual(['medium'])
    expect(run(g, 60, 10)).toEqual(['high']) // first failure: try again
    expect(run(g, 40, 3)).toEqual(['medium'])
    expect(run(g, 60, 60)).toEqual([]) // second failure: stay
    expect(g.preset).toBe('medium')
  })

  it('GV-start: starts at the tier start and never climbs above the ceiling', () => {
    const g = createGovernor({ start: 'low', ceiling: 'medium' })
    expect(g.preset).toBe('low')
    expect(run(g, 60, 10)).toEqual(['medium'])
    expect(run(g, 60, 60)).toEqual([])
    expect(g.preset).toBe('medium')
  })

  it('GV-start: a software tier starts at Minimal and may step down to it again', () => {
    const g = createGovernor({ start: 'minimal', ceiling: 'low' })
    expect(g.preset).toBe('minimal')
    // Reaching a 30 fps cap proves nothing about more headroom: it stays.
    expect(run(g, 30, 30, 30)).toEqual([])
    expect(run(g, 60, 10, null)).toEqual(['low'])
    expect(run(g, 40, 3, 60)).toEqual(['minimal'])
  })

  it('GV-floor: without a Minimal start, Auto never drops below Low', () => {
    const g = createGovernor({ start: 'medium', ceiling: 'high' })
    expect(run(g, 10, 20)).toEqual(['low'])
  })

  it('judges frame rates relative to the frame-rate limit; paused samples are ignored', () => {
    const g = createGovernor({ start: 'medium', ceiling: 'high' })
    // 15 fps under the 15 fps blur cap is neither slow nor proof of headroom.
    expect(run(g, 15, 20, 15)).toEqual([])
    expect(run(g, 0, 10, 0)).toEqual([])
    expect(g.preset).toBe('medium')
    expect(run(g, 10, 3, 15)).toEqual(['low'])
  })

  it('reset() goes back to High and forgets history', () => {
    const g = createGovernor()
    run(g, 40, 6)
    g.reset()
    expect(g.preset).toBe('high')
    expect(run(g, 40, 2.5)).toEqual([])
  })
})

const input = (over: Partial<EffectiveInput> = {}): EffectiveInput => ({
  preset: 'high',
  advanced: GraphicsAdvancedSchema.parse({}),
  dpr: 2,
  power: { focused: true, hidden: false, onBattery: false },
  saver: { blur: true, hidden: true, battery: 'off' },
  ...over,
})
const adv = (a: Partial<EffectiveInput['advanced']>) => GraphicsAdvancedSchema.parse(a)

describe('effectiveGraphics', () => {
  it('Q-eff-1: preset only gives the preset values', () => {
    expect(effectiveGraphics(input())).toEqual({
      preset: 'high',
      resolutionScale: 1,
      pixelRatioCap: 2,
      fpsLimit: null,
      shadows: 'full',
      shadowMap: 2048,
      bloom: true,
      smaa: true,
      gtao: 'half',
      lod: [20, 45],
      maxAnimated: 150,
      labels: { mode: 'all', nearbyM: 30 },
      links: 'animated',
      detailCullM: 32,
      lightmapTier: 'full',
      envMap: true,
      hover: true,
      powerPreference: 'high-performance',
    })
    const min = effectiveGraphics(input({ preset: 'minimal' }))
    expect(min).toMatchObject({ fpsLimit: 30, resolutionScale: 0.75, shadows: 'off', hover: false })
    expect(min.labels).toEqual({ mode: 'nearby', nearbyM: 15 })
  })

  it('Q-eff-2: each advanced override wins over the preset', () => {
    const e = effectiveGraphics(
      input({
        advanced: adv({
          resolution: '0.5',
          fps: '30',
          shadows: 'contact',
          effects: 'off',
          characters: 'low',
          labels: 'selected',
          links: 'off',
          building: 'low',
        }),
      }),
    )
    expect(e).toMatchObject({
      preset: 'high',
      resolutionScale: 0.5,
      fpsLimit: 30,
      shadows: 'contact',
      shadowMap: 0,
      bloom: false,
      smaa: false,
      gtao: 'off',
      lod: [8, 20],
      maxAnimated: 60,
      labels: { mode: 'selected', nearbyM: 30 },
      links: 'off',
      detailCullM: 24,
      lightmapTier: 'half',
    })
    const up = effectiveGraphics(
      input({
        preset: 'minimal',
        advanced: adv({
          fps: 'unlimited',
          shadows: 'full',
          effects: 'on',
          characters: 'high',
          building: 'high',
          labels: 'all',
          links: 'animated',
        }),
      }),
    )
    expect(up).toMatchObject({
      fpsLimit: null,
      shadows: 'full',
      shadowMap: 1024,
      bloom: true,
      smaa: true,
      gtao: 'off',
      lod: [20, 45],
      detailCullM: 32,
      lightmapTier: 'full',
      labels: { mode: 'all', nearbyM: 15 },
      links: 'animated',
    })
    // "On" keeps the preset's own effects when it has some (High keeps its GTAO).
    expect(effectiveGraphics(input({ advanced: adv({ effects: 'on' }) })).gtao).toBe('half')
    expect(effectiveGraphics(input({ advanced: adv({ fps: '60' }) })).fpsLimit).toBe(60)
    expect(
      effectiveGraphics(input({ advanced: adv({ characters: 'medium', building: 'medium' }) })),
    ).toMatchObject({ lod: [15, 35], detailCullM: 32, lightmapTier: 'half' })
  })

  it('Q-eff-3: the pixel ratio cap is resolved against the device pixel ratio', () => {
    expect(effectiveGraphics(input({ preset: 'ultra', dpr: 3 })).pixelRatioCap).toBe(3)
    expect(effectiveGraphics(input({ preset: 'medium', dpr: 3 })).pixelRatioCap).toBe(1.5)
    expect(effectiveGraphics(input({ preset: 'low', dpr: 1 })).pixelRatioCap).toBe(1)
    const e = effectiveGraphics(
      input({ preset: 'high', dpr: 3, advanced: adv({ resolution: '0.67' }) }),
    )
    expect(e.pixelRatioCap * e.resolutionScale).toBeCloseTo(1.34)
  })

  it('Q-eff-4: unfocused with the blur saver caps at 15 fps', () => {
    const blurred = { focused: false, hidden: false, onBattery: false }
    expect(effectiveGraphics(input({ power: blurred })).fpsLimit).toBe(15)
    expect(effectiveGraphics(input({ preset: 'minimal', power: blurred })).fpsLimit).toBe(15)
    expect(
      effectiveGraphics(
        input({ power: blurred, saver: { blur: false, hidden: true, battery: 'off' } }),
      ).fpsLimit,
    ).toBeNull()
  })

  it('Q-eff-5: hidden with the hidden saver pauses (fpsLimit 0)', () => {
    const hidden = { focused: false, hidden: true, onBattery: false }
    expect(effectiveGraphics(input({ power: hidden })).fpsLimit).toBe(0)
    expect(
      effectiveGraphics(
        input({ power: hidden, saver: { blur: true, hidden: false, battery: 'off' } }),
      ).fpsLimit,
    ).toBe(15)
  })

  it('Q-eff-6: the battery preset replaces the preset only on battery', () => {
    const saver = { blur: true, hidden: true, battery: 'low' as const }
    expect(effectiveGraphics(input({ saver })).preset).toBe('high')
    expect(
      effectiveGraphics(input({ saver, power: { focused: true, hidden: false, onBattery: true } }))
        .preset,
    ).toBe('low')
  })

  it('Q-eff-7: battery "off" ignores the battery', () => {
    expect(
      effectiveGraphics(input({ power: { focused: true, hidden: false, onBattery: true } })).preset,
    ).toBe('high')
  })

  it('Q-eff-8: advanced still applies on top of the battery preset', () => {
    const e = effectiveGraphics(
      input({
        advanced: adv({ fps: '30' }),
        saver: { blur: true, hidden: true, battery: 'minimal' },
        power: { focused: true, hidden: false, onBattery: true },
      }),
    )
    expect(e).toMatchObject({ preset: 'minimal', fpsLimit: 30, resolutionScale: 0.75 })
  })
})
