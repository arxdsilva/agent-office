import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { classifyExit, runtimeEnv, spawnRuntime, which } from './process.ts'

const dir = mkdtempSync(join(tmpdir(), 'runtime-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A tiny node script used as a fake runtime binary. */
function script(name: string, body: string): string {
  const p = join(dir, name)
  writeFileSync(p, body)
  return p
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readLine(p: { stdout: NodeJS.ReadableStream }): Promise<string> {
  return new Promise((resolve) => {
    let buf = ''
    p.stdout.on('data', (c: Buffer) => {
      buf += c.toString()
      const i = buf.indexOf('\n')
      if (i >= 0) resolve(buf.slice(0, i))
    })
  })
}

async function waitUntil(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
}

describe('spawnRuntime', () => {
  // PR-1: closing a session must not leave grandchildren (shells, MCP servers) behind.
  it('kills the whole process tree', async () => {
    const bin = script(
      'tree.js',
      `const { spawn } = require('node:child_process')
       const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
       console.log(c.pid)
       setInterval(() => {}, 1000)`,
    )
    const p = spawnRuntime(process.execPath, [bin], { cwd: dir })
    const grandchild = Number(await readLine(p))
    expect(isRunning(grandchild)).toBe(true)
    expect(p.alive()).toBe(true)
    await p.kill()
    await waitUntil(() => !isRunning(grandchild))
    expect(isRunning(grandchild)).toBe(false)
    expect(p.alive()).toBe(false)
    expect((await p.exited).signal).toBe('SIGTERM')
  })

  // PR-1: a runtime that ignores SIGTERM is SIGKILLed after the grace period.
  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const bin = script(
      'stubborn.js',
      `process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1000)`,
    )
    const p = spawnRuntime(process.execPath, [bin], { cwd: dir, killGraceMs: 200 })
    await readLine(p)
    await p.kill()
    expect((await p.exited).signal).toBe('SIGKILL')
    await p.kill() // idempotent once exited
  })

  // PR-4: stderr is kept (bounded) for classification, never printed.
  it('keeps only the last 64 KB of stderr and reports the exit code', async () => {
    const bin = script(
      'noisy.js',
      `process.stderr.write('x'.repeat(70000) + 'Please log in', () => process.exit(2))`,
    )
    const p = spawnRuntime(process.execPath, [bin], { cwd: dir })
    const e = await p.exited
    expect(e.code).toBe(2)
    expect(p.stderrTail().length).toBe(64 * 1024)
    expect(p.stderrTail().endsWith('Please log in')).toBe(true)
  })

  // PR-4: a missing working folder is reported as such (Node says ENOENT for both cases).
  it('reports a missing cwd as a folder error and a missing binary as ENOENT', async () => {
    const a = spawnRuntime(process.execPath, ['-e', '1'], { cwd: join(dir, 'nope') })
    expect(await a.exited).toMatchObject({ code: null, spawnError: 'cwd' })
    expect(a.alive()).toBe(false)
    const b = spawnRuntime(join(dir, 'no-such-binary'), [], { cwd: dir })
    expect(await b.exited).toMatchObject({ code: null, spawnError: 'ENOENT' })
    await b.kill()
  })

  // PR-5: the runtime never sees our API token; it is marked as managed.
  it('passes the environment without our token and marks the session managed', async () => {
    process.env.AGENT_OFFICE_TOKEN_FILE = '/secret/token'
    const bin = script('env.js', `console.log(JSON.stringify(process.env))`)
    const p = spawnRuntime(process.execPath, [bin], {
      cwd: dir,
      env: { FOO: 'bar', AGENT_OFFICE_TOKEN: 'sentinel-token' },
    })
    const env = JSON.parse(await readLine(p)) as Record<string, string>
    delete process.env.AGENT_OFFICE_TOKEN_FILE
    expect(env.FOO).toBe('bar')
    expect(env.AGENT_OFFICE_MANAGED).toBe('1')
    expect(JSON.stringify(env)).not.toContain('sentinel-token')
    expect(env.AGENT_OFFICE_TOKEN_FILE).toBeUndefined()
    await p.exited
  })
})

describe('runtimeEnv', () => {
  it('drops every AGENT_OFFICE_TOKEN* variable, whatever the case', () => {
    const env = runtimeEnv({ agent_office_token_x: 'a', AGENT_OFFICE_TOKEN: 'b', PATH: '/bin' }, {})
    expect(env).toEqual({ PATH: '/bin', AGENT_OFFICE_MANAGED: '1' })
  })
})

describe('classifyExit (PR-2)', () => {
  it.each([
    [1, 'Error: Not logged in. Run codex login', undefined, 'auth'],
    [1, '401 Unauthorized', undefined, 'auth'],
    [1, 'authentication required', undefined, 'auth'],
    [null, '', 'cwd', 'folder'],
    [1, "ENOENT: no such file or directory, chdir '/x' -> cwd", undefined, 'folder'],
    [null, '', 'ENOENT', 'runtime'],
    [null, '', 'EACCES', 'runtime'],
    [1, 'thread panicked', undefined, 'crash'],
    [null, '', undefined, 'crash'],
  ] as const)('(%s, %j, %s) → %s', (code, tail, spawnError, want) => {
    expect(classifyExit(code, tail, spawnError)).toBe(want)
  })
})

describe('which (PR-3)', () => {
  it('finds a binary on PATH and resolves Windows PATHEXT (.cmd)', () => {
    const bin = join(dir, 'bin')
    rmSync(bin, { recursive: true, force: true })
    mkdirSync(bin)
    writeFileSync(join(bin, 'tool'), '')
    chmodSync(join(bin, 'tool'), 0o755)
    writeFileSync(join(bin, 'agent.cmd'), '')
    expect(which('tool', { env: { PATH: `/nowhere:${bin}` }, platform: 'darwin' })).toBe(
      join(bin, 'tool'),
    )
    expect(which('agent', { env: { Path: bin, PATHEXT: '.EXE;.CMD' }, platform: 'win32' })).toBe(
      join(bin, 'agent.cmd'),
    )
    expect(which('agent', { env: { PATH: bin }, platform: 'darwin' })).toBeUndefined()
    expect(which('missing', { env: { PATH: bin }, platform: 'darwin' })).toBeUndefined()
    expect(which(join(bin, 'tool'), { env: {}, platform: 'darwin' })).toBe(join(bin, 'tool'))
    expect(which(join(bin, 'nope'), { env: {}, platform: 'darwin' })).toBeUndefined()
  })
})
