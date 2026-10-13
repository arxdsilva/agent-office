import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  assertLoopback,
  basicAuth,
  HttpError,
  httpJson,
  localUrl,
  toRunnerExit,
} from './http-json.ts'

let base = ''
let close = () => {}
const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => void> = {
  '/ok': (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ n: 1, auth: req.headers.authorization ?? null, m: req.method }))
  },
  '/echo': (req, res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ n: 2, body: JSON.parse(b), ct: req.headers['content-type'] }))
    })
  },
  '/401': (_req, res) => void res.writeHead(401).end(),
  '/403': (_req, res) => void res.writeHead(403).end(),
  '/404': (_req, res) => void res.writeHead(404).end('{}'),
  '/500': (_req, res) => void res.writeHead(500).end('secret /Users/x/path'),
  '/bad-json': (_req, res) => void res.writeHead(200).end('{nope'),
  '/empty': (_req, res) => void res.writeHead(200).end(''),
  '/wrong-shape': (_req, res) => void res.writeHead(200).end('{"n":"x"}'),
  '/big': (_req, res) =>
    void res.writeHead(200).end(JSON.stringify({ n: 1, pad: 'x'.repeat(5000) })),
  '/big-chunked': (_req, res) => {
    res.writeHead(200, { 'transfer-encoding': 'chunked' })
    for (let i = 0; i < 10; i++) res.write('x'.repeat(1000))
    res.end()
  },
  '/slow': () => {},
}

beforeAll(async () => {
  const srv = createServer((req, res) => {
    const r = routes[new URL(req.url!, 'http://x').pathname]
    if (r) r(req, res)
    else res.writeHead(404).end()
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
  close = () => {
    srv.closeAllConnections()
    srv.close()
  }
})
afterAll(() => close())

const N = z.looseObject({ n: z.number() })
const kind = async (p: Promise<unknown>) => {
  try {
    await p
    return 'resolved'
  } catch (e) {
    return e instanceof HttpError ? e.kind : String(e)
  }
}

describe('httpJson', () => {
  it('GETs and validates, with headers', async () => {
    const r = await httpJson(`${base}/ok`, {
      schema: z.object({ n: z.number(), auth: z.string().nullable(), m: z.string() }),
      headers: { authorization: basicAuth('opencode', 'pw') },
    })
    expect(r).toEqual({
      n: 1,
      auth: `Basic ${Buffer.from('opencode:pw').toString('base64')}`,
      m: 'GET',
    })
  })

  it('POSTs a JSON body', async () => {
    const r = await httpJson(`${base}/echo`, {
      method: 'POST',
      body: { a: 1 },
      schema: z.looseObject({ body: z.unknown(), ct: z.string() }),
    })
    expect(r).toMatchObject({ body: { a: 1 }, ct: 'application/json' })
  })

  it('classifies failures without leaking the body', async () => {
    expect(await kind(httpJson(`${base}/401`, { schema: N }))).toBe('auth')
    expect(await kind(httpJson(`${base}/403`, { schema: N }))).toBe('auth')
    expect(await kind(httpJson(`${base}/404`, { schema: N }))).toBe('not-found')
    expect(await kind(httpJson(`${base}/bad-json`, { schema: N }))).toBe('invalid')
    expect(await kind(httpJson(`${base}/empty`, { schema: N }))).toBe('invalid')
    expect(await kind(httpJson(`${base}/wrong-shape`, { schema: N }))).toBe('invalid')
    expect(await kind(httpJson(`${base}/big`, { schema: N, maxBytes: 100 }))).toBe('too-large')
    expect(await kind(httpJson(`${base}/big-chunked`, { schema: N, maxBytes: 3000 }))).toBe(
      'too-large',
    )
    expect(await kind(httpJson('http://127.0.0.1:1/x', { schema: N }))).toBe('network')
    try {
      await httpJson(`${base}/500`, { schema: N })
    } catch (e) {
      expect((e as HttpError).kind).toBe('status')
      expect((e as HttpError).status).toBe(500)
      expect(String((e as Error).message)).not.toContain('/Users')
    }
  })

  it('times out and aborts', async () => {
    expect(await kind(httpJson(`${base}/slow`, { schema: N, timeoutMs: 30 }))).toBe('timeout')
    const ctl = new AbortController()
    const p = httpJson(`${base}/slow`, { schema: N, signal: ctl.signal })
    setTimeout(() => ctl.abort(), 20)
    expect(await kind(p)).toBe('aborted')
    const pre = new AbortController()
    pre.abort()
    expect(await kind(httpJson(`${base}/ok`, { schema: N, signal: pre.signal }))).toBe('aborted')
  })

  it('refuses non-loopback URLs before any request', async () => {
    let called = false
    const f = (() => {
      called = true
      return Promise.reject(new Error('no'))
    }) as unknown as typeof fetch
    expect(await kind(httpJson('http://example.com/x', { schema: N, fetch: f }))).toMatch(
      /loopback/,
    )
    expect(called).toBe(false)
  })
})

describe('helpers', () => {
  it('assertLoopback accepts only local http(s)', () => {
    for (const ok of [
      'http://127.0.0.1:1/',
      'http://localhost:2',
      'http://[::1]:3/x',
      'https://127.0.0.1/',
    ])
      expect(() => assertLoopback(ok)).not.toThrow()
    for (const bad of [
      'http://10.0.0.1/',
      'ftp://127.0.0.1/',
      'not a url',
      'http://127.0.0.1.evil.com/',
    ])
      expect(() => assertLoopback(bad)).toThrow(/loopback/)
  })

  it('localUrl joins the path and skips undefined query values', () => {
    expect(
      localUrl('http://127.0.0.1:9', '/session', { limit: 5, roots: true, x: undefined }),
    ).toBe('http://127.0.0.1:9/session?limit=5&roots=true')
    expect(localUrl('http://127.0.0.1:9/', 'a/b')).toBe('http://127.0.0.1:9/a/b')
    expect(() => localUrl('http://8.8.8.8', '/x')).toThrow()
  })

  it('toRunnerExit maps classes', () => {
    expect(toRunnerExit(new HttpError('auth', 401))).toEqual({ error: 'auth' })
    expect(toRunnerExit(new HttpError('network'))).toEqual({ error: 'runtime' })
    expect(toRunnerExit(new HttpError('timeout'))).toEqual({ error: 'runtime' })
    expect(toRunnerExit(new HttpError('aborted'))).toEqual({})
    expect(toRunnerExit(new HttpError('invalid'))).toEqual({ error: 'crash' })
    expect(toRunnerExit(new Error('x'))).toEqual({ error: 'crash' })
  })
})
