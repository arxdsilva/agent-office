import { DEFAULT_SETTINGS } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { ValidationError } from './errors.ts'
import { mergeSettings } from './settings.ts'

describe('mergeSettings', () => {
  it('applies a patch and flags fields that need a backend restart', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, { notifications: false })).toEqual({
      settings: { ...DEFAULT_SETTINGS, notifications: false },
      restartRequired: false,
    })
    expect(mergeSettings(DEFAULT_SETTINGS, { port: 5000 }).restartRequired).toBe(true)
    expect(mergeSettings(DEFAULT_SETTINGS, { claudeAdapter: false }).restartRequired).toBe(true)
    expect(mergeSettings(DEFAULT_SETTINGS, { port: DEFAULT_SETTINGS.port }).restartRequired).toBe(
      false,
    )
  })

  it('rejects invalid patches', () => {
    expect(() => mergeSettings(DEFAULT_SETTINGS, { port: 1 })).toThrow(ValidationError)
  })
})
