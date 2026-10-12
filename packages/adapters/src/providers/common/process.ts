// Shared process plumbing for managed runtimes (Codex app-server, ACP agents). No shell, no token,
// bounded stderr that is never logged, and a close that takes the whole process tree down.
import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter as hostDelimiter, isAbsolute, join } from 'node:path'
import { PassThrough, type Readable, type Writable } from 'node:stream'

const STDERR_MAX = 64 * 1024
const KILL_GRACE_MS = 2000

export interface RuntimeExit {
  code: number | null
  signal: NodeJS.Signals | null
  /** Set when the process never started: 'cwd' (missing folder) or the errno code ('ENOENT', …). */
  spawnError?: string
}

/** A spawned runtime. `stdin`/`stdout` carry the protocol; stderr stays inside. */
export interface RuntimeProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly pid: number | undefined
  /** SIGTERM to the process group, SIGKILL after the grace period (Windows: taskkill /T /F). */
  kill(): Promise<void>
  readonly exited: Promise<RuntimeExit>
  /** The last 64 KB of stderr, for exit classification only. Never log it. */
  stderrTail(): string
  alive(): boolean
}

export interface SpawnRuntimeOptions {
  cwd: string
  env?: Record<string, string | undefined>
  /** Default 2000 ms. */
  killGraceMs?: number
}

/** process.env plus `extra`, minus anything that could carry our API token, marked as managed. */
export function runtimeEnv(
  extra: Record<string, string | undefined> = {},
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...base, ...extra })) {
    if (v === undefined || /^AGENT_OFFICE_TOKEN/i.test(k)) continue
    out[k] = v
  }
  out.AGENT_OFFICE_MANAGED = '1'
  return out
}

function folderExists(cwd: string): boolean {
  try {
    return statSync(cwd).isDirectory()
  } catch {
    return false
  }
}

export function spawnRuntime(bin: string, args: string[], o: SpawnRuntimeOptions): RuntimeProcess {
  const windows = process.platform === 'win32'
  const grace = o.killGraceMs ?? KILL_GRACE_MS
  let tail = ''
  let done = false
  let resolveExit!: (e: RuntimeExit) => void
  const exited = new Promise<RuntimeExit>((r) => (resolveExit = r))
  const finish = (e: RuntimeExit) => {
    if (done) return
    done = true
    resolveExit(e)
  }

  // Node reports a missing cwd as `spawn <bin> ENOENT`, like a missing binary: check it first
  // and never start the runtime anywhere else.
  if (!folderExists(o.cwd)) {
    const stdout = new PassThrough()
    stdout.end()
    return {
      stdin: new PassThrough(),
      stdout,
      pid: undefined,
      kill: () => Promise.resolve(),
      exited: Promise.resolve({ code: null, signal: null, spawnError: 'cwd' }),
      stderrTail: () => '',
      alive: () => false,
    }
  }
  const child = spawn(bin, args, {
    cwd: o.cwd,
    env: runtimeEnv(o.env),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Own process group on POSIX so kill() reaches grandchildren; Windows uses taskkill /T.
    detached: !windows,
    windowsHide: true,
  })
  child.on('error', (err: NodeJS.ErrnoException) =>
    finish({ code: null, signal: null, spawnError: err.code ?? 'spawn' }),
  )
  // 'close' comes after stderr is drained; a grandchild holding the pipes must not delay the
  // exit report for long, so 'exit' finishes on its own shortly after.
  child.on('close', (code, signal) => finish({ code, signal }))
  child.on('exit', (code, signal) => {
    setTimeout(() => finish({ code, signal }), 300).unref()
  })
  child.stderr.on('data', (c: Buffer) => {
    tail = (tail + c.toString('utf8')).slice(-STDERR_MAX)
  })
  // A dead pipe must not crash the app; the exit is reported through `exited`.
  child.stdin.on('error', () => {})
  child.stdout.on('error', () => {})

  const signalTree = (sig: NodeJS.Signals) => {
    const pid = child.pid
    if (pid === undefined) return
    try {
      if (windows) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {})
      else process.kill(-pid, sig)
    } catch {
      try {
        child.kill(sig)
      } catch {
        /* already gone */
      }
    }
  }

  let killing: Promise<void> | undefined
  const kill = (): Promise<void> => {
    if (done) return Promise.resolve()
    killing ??= (async () => {
      child.stdin.end()
      signalTree('SIGTERM')
      const timer = setTimeout(() => signalTree('SIGKILL'), grace)
      await exited
      clearTimeout(timer)
      // The leader is gone; make sure nothing in its group outlives it.
      if (!windows) signalTree('SIGKILL')
    })()
    return killing
  }

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    pid: child.pid,
    kill,
    exited,
    stderrTail: () => tail,
    alive: () => !done,
  }
}

const AUTH = /\b(not logged in|log ?in|login|unauthori[sz]ed|401|auth\w*|credential\w*|api key)\b/i
const FOLDER = /\b(ENOENT|no such file or directory)\b[^\n]*\b(cwd|chdir|directory)\b/i

/** Classifies an unexpected runtime exit. Only the class is kept; stderr text never leaves. */
export function classifyExit(
  code: number | null,
  stderrTail: string,
  spawnError?: string,
): 'auth' | 'folder' | 'runtime' | 'crash' {
  if (spawnError === 'cwd') return 'folder'
  if (spawnError) return 'runtime'
  if (AUTH.test(stderrTail)) return 'auth'
  if (FOLDER.test(stderrTail)) return 'folder'
  void code
  return 'crash'
}

export interface WhichOptions {
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
}

function executable(p: string, windows: boolean): boolean {
  try {
    if (!statSync(p).isFile()) return false
    if (!windows) accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolves `bin` on PATH (Windows: with PATHEXT, so `codex` finds `codex.cmd`). */
export function which(bin: string, o: WhichOptions = {}): string | undefined {
  const env = o.env ?? process.env
  const platform = o.platform ?? process.platform
  const windows = platform === 'win32'
  // npm puts a POSIX shell script next to `codex.cmd` on Windows: try PATHEXT first, the bare
  // name only when it already has an extension.
  const pathExt = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const exts = windows ? [...pathExt, ...(/\.[A-Za-z0-9]+$/.test(bin) ? [''] : [])] : ['']
  const candidates = (base: string) => exts.map((e) => base + e.toLowerCase())
  if (isAbsolute(bin) || bin.includes('/') || bin.includes('\\'))
    return candidates(bin).find((c) => executable(c, windows))
  const pathVar = env.PATH ?? env.Path ?? ''
  const sep = windows ? ';' : platform === process.platform ? hostDelimiter : ':'
  for (const d of pathVar.split(sep).filter(Boolean)) {
    const hit = candidates(join(d, bin)).find((c) => executable(c, windows))
    if (hit) return hit
  }
  return undefined
}
