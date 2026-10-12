import { SettingsSchema, type Settings, type SettingsPatch } from '@agent-office/shared'
import { ValidationError } from './errors.ts'

/** Fields whose change needs the backend (HTTP API + sources) to restart. */
const RESTART_FIELDS = ['port', 'claudeAdapter', 'mock'] as const

export function mergeSettings(current: Settings, patch: SettingsPatch): { settings: Settings; restartRequired: boolean } {
  const parsed = SettingsSchema.safeParse({ ...current, ...patch })
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  const settings = parsed.data
  return { settings, restartRequired: RESTART_FIELDS.some((k) => settings[k] !== current[k]) }
}
