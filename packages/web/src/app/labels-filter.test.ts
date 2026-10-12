import { describe, expect, it } from 'vitest'
import { labelVisible, needsOcclusion, type LabelFilter } from './labels-filter.ts'

const f = (mode: LabelFilter['mode'], selected: string | null = 'sel'): LabelFilter => ({
  mode,
  nearbyM: 15,
  selected,
})

describe('labels filter', () => {
  it('LB-1: "selected" shows only the selected tag', () => {
    expect(labelVisible(f('selected'), 'sel', 50)).toBe(true)
    expect(labelVisible(f('selected'), 'other', 1)).toBe(false)
    expect(labelVisible(f('selected', null), 'other', 1)).toBe(false)
  })

  it('LB-2: "nearby" hides tags beyond nearbyM (the selected one always shows); "all" shows all', () => {
    expect(labelVisible(f('nearby'), 'a', 14.9)).toBe(true)
    expect(labelVisible(f('nearby'), 'a', 15)).toBe(false)
    expect(labelVisible(f('nearby'), 'sel', 80)).toBe(true)
    expect(labelVisible(f('all'), 'a', 500)).toBe(true)
  })

  it('LB-3: hidden tags and the selected tag skip the occlusion test', () => {
    expect(needsOcclusion(f('nearby'), 'a', 20)).toBe(false)
    expect(needsOcclusion(f('selected'), 'a', 2)).toBe(false)
    expect(needsOcclusion(f('nearby'), 'sel', 2)).toBe(false)
    expect(needsOcclusion(f('nearby'), 'a', 2)).toBe(true)
    expect(needsOcclusion(f('all'), 'a', 200)).toBe(true)
  })
})
