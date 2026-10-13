import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { probeCli } from './probe.ts'

const dir = mkdtempSync(join(tmpdir(), 'probe-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function fake(name: string, body: string): string {
  const p = join(dir, name)
  writeFileSync(p, `#!${process.execPath}\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}

describe('probeCli', () => {
  it('returns stdout and exit code', async () => {
    const bin = fake('ok', 'console.log("hello", process.argv[2])')
    expect(await probeCli(bin, ['x'], 3000)).toEqual({
      stdout: 'hello x\n',
      stderr: '',
      code: 0,
      timedOut: false,
    })
  })

  it('caps stdout at 4 KB', async () => {
    const bin = fake('big', 'process.stdout.write("a".repeat(10000))')
    const r = await probeCli(bin, [], 3000)
    expect(r.stdout.length).toBeLessThanOrEqual(4096)
    expect(r.stdout.length).toBeGreaterThan(0)
  })

  it('reports a non-zero exit code', async () => {
    const bin = fake('fail', 'process.exit(3)')
    expect((await probeCli(bin, [], 3000)).code).toBe(3)
  })

  it('times out and kills a hanging process', async () => {
    const bin = fake('hang', 'setInterval(() => {}, 1000)')
    const r = await probeCli(bin, [], 150)
    expect(r.timedOut).toBe(true)
  })

  it('rejects with a spawn error for a missing binary', async () => {
    await expect(probeCli(join(dir, 'missing'), [], 1000)).rejects.toThrow()
  })
})
