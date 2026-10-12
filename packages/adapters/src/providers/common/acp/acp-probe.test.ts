import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { providerProbeContract } from '@agent-office/core/testing'
import { afterAll, describe, expect, it } from 'vitest'
import { AcpProbe } from './acp-probe.ts'
import type { AcpProfile } from './acp-profile.ts'

const FAKE = fileURLToPath(new URL('../../../../test/fakes/fake-acp-agent.mjs', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'acp-probe-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const base: AcpProfile = {
  provider: 'cursor',
  prefix: 'cu:',
  label: 'Cursor',
  bin: 'agent',
  args: ['acp'],
  helpArgs: ['acp', '--help'],
  acpFlag: /Agent Client Protocol/,
  caps: ['launch'],
  authMethodPrefer: [],
  loginHint: 'agent login',
}
const copilot: AcpProfile = {
  ...base,
  provider: 'copilot',
  helpArgs: undefined,
  acpFlag: /--acp\b/,
}

const fake = (
  p: AcpProfile,
  fakeProfile: string,
  env: Record<string, string> = {},
  timeoutMs?: number,
) =>
  new AcpProbe(p, {
    bin: process.execPath,
    argsPrefix: [FAKE, '--profile', fakeProfile],
    env,
    ...(timeoutMs ? { timeoutMs } : {}),
  })

describe('AcpProbe', () => {
  it('detects the version and the ACP surface (helpArgs); auth stays unknown', async () => {
    const p = fake(base, 'cursor')
    expect(p.provider).toBe('cursor')
    expect(await p.detect()).toEqual({
      installed: true,
      version: '2026.10.01-e373342',
      flagsOk: true,
      auth: 'unknown',
    })
  })

  it('finds the flag past the first 4 KB of help (Copilot)', async () => {
    expect(await fake(copilot, 'copilot').detect()).toEqual({
      installed: true,
      version: '1.0.96',
      flagsOk: true,
      auth: 'unknown',
    })
  })

  it('reports an old CLI without the ACP flag', async () => {
    const r = await fake(copilot, 'copilot', { FAKE_ACP_NOFLAG: '1' }).detect()
    expect(r).toMatchObject({ installed: true, flagsOk: false, auth: 'unknown' })
    expect(r.error).toBeUndefined()
  })

  it('times out without throwing', async () => {
    const r = await fake(base, 'cursor', { FAKE_ACP_HANG: '1' }, 400).detect()
    expect(r).toEqual({ installed: true, flagsOk: false, auth: 'unknown', error: 'timeout' })
  })

  it('a missing CLI is not installed; an unspawnable one is a spawn error', async () => {
    expect(await new AcpProbe(base, { bin: join(dir, 'none') }).detect()).toEqual({
      installed: false,
      flagsOk: false,
      auth: 'unknown',
    })
    const notExec = join(dir, 'plain.txt')
    writeFileSync(notExec, 'x')
    const r = await new AcpProbe(base, { bin: notExec }).detect()
    expect(r.installed).toBe(false)
  })

  it('never starts a session', async () => {
    const log = join(dir, 'probe.log')
    await fake(base, 'cursor', { FAKE_LOG: log }).detect()
    // --version/--help exit before the fake logs anything.
    expect(() => rmSync(log)).toThrow()
  })
})

providerProbeContract('AcpProbe (fake cursor)', () => fake(base, 'cursor'))
providerProbeContract(
  'AcpProbe (missing CLI)',
  () => new AcpProbe(base, { bin: join(dir, 'none') }),
)
