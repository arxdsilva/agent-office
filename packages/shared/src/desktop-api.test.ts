import { describe, expect, it } from 'vitest'
import { PERMISSION_MODES, PermissionModeSchema } from './protocol.ts'
import { PROVIDER_IDS } from './providers.ts'
import {
  GraphicsAdvancedSchema,
  AnswerArgsSchema,
  NewSessionArgsSchema,
  CopyTextSchema,
  DEFAULT_SETTINGS,
  GRAPHICS_QUALITIES,
  IPC,
  SendMessageArgsSchema,
  SettingsPatchSchema,
  SettingsSchema,
  SetModeIdArgsSchema,
  ProviderEnableArgsSchema,
  ProviderCallSchema,
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
    expect(GRAPHICS_QUALITIES).toEqual(['auto', 'minimal', 'low', 'medium', 'high', 'ultra'])
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

describe('graphics settings (low-spec plan §4.1)', () => {
  it('adds a Minimal preset and keeps Auto as the default', () => {
    expect(GRAPHICS_QUALITIES).toEqual(['auto', 'minimal', 'low', 'medium', 'high', 'ultra'])
    expect(DEFAULT_SETTINGS.graphicsQuality).toBe('auto')
  })

  it('defaults every advanced option to auto and power saver on', () => {
    expect(DEFAULT_SETTINGS.graphicsAdvanced).toEqual({
      resolution: 'auto',
      fps: 'auto',
      shadows: 'auto',
      effects: 'auto',
      characters: 'auto',
      labels: 'auto',
      links: 'auto',
      building: 'auto',
    })
    expect(DEFAULT_SETTINGS).toMatchObject({
      powerSaverBlur: true,
      powerSaverHidden: true,
      batteryPreset: 'off',
      hardwareAcceleration: true,
    })
  })

  it('rejects unknown advanced values and accepts a partial advanced object', () => {
    expect(GraphicsAdvancedSchema.safeParse({ fps: '45' }).success).toBe(false)
    expect(GraphicsAdvancedSchema.parse({ fps: '30' })).toMatchObject({ fps: '30', labels: 'auto' })
    expect(
      SettingsPatchSchema.safeParse({ graphicsAdvanced: { labels: 'selected' } }).success,
    ).toBe(true)
  })

  it('reads an older settings file without the new fields', () => {
    const old = SettingsSchema.parse({ graphicsQuality: 'low', port: 4317 })
    expect(old.graphicsQuality).toBe('low')
    expect(old.graphicsAdvanced.fps).toBe('auto')
    expect(old.hardwareAcceleration).toBe(true)
  })
})

describe('view mode (2D RPG plan §10.1)', () => {
  // An optional extra view: everyone stays on the 3D office unless they pick 2D.
  it('defaults to the 3D office and accepts the 2D RPG mode', () => {
    expect(DEFAULT_SETTINGS.viewMode).toBe('3d')
    expect(SettingsPatchSchema.safeParse({ viewMode: 'pixel' }).success).toBe(true)
    expect(SettingsPatchSchema.safeParse({ viewMode: '2d' }).success).toBe(false)
    expect(SettingsSchema.parse({ graphicsQuality: 'low' }).viewMode).toBe('3d')
  })

  // Horizon ('special') was removed: a saved choice opens Classic 3D; nobody can pick it anymore.
  it('reads a saved Horizon choice as Classic 3D and rejects it in a patch', () => {
    expect(SettingsSchema.parse({ viewMode: 'special' }).viewMode).toBe('3d')
    expect(SettingsPatchSchema.safeParse({ viewMode: 'special' }).success).toBe(false)
    expect(SettingsPatchSchema.safeParse({ viewMode: 'minimal' }).success).toBe(true)
  })
})

// Multi-provider contract (plan "multi-provider platform" §1): additive, old payloads still valid.
describe('provider contracts', () => {
  it('defaults provider settings to empty and accepts a subset of providers', () => {
    expect(DEFAULT_SETTINGS.providers).toEqual({})
    expect(SettingsSchema.parse({ providers: { codex: { enabled: true } } }).providers).toEqual({
      codex: { enabled: true },
    })
    expect(SettingsSchema.safeParse({ providers: { windsurf: { enabled: true } } }).success).toBe(
      false,
    )
  })

  it('starts Claude Code sessions when a new-session payload names no provider', () => {
    const base = { folder: 'ctx_abcdefghijkl', text: 'hi' }
    expect(NewSessionArgsSchema.parse(base).provider).toBe('claude-code')
    expect(NewSessionArgsSchema.parse({ ...base, provider: 'codex', modeId: 'ask' })).toMatchObject(
      {
        provider: 'codex',
        modeId: 'ask',
      },
    )
    expect(NewSessionArgsSchema.safeParse({ ...base, provider: 'not-a-provider' }).success).toBe(
      false,
    )
    expect(NewSessionArgsSchema.safeParse({ ...base, modeId: 'x'.repeat(61) }).success).toBe(false)
  })

  it('validates provider and mode-id calls', () => {
    expect(SetModeIdArgsSchema.safeParse({ agentId: 'cx:1', modeId: 'auto' }).success).toBe(true)
    expect(SetModeIdArgsSchema.safeParse({ agentId: 'cx:1', modeId: '' }).success).toBe(false)
    expect(ProviderEnableArgsSchema.safeParse({ provider: 'cursor', enabled: true }).success).toBe(
      true,
    )
    expect(ProviderCallSchema.safeParse({ provider: 'cursor-ide' }).success).toBe(false)
    expect(PROVIDER_IDS).toContain('claude-code')
  })
})

// Zod 4 keeps `.default()` inside `.partial()`: a patch must carry only the keys it was given, or every
// settings change would silently reset all other settings to their defaults (found by graphics G2 on CI).
describe('SettingsPatchSchema', () => {
  it('keeps only the given keys (no defaults injected)', () => {
    expect(SettingsPatchSchema.parse({ theme: 'dark' })).toEqual({ theme: 'dark' })
    expect(SettingsPatchSchema.parse({ graphicsAdvanced: { fps: '30' } })).toEqual({
      graphicsAdvanced: expect.objectContaining({ fps: '30' }),
    })
    expect(Object.keys(SettingsPatchSchema.parse({ port: 4400 }))).toEqual(['port'])
  })

  it('still validates values and rejects unknown keys', () => {
    expect(SettingsPatchSchema.safeParse({ port: 80 }).success).toBe(false)
    expect(SettingsPatchSchema.safeParse({ nope: true }).success).toBe(false)
  })
})
