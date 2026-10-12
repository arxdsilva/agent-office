import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, IPC, SendMessageArgsSchema, SettingsPatchSchema, SettingsSchema } from './desktop-api.ts'

describe('SettingsSchema', () => {
  it('fills defaults for a missing/empty file', () => {
    expect(SettingsSchema.parse({})).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS).toMatchObject({ port: 4317, notifications: true, launchAtLogin: false })
  })

  it('rejects privileged or invalid ports', () => {
    expect(SettingsSchema.safeParse({ port: 80 }).success).toBe(false)
    expect(SettingsSchema.safeParse({ port: 70000 }).success).toBe(false)
    expect(SettingsSchema.safeParse({ port: 4318 }).success).toBe(true)
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
    expect(SendMessageArgsSchema.safeParse({ agentId: 'a', text: 'x'.repeat(4001) }).success).toBe(false)
  })

  it('channel names are unique', () => {
    const names = Object.values(IPC)
    expect(new Set(names).size).toBe(names.length)
  })
})
