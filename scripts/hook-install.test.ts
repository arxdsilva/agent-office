import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from './hook-install.ts'

function env(content?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ao-cli-'))
  const settingsFile = join(dir, 'claude', 'settings.json')
  if (content !== undefined) {
    mkdirSync(join(dir, 'claude'))
    writeFileSync(settingsFile, content)
  }
  const lines: string[] = []
  return { dir, settingsFile, lines, io: { settingsFile, home: join(dir, 'home'), hookScript: '/repo/hooks/agent-office-hook.mjs', log: (l: string) => lines.push(l), confirm: async () => true } }
}

describe('hook-install CLI', () => {
  it('installs (with backup and a node wrapper), reports status, then uninstalls', async () => {
    const e = env('{"theme":"dark"}')
    expect(await run(['install', '--yes'], e.io)).toBe(0)
    const installed = JSON.parse(readFileSync(e.settingsFile, 'utf8'))
    expect(installed.theme).toBe('dark')
    const cmd: string = installed.hooks.Stop[0].hooks[0].command
    expect(cmd).toContain('agent-office-hook.sh')
    expect(readFileSync(cmd.replaceAll('"', ''), 'utf8')).toContain('exec "node" "/repo/hooks/agent-office-hook.mjs"')
    expect(existsSync(`${e.settingsFile}.agent-office.bak`)).toBe(true)
    expect(await run(['status'], e.io)).toBe(0)
    expect(e.lines.at(-1)).toBe('installed')
    expect(await run(['uninstall', '--yes'], e.io)).toBe(0)
    expect(JSON.parse(readFileSync(e.settingsFile, 'utf8'))).toEqual({ theme: 'dark' })
  })

  it('asks before changing anything and aborts on "no"', async () => {
    const e = env('{}')
    expect(await run(['install'], { ...e.io, confirm: async () => false })).toBe(1)
    expect(readFileSync(e.settingsFile, 'utf8')).toBe('{}')
  })

  it('refuses invalid JSON and unknown commands', async () => {
    const e = env('{oops')
    expect(await run(['install', '--yes'], e.io)).toBe(2)
    expect(e.lines.join('\n')).toMatch(/not valid JSON/)
    expect(await run(['dance'], e.io)).toBe(2)
  })
})
