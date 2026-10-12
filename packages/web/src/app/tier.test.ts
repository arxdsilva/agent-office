import { describe, expect, it } from 'vitest'
import type { HardwareInfo } from './graphics-types.ts'
import { detectTier, UNKNOWN_TIER } from './tier.ts'

const hw = (renderer: string, over: Partial<HardwareInfo> = {}): HardwareInfo => ({
  renderer,
  vendor: 'Google Inc.',
  maxTextureSize: 16384,
  dpr: 1,
  cores: 8,
  memoryGB: 16,
  webgl2: true,
  ...over,
})

describe('detectTier', () => {
  it('TR-1: software rendering starts at Minimal, ceiling Low', () => {
    for (const r of [
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
      'Google SwiftShader',
      'llvmpipe (LLVM 15.0.7, 256 bits)',
      'Microsoft Basic Render Driver',
    ])
      expect(detectTier(hw(r))).toEqual({ start: 'minimal', ceiling: 'low', why: 'software' })
  })

  it('TR-2: Intel UHD / HD / Iris and mobile GPUs start at Low, ceiling Medium', () => {
    for (const r of [
      'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'Intel(R) HD Graphics 520',
      'Intel Iris Pro OpenGL Engine',
      'Mali-G78',
      'Adreno (TM) 650',
      'PowerVR Rogue GE8320',
    ])
      expect(detectTier(hw(r))).toEqual({ start: 'low', ceiling: 'medium', why: 'integrated' })
  })

  it('TR-3: Apple M1/M2 base, Radeon APUs and Iris Xe start at Medium, ceiling High', () => {
    for (const r of [
      'Apple M1',
      'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
      'AMD Radeon(TM) Graphics',
      'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
    ])
      expect(detectTier(hw(r))).toEqual({ start: 'medium', ceiling: 'high', why: 'integrated' })
  })

  it('TR-4: Apple Pro/Max and later, discrete NVIDIA, Radeon RX and Arc start at High, ceiling Ultra', () => {
    for (const r of [
      'Apple M3 Pro',
      'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max, Unspecified Version)',
      'Apple M4',
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'AMD Radeon RX 6800 XT',
      'Intel(R) Arc(TM) A770 Graphics',
    ])
      expect(detectTier(hw(r))).toEqual({ start: 'high', ceiling: 'ultra', why: 'capable' })
  })

  it('TR-5: low memory or few cores cap the start at Low', () => {
    expect(detectTier(hw('Apple M3 Pro', { memoryGB: 4 }))).toEqual({
      start: 'low',
      ceiling: 'ultra',
      why: 'lowMemory',
    })
    expect(detectTier(hw('NVIDIA GeForce GTX 1050', { cores: 4 })).start).toBe('low')
    // Already at Low or below: unchanged, keeps its reason.
    expect(detectTier(hw('Google SwiftShader', { memoryGB: 2 }))).toEqual({
      start: 'minimal',
      ceiling: 'low',
      why: 'software',
    })
  })

  it('TR-6: an unknown renderer is a safe middle (Medium / High)', () => {
    expect(detectTier(hw('Some Future GPU 9000'))).toEqual(UNKNOWN_TIER)
    expect(UNKNOWN_TIER).toEqual({ start: 'medium', ceiling: 'high', why: 'capable' })
    expect(detectTier(hw('', { vendor: '' }))).toEqual(UNKNOWN_TIER)
  })

  it('reads the vendor when the renderer string is generic', () => {
    expect(detectTier(hw('WebKit WebGL', { vendor: 'Intel(R) HD Graphics 4000' })).start).toBe(
      'low',
    )
  })

  it('a high-DPI display keeps the tier (the preset caps the pixel ratio)', () => {
    expect(detectTier(hw('Intel(R) UHD Graphics 620', { dpr: 2 }))).toEqual({
      start: 'low',
      ceiling: 'medium',
      why: 'integrated',
    })
  })

  it('TR-sw: no WebGL2 gives Minimal', () => {
    expect(detectTier(hw('Apple M3 Pro', { webgl2: false }))).toEqual({
      start: 'minimal',
      ceiling: 'low',
      why: 'software',
    })
  })
})
