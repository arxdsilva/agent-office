import { describe, expect, it } from 'vitest'
import { ValidationError } from '../domain/errors.ts'
import { FakeClaudeSettingsStore, FakeHookRunner } from '../../test/fakes/index.ts'
import { HookService } from './hook-service.ts'

function setup(raw?: string, cmd?: string) {
  const claude = new FakeClaudeSettingsStore(raw)
  const runner = new FakeHookRunner(cmd)
  return { claude, runner, svc: new HookService({ claude, runner }) }
}

describe('HookService', () => {
  it('installs: writes the runner, merges settings (keeping foreign keys), reports installed', async () => {
    const { svc, claude, runner } = setup('{"theme":"dark"}')
    expect(await svc.status()).toBe('not-installed')
    expect(await svc.install()).toBe('installed')
    expect(runner.installed).toBe(true)
    expect(JSON.parse(claude.raw!).theme).toBe('dark')
    expect(claude.lastBackup).toBe('{"theme":"dark"}')
  })

  it('installs into a missing settings file', async () => {
    const { svc } = setup(undefined)
    expect(await svc.install()).toBe('installed')
  })

  it('uninstalls: removes our entries and the runner', async () => {
    const { svc, claude, runner } = setup('{"theme":"dark"}')
    await svc.install()
    expect(await svc.uninstall()).toBe('not-installed')
    expect(JSON.parse(claude.raw!)).toEqual({ theme: 'dark' })
    expect(runner.installed).toBe(false)
  })

  it('uninstall without a settings file only removes the runner', async () => {
    const { svc, claude } = setup(undefined)
    expect(await svc.uninstall()).toBe('not-installed')
    expect(claude.raw).toBeUndefined()
  })

  it('heal refreshes an outdated command and leaves non-installed setups alone', async () => {
    const outdated = setup(
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'node /old/agent-office-hook.mjs' }] }],
        },
      }),
    )
    expect(await outdated.svc.status()).toBe('outdated')
    await outdated.svc.heal()
    expect(await outdated.svc.status()).toBe('installed')
    expect(outdated.runner.installed).toBe(true)

    const none = setup('{}')
    await none.svc.heal()
    expect(none.runner.installed).toBe(false)
    expect(none.claude.lastBackup).toBeUndefined()
  })

  it('propagates invalid Claude settings as ValidationError and does not write', async () => {
    const { svc, claude } = setup('{oops')
    await expect(svc.install()).rejects.toBeInstanceOf(ValidationError)
    expect(claude.raw).toBe('{oops')
  })
})
