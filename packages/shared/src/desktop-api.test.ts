import { describe, expect, it } from 'vitest'
import { PERMISSION_MODES, PermissionModeSchema } from './protocol.ts'
import {
  AnswerArgsSchema,
  NewSessionArgsSchema,
  CopyTextSchema,
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

  it('limits clipboard text to 1–4000 characters', () => {
    expect(CopyTextSchema.safeParse('curl …').success).toBe(true)
    expect(CopyTextSchema.safeParse('x'.repeat(4000)).success).toBe(true)
    expect(CopyTextSchema.safeParse('').success).toBe(false)
    expect(CopyTextSchema.safeParse('x'.repeat(4001)).success).toBe(false)
    expect(CopyTextSchema.safeParse(42).success).toBe(false)
  })

  it('channel names are unique', () => {
    const names = Object.values(IPC)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('managed sessions and context contracts', () => {
  const ref = 'ctx_abc123def456'

  it('lists the six Claude Code permission modes', () => {
    expect(PERMISSION_MODES).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'auto',
      'dontAsk',
      'bypassPermissions',
    ])
    expect(PermissionModeSchema.safeParse('yolo').success).toBe(false)
  })

  it('accepts messages with or without context refs and tool ids, within limits', () => {
    const base = { agentId: 'a', text: 'hi' }
    expect(SendMessageArgsSchema.safeParse(base).success).toBe(true)
    expect(
      SendMessageArgsSchema.safeParse({ ...base, context: [ref], use: ['mcp:claude-in-chrome'] })
        .success,
    ).toBe(true)
    expect(
      SendMessageArgsSchema.safeParse({ ...base, use: ['skill:run-office', 'shell'] }).success,
    ).toBe(true)
    expect(SendMessageArgsSchema.safeParse({ ...base, context: Array(10).fill(ref) }).success).toBe(
      true,
    )
    expect(SendMessageArgsSchema.safeParse({ ...base, context: Array(11).fill(ref) }).success).toBe(
      false,
    )
    expect(SendMessageArgsSchema.safeParse({ ...base, context: ['ctx_ABC'] }).success).toBe(false)
    expect(SendMessageArgsSchema.safeParse({ ...base, context: ['/etc/passwd'] }).success).toBe(
      false,
    )
    expect(SendMessageArgsSchema.safeParse({ ...base, use: ['rm -rf /'] }).success).toBe(false)
    expect(SendMessageArgsSchema.safeParse({ ...base, use: Array(6).fill('web') }).success).toBe(
      false,
    )
  })

  it('fills new-session defaults and requires a folder and a first message', () => {
    const parsed = NewSessionArgsSchema.parse({ folder: ref, text: 'Plan the logout flow' })
    expect(parsed).toMatchObject({ mode: 'default', extraFolders: [], chrome: false })
    expect(NewSessionArgsSchema.safeParse({ text: 'x' }).success).toBe(false)
    expect(NewSessionArgsSchema.safeParse({ folder: ref, text: '' }).success).toBe(false)
  })

  it('defaults the theme to system and bypass mode to off', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('system')
    expect(DEFAULT_SETTINGS.allowBypassPermissions).toBe(false)
    expect(SettingsPatchSchema.safeParse({ theme: 'dark' }).success).toBe(true)
    expect(SettingsPatchSchema.safeParse({ theme: 'sepia' }).success).toBe(false)
  })

  it('checks permission answer ids and decisions', () => {
    const ok = { agentId: 'a', requestId: 'perm_0a1b2c3d4e', decision: 'allow-session' }
    expect(AnswerArgsSchema.safeParse(ok).success).toBe(true)
    expect(AnswerArgsSchema.safeParse({ ...ok, requestId: 'perm_x' }).success).toBe(false)
    expect(AnswerArgsSchema.safeParse({ ...ok, decision: 'always' }).success).toBe(false)
  })
})
