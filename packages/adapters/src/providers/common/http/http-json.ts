// JSON over HTTP to a runtime's local server (OpenCode, OpenHands): loopback only, a timeout and
// an abort signal on every call, a body size cap, and zod-validated responses. Errors carry a
// class only; response bodies and URLs are never put in messages (they may hold paths or text).
import type { RunnerExit } from '@agent-office/core'
import type { z } from 'zod'

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export type HttpErrorKind =
  'timeout' | 'aborted' | 'network' | 'auth' | 'not-found' | 'status' | 'invalid' | 'too-large'

export class HttpError extends Error {
  constructor(
    readonly kind: HttpErrorKind,
    readonly status?: number,
  ) {
    super(status ? `http ${kind} (${status})` : `http ${kind}`)
    this.name = 'HttpError'
  }
}

/** Throws unless `url` is http(s) on a loopback host: we never talk to a remote server. */
export function assertLoopback(url: string): URL {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error('not a loopback URL')
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !LOOPBACK.has(u.hostname))
    throw new Error('not a loopback URL')
  return u
}

/** `base` + `path` + query (undefined values skipped); loopback-checked. */
export function localUrl(
  base: string,
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
): string {
  const u = assertLoopback(new URL(path, base.endsWith('/') ? base : `${base}/`).toString())
  for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v))
  return u.toString()
}

export function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

export type FetchLike = typeof fetch

export interface HttpJsonOptions<T> {
  schema: z.ZodType<T>
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: unknown
  /** Default 5000 ms. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Default 16 MB. */
  maxBytes?: number
  fetch?: FetchLike
}

async function readCapped(res: Response, max: number): Promise<string> {
  const len = Number(res.headers.get('content-length'))
  if (Number.isFinite(len) && len > max) {
    await res.body?.cancel().catch(() => {})
    throw new HttpError('too-large')
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let out = ''
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      throw new HttpError('too-large')
    }
    out += dec.decode(value, { stream: true })
  }
  return out + dec.decode()
}

/** One JSON request. Resolves with the schema's output or throws an `HttpError`. */
export async function httpJson<T>(url: string, o: HttpJsonOptions<T>): Promise<T> {
  assertLoopback(url)
  const ctl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctl.abort()
  }, o.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const onAbort = () => ctl.abort()
  if (o.signal?.aborted) ctl.abort()
  o.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    let res: Response
    try {
      res = await (o.fetch ?? fetch)(url, {
        method: o.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...o.headers,
        },
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
        signal: ctl.signal,
        redirect: 'error',
      })
    } catch {
      throw new HttpError(timedOut ? 'timeout' : ctl.signal.aborted ? 'aborted' : 'network')
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      if (res.status === 401 || res.status === 403) throw new HttpError('auth', res.status)
      if (res.status === 404) throw new HttpError('not-found', res.status)
      throw new HttpError('status', res.status)
    }
    let text: string
    try {
      text = await readCapped(res, o.maxBytes ?? DEFAULT_MAX_BYTES)
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw new HttpError(timedOut ? 'timeout' : ctl.signal.aborted ? 'aborted' : 'network')
    }
    let data: unknown
    try {
      data = text === '' ? undefined : JSON.parse(text)
    } catch {
      throw new HttpError('invalid')
    }
    const parsed = o.schema.safeParse(data)
    if (!parsed.success) throw new HttpError('invalid')
    return parsed.data
  } finally {
    clearTimeout(timer)
    o.signal?.removeEventListener('abort', onAbort)
  }
}

/** Maps a failed call to a runner exit class (for HTTP-based runtimes). */
export function toRunnerExit(err: unknown): RunnerExit {
  if (err instanceof HttpError) {
    if (err.kind === 'auth') return { error: 'auth' }
    if (err.kind === 'network' || err.kind === 'timeout') return { error: 'runtime' }
    if (err.kind === 'aborted') return {}
  }
  return { error: 'crash' }
}
