// Contract for the trusted validation runner (`GateRunner`, docs/harness.md §4). Uses only the
// running Node binary (`process.execPath`), so it runs on every platform CI uses.
import { describe, expect, it } from 'vitest'
import type { GateSpec } from '../../src/domain/harness-types.ts'
import type { GateRunner } from '../../src/ports/driven.ts'
import type { CancelSignal } from '../../src/ports/driving.ts'

// core is compiled without Node or DOM types: the host globals this contract needs, typed here.
interface Host {
  process: {
    execPath: string
    cwd(): string
    env: Record<string, string | undefined>
    kill(pid: number, signal: number): void
  }
  setTimeout(fn: () => void, ms: number): unknown
  AbortController: new () => { signal: CancelSignal; abort(): void }
}
const host = globalThis as unknown as Host
const { process } = host
const setTimeout = host.setTimeout.bind(globalThis)
const AbortController = host.AbortController

export interface GateRunnerContractOptions {
  /** An existing directory to run in. Default `process.cwd()`. */
  cwd?: string
  /** Skip the process-tree check (runtimes that cannot observe other pids). */
  skipTreeKill?: boolean
}

const NODE = process.execPath

const spec = (id: string, script: string, more: Partial<GateSpec> = {}, args: string[] = []) => ({
  id,
  argv: [NODE, '-e', script, ...args],
  timeoutMs: 20_000,
  ...more,
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM'
  }
}

async function until(fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await new Promise<void>((r) => setTimeout(r, 50))
  }
  return fn()
}

export function gateRunnerContract(
  name: string,
  make: () => GateRunner,
  opts: GateRunnerContractOptions = {},
): void {
  const cwd = opts.cwd ?? process.cwd()

  describe(`GateRunner contract: ${name}`, () => {
    it('exit 0 is a pass, with the output tail and a duration', async () => {
      const r = await make().run(spec('g1', 'console.log("all good")'), { cwd })
      expect(r.status).toBe('pass')
      expect(r.exitCode).toBe(0)
      expect(r.outputTail).toContain('all good')
      expect(r.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('a non-zero exit is a fail with its exit code', async () => {
      const r = await make().run(spec('g2', 'console.error("broken"); process.exit(3)'), { cwd })
      expect(r.status).toBe('fail')
      expect(r.exitCode).toBe(3)
      expect(r.outputTail).toContain('broken')
    })

    it.skipIf(!!opts.skipTreeKill)(
      'a timeout kills the whole process tree',
      async () => {
        const script = [
          "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
          "console.log('GRANDCHILD=' + c.pid)",
          'setInterval(() => {}, 1000)',
        ].join(';')
        const r = await make().run(spec('g3', script, { timeoutMs: 1000 }), { cwd })
        expect(r.status).toBe('timeout')
        const pid = Number(/GRANDCHILD=(\d+)/.exec(r.outputTail)?.[1])
        expect(pid).toBeGreaterThan(0)
        expect(await until(() => !alive(pid), 8000)).toBe(true)
      },
      20_000,
    )

    it('an abort cancels the run', async () => {
      const ac = new AbortController()
      const p = make().run(spec('g4', 'setInterval(() => {}, 1000)'), { cwd, signal: ac.signal })
      setTimeout(() => ac.abort(), 300)
      const r = await p
      expect(r.status).toBe('cancelled')
    }, 15_000)

    it('an already aborted signal never starts the gate', async () => {
      const ac = new AbortController()
      ac.abort()
      const r = await make().run(spec('g4b', 'console.log("ran")'), { cwd, signal: ac.signal })
      expect(r.status).toBe('cancelled')
      expect(r.outputTail).not.toContain('ran')
    })

    it('a missing binary is an error with a spawn error', async () => {
      const r = await make().run(
        { id: 'g5', argv: [`${cwd}/definitely-not-a-binary-${Date.now()}`], timeoutMs: 5000 },
        { cwd },
      )
      expect(r.status).toBe('error')
      expect(r.spawnError).toBeTruthy()
      expect(r.exitCode).toBeNull()
    })

    it('a missing cwd is an error', async () => {
      const r = await make().run(spec('g6', 'console.log(1)'), {
        cwd: `${cwd}/no-such-dir-${Date.now()}`,
      })
      expect(r.status).toBe('error')
      expect(r.spawnError).toBeTruthy()
    })

    it('passes argv literally (no shell)', async () => {
      const r = await make().run(
        spec('g7', 'console.log("ARG=" + process.argv[1])', {}, ['$(whoami); echo `id` | cat']),
        { cwd },
      )
      expect(r.status).toBe('pass')
      expect(r.outputTail).toContain('ARG=$(whoami); echo `id` | cat')
    })

    it('scrubs credentials and our own variables from the environment', async () => {
      const keys = ['AGENT_OFFICE_TOKEN', 'FOO_SECRET', 'X_API_KEY']
      const saved = keys.map((k) => process.env[k])
      for (const k of keys) process.env[k] = 'zz-env-sentinel-zz'
      try {
        const r = await make().run(
          spec(
            'g8',
            `const ks = ${JSON.stringify(keys)}.filter((k) => k in process.env);` +
              'console.log("LEAKED=" + (ks.join(",") || "none"));' +
              'console.log("VALUES=" + Object.values(process.env).filter((v) => v.includes("sentinel")).length);' +
              'console.log("GATE=" + process.env.AGENT_OFFICE_GATE + " CI=" + process.env.CI)',
          ),
          { cwd },
        )
        expect(r.outputTail).toContain('LEAKED=none')
        expect(r.outputTail).toContain('VALUES=0')
        expect(r.outputTail).toContain('GATE=1 CI=1')
      } finally {
        keys.forEach((k, i) => {
          if (saved[i] === undefined) delete process.env[k]
          else process.env[k] = saved[i]
        })
      }
    })

    it('keeps at most 8 KB of output and masks secrets in it', async () => {
      const r = await make().run(
        spec('g9', 'console.log("x".repeat(20000)); console.log("token=ABCDEF")'),
        { cwd },
      )
      expect(r.outputTail.length).toBeLessThanOrEqual(8192)
      expect(r.outputTail).not.toContain('ABCDEF')
      expect(r.outputTail).toContain('token=')
    })
  })
}
