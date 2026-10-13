// Server-sent events from a runtime's local server (WHATWG EventSource parsing rules). The parser
// is incremental (any chunk split), caps each event at 1 MB (bigger ones are dropped whole), and the
// client reads the next chunk only after the handler settled (backpressure), reconnecting with
// backoff and Last-Event-ID. Loopback URLs only; event data is never logged.
import { assertLoopback, type FetchLike } from './http-json.ts'

export interface SseEvent {
  event: string
  data: string
  id?: string
}

export interface SseParserOptions {
  /** Default 1 MB (bytes of one event's data, or of one unterminated line). */
  maxEventBytes?: number
}

const MB = 1024 * 1024

export class SseParser {
  /** The last `id:` seen (sent back as Last-Event-ID on reconnect). */
  lastEventId: string | undefined
  /** The server's `retry:` in ms, when it sent one. */
  retry: number | undefined
  private readonly max: number
  private line = ''
  private data: string[] = []
  private size = 0
  private type = ''
  private oversize = false
  private skipLine = false
  private pendingCR = false
  private first = true

  constructor(o: SseParserOptions = {}) {
    this.max = o.maxEventBytes ?? MB
  }

  feed(chunk: string): SseEvent[] {
    const out: SseEvent[] = []
    let s = chunk
    if (this.first && s.length > 0) {
      this.first = false
      if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
    }
    let i = 0
    if (this.pendingCR && s.startsWith('\n')) i = 1
    this.pendingCR = false
    let start = i
    for (; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (c !== 10 && c !== 13) continue
      this.append(s.slice(start, i))
      this.endLine(out)
      if (c === 13) {
        if (i + 1 < s.length) {
          if (s.charCodeAt(i + 1) === 10) i++
        } else this.pendingCR = true
      }
      start = i + 1
    }
    this.append(s.slice(start))
    return out
  }

  private append(part: string) {
    if (this.skipLine || part === '') return
    this.line += part
    if (this.line.length + this.size > this.max) {
      // One line alone is too big: drop it and the event it belongs to.
      this.line = ''
      this.skipLine = true
      this.oversize = true
    }
  }

  private endLine(out: SseEvent[]) {
    const line = this.line
    const skipped = this.skipLine
    this.line = ''
    this.skipLine = false
    if (skipped) return
    if (line === '') return this.dispatch(out)
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    switch (field) {
      case 'data':
        if (this.oversize) return
        this.size += value.length + 1
        if (this.size > this.max) {
          this.oversize = true
          this.data = []
          return
        }
        this.data.push(value)
        return
      case 'event':
        this.type = value
        return
      case 'id':
        if (!value.includes('\u0000')) this.lastEventId = value
        return
      case 'retry':
        if (/^\d+$/.test(value)) this.retry = Number(value)
        return
    }
  }

  private dispatch(out: SseEvent[]) {
    const had = this.data.length > 0 && !this.oversize
    const e: SseEvent = { event: this.type || 'message', data: this.data.join('\n') }
    this.data = []
    this.size = 0
    this.type = ''
    this.oversize = false
    if (!had) return
    if (this.lastEventId !== undefined) e.id = this.lastEventId
    out.push(e)
  }
}

export type SseState = 'connecting' | 'open' | 'auth' | 'error' | 'closed'

export interface SseOptions {
  url: string
  headers?: Record<string, string>
  onEvent(e: SseEvent): void | Promise<void>
  onState?(s: SseState): void
  /** Reconnect delays: doubles from `initialMs` (or the server's `retry`) up to `maxMs`. */
  backoff?: { initialMs?: number; maxMs?: number }
  maxEventBytes?: number
  /** Time to get response headers. Default 5000 ms. */
  connectTimeoutMs?: number
  fetch?: FetchLike
}

export interface SseStream {
  close(): void
  readonly lastEventId: string | undefined
}

/** Opens a reconnecting event stream. Throws synchronously for a non-loopback URL. */
export function openSse(o: SseOptions): SseStream {
  assertLoopback(o.url)
  const initial = o.backoff?.initialMs ?? 1000
  const maxDelay = o.backoff?.maxMs ?? 30_000
  let closed = false
  let ctl: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  let lastEventId: string | undefined
  let serverRetry: number | undefined
  let state: SseState | undefined
  const set = (s: SseState) => {
    if (state === s && s !== 'auth' && s !== 'error') return
    state = s
    try {
      o.onState?.(s)
    } catch {
      /* a listener's problem, not the stream's */
    }
  }

  const schedule = () => {
    if (closed) return
    const base = serverRetry ?? initial
    const delay = Math.min(maxDelay, base * 2 ** Math.min(attempt, 16))
    attempt++
    timer = setTimeout(() => void connect(), delay)
    timer.unref?.()
  }

  async function connect(): Promise<void> {
    if (closed) return
    set('connecting')
    const c = new AbortController()
    ctl = c
    const headersTimer = setTimeout(() => c.abort(), o.connectTimeoutMs ?? 5000)
    let res: Response
    try {
      res = await (o.fetch ?? fetch)(o.url, {
        headers: {
          accept: 'text/event-stream',
          'cache-control': 'no-cache',
          ...o.headers,
          ...(lastEventId !== undefined ? { 'last-event-id': lastEventId } : {}),
        },
        signal: c.signal,
        redirect: 'error',
      })
    } catch {
      clearTimeout(headersTimer)
      if (closed) return
      set('error')
      return schedule()
    }
    clearTimeout(headersTimer)
    if (closed) {
      await res.body?.cancel().catch(() => {})
      return
    }
    if (res.status === 204) {
      closed = true
      set('closed')
      return
    }
    const type = res.headers.get('content-type') ?? ''
    if (!res.ok || !type.toLowerCase().startsWith('text/event-stream') || !res.body) {
      await res.body?.cancel().catch(() => {})
      set(res.status === 401 || res.status === 403 ? 'auth' : 'error')
      return schedule()
    }
    set('open')
    attempt = 0
    const parser = new SseParser({ maxEventBytes: o.maxEventBytes ?? MB })
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let dropped = false
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || closed) break
        for (const e of parser.feed(dec.decode(value, { stream: true }))) {
          if (closed) break
          try {
            await o.onEvent(e)
          } catch {
            /* a bad event must not end the stream */
          }
        }
        lastEventId = parser.lastEventId
        serverRetry = parser.retry ?? serverRetry
      }
    } catch {
      dropped = true // the connection dropped
    } finally {
      lastEventId = parser.lastEventId ?? lastEventId
      serverRetry = parser.retry ?? serverRetry
      await reader.cancel().catch(() => {})
    }
    if (closed) return
    if (dropped) set('error')
    schedule()
  }

  void connect()
  return {
    close() {
      if (closed) return
      closed = true
      if (timer) clearTimeout(timer)
      ctl?.abort()
      set('closed')
    },
    get lastEventId() {
      return lastEventId
    },
  }
}
