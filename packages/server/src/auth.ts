import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Reads `<dir>/token`, creating a random one (mode 0600) on first run. */
export function loadOrCreateToken(dir: string): string {
  const file = join(dir, 'token')
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(t)) return t
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const token = randomBytes(32).toString('hex')
  writeFileSync(file, token + '\n', { mode: 0o600 })
  chmodSync(file, 0o600)
  return token
}

export interface AuthOptions {
  token: string
  port: number
  /** Extra `host:port` values accepted when binding beyond localhost. */
  allowedHosts?: string[]
  /** Browser origins of a dev server (Vite) allowed to call the API. */
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
