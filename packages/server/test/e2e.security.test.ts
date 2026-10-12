import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { connectWs, startServer } from './helpers.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.reverse()) await c()
  cleanup = []
})

/** fetch() won't let us forge Host, so use node:http directly. */
function rawGet(port: number, path: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
      .on('error', reject)
      .end()
  })
}

describe('security (E2E)', () => {
  it('rejects a DNS-rebinding style Host header with 421', async () => {
    const srv = await startServer()
    cleanup.push(srv.close)
    // evil.com resolving to 127.0.0.1 still sends Host: evil.com — must be refused.
    expect(await rawGet(srv.port, '/api/agents', { host: 'evil.com' })).toBe(421)
  })

  it('rejects writes from a foreign Origin with 403 even with a token', async () => {
    const srv = await startServer()
    cleanup.push(srv.close)
    // A malicious page can't read the token, but even if it had one, a foreign Origin is refused.
    const r = await srv.api('/api/events', {
      method: 'POST',
      headers: { origin: 'https://evil.com' },
      body: JSON.stringify({ agentId: 'x' }),
    })
    expect(r.status).toBe(403)
  })

  it('rejects writes without the token with 401', async () => {
    const srv = await startServer()
    cleanup.push(srv.close)
    const r = await fetch(`${srv.url}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'x' }),
    })
    expect(r.status).toBe(401)
  })

  it('refuses WebSocket upgrades from a foreign Origin', async () => {
    const srv = await startServer()
    cleanup.push(srv.close)
    await expect(connectWs(srv.url, { origin: 'https://evil.com' })).rejects.toThrow(/403/)
  })

  it('closes WebSockets that present a wrong token', async () => {
    const srv = await startServer()
    cleanup.push(srv.close)
    const c = await connectWs(srv.url, { token: 'nope' })
    const code = await new Promise<number>((resolve) => c.ws.once('close', (code) => resolve(code)))
    expect(code).toBe(4401)
  })
})
