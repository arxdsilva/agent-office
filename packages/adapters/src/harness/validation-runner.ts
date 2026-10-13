// The trusted validation runner (docs/harness.md §4): runs a published gate's argv with no shell,
// a scrubbed environment and a timeout that takes the whole process tree down. Output is kept as a
// bounded raw tail, then redacted; nothing of it is logged.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import type { CancelSignal, GateRun, GateRunner, GateSpec } from '@agent-office/core'
import { signalProcessTree } from '../providers/common/process.ts'
import { gateEnv } from './gate-env.ts'
import { redactOutput } from './redact.ts'

const RAW_TAIL = 64 * 1024
const KILL_GRACE_MS = 5000
const PIN_MAX_BYTES = 8 * 1024 * 1024

export interface ProcessGateRunnerOptions {
  /** Environment the scrubbed gate env is built from. Default `process.env` (read per run). */
  env?: () => Record<string, string | undefined>
  /** Home directory abbreviated to `~` in the output. Default `os.homedir()`. */
  home?: string
  /** SIGTERM → SIGKILL grace. Default 5 s. */
  killGraceMs?: number
  now?: () => number
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** sha256 per pinned file, contained in `cwd` (missing, unreadable or outside: a fixed marker). */
function hashPins(cwd: string, pins: string[]): string[] {
  return pins.map((rel) => {
    const abs = resolve(cwd, rel)
    const r = relative(cwd, abs)
    if (!r || r.startsWith('..') || isAbsolute(r)) return 'outside'
    try {
      const st = statSync(abs)
      if (!st.isFile() || st.size > PIN_MAX_BYTES) return `size:${st.size}`
      return createHash('sha256').update(readFileSync(abs)).digest('hex')
    } catch {
      return 'missing'
    }
  })
}

export class ProcessGateRunner implements GateRunner {
  constructor(private o: ProcessGateRunnerOptions = {}) {}

  async run(spec: GateSpec, o: { cwd: string; signal?: CancelSignal }): Promise<GateRun> {
    const now = this.o.now ?? Date.now
    const t0 = now()
    const home = this.o.home ?? homedir()
    const done = (r: Omit<GateRun, 'durationMs'>): GateRun => ({ ...r, durationMs: now() - t0 })
    const empty = { exitCode: null, outputTail: '' }
    if (o.signal?.aborted) return done({ status: 'cancelled', ...empty })
    const [bin, ...args] = spec.argv
    if (!bin) return done({ status: 'error', ...empty, spawnError: 'argv' })
    // Node reports a missing cwd as `spawn ENOENT`, like a missing binary: tell them apart.
    if (!isDir(o.cwd)) return done({ status: 'error', ...empty, spawnError: 'cwd' })
    const pins = spec.pinFiles?.length ? spec.pinFiles : undefined
    const before = pins ? hashPins(o.cwd, pins) : undefined

    const windows = process.platform === 'win32'
    const child = spawn(bin, args, {
      cwd: o.cwd,
      shell: false,
      detached: !windows,
      windowsHide: true,
      env: gateEnv((this.o.env ?? (() => process.env))()),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let raw = ''
    const take = (c: Buffer) => {
      raw = (raw + c.toString('utf8')).slice(-RAW_TAIL)
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.stdout?.on('error', () => {})
    child.stderr?.on('error', () => {})

    let stop: 'timeout' | 'cancelled' | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const kill = (why: 'timeout' | 'cancelled') => {
      if (stop) return
      stop = why
      signalProcessTree(child, 'SIGTERM')
      killTimer = setTimeout(
        () => signalProcessTree(child, 'SIGKILL'),
        this.o.killGraceMs ?? KILL_GRACE_MS,
      )
      killTimer.unref?.()
    }
    const timer = setTimeout(() => kill('timeout'), Math.max(1, spec.timeoutMs))
    const onAbort = () => kill('cancelled')
    o.signal?.addEventListener('abort', onAbort, { once: true })

    const exit = await new Promise<{ code: number | null; spawnError?: string }>((res) => {
      let settled = false
      const settle = (v: { code: number | null; spawnError?: string }) => {
        if (settled) return
        settled = true
        res(v)
      }
      child.on('error', (err: NodeJS.ErrnoException) =>
        settle({ code: null, spawnError: err.code ?? 'spawn' }),
      )
      // 'close' waits for the pipes; a grandchild holding them must not keep us waiting long.
      child.on('close', (code) => settle({ code }))
      child.on('exit', (code) => {
        setTimeout(() => settle({ code }), 300).unref?.()
      })
    })
    clearTimeout(timer)
    o.signal?.removeEventListener('abort', onAbort)
    // The leader is gone: make sure nothing in its group outlives it.
    if (stop && !windows) signalProcessTree(child, 'SIGKILL')
    if (killTimer) clearTimeout(killTimer)

    const outputTail = redactOutput(raw, { home })
    const pinChanged =
      pins && before ? hashPins(o.cwd, pins).some((h, i) => h !== before[i]) : undefined
    const extra = pinChanged === undefined ? {} : { pinChanged }
    if (exit.spawnError)
      return done({ status: 'error', exitCode: null, outputTail, spawnError: exit.spawnError })
    if (stop) return done({ status: stop, exitCode: exit.code, outputTail, ...extra })
    return done({
      status: exit.code === 0 ? 'pass' : 'fail',
      exitCode: exit.code,
      outputTail,
      ...extra,
    })
  }
}
