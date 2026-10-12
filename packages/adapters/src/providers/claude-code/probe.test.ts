import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeProbe, parseClaudeVersion } from './probe.ts'

const dir = mkdtempSync(join(tmpdir(), 'cprobe-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function fake(name: string, body: string): string {
  const p = join(dir, name)
  writeFileSync(p, `#!${process.execPath}\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}

describe('parseClaudeVersion', () => {
  it('extracts the semver', () => {
    expect(parseClaudeVersion('2.1.270 (Claude Code)\n')).toBe('2.1.270')
    expect(parseClaudeVersion('nonsense')).toBeUndefined()
  })
})

describe('ClaudeProbe', () => {
  it('detects version, flags ok, auth unknown', async () => {
    const bin = fake('claude', 'console.log("2.1.270 (Claude Code)")')
    const probe = new ClaudeProbe({ resolve: () => bin })
    expect(probe.provider).toBe('claude-code')
    expect(await probe.detect()).toEqual({
      installed: true,
      version: '2.1.270',
      flagsOk: true,
      auth: 'unknown',
    })
  })

  it('reports not installed when the CLI cannot be found', async () => {
    const probe = new ClaudeProbe({ resolve: () => undefined })
    expect(await probe.detect()).toEqual({ installed: false, flagsOk: false, auth: 'unknown' })
  })

  it('reports spawn when the binary cannot run', async () => {
    const probe = new ClaudeProbe({ resolve: () => join(dir, 'nope') })
    expect(await probe.detect()).toMatchObject({ installed: false, error: 'spawn' })
  })

  it('reports timeout', async () => {
    const bin = fake('slow', 'setInterval(() => {}, 1000)')
    const probe = new ClaudeProbe({ resolve: () => bin, timeoutMs: 150 })
    expect(await probe.detect()).toMatchObject({ installed: true, error: 'timeout' })
  })

  it('reports a protocol error on unparsable output or non-zero exit', async () => {
    const odd = new ClaudeProbe({ resolve: () => fake('odd', 'console.log("hi")') })
    expect(await odd.detect()).toMatchObject({ installed: true, error: 'protocol' })
    const bad = new ClaudeProbe({ resolve: () => fake('bad', 'process.exit(2)') })
    expect(await bad.detect()).toMatchObject({ installed: true, error: 'protocol' })
  })

  it('never throws when resolve throws', async () => {
    const probe = new ClaudeProbe({
      resolve: () => {
        throw new Error('boom')
      },
    })
    expect(await probe.detect()).toMatchObject({ installed: false })
  })
})
