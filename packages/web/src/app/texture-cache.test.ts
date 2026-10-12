import { describe, expect, it } from 'vitest'
import { createTextureDedup, lightmapSource, textureBytes, textureHash } from './texture-cache.ts'

describe('texture dedup', () => {
  it('AS-1: the first texture with a hash wins; later ones are marked for disposal', () => {
    const cache = createTextureDedup<{ name: string }>()
    const a = { name: 'a' }
    const b = { name: 'b' }
    expect(cache.register(a, 'abcdef012345')).toEqual({ use: a, duplicate: null })
    expect(cache.register(b, 'abcdef012345')).toEqual({ use: a, duplicate: b })
    // Registering the kept texture again is not a duplicate of itself.
    expect(cache.register(a, 'abcdef012345')).toEqual({ use: a, duplicate: null })
    expect(cache.unique()).toEqual([a])
    expect(cache.size).toBe(1)
    cache.clear()
    expect(cache.size).toBe(0)
  })

  it('AS-2: textures without a hash pass through and are still counted once', () => {
    const cache = createTextureDedup<{ name: string }>()
    const a = { name: 'a' }
    expect(cache.register(a, undefined)).toEqual({ use: a, duplicate: null })
    expect(cache.register(a, undefined)).toEqual({ use: a, duplicate: null })
    expect(cache.unique()).toEqual([a])
  })

  it('reads the hash from glTF extras (12 hex chars only)', () => {
    expect(textureHash({ hash: '0123456789ab' })).toBe('0123456789ab')
    expect(textureHash({ hash: 'not-a-hash' })).toBeUndefined()
    expect(textureHash({ hash: 12 })).toBeUndefined()
    expect(textureHash(undefined)).toBeUndefined()
    expect(textureHash('x')).toBeUndefined()
  })
})

describe('lightmapSource', () => {
  const lm = {
    file: 'atrium.lightmap.png',
    variants: { full: 'a.full.ktx2', half: 'a.half.ktx2', quarter: 'a.quarter.ktx2' },
  }

  it('AS-3: picks the KTX2 variant for the tier', () => {
    expect(lightmapSource(lm, 'full')).toEqual({ url: 'a.full.ktx2', ktx2: true })
    expect(lightmapSource(lm, 'half')).toEqual({ url: 'a.half.ktx2', ktx2: true })
    expect(lightmapSource(lm, 'quarter')).toEqual({ url: 'a.quarter.ktx2', ktx2: true })
  })

  it('AS-3: falls back to the PNG without variants (older manifests)', () => {
    expect(lightmapSource({ file: 'a.png' }, 'half')).toEqual({ url: 'a.png', ktx2: false })
    expect(lightmapSource({ file: 'a.png', variants: { full: 'a.full.ktx2' } }, 'quarter')).toEqual(
      { url: 'a.full.ktx2', ktx2: true },
    )
  })
})

describe('textureBytes', () => {
  it('counts width × height × bytes per pixel, plus a third for mipmaps', () => {
    expect(textureBytes(1024, 1024, 'rgba8', false)).toBe(4 * 1024 * 1024)
    expect(textureBytes(1024, 1024, 'rgba8', true)).toBeCloseTo((4 * 1024 * 1024 * 4) / 3)
    expect(textureBytes(1024, 1024, 'compressed', false)).toBe(1024 * 1024)
    expect(textureBytes(1024, 1024, 'bc1', false)).toBe(512 * 1024)
  })
})
