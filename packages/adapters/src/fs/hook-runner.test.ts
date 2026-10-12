import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FsHookRunner } from './hook-runner.ts'

const tmp = () => join(mkdtempSync(join(tmpdir(), 'ao-hr-')), 'hook')
const base = {
  execPath: '/usr/bin/node',
  script: '/r/hooks/agent-office-observe.mjs',
  runAsNode: true,
}

describe('FsHookRunner: default output is byte-identical to the Claude wrapper', () => {
  it('posix', async () => {
    const r = new FsHookRunner({
      dir: tmp(),
      ...base,
      script: '/r/h.mjs',
      platform: 'darwin',
      url: () => 'http://127.0.0.1:4317',
    })
    await r.ensureInstalled()
    expect(r.wrapperPath.endsWith('/agent-office-hook.sh')).toBe(true)
    expect(readFileSync(r.wrapperPath, 'utf8')).toBe(
      '#!/bin/sh\n# agent-office hook wrapper (generated)\nAGENT_OFFICE_URL="${AGENT_OFFICE_URL:-http://127.0.0.1:4317}" ELECTRON_RUN_AS_NODE=1 exec "/usr/bin/node" "/r/h.mjs"\n',
    )
  })
  it('windows', async () => {
    const r = new FsHookRunner({ dir: tmp(), ...base, script: 'C:\\h.mjs', platform: 'win32' })
    await r.ensureInstalled()
    expect(r.wrapperPath.endsWith('agent-office-hook.cmd')).toBe(true)
    expect(readFileSync(r.wrapperPath, 'utf8')).toBe(
      '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"/usr/bin/node" "C:\\h.mjs"\r\n',
    )
  })
})

describe('FsHookRunner: observe wrapper (name + provider arg)', () => {
  const make = (platform: string) =>
    new FsHookRunner({
      dir: tmp(),
      ...base,
      platform,
      name: 'agent-office-observe-cursor',
      args: { provider: 'cursor' },
    })

  it('posix wrapper passes --provider and is named after the provider', async () => {
    const r = make('linux')
    await r.ensureInstalled()
    expect(r.wrapperPath.endsWith('agent-office-observe-cursor.sh')).toBe(true)
    expect(readFileSync(r.wrapperPath, 'utf8')).toContain(
      'ELECTRON_RUN_AS_NODE=1 exec "/usr/bin/node" "/r/hooks/agent-office-observe.mjs" --provider cursor\n',
    )
  })
  it('windows wrapper passes --provider', async () => {
    const r = make('win32')
    await r.ensureInstalled()
    expect(r.wrapperPath.endsWith('agent-office-observe-cursor.cmd')).toBe(true)
    expect(readFileSync(r.wrapperPath, 'utf8')).toContain(
      '"/r/hooks/agent-office-observe.mjs" --provider cursor\r\n',
    )
  })
  // The shared hookRunnerContract asserts the Claude marker in command(); same behaviour checked here.
  it('has a command with the observe marker; installs idempotently and removes', async () => {
    const r = make('linux')
    expect(r.command()).toContain('agent-office-observe')
    await r.ensureInstalled()
    await r.ensureInstalled()
    expect(existsSync(r.wrapperPath)).toBe(true)
    await r.remove()
    expect(existsSync(r.wrapperPath)).toBe(false)
    await expect(r.remove()).resolves.toBeUndefined()
  })
  it('rejects unsafe names and provider ids', () => {
    const o = { dir: tmp(), ...base, platform: 'linux' }
    expect(() => new FsHookRunner({ ...o, name: '../x' })).toThrow(/name/)
    expect(() => new FsHookRunner({ ...o, args: { provider: 'cursor; rm -rf /' } })).toThrow(
      /provider/,
    )
    expect(() => new FsHookRunner({ ...o, args: { provider: 'Cursor' } })).toThrow(/provider/)
  })
})
