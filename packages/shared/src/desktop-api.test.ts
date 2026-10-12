import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  GRAPHICS_QUALITIES,
  IPC,
  SendMessageArgsSchema,
  SettingsPatchSchema,
  SettingsSchema,
} from './desktop-api.ts'

describe('SettingsSchema', () => {
  it('fills defaults for a missing/empty file', () => {
    expect(SettingsSchema.parse({})).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS).toMatchObject({
      port: 4317,
      notifications: true,
      launchAtLogin: false,
    })
  })

  it('rejects privileged or invalid ports', () => {
    expect(SettingsSchema.safeParse({ port: 80 }).success).toBe(false)
    expect(SettingsSchema.safeParse({ port: 70000 }).success).toBe(false)
    expect(SettingsSchema.safeParse({ port: 4318 }).success).toBe(true)
  })

  it('graphicsQuality defaults to auto and accepts only the presets', () => {
    expect(DEFAULT_SETTINGS.graphicsQuality).toBe('auto')
    expect(GRAPHICS_QUALITIES).toEqual(['auto', 'low', 'medium', 'high', 'ultra'])
    for (const q of GRAPHICS_QUALITIES)
      expect(SettingsSchema.parse({ graphicsQuality: q }).graphicsQuality).toBe(q)
    expect(SettingsSchema.safeParse({ graphicsQuality: 'max' }).success).toBe(false)
    expect(SettingsPatchSchema.safeParse({ graphicsQuality: 'low' }).success).toBe(true)
    expect(SettingsPatchSchema.safeParse({ graphicsQuality: 3 }).success).toBe(false)
  })

  it('discoverCapabilities defaults to true and is a boolean', () => {
    expect(DEFAULT_SETTINGS.discoverCapabilities).toBe(true)
    expect(SettingsSchema.parse({ discoverCapabilities: false }).discoverCapabilities).toBe(false)
    expect(SettingsPatchSchema.safeParse({ discoverCapabilities: 'yes' }).success).toBe(false)
  })

  it('patches are partial and strict about types', () => {
    expect(SettingsPatchSchema.safeParse({ notifications: false }).success).toBe(true)
    expect(SettingsPatchSchema.safeParse({ notifications: 'no' }).success).toBe(false)
  })
})

describe('IPC payloads', () => {
  it('validates send-message arguments', () => {
    expect(SendMessageArgsSchema.safeParse({ agentId: 'a', text: 'hi' }).success).toBe(true)
    expect(SendMessageArgsSchema.safeParse({ agentId: '', text: 'hi' }).success).toBe(false)
    expect(SendMessageArgsSchema.safeParse({ agentId: 'a', text: 'x'.repeat(4001) }).success).toBe(
      false,
    )
  })

  it('channel names are unique', () => {
    const names = Object.values(IPC)
    expect(new Set(names).size).toBe(names.length)
  })
})
