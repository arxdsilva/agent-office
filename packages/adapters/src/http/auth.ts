import { timingSafeEqual } from 'node:crypto'

export interface AuthOptions {
  token: string
  port: number
  /** Extra `host:port` values accepted when binding beyond localhost. */
  allowedHosts?: string[]
  /** Extra browser origins allowed to call the API (none by default: the desktop UI uses IPC). */
  devOrigins?: string[]
}

export interface Auth {
  token: string
  hostAllowed(host: string | undefined): boolean
  originAllowed(origin: string | undefined): boolean
  bearerOk(header: string | undefined): boolean
  tokenOk(token: string | undefined): boolean
}

export function createAuth(opts: AuthOptions): Auth {
  const devHosts = (opts.devOrigins ?? []).map((o) => new URL(o).host)
  const hosts = new Set([
    `localhost:${opts.port}`,
    `127.0.0.1:${opts.port}`,
    ...devHosts,
    ...(opts.allowedHosts ?? []),
  ])
  const origins = new Set([...[...hosts].map((h) => `http://${h}`), ...(opts.devOrigins ?? [])])
  const expected = Buffer.from(opts.token)

  const tokenOk = (t: string | undefined) => {
    if (!t) return false
    const got = Buffer.from(t)
    return got.length === expected.length && timingSafeEqual(got, expected)
  }

  return {
    token: opts.token,
    // Host allowlist blocks DNS rebinding: a foreign domain resolving to 127.0.0.1 still sends its own Host.
    hostAllowed: (host) => !!host && hosts.has(host),
    // No Origin means a non-browser client (curl, hook); those still need the token to write.
    originAllowed: (origin) => origin === undefined || origins.has(origin),
    bearerOk: (header) => tokenOk(header?.startsWith('Bearer ') ? header.slice(7) : undefined),
    tokenOk,
  }
}
