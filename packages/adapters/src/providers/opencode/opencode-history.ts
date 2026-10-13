// OpenCode history (docs/providers/opencode.md, "History and observation"): past sessions come from
// OpenCode's own server API, never from its database files. `OpenCodeServers` hands out a server to
// read from: the one the user runs (Settings → observe; no credentials are sent to it), else a
// short-lived `opencode serve --pure` on 127.0.0.1 with a per-run password, stopped when idle.
// Only GET requests are made. Paths (session directories) stay in main; nothing is copied.
import { mkdirSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import type { HistorySource, PastSession } from '@agent-office/core'
import { HttpError, httpJson, localUrl, type FetchLike } from '../common/http/http-json.ts'
import { startLocalServer, type LocalServer } from '../common/http/local-server.ts'
import { which } from '../common/process.ts'
import {
  AnyArray,
  items,
  OPENCODE_PASSWORD_ENV,
  OPENCODE_SESSION_ID,
  OPENCODE_USERNAME,
  refOf,
  SessionInfo,
} from './opencode-protocol.ts'

const MAX_TITLE = 80
const IDLE_MS = 30_000
const START_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 10_000

export interface OpenCodeServer {
  readonly baseUrl: string
  readonly headers: Readonly<Record<string, string>>
}

/** Runs `fn` against a reachable OpenCode server; rejects when none can be had. */
export interface OpenCodeServerAccess {
  use<T>(fn: (s: OpenCodeServer) => Promise<T>): Promise<T>
}

export interface OpenCodeServersOptions {
  /** Where the short-lived server runs: an empty folder agent-office owns (created on demand). */
  cwd: string
  /** The binary; default: `opencode` on PATH. undefined → no short-lived server. */
  bin?: () => string | undefined
  /** Port of a server the user runs on 127.0.0.1 (the observe setting); tried first. */
  userPort?: () => number | undefined | Promise<number | undefined>
  env?: Record<string, string | undefined>
  /** Arguments before `serve …` (dev: the fake server script run by node). */
  argsPrefix?: string[]
  /** Stop the short-lived server after this long unused. Default 30 s. */
  idleMs?: number
  /** Test seam. */
  start?: typeof startLocalServer
}

export class OpenCodeServers implements OpenCodeServerAccess {
  private server: LocalServer | undefined
  private starting: Promise<LocalServer> | undefined
  private active = 0
  private idle: ReturnType<typeof setTimeout> | undefined

  constructor(private o: OpenCodeServersOptions) {}

  running(): boolean {
    return !!this.server?.alive()
  }

  async use<T>(fn: (s: OpenCodeServer) => Promise<T>): Promise<T> {
    const port = await this.o.userPort?.()
    if (port) {
      try {
        return await fn({ baseUrl: `http://127.0.0.1:${port}`, headers: {} })
      } catch (err) {
        // Not reachable, password-protected or too old: read through our own server instead.
        if (!(err instanceof HttpError)) throw err
      }
    }
    this.active++
    if (this.idle) clearTimeout(this.idle)
    this.idle = undefined
    try {
      return await fn(await this.ensure())
    } finally {
      if (--this.active === 0) {
        this.idle = setTimeout(() => void this.close(), this.o.idleMs ?? IDLE_MS)
        this.idle.unref?.()
      }
    }
  }

  private ensure(): Promise<LocalServer> {
    if (this.server?.alive()) return Promise.resolve(this.server)
    this.starting ??= (async () => {
      const bin = this.o.bin ? this.o.bin() : which('opencode')
      if (!bin) throw new Error('opencode is not installed')
      mkdirSync(this.o.cwd, { recursive: true })
      const s = await (this.o.start ?? startLocalServer)({
        bin,
        args: ({ host, port }) => [
          ...(this.o.argsPrefix ?? []),
          'serve',
          '--hostname',
          host,
          '--port',
          String(port),
          '--pure',
        ],
        cwd: this.o.cwd,
        ...(this.o.env ? { env: this.o.env } : {}),
        passwordEnv: OPENCODE_PASSWORD_ENV,
        username: OPENCODE_USERNAME,
        readyPath: '/global/health',
        timeoutMs: START_TIMEOUT_MS,
      })
      this.server = s
      return s
    })().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  async close(): Promise<void> {
    if (this.idle) clearTimeout(this.idle)
    this.idle = undefined
    const s = this.server ?? (await this.starting?.catch(() => undefined))
    this.server = undefined
    await s?.stop()
  }
}

/** GET a JSON array from an OpenCode server (read-only, timeout, size cap). */
export function getArray(
  s: OpenCodeServer,
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
  o: { timeoutMs?: number; maxBytes?: number; fetch?: FetchLike } = {},
): Promise<unknown[]> {
  return httpJson(localUrl(s.baseUrl, path, query), {
    schema: AnyArray,
    headers: { ...s.headers },
    timeoutMs: o.timeoutMs ?? CALL_TIMEOUT_MS,
    ...(o.maxBytes ? { maxBytes: o.maxBytes } : {}),
    ...(o.fetch ? { fetch: o.fetch } : {}),
  })
}

const clip = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= MAX_TITLE ? t : `${t.slice(0, MAX_TITLE - 1)}…`
}

export interface OpenCodeHistorySourceOptions {
  servers: OpenCodeServerAccess
  /** Without it (the provider is off) nothing is listed. */
  enabled?: () => boolean | Promise<boolean>
}

/** Lists past OpenCode sessions (top-level, not archived), newest first. */
export class OpenCodeHistorySource implements HistorySource {
  readonly idPattern = OPENCODE_SESSION_ID

  constructor(private o: OpenCodeHistorySourceOptions) {}

  async list(o: { limit: number }): Promise<PastSession[]> {
    if (this.o.enabled && !(await this.o.enabled())) return []
    const limit = Math.max(0, Math.min(500, Math.floor(o.limit)))
    if (limit === 0) return []
    let raw: unknown[]
    try {
      raw = await this.o.servers.use((s) =>
        getArray(s, '/experimental/session', { roots: true, limit }),
      )
    } catch {
      return [] // OpenCode missing or unreachable: nothing to import (nothing logged)
    }
    const out: PastSession[] = []
    for (const s of items(SessionInfo, raw)) {
      if (s.parentID || s.time.archived) continue
      const cwd = s.directory && isAbsolute(s.directory) ? s.directory : undefined
      const title = clip(s.title ?? '') || (cwd ? clip(basename(cwd)) : '') || 'OpenCode session'
      out.push({
        provider: 'opencode',
        providerSessionId: s.id,
        transcriptRef: refOf(s.id),
        ...(cwd ? { cwd } : {}),
        title,
        startedAt: s.time.created,
        lastSeenAt: s.time.updated ?? s.time.created,
      })
    }
    out.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    return out.slice(0, limit)
  }
}
