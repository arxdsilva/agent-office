import { describe, expect, it } from 'vitest'
import { HORIZON_ASSET_BASE, HORIZON_LABELS, labelsDefaultFor, manifestUrlFor } from './flavor.ts'

describe('manifestUrlFor', () => {
  it('keeps the controller URL for the Classic asset base', () => {
    expect(manifestUrlFor('assets/manifest.json', 'assets/')).toBe('assets/manifest.json')
  })

  it("rewrites it to the flavor's own manifest", () => {
    expect(manifestUrlFor('assets/manifest.json', HORIZON_ASSET_BASE)).toBe('horizon/manifest.json')
    expect(manifestUrlFor('./assets/manifest.json?v=2', 'horizon/')).toBe('horizon/manifest.json')
  })
})

describe('labelsDefaultFor', () => {
  it('Horizon defaults name tags to nearby; the other views keep the preset', () => {
    expect(HORIZON_LABELS).toBe('nearby')
    expect(labelsDefaultFor('special')).toBe('nearby')
    expect(labelsDefaultFor('3d')).toBeUndefined()
    expect(labelsDefaultFor('pixel')).toBeUndefined()
    expect(labelsDefaultFor(undefined)).toBeUndefined()
  })
})
