import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { McpLauncher } from './mcp-launcher.ts'

const TOKEN = `mcp_${'e'.repeat(64)}`
const base = {
  execPath: '/Applications/agent-office.app/Contents/MacOS/agent-office',
  script: '/Applications/agent-office.app/Contents/Resources/hooks/agent-office-mcp.mjs',
  runAsNode: true,
  url: () => 'http://127.0.0.1:4317',
}
const userData = () => mkdtempSync(join(tmpdir(), 'ao-mcp-'))

describe('McpLauncher', () => {
  it('posix: writes <userData>/mcp/agent-office-mcp.sh (0755) running the bridge in Node mode', async () => {
    const dir = userData()
    const l = new McpLauncher({ ...base, userData: dir, platform: 'darwin' })
    expect(l.wrapperPath).toBe(join(dir, 'mcp', 'agent-office-mcp.sh'))
    await l.ensureInstalled()
    expect(readFileSync(l.wrapperPath, 'utf8')).toBe(
      `#!/bin/sh\n# agent-office MCP bridge wrapper (generated)\nELECTRON_RUN_AS_NODE=1 exec "${base.execPath}" "${base.script}"\n`,
    )
    expect(statSync(l.wrapperPath).mode & 0o777).toBe(0o755)
  })

  it('windows: writes agent-office-mcp.cmd', async () => {
    const dir = userData()
    const l = new McpLauncher({
      ...base,
      execPath: 'C:\\Program Files\\agent-office\\agent-office.exe',
      script: 'C:\\Program Files\\agent-office\\hooks\\agent-office-mcp.mjs',
      userData: dir,
      platform: 'win32',
    })
    expect(l.wrapperPath).toBe(join(dir, 'mcp', 'agent-office-mcp.cmd'))
    await l.ensureInstalled()
    expect(readFileSync(l.wrapperPath, 'utf8')).toBe(
      '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:\\Program Files\\agent-office\\agent-office.exe" "C:\\Program Files\\agent-office\\hooks\\agent-office-mcp.mjs"\r\n',
    )
  })

  it('dev (plain node): no ELECTRON_RUN_AS_NODE', async () => {
    const l = new McpLauncher({
      ...base,
      runAsNode: false,
      userData: userData(),
      platform: 'linux',
    })
    await l.ensureInstalled()
    expect(readFileSync(l.wrapperPath, 'utf8')).not.toContain('ELECTRON_RUN_AS_NODE')
  })

  it('launch() returns the RunnerStart.mcp stdio entry with the live url and the token', () => {
    let port = 4317
    const l = new McpLauncher({
      ...base,
      url: () => `http://127.0.0.1:${port}`,
      userData: '/u',
      platform: 'darwin',
    })
    expect(l.launch(TOKEN)).toEqual({
      name: 'agent-office',
      command: '/u/mcp/agent-office-mcp.sh',
      args: [],
      env: { AGENT_OFFICE_MCP_URL: 'http://127.0.0.1:4317/mcp', AGENT_OFFICE_MCP_TOKEN: TOKEN },
    })
    port = 4400
    expect(l.launch(TOKEN).env.AGENT_OFFICE_MCP_URL).toBe('http://127.0.0.1:4400/mcp')
  })

  it('launch() refuses a non-loopback url or a malformed token', () => {
    const mk = (url: string) =>
      new McpLauncher({ ...base, url: () => url, userData: '/u', platform: 'darwin' })
    for (const bad of [
      'http://0.0.0.0:4317',
      'https://127.0.0.1:4317',
      'http://127.0.0.1.evil.example:4317',
      'http://127.0.0.1:4317/x',
    ])
      expect(() => mk(bad).launch(TOKEN)).toThrow(/url/)
    const l = mk('http://[::1]:4317')
    expect(l.launch(TOKEN).env.AGENT_OFFICE_MCP_URL).toBe('http://[::1]:4317/mcp')
    for (const t of ['', 'abc', `api_${'e'.repeat(64)}`, 'mcp_short', `mcp_${'e'.repeat(60)};x`])
      expect(() => l.launch(t)).toThrow(/token/)
  })

  it('refuses paths that would break out of the quoted wrapper line', () => {
    const o = { ...base, userData: '/u' }
    expect(
      () => new McpLauncher({ ...o, platform: 'darwin', execPath: '/a"; rm -rf ~; "' }),
    ).toThrow(/path/)
    expect(() => new McpLauncher({ ...o, platform: 'linux', script: '/a/$(id).mjs' })).toThrow(
      /path/,
    )
    expect(() => new McpLauncher({ ...o, platform: 'win32', script: 'C:\\%PATH%\\x.mjs' })).toThrow(
      /path/,
    )
    expect(() => new McpLauncher({ ...o, platform: 'darwin', script: '/a\nb' })).toThrow(/path/)
  })

  it('ensureInstalled is idempotent; remove() deletes the wrapper', async () => {
    const l = new McpLauncher({ ...base, userData: userData(), platform: 'linux' })
    await l.ensureInstalled()
    await l.ensureInstalled()
    expect(existsSync(l.wrapperPath)).toBe(true)
    await l.remove()
    expect(existsSync(l.wrapperPath)).toBe(false)
    await expect(l.remove()).resolves.toBeUndefined()
  })
})
