import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { providerProbeContract } from '@agent-office/core/testing'
import { describe, expect, it } from 'vitest'
import { CopilotProbe } from './probe.ts'

const FAKE = fileURLToPath(new URL('../../../test/fakes/fake-acp-agent.mjs', import.meta.url))
const fake = () => new CopilotProbe({ bin: process.execPath, argsPrefix: [FAKE, '--profile', 'copilot'] })

describe('CopilotProbe', () => {
  it('detects the fake copilot CLI and its ACP surface', async () => {
    const p = fake()
    expect(p.provider).toBe('copilot')
    expect(await p.detect()).toMatchObject({ installed: true, flagsOk: true, auth: 'unknown' })
  })
})

providerProbeContract('CopilotProbe (fake)', fake)
providerProbeContract('CopilotProbe (missing CLI)', () => new CopilotProbe({ bin: join(tmpdir(), 'no-such-copilot') }))
