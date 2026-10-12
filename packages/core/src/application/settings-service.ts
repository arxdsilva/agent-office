import type { Settings, SettingsPatch, SettingsResult } from '@agent-office/shared'
import { mergeSettings } from '../domain/settings.ts'
import type { LoginItem, SettingsRepository } from '../ports/driven.ts'
import type { SettingsManagement } from '../ports/driving.ts'

export interface SettingsDeps {
  repo: SettingsRepository
  loginItem: LoginItem
}

export class SettingsService implements SettingsManagement {
  private listeners = new Set<(r: SettingsResult) => void>()

  constructor(private d: SettingsDeps) {}

  get(): Promise<Settings> {
    return this.d.repo.load()
  }

  async update(patch: SettingsPatch): Promise<SettingsResult> {
    const current = await this.d.repo.load()
    const result = mergeSettings(current, patch)
    await this.d.repo.save(result.settings)
    if (result.settings.launchAtLogin !== current.launchAtLogin)
      this.d.loginItem.setOpenAtLogin(result.settings.launchAtLogin)
    for (const l of this.listeners) l(result)
    return result
  }

  onChange(fn: (r: SettingsResult) => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
}
