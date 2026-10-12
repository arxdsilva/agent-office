import { DEFAULT_SETTINGS } from '@agent-office/shared'
import { describe, expect, it, vi } from 'vitest'
import { ValidationError } from '../domain/errors.ts'
import { FakeSettingsRepository, RecordingLoginItem } from '../../test/fakes/index.ts'
import { SettingsService } from './settings-service.ts'

describe('SettingsService', () => {
  it('saves patches, applies login-item changes and notifies listeners', async () => {
    const repo = new FakeSettingsRepository()
    const login = new RecordingLoginItem()
    const svc = new SettingsService({ repo, loginItem: login })
    const listener = vi.fn()
    svc.onChange(listener)
    const r = await svc.update({ launchAtLogin: true, port: 5000 })
    expect(r).toEqual({
      settings: { ...DEFAULT_SETTINGS, launchAtLogin: true, port: 5000 },
      restartRequired: true,
    })
    expect(repo.saved?.port).toBe(5000)
    expect(login.calls).toEqual([true])
    expect(listener).toHaveBeenCalledWith(r)
    await svc.update({ notifications: false })
    expect(login.calls).toEqual([true])
    expect(await svc.get()).toMatchObject({ notifications: false, port: 5000 })
  })

  it('rejects invalid patches without saving', async () => {
    const repo = new FakeSettingsRepository()
    const svc = new SettingsService({ repo, loginItem: new RecordingLoginItem() })
    await expect(svc.update({ port: 1 })).rejects.toBeInstanceOf(ValidationError)
    expect(repo.saved).toBeUndefined()
  })

  it('unsubscribed listeners are not called', async () => {
    const svc = new SettingsService({
      repo: new FakeSettingsRepository(),
      loginItem: new RecordingLoginItem(),
    })
    const listener = vi.fn()
    svc.onChange(listener)()
    await svc.update({ mock: true })
    expect(listener).not.toHaveBeenCalled()
  })
})
