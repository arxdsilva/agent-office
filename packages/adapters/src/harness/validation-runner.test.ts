import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProcessGateRunner } from './validation-runner.ts'

const NODE = process.execPath
const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ao-gate-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('ProcessGateRunner', () => {
  it('reports pinChanged when the gate rewrites a pinned file', async () => {
    const cwd = tmp()
    writeFileSync(join(cwd, 'Makefile'), 'test:\n\ttrue\n')
    const r = await new ProcessGateRunner().run(
      {
        id: 'g',
        argv: [NODE, '-e', "require('fs').writeFileSync('Makefile', 'test:\\n\\tfalse\\n')"],
        timeoutMs: 10_000,
        pinFiles: ['Makefile'],
      },
      { cwd },
    )
    expect(r.status).toBe('pass')
    expect(r.pinChanged).toBe(true)
  })

  it('pinChanged is false when pinned files are untouched (missing ones included)', async () => {
    const cwd = tmp()
    writeFileSync(join(cwd, 'package.json'), '{}')
    const r = await new ProcessGateRunner().run(
      {
        id: 'g',
        argv: [NODE, '-e', 'console.log(1)'],
        timeoutMs: 10_000,
        pinFiles: ['package.json', 'missing.json'],
      },
      { cwd },
    )
    expect(r.pinChanged).toBe(false)
  })

  it('does not read pinned files outside cwd', async () => {
    const cwd = tmp()
    const r = await new ProcessGateRunner().run(
      { id: 'g', argv: [NODE, '-e', '1'], timeoutMs: 10_000, pinFiles: ['../../etc/passwd'] },
      { cwd },
    )
    expect(r.status).toBe('pass')
    expect(r.pinChanged).toBe(false)
  })

  it('omits pinChanged without pinFiles', async () => {
    const r = await new ProcessGateRunner().run(
      { id: 'g', argv: [NODE, '-e', '1'], timeoutMs: 10_000 },
      { cwd: tmp() },
    )
    expect(r).not.toHaveProperty('pinChanged')
  })

  it('rejects an empty argv as an error without spawning', async () => {
    const r = await new ProcessGateRunner().run(
      { id: 'g', argv: [], timeoutMs: 10_000 },
      { cwd: tmp() },
    )
    expect(r.status).toBe('error')
    expect(r.spawnError).toBe('argv')
  })

  it('abbreviates the home directory in the output', async () => {
    const r = await new ProcessGateRunner({ home: '/Users/zed' }).run(
      { id: 'g', argv: [NODE, '-e', 'console.log("/Users/zed/repo")'], timeoutMs: 10_000 },
      { cwd: tmp() },
    )
    expect(r.outputTail).toContain('~/repo')
  })

  it('kills with SIGKILL when SIGTERM is ignored', async () => {
    const r = await new ProcessGateRunner({ killGraceMs: 300 }).run(
      {
        id: 'g',
        argv: [NODE, '-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        timeoutMs: 500,
      },
      { cwd: tmp() },
    )
    expect(r.status).toBe('timeout')
    expect(r.durationMs).toBeLessThan(5000)
  }, 10_000)
})
