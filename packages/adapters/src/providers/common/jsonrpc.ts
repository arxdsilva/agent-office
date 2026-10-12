// NDJSON JSON-RPC peer for managed runtimes: Codex app-server (`dialect:'codex'`, no "jsonrpc"
// field on the wire) and ACP agents (`'jsonrpc2'`). Never logs message content.

/** Anything that emits 'data' chunks and 'end'/'close' (a Node Readable, or a test double). */
export interface ByteSource {
  // `any`: Node's overloaded `on` only matches an any-typed listener.
  on(event: string, listener: (...args: any[]) => void): unknown
}
/** Anything that accepts written text (a Node Writable, or a test double). */
export interface ByteSink {
  write(chunk: string): unknown
}

export type RpcId = number | string

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'RpcError'
  }
}
export class RpcTimeoutError extends Error {
  constructor(readonly method: string) {
    super(`JSON-RPC request timed out: ${method}`)
    this.name = 'RpcTimeoutError'
  }
}
export class PeerClosedError extends Error {
  constructor() {
    super('JSON-RPC peer closed')
    this.name = 'PeerClosedError'
  }
}

export interface JsonRpcPeerOptions {
  dialect: 'jsonrpc2' | 'codex'
  /** Default per-request timeout; 0 or absent = none. */
  timeoutMs?: number
  /** Default 1 MB. */
  maxLineBytes?: number
}

type RequestHandler = (params: unknown, method: string) => unknown
type NotificationHandler = (params: unknown, method: string) => void

interface Pending {
  method: string
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

const MAX_LINE = 1024 * 1024

export class JsonRpcPeer {
  /** Counters only: dropped lines are never logged (they may hold user text). */
  readonly stats = { malformed: 0, oversized: 0 }
  private buf = ''
  private discarding = false
  private nextId = 1
  private pending = new Map<RpcId, Pending>()
  private requestHandlers = new Map<string, RequestHandler>()
  private notificationHandlers = new Map<string, NotificationHandler[]>()
  private closeFns: (() => void)[] = []
  private isClosed = false
  private readonly maxLine: number

  constructor(
    source: ByteSource,
    private sink: ByteSink,
    private o: JsonRpcPeerOptions,
  ) {
    this.maxLine = o.maxLineBytes ?? MAX_LINE
    const on = source.on.bind(source) as (ev: string, fn: (...a: unknown[]) => void) => unknown
    on('data', (chunk) => this.feed(String(chunk)))
    on('end', () => this.close())
    on('close', () => this.close())
    on('error', () => this.close())
  }

  get closed(): boolean {
    return this.isClosed
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    o: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.isClosed) return Promise.reject(new PeerClosedError())
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { method, resolve: resolve as (v: unknown) => void, reject }
      const ms = o.timeoutMs ?? this.o.timeoutMs
      if (ms && ms > 0)
        p.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new RpcTimeoutError(method))
        }, ms)
      this.pending.set(id, p)
      this.send({ id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.isClosed) return
    this.send({ method, ...(params === undefined ? {} : { params }) })
  }

  /** Handles a server→client request. A thrown RpcError is sent as is; anything else as -32603. */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler)
  }

  /** `'*'` receives every notification (after the method's own handlers). */
  onNotification(method: string, fn: NotificationHandler): void {
    const list = this.notificationHandlers.get(method) ?? []
    list.push(fn)
    this.notificationHandlers.set(method, list)
  }

  onClose(fn: () => void): void {
    if (this.isClosed) fn()
    else this.closeFns.push(fn)
  }

  close(): void {
    if (this.isClosed) return
    this.isClosed = true
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const p of pending) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(new PeerClosedError())
    }
    for (const fn of this.closeFns.splice(0)) fn()
  }

  private send(msg: Record<string, unknown>): void {
    const framed = this.o.dialect === 'jsonrpc2' ? { jsonrpc: '2.0', ...msg } : msg
    try {
      this.sink.write(JSON.stringify(framed) + '\n')
    } catch {
      this.close()
    }
  }

  private feed(chunk: string): void {
    let start = 0
    for (;;) {
      const nl = chunk.indexOf('\n', start)
      if (nl < 0) break
      const piece = chunk.slice(start, nl)
      start = nl + 1
      if (this.discarding) {
        this.discarding = false
        this.buf = ''
        continue
      }
      const line = this.buf + piece
      this.buf = ''
      if (line.length > this.maxLine) {
        this.stats.oversized++
        continue
      }
      this.handleLine(line)
      if (this.isClosed) return
    }
    if (this.discarding) return
    this.buf += chunk.slice(start)
    if (this.buf.length > this.maxLine) {
      this.stats.oversized++
      this.buf = ''
      this.discarding = true
    }
  }

  private handleLine(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!line.trim()) return
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      this.stats.malformed++
      return
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      this.stats.malformed++
      return
    }
    const m = msg as {
      id?: RpcId
      method?: unknown
      params?: unknown
      result?: unknown
      error?: unknown
    }
    const hasId = typeof m.id === 'number' || typeof m.id === 'string'
    if (typeof m.method === 'string') {
      if (hasId) this.handleRequest(m.id!, m.method, m.params)
      else this.handleNotification(m.method, m.params)
      return
    }
    if (hasId && ('result' in m || 'error' in m)) return this.handleResponse(m.id!, m)
    this.stats.malformed++
  }

  private handleResponse(id: RpcId, m: { result?: unknown; error?: unknown }): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    if (p.timer) clearTimeout(p.timer)
    if (m.error !== undefined && m.error !== null) {
      const e = m.error as { code?: unknown; message?: unknown; data?: unknown }
      p.reject(
        new RpcError(
          typeof e.code === 'number' ? e.code : -32603,
          typeof e.message === 'string' ? e.message : 'Error',
          e.data,
        ),
      )
    } else p.resolve(m.result)
  }

  private handleNotification(method: string, params: unknown): void {
    for (const fn of this.notificationHandlers.get(method) ?? []) fn(params, method)
    for (const fn of this.notificationHandlers.get('*') ?? []) fn(params, method)
  }

  private handleRequest(id: RpcId, method: string, params: unknown): void {
    const handler = this.requestHandlers.get(method)
    if (!handler) {
      this.send({ id, error: { code: -32601, message: 'Method not found' } })
      return
    }
    void (async () => {
      try {
        const result = await handler(params, method)
        if (!this.isClosed) this.send({ id, result: result ?? null })
      } catch (err) {
        if (this.isClosed) return
        const error =
          err instanceof RpcError
            ? { code: err.code, message: err.message }
            : { code: -32603, message: 'Internal error' }
        this.send({ id, error })
      }
    })()
  }
}
