import type { SweepPolicy } from '@agent-office/core'
import type { ServerMessage } from '@agent-office/shared'
import { createAuth, type Auth } from '../src/http/auth.ts'
import { buildHttpApi } from '../src/http/http-api.ts'
import { startHttpServer } from '../src/http/server.ts'
import { makeOffice } from './support.ts'

export const TOKEN = 'e'.repeat(64)

/** Real core + real HTTP server on a random port (port 0 → OS picks; Host allowlist follows it). */
export async function startServer(policy: Partial<SweepPolicy> = {}) {
  const { office, bus, scheduler } = makeOffice({ policy })
  let current = createAuth({ token: TOKEN, port: 0 })
  const auth: Auth = {
    token: TOKEN,
    hostAllowed: (h) => current.hostAllowed(h),
    originAllowed: (o) => current.originAllowed(o),
    bearerOk: (h) => current.bearerOk(h),
    tokenOk: (t) => current.tokenOk(t),
  }
  const app = buildHttpApi({ activity: office.activity, inbox: office.inbox, chat: office.chat, query: office.query }, auth)
  const server = await startHttpServer(app, { host: '127.0.0.1', port: 0 })
  current = createAuth({ token: TOKEN, port: server.port })
  const url = `http://127.0.0.1:${server.port}`

  const api = (path: string, init: RequestInit = {}) =>
    fetch(url + path, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...init.headers },
    })

  return {
    office,
    bus,
    url,
    port: server.port,
    api,
    close: async () => {
      await server.close()
      scheduler.dispose()
    },
  }
}

/** Collects what a UI would receive (OfficeQuery.watch) so tests can await specific messages. */
export function observe(office: ReturnType<typeof makeOffice>['office']) {
  const received: ServerMessage[] = []
  const waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = []
  const stop = office.query.watch((msg) => {
    received.push(msg)
    for (const w of [...waiters]) {
      if (w.pred(msg)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(msg)
      }
    }
  })
  const next = <T extends ServerMessage>(pred: (m: ServerMessage) => m is T, timeoutMs = 3000): Promise<T> => {
    const seen = received.find(pred)
    if (seen) {
      received.splice(received.indexOf(seen), 1)
      return Promise.resolve(seen)
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs)
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
  return { next, stop }
}

export const is =
  <K extends ServerMessage['type']>(type: K, extra: (m: Extract<ServerMessage, { type: K }>) => boolean = () => true) =>
  (m: ServerMessage): m is Extract<ServerMessage, { type: K }> =>
    m.type === type && extra(m as Extract<ServerMessage, { type: K }>)
