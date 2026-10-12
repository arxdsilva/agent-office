import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GEMINI_HOOK_FORMAT, geminiSettingsPath } from './hook-format.ts'

describe('gemini hook format', () => {
  it('uses the shared format id', () => expect(GEMINI_HOOK_FORMAT).toBe('gemini-settings'))
  it('defaults under the home directory', () => {
    expect(geminiSettingsPath({}, '/home/u')).toBe(join('/home/u', '.gemini', 'settings.json'))
  })
  it('honours GEMINI_SETTINGS_FILE', () => {
    expect(geminiSettingsPath({ GEMINI_SETTINGS_FILE: '/t/x' }, '/home/u')).toBe('/t/x')
  })
})
