import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs script, no types
import { addHooks, removeHooks, run } from './hook-install.mjs'

const CMD = 'node "/repo/hooks/agent-office-hook.mjs"'

describe('addHooks / removeHooks', () => {
  it('adds Stop and UserPromptSubmit entries and keeps existing hooks', () => {
    const existing = {
      model: 'opus',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
    }
    const out = addHooks(existing, CMD)
    expect(out.model).toBe('opus')
    expect(out.hooks.Stop).toHaveLength(2)
    expect(out.hooks.Stop[0].hooks[0].command).toBe('say done')
    expect(out.hooks.Stop[1].hooks[0]).toEqual({ type: 'command', command: CMD, timeout: 5 })
    expect(out.hooks.UserPromptSubmit[0].hooks[0].command).toBe(CMD)
    expect(existing.hooks.Stop).toHaveLength(1) // input not mutated
  })

  it('is idempotent', () => {
    const once = addHooks({}, CMD)
    expect(addHooks(once, CMD)).toEqual(once)
  })

  it('removes only its own entries', () => {
    const settings = addHooks(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } },
      CMD,
    )
    const out = removeHooks(settings)
    expect(out.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'say done' }] }])
    expect(out.hooks.UserPromptSubmit).toBeUndefined()
    expect(removeHooks({})).toEqual({})
  })
})

describe('run', () => {
  const tmpSettings = (content?: string) => {
    const file = join(mkdtempSync(join(tmpdir(), 'ao-inst-')), 'settings.json')
    if (content !== undefined) writeFileSync(file, content)
    return file
  }
  const quiet = { log: () => {}, confirm: async () => true }

  it('installs with a backup, then uninstalls', async () => {
    const file = tmpSettings('{"theme":"dark"}')
    expect(
      await run(['install', '--yes'], {
        settingsFile: file,
        hookPath: '/repo/hooks/agent-office-hook.mjs',
        ...quiet,
      }),
    ).toBe(0)
    const installed = JSON.parse(readFileSync(file, 'utf8'))
    expect(installed.theme).toBe('dark')
    expect(installed.hooks.Stop[0].hooks[0].command).toContain('agent-office-hook.mjs')
    expect(JSON.parse(readFileSync(file + '.agent-office.bak', 'utf8'))).toEqual({ theme: 'dark' })

    expect(
      await run(['uninstall', '--yes'], { settingsFile: file, hookPath: '/x', ...quiet }),
    ).toBe(0)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ theme: 'dark' })
  })

  it('creates the settings file when missing', async () => {
    const file = tmpSettings()
    await run(['install', '--yes'], { settingsFile: file, hookPath: '/h.mjs', ...quiet })
    expect(existsSync(file)).toBe(true)
  })

  it('does nothing when the user declines or nothing changes', async () => {
    const file = tmpSettings('{}')
    const declined = await run(['install'], {
      settingsFile: file,
      hookPath: '/h.mjs',
      log: () => {},
      confirm: async () => false,
    })
    expect(declined).toBe(1)
    expect(readFileSync(file, 'utf8')).toBe('{}')
    expect(
      await run(['uninstall', '--yes'], { settingsFile: file, hookPath: '/h.mjs', ...quiet }),
    ).toBe(0)
    expect(existsSync(file + '.agent-office.bak')).toBe(false)
  })

  it('refuses invalid JSON and unknown commands', async () => {
    const file = tmpSettings('{oops')
    expect(
      await run(['install', '--yes'], { settingsFile: file, hookPath: '/h.mjs', ...quiet }),
    ).toBe(2)
    expect(await run(['dance'], { settingsFile: file, hookPath: '/h.mjs', ...quiet })).toBe(2)
  })
})
