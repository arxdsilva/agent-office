// The Horizon failure card's diagnostics are safe (no paths, no URLs) and its test seam only
// works with ?debug=1.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { forcedHorizonFailure, safeDiagnostic } from './failure.ts'

describe('safeDiagnostic', () => {
  it('keeps the first line without paths or URLs, at most 120 characters', () => {
    const e = new Error('cannot read /Users/me/secret/file.glb from https://x.test/a?b=1\nstack')
    const d = safeDiagnostic(e)
    expect(d).toBe('Error: cannot read … from …')
    expect(safeDiagnostic(`C:\\Users\\me\\x ${'y'.repeat(300)}`).length).toBeLessThanOrEqual(120)
    expect(safeDiagnostic('plain')).toBe('plain')
  })
})

describe('forcedHorizonFailure', () => {
  afterEach(() => vi.unstubAllGlobals())
  const at = (search: string, extra: Record<string, unknown> = {}) => {
    vi.stubGlobal('location', { search })
    vi.stubGlobal('window', extra)
    vi.stubGlobal('localStorage', { getItem: () => null })
  }

  it('honours ?forceSpecialFail=1', () => {
    at('?forceSpecialFail=1')
    expect(forcedHorizonFailure()).toBe(true)
  })

  it('takes the window flag only in debug builds', () => {
    at('?debug=1', { __aoForceSpecialFail: true })
    expect(forcedHorizonFailure()).toBe(true)
    at('', { __aoForceSpecialFail: true })
    expect(forcedHorizonFailure()).toBe(false)
  })

  it('reads localStorage in debug builds and survives it throwing', () => {
    at('?debug=1')
    vi.stubGlobal('localStorage', { getItem: () => '1' })
    expect(forcedHorizonFailure()).toBe(true)
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
    })
    expect(forcedHorizonFailure()).toBe(false)
  })
})
