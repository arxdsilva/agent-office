import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { providerProbeContract } from '@agent-office/core/testing'
import { describe, expect, it } from 'vitest'
import { GeminiProbe } from './probe.ts'

const FAKE = fileURLToPath(new URL('../../../test/fakes/fake-acp-agent.mjs', import.meta.url))
const fake = () =>
  new GeminiProbe({ bin: process.execPath, argsPrefix: [FAKE, '--profile', 'gemini'] })

describe('GeminiProbe', () => {
  it('detects the fake gemini CLI and its ACP surface', async () => {
    const p = fake()
    expect(p.provider).toBe('gemini')
    expect(await p.detect()).toMatchObject({ installed: true, flagsOk: true, auth: 'unknown' })
  })
})

providerProbeContract('GeminiProbe (fake)', fake)
providerProbeContract(
  'GeminiProbe (missing CLI)',
  () => new GeminiProbe({ bin: join(tmpdir(), 'no-such-gemini') }),
)
