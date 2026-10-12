import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVIDER_DECLS } from '@agent-office/core'
import { managedRuntimeContract } from '@agent-office/core/testing'
import { afterAll, describe, expect, it } from 'vitest'
import { acpHarness } from '../../../test/fakes/acp-harness.ts'
import { GeminiAcpRunner, GEMINI_PROFILE } from './profile.ts'

const FAKE = fileURLToPath(new URL('../../../test/fakes/fake-acp-agent.mjs', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'gemini-acp-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('GEMINI_PROFILE', () => {
  it('runs the gemini ACP server with its prefix and declared caps', () => {
    const p = GEMINI_PROFILE
    expect(p.provider).toBe('gemini')
    expect(p.bin).toBe('gemini')
    expect(p.args).toEqual(['--acp'])
    expect(p.prefix).toBe('gm:')
    expect(p.prefix).toBe(PROVIDER_DECLS.gemini.prefix)
    expect(p.caps).toEqual(PROVIDER_DECLS.gemini.managedCaps)
    expect(p.authMethodPrefer).toEqual([])
    expect(p.loginHint).toBe('gemini')
    expect(p.acpFlag.test('      --acp     Starts the agent in ACP mode')).toBe(true)
  })

  it('offers the agent modes, the default first, dangerous ones flagged', () => {
    const r = new GeminiAcpRunner()
    expect(r.decl.modes?.map((m) => m.id)).toEqual(['default', 'autoEdit', 'yolo', 'plan'])
    expect(r.decl.defaultModeId).toBe('default')
    for (const m of r.decl.modes ?? []) expect(m.id.length).toBeLessThanOrEqual(60)
  })

  it('never prefers an API-key or browser login method', () => {
    for (const id of GEMINI_PROFILE.authMethodPrefer)
      expect(id).not.toMatch(/api|key|oauth|vertex|gateway/i)
  })

  it('starts a session against the fake gemini agent and stops cleanly', async () => {
    const runner = new GeminiAcpRunner({
      bin: process.execPath,
      args: [FAKE, '--profile', 'gemini'],
    })
    const s = runner.start({
      cwd: dir,
      mode: 'default',
      extraDirs: [],
      chrome: false,
      allowBypass: false,
      modeId: 'default',
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

managedRuntimeContract('GeminiAcpRunner', () => acpHarness(GEMINI_PROFILE))
