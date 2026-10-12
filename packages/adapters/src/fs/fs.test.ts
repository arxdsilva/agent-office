import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claudeSettingsStoreContract,
  hookRunnerContract,
  settingsRepositoryContract,
} from '@agent-office/core/testing'
import { DEFAULT_SETTINGS } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { ClaudeSettingsFile } from './claude-settings-store.ts'
import { FsHookRunner } from './hook-runner.ts'
import { JsonFileSettingsRepository } from './json-settings-repository.ts'
import { loadOrCreateToken } from './token-file.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'ao-fs-'))

settingsRepositoryContract(
  'JsonFileSettingsRepository',
  async () => new JsonFileSettingsRepository(join(tmp(), 'settings.json')),
)

claudeSettingsStoreContract('ClaudeSettingsFile', async (initial) => {
  const file = join(tmp(), '.claude', 'settings.json')
  if (initial !== undefined) {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, initial)
  }
  const store = new ClaudeSettingsFile(file)
  return {
    store,
    backup: async () =>
      existsSync(store.backupPath) ? readFileSync(store.backupPath, 'utf8') : undefined,
  }
})

hookRunnerContract('FsHookRunner (posix)', async () => {
  const runner = new FsHookRunner({
    dir: join(tmp(), 'hook'),
    execPath: '/usr/bin/node',
    script: '/app/hooks/agent-office-hook.mjs',
    platform: 'darwin',
    runAsNode: true,
  })
  return { runner, exists: async () => existsSync(runner.wrapperPath) }
})

hookRunnerContract('FsHookRunner (windows)', async () => {
  const runner = new FsHookRunner({
    dir: join(tmp(), 'hook'),
    execPath: 'C:\\Apps\\agent-office.exe',
    script: 'C:\\Apps\\resources\\hooks\\agent-office-hook.mjs',
    platform: 'win32',
    runAsNode: true,
  })
  return { runner, exists: async () => existsSync(runner.wrapperPath) }
})

describe('FsHookRunner details', () => {
  it('posix wrapper runs the app binary as node and is executable', async () => {
    const dir = join(tmp(), 'hook')
    const runner = new FsHookRunner({
      dir,
      execPath: '/Applications/agent-office.app/Contents/MacOS/agent-office',
      script: '/r/hooks/agent-office-hook.mjs',
      platform: 'darwin',
      runAsNode: true,
    })
    await runner.ensureInstalled()
    const body = readFileSync(runner.wrapperPath, 'utf8')
    expect(body).toContain(
      'ELECTRON_RUN_AS_NODE=1 exec "/Applications/agent-office.app/Contents/MacOS/agent-office" "/r/hooks/agent-office-hook.mjs"',
    )
    expect(statSync(runner.wrapperPath).mode & 0o111).not.toBe(0)
    expect(runner.command()).toBe(`"${runner.wrapperPath}"`)
  })

  it('dev mode (plain node) omits ELECTRON_RUN_AS_NODE', async () => {
    const runner = new FsHookRunner({
      dir: join(tmp(), 'hook'),
      execPath: 'node',
      script: '/r/agent-office-hook.mjs',
      platform: 'linux',
      runAsNode: false,
    })
    await runner.ensureInstalled()
    expect(readFileSync(runner.wrapperPath, 'utf8')).toContain(
      'exec "node" "/r/agent-office-hook.mjs"',
    )
  })

  it('windows wrapper is a .cmd that sets ELECTRON_RUN_AS_NODE', async () => {
    const runner = new FsHookRunner({
      dir: join(tmp(), 'hook'),
      execPath: 'C:\\A\\agent-office.exe',
      script: 'C:\\A\\hook.mjs',
      platform: 'win32',
      runAsNode: true,
    })
    await runner.ensureInstalled()
    expect(runner.wrapperPath.endsWith('agent-office-hook.cmd')).toBe(true)
    const body = readFileSync(runner.wrapperPath, 'utf8')
    expect(body).toContain('set ELECTRON_RUN_AS_NODE=1')
    expect(body).toContain('"C:\\A\\agent-office.exe" "C:\\A\\hook.mjs"')
  })
})

describe('JsonFileSettingsRepository details', () => {
  it('falls back to defaults on a corrupt file and writes atomically', async () => {
    const file = join(tmp(), 'settings.json')
    writeFileSync(file, '{not json')
    const warnings: string[] = []
    const repo = new JsonFileSettingsRepository(file, {
      warn: (m) => warnings.push(m),
      info: () => {},
    })
    expect(await repo.load()).toEqual(DEFAULT_SETTINGS)
    expect(warnings[0]).toMatch(/corrupt/)
    await repo.save({ ...DEFAULT_SETTINGS, port: 6000 })
    expect(JSON.parse(readFileSync(file, 'utf8')).port).toBe(6000)
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('drops invalid fields instead of failing', async () => {
    const file = join(tmp(), 'settings.json')
    writeFileSync(file, JSON.stringify({ port: 1, notifications: false }))
    expect(await new JsonFileSettingsRepository(file).load()).toEqual({
      ...DEFAULT_SETTINGS,
      notifications: false,
    })
  })
})

describe('loadOrCreateToken', () => {
  it('creates a 64-hex token with mode 0600 and reuses it', () => {
    const dir = join(tmp(), 'home')
    const t1 = loadOrCreateToken(dir)
    expect(t1).toMatch(/^[0-9a-f]{64}$/)
    expect(statSync(join(dir, 'token')).mode & 0o777).toBe(0o600)
    expect(loadOrCreateToken(dir)).toBe(t1)
  })
})
