import { describe, expect, it } from 'vitest'
import { FakeHookRunner, FakeJsonConfigStore, MemoryLogger } from '../../test/fakes/index.ts'
import { ValidationError } from '../domain/errors.ts'
import { ProviderHookService } from './provider-hook-service.ts'

const CMD = '"/u/agent-office-observe-cursor.sh"'

function setup(cursorRaw?: string, copilotRaw?: string) {
  const cursor = { store: new FakeJsonConfigStore(cursorRaw), runner: new FakeHookRunner(CMD) }
  const copilot = {
    store: new FakeJsonConfigStore(copilotRaw),
    runner: new FakeHookRunner('"/u/agent-office-observe-copilot.sh"'),
  }
  const log = new MemoryLogger()
  const svc = new ProviderHookService({
    targets: {
      cursor: { format: 'cursor-json', ...cursor },
      copilot: { format: 'copilot-file', ...copilot },
    },
    log,
  })
  return { svc, cursor, copilot, log }
}

const foreign = JSON.stringify({ version: 1, hooks: { stop: [{ command: './mine.sh' }] } })

describe('ProviderHookService', () => {
  it('installs into a file with foreign hooks, keeping them; status follows', async () => {
    const t = setup(foreign)
    expect(await t.svc.status('cursor')).toBe('not-installed')
    expect(await t.svc.install('cursor')).toBe('installed')
    expect(t.cursor.runner.installed).toBe(true)
    expect(t.cursor.store.lastBackup).toBe(foreign)
    const hooks = t.cursor.store.json!.hooks as Record<string, unknown[]>
    expect(hooks.stop).toContainEqual({ command: './mine.sh' })
    expect(await t.svc.install('cursor')).toBe('installed') // idempotent
  })

  it('uninstall removes only ours; a Copilot file of our own is deleted', async () => {
    const t = setup(foreign)
    await t.svc.install('cursor')
    await t.svc.install('copilot')
    expect(await t.svc.uninstall('cursor')).toBe('not-installed')
    expect(t.cursor.store.json).toEqual(JSON.parse(foreign))
    expect(t.cursor.runner.installed).toBe(false)
    expect(await t.svc.uninstall('copilot')).toBe('not-installed')
    expect(t.copilot.store.removed).toBe(true)
    expect(t.copilot.store.raw).toBeUndefined()
    // nothing of ours: no write
    const writes = t.cursor.store.writes
    await t.svc.uninstall('cursor')
    expect(t.cursor.store.writes).toBe(writes)
  })

  it('refuses invalid JSON and providers without hooks', async () => {
    const t = setup('{oops')
    await expect(t.svc.install('cursor')).rejects.toBeInstanceOf(ValidationError)
    await expect(t.svc.status('cursor')).rejects.toBeInstanceOf(ValidationError)
    expect(t.cursor.store.raw).toBe('{oops')
    await expect(t.svc.status('codex')).rejects.toBeInstanceOf(ValidationError)
    expect(t.svc.supports('cursor')).toBe(true)
    expect(t.svc.supports('codex')).toBe(false)
  })

  it('heal refreshes installed hooks, rewrites outdated ones and never installs new ones', async () => {
    const t = setup(foreign)
    await t.svc.install('cursor')
    t.cursor.runner.installed = false
    const cmd2 = '"/moved/agent-office-observe-cursor.sh"'
    ;(t.cursor.runner as unknown as { cmd: string }).cmd = cmd2
    expect(await t.svc.status('cursor')).toBe('outdated')
    await t.svc.heal()
    expect(t.cursor.runner.installed).toBe(true)
    expect(await t.svc.status('cursor')).toBe('installed')
    expect(t.copilot.store.raw).toBeUndefined() // not installed → untouched
    expect(t.copilot.runner.installed).toBe(false)
  })

  it('heal isolates a broken config and logs without paths', async () => {
    const t = setup('{oops')
    await t.svc.install('copilot')
    await expect(t.svc.heal()).resolves.toBeUndefined()
    expect(t.log.lines).toEqual(['warn provider hooks heal failed: cursor'])
  })
})
