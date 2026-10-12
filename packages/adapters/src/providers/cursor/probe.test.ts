import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { providerProbeContract } from '@agent-office/core/testing'
import { describe, expect, it } from 'vitest'
import { CursorProbe } from './probe.ts'

const FAKE = fileURLToPath(new URL('../../../test/fakes/fake-acp-agent.mjs', import.meta.url))
const fake = () =>
  new CursorProbe({ bin: process.execPath, argsPrefix: [FAKE, '--profile', 'cursor'] })

describe('CursorProbe', () => {
  it('detects the fake cursor CLI and its ACP surface', async () => {
    const p = fake()
    expect(p.provider).toBe('cursor')
    expect(await p.detect()).toMatchObject({ installed: true, flagsOk: true, auth: 'unknown' })
  })
})

providerProbeContract('CursorProbe (fake)', fake)
providerProbeContract(
  'CursorProbe (missing CLI)',
  () => new CursorProbe({ bin: join(tmpdir(), 'no-such-cursor') }),
)
