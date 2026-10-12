import { DEFAULT_SETTINGS } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { ValidationError } from '../../src/domain/errors.ts'
import type { ClaudeSettingsStore, HookRunner, SettingsRepository } from '../../src/ports/driven.ts'

/** Every SettingsRepository must pass this. `make()` returns a fresh, empty store. */
export function settingsRepositoryContract(name: string, make: () => Promise<SettingsRepository>) {
  describe(`SettingsRepository contract: ${name}`, () => {
    it('returns defaults when nothing was saved', async () => {
      expect(await (await make()).load()).toEqual(DEFAULT_SETTINGS)
    })

    it('round-trips saved settings', async () => {
      const repo = await make()
      const s = { ...DEFAULT_SETTINGS, port: 5050, notifications: false }
      await repo.save(s)
      expect(await repo.load()).toEqual(s)
    })
  })
}

/**
 * Every ClaudeSettingsStore must pass this. `make(initial)` creates a store whose file holds
 * `initial` (undefined = no file, string = raw contents); `backup()` reads the last backup.
 */
export function claudeSettingsStoreContract(
  name: string,
  make: (
    initial?: string,
  ) => Promise<{ store: ClaudeSettingsStore; backup: () => Promise<string | undefined> }>,
) {
  describe(`ClaudeSettingsStore contract: ${name}`, () => {
    it('reads undefined when there is no file', async () => {
      const { store } = await make()
      expect(await store.read()).toBeUndefined()
    })

    it('reads JSON and writes with a backup of the previous contents', async () => {
      const { store, backup } = await make('{"theme":"dark"}')
      expect(await store.read()).toEqual({ theme: 'dark' })
      await store.write({ theme: 'light' })
      expect(await store.read()).toEqual({ theme: 'light' })
      expect(JSON.parse((await backup())!)).toEqual({ theme: 'dark' })
    })

    it('refuses invalid JSON with a ValidationError', async () => {
      const { store } = await make('{oops')
      await expect(store.read()).rejects.toBeInstanceOf(ValidationError)
    })
  })
}

/** Every HookRunner must pass this. */
export function hookRunnerContract(
  name: string,
  make: () => Promise<{ runner: HookRunner; exists: () => Promise<boolean> }>,
) {
  describe(`HookRunner contract: ${name}`, () => {
    it('exposes a command that mentions the hook marker', async () => {
      const { runner } = await make()
      expect(runner.command()).toContain('agent-office-hook')
    })

    it('installs idempotently and removes', async () => {
      const { runner, exists } = await make()
      await runner.ensureInstalled()
      await runner.ensureInstalled()
      expect(await exists()).toBe(true)
      await runner.remove()
      expect(await exists()).toBe(false)
      await expect(runner.remove()).resolves.toBeUndefined()
    })
  })
}
