import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVIDER_DECLS } from '@agent-office/core'
import { managedRuntimeContract } from '@agent-office/core/testing'
import { afterAll, describe, expect, it } from 'vitest'
import { acpHarness } from '../../../test/fakes/acp-harness.ts'
import { CopilotAcpRunner, COPILOT_PROFILE } from './profile.ts'

const FAKE = fileURLToPath(new URL('../../../test/fakes/fake-acp-agent.mjs', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'copilot-acp-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('COPILOT_PROFILE', () => {
  it('runs the copilot ACP server with its prefix and declared caps', () => {
    const p = COPILOT_PROFILE
    expect(p.provider).toBe('copilot')
    expect(p.bin).toBe('copilot')
    expect(p.args).toEqual(['--acp'])
    expect(p.prefix).toBe('gh:')
    expect(p.prefix).toBe(PROVIDER_DECLS.copilot.prefix)
    expect(p.caps).toEqual(PROVIDER_DECLS.copilot.managedCaps)
    expect(p.authMethodPrefer).toEqual([])
    expect(p.loginHint).toBe('copilot login')
    expect(p.acpFlag.test('      --acp\n          Start as Agent Client Protocol server')).toBe(
      true,
    )
  })

  it('offers the agent modes, the default first, dangerous ones flagged', () => {
    const r = new CopilotAcpRunner()
    expect(r.decl.modes?.map((m) => m.id)).toEqual(['agent', 'plan', 'autopilot'])
    expect(r.decl.defaultModeId).toBe('agent')
    for (const m of r.decl.modes ?? []) expect(m.id.length).toBeLessThanOrEqual(60)
  })

  it('never prefers an API-key or browser login method', () => {
    for (const id of COPILOT_PROFILE.authMethodPrefer)
      expect(id).not.toMatch(/api|key|oauth|vertex|gateway/i)
  })

  it('starts a session against the fake copilot agent and stops cleanly', async () => {
    const runner = new CopilotAcpRunner({
      bin: process.execPath,
      args: [FAKE, '--profile', 'copilot'],
    })
    const s = runner.start({
      cwd: dir,
      mode: 'default',
      extraDirs: [],
      chrome: false,
      allowBypass: false,
      modeId: 'agent',
    })
    const results: string[] = []
    s.onResult((r) => results.push(r.text))
    await expect(s.sessionId).resolves.toBe('sess_fake1')
    s.push('/quick hi')
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (results.length) {
          clearInterval(t)
          resolve()
        }
      }, 10)
    })
    expect(results).toEqual(['ok: /quick hi'])
    await s.close()
  })
})

managedRuntimeContract('CopilotAcpRunner', () => acpHarness(COPILOT_PROFILE))
