import { describe, expect, it } from 'vitest'
import { AUTO_MAX, createGovernor, PRESETS, pixelRatioFor, resolvePreset } from './quality.ts'

/** Feeds `seconds` of frames at a steady `fps` in 0.5 s windows; returns every preset change. */
function run(g: ReturnType<typeof createGovernor>, fps: number, seconds: number) {
  const changes: string[] = []
  for (let t = 0; t < seconds; t += 0.5) {
    const c = g.sample(fps, 0.5)
    if (c) changes.push(c)
  }
  return changes
}

describe('quality presets', () => {
  it('match the plan table (§4.2)', () => {
    expect(PRESETS.low).toMatchObject({ shadowMap: 0, gtao: 'off', bloom: false, smaa: false })
    expect(PRESETS.medium).toMatchObject({ shadowMap: 1024, gtao: 'half', bloom: true, smaa: true })
    expect(PRESETS.high).toMatchObject({ shadowMap: 2048, gtao: 'full', bloom: true, smaa: true })
    expect(PRESETS.ultra).toMatchObject({ shadowMap: 4096, gtao: 'high', bloom: true, smaa: true })
    expect(PRESETS.low.lod).toEqual([8, 20])
    expect(PRESETS.medium.lod).toEqual([15, 35])
    expect(PRESETS.high.lod).toEqual([20, 45])
    expect(PRESETS.ultra.lod).toEqual([30, 60])
    expect([60, 120, 150, 250]).toEqual(
      (['low', 'medium', 'high', 'ultra'] as const).map((p) => PRESETS[p].maxAnimated),
    )
  })

  it('caps the pixel ratio per preset', () => {
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

  it('reset() goes back to High and forgets history', () => {
    const g = createGovernor()
    run(g, 40, 6)
    g.reset()
    expect(g.preset).toBe('high')
    expect(run(g, 40, 2.5)).toEqual([])
  })
})
