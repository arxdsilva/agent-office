import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { providerProbeContract } from '@agent-office/core/testing'
import { afterAll, describe, expect, it } from 'vitest'
import { CodexProbe } from './codex-probe.ts'

const FAKE = fileURLToPath(
  new URL('../../../test/fakes/fake-codex-app-server.mjs', import.meta.url),
)
const dir = mkdtempSync(join(tmpdir(), 'codex-probe-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const fake = (env: Record<string, string> = {}, timeoutMs?: number) =>
  new CodexProbe({
    bin: process.execPath,
    argsPrefix: [FAKE],
    env,
    ...(timeoutMs ? { timeoutMs } : {}),
  })

describe('CodexProbe', () => {
  it('detects version, the app-server surface and a logged-in account', async () => {
    const p = fake()
    expect(p.provider).toBe('codex')
    expect(await p.detect()).toEqual({
      installed: true,
      version: '0.162.1',
      flagsOk: true,
      auth: 'ok',
    })
  })

  it('reports a needed login', async () => {
    expect(await fake({ FAKE_CODEX_AUTH: 'none' }).detect()).toMatchObject({
      installed: true,
      flagsOk: true,
      auth: 'needed',
    })
  })

  it('reports a missing CLI as not installed', async () => {
    expect(await new CodexProbe({ bin: join(dir, 'no-codex') }).detect()).toEqual({
      installed: false,
      flagsOk: false,
      auth: 'unknown',
    })
  })

  it('times out a hanging app-server and leaves auth unknown', async () => {
    const t0 = Date.now()
    const r = await fake({ FAKE_CODEX_HANG: '1' }, 600).detect()
    expect(r).toMatchObject({ installed: true, flagsOk: true, auth: 'unknown', error: 'timeout' })
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('flags an old CLI without app-server and skips the auth check', async () => {
    const old = join(dir, 'old.js')
    writeFileSync(
      old,
      `console.log(process.argv.includes('--version') ? 'codex-cli 0.1.0' : 'usage: codex')`,
    )
    expect(await new CodexProbe({ bin: process.execPath, argsPrefix: [old] }).detect()).toEqual({
      installed: true,
      version: '0.1.0',
      flagsOk: false,
      auth: 'unknown',
    })
  })

  it('reports a protocol error when the app-server dies', async () => {
    const dead = join(dir, 'dead.js')
    writeFileSync(
      dead,
      `const a = process.argv
       if (a.includes('--version')) console.log('nonsense')
       else if (a.includes('--help')) console.log('generate-json-schema')
       else process.exit(3)`,
    )
    expect(await new CodexProbe({ bin: process.execPath, argsPrefix: [dead] }).detect()).toEqual({
      installed: true,
      flagsOk: true,
      auth: 'unknown',
      error: 'protocol',
    })
  })
})

providerProbeContract('CodexProbe (fake app-server)', () => fake())
providerProbeContract('CodexProbe (missing CLI)', () => new CodexProbe({ bin: join(dir, 'none') }))
