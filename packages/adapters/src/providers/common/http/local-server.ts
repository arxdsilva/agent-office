// Starts a runtime's own HTTP server for a short while (`opencode serve`, …): through spawnRuntime
// (shell:false, AGENT_OFFICE_MANAGED=1, our token stripped), bound to 127.0.0.1 on a port we picked
// by binding :0 first, with a fresh random password when the server supports one, polled until
// ready. stop() is SIGTERM, then SIGKILL after 3 s. Output and stderr are never logged.
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import type { RunnerExit } from '@agent-office/core'
import { classifyExit, spawnRuntime, type RuntimeExit, type RuntimeProcess } from '../process.ts'
import { basicAuth, type FetchLike } from './http-json.ts'

const HOST = '127.0.0.1'
const KILL_GRACE_MS = 3000

export class LocalServerError extends Error {
  constructor(
    readonly kind: 'spawn' | 'exited' | 'timeout',
    readonly exit?: RunnerExit,
  ) {
    super(`local server ${kind}`)
    this.name = 'LocalServerError'
  }
}

export interface LocalServerOptions {
  bin: string
  /** Fixed arguments; `host` is always 127.0.0.1 and `port` a free one. */
  args: (o: { host: string; port: number }) => string[]
  cwd: string
  env?: Record<string, string | undefined>
  /** The env var the server reads its password from (OpenCode: OPENCODE_SERVER_PASSWORD). */
  passwordEnv?: string
  /** HTTP Basic user for that password (OpenCode: "opencode"). */
  username?: string
  /** GET path that answers 2xx once the server is up. */
  readyPath: string
  /** Default 15 s. */
  timeoutMs?: number
  /** Default 100 ms. */
  pollMs?: number
  /** Default 3000 ms. */
  killGraceMs?: number
  fetch?: FetchLike
}

export interface LocalServer {
  /** http://127.0.0.1:<port> */
  readonly baseUrl: string
  /** Send with every request (the per-run password); empty when the server has none. */
  readonly headers: Readonly<Record<string, string>>
  readonly exited: Promise<RuntimeExit>
  alive(): boolean
  stop(): Promise<void>
}

/** A port that was free a moment ago on 127.0.0.1 (bind :0, read it, release it). */
export function freePort(host = HOST): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.once('error', reject)
    s.listen(0, host, () => {
      const a = s.address()
      const port = typeof a === 'object' && a ? a.port : 0
      s.close(() => resolve(port))
    })
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function startLocalServer(o: LocalServerOptions): Promise<LocalServer> {
  const port = await freePort()
  const secret = o.passwordEnv ? randomBytes(32).toString('hex') : undefined
  const headers: Record<string, string> = secret
    ? { authorization: basicAuth(o.username ?? 'user', secret) }
    : {}
  const proc: RuntimeProcess = spawnRuntime(o.bin, o.args({ host: HOST, port }), {
    cwd: o.cwd,
    env: { ...o.env, ...(o.passwordEnv && secret ? { [o.passwordEnv]: secret } : {}) },
    killGraceMs: o.killGraceMs ?? KILL_GRACE_MS,
  })
  // Drain stdout so a chatty server never blocks on a full pipe; the content is ignored.
  proc.stdout.resume()
  const baseUrl = `http://${HOST}:${port}`
  let exitInfo: RuntimeExit | undefined
  void proc.exited.then((e) => (exitInfo = e))

  const deadline = Date.now() + (o.timeoutMs ?? 15_000)
  const poll = o.pollMs ?? 100
  const doFetch = o.fetch ?? fetch
  for (;;) {
    await Promise.race([proc.exited, sleep(0)])
    if (exitInfo) {
      const e = exitInfo
      throw new LocalServerError(e.spawnError ? 'spawn' : 'exited', {
        error: classifyExit(e.code, proc.stderrTail(), e.spawnError),
      })
    }
    try {
      const res = await doFetch(`${baseUrl}${o.readyPath}`, {
        headers,
        signal: AbortSignal.timeout(Math.max(200, poll * 5)),
      })
      await res.body?.cancel().catch(() => {})
      if (res.ok) break
    } catch {
      /* not listening yet */
    }
    if (Date.now() >= deadline) {
      await proc.kill()
      throw new LocalServerError('timeout', { error: 'runtime' })
    }
    await Promise.race([proc.exited, sleep(poll)])
  }

  return {
    baseUrl,
    headers,
    exited: proc.exited,
    alive: () => proc.alive(),
    stop: () => proc.kill(),
  }
}
