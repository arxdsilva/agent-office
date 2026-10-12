import type { ServerMessage } from '@agent-office/shared'
import WebSocket from 'ws'
import { createAuth } from '../src/auth.ts'
import { buildApp } from '../src/http.ts'
import { MessageStore } from '../src/messages.ts'
import { AgentStore } from '../src/store.ts'

export const TOKEN = 'e'.repeat(64)

/** Boots the real app on a random port. Port 0 → OS picks; Host allowlist uses the real port. */
export async function startServer(
  storeOpts: Partial<ConstructorParameters<typeof AgentStore>[0]> = {},
) {
  const store = new AgentStore({
    idleAfterMs: 60_000,
    expireAfterMs: 600_000,
    doneTtlMs: 30_000,
    interactiveTtlMs: 600_000,
    ...storeOpts,
  })
  const messages = new MessageStore()
  // The port is only known after listen, so auth checks against a mutable holder.
  const holder = { auth: createAuth({ token: TOKEN, port: 0 }) }
  const auth = {
    get token() {
      return TOKEN
    },
    hostAllowed: (h: string | undefined) => holder.auth.hostAllowed(h),
    originAllowed: (o: string | undefined) => holder.auth.originAllowed(o),
    bearerOk: (h: string | undefined) => holder.auth.bearerOk(h),
    tokenOk: (t: string | undefined) => holder.auth.tokenOk(t),
  }
  const app = buildApp({ store, messages, auth })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = (app.server.address() as { port: number }).port
  holder.auth = createAuth({ token: TOKEN, port })
  const url = `http://127.0.0.1:${port}`

  const api = (path: string, init: RequestInit = {}) =>
    fetch(url + path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
        ...init.headers,
      },
    })

  return { app, store, messages, url, port, api, close: () => app.close() }
}

/** Opens a WebSocket and buffers every ServerMessage so tests can await specific ones. */
export async function connectWs(url: string, opts: { token?: string; origin?: string } = {}) {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/ws?token=${opts.token ?? TOKEN}`, {
    ...(opts.origin ? { origin: opts.origin } : {}),
  })
  const received: ServerMessage[] = []
  const waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = []
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as ServerMessage
    received.push(msg)
    for (const w of [...waiters]) {
      if (w.pred(msg)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(msg)
      }
    }
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
    // With a listener attached, ws leaves the rejected request open — destroy it so servers can close.
    ws.once('unexpected-response', (req, res) => {
      req.destroy()
      res.destroy()
      reject(new Error(`HTTP ${res.statusCode}`))
    })
  })
  const next = <T extends ServerMessage>(
    pred: (m: ServerMessage) => m is T,
    timeoutMs = 3000,
  ): Promise<T> => {
    const seen = received.find(pred)
    if (seen) {
      received.splice(received.indexOf(seen), 1)
      return Promise.resolve(seen)
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for ws message')), timeoutMs)
      waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t)
          received.splice(received.indexOf(m), 1)
          resolve(m as T)
        },
      })
    })
  }
  return { ws, next, close: () => ws.close() }
}

export const is =
  <K extends ServerMessage['type']>(
    type: K,
    extra: (m: Extract<ServerMessage, { type: K }>) => boolean = () => true,
  ) =>
  (m: ServerMessage): m is Extract<ServerMessage, { type: K }> =>
    m.type === type && extra(m as Extract<ServerMessage, { type: K }>)
