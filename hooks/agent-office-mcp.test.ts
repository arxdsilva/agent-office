import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs script, no types
import { forward, loopbackUrl, runBridge } from './agent-office-mcp.mjs'

const URL_OK = 'http://127.0.0.1:4317/mcp'
const TOKEN = `mcp_${'c'.repeat(64)}`

type Seen = { body: unknown; headers: Record<string, string> }

/** Fake fetch: records requests and answers with the given (status, body). */
function fakeFetch(answer: (body: Record<string, unknown>) => { status: number; body?: unknown }) {
  const seen: Seen[] = []
  const f = async (url: string, init: { body: string; headers: Record<string, string> }) => {
    expect(url).toBe(URL_OK)
    const body = JSON.parse(init.body)
    seen.push({ body, headers: init.headers })
    const a = answer(body)
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), {
      status: a.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { f, seen }
}

const deps = (f: unknown, over: Record<string, unknown> = {}) => ({
  url: URL_OK,
  token: TOKEN,
  fetch: f,
  timeoutMs: 500,
  state: {},
  ...over,
})

describe('forward', () => {
  it('posts a request with the bearer token and returns the response line', async () => {
    const { f, seen } = fakeFetch((b) => ({
      status: 200,
      body: { jsonrpc: '2.0', id: b.id, result: {} },
    }))
    const out = await forward(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), deps(f))
    expect(JSON.parse(out)).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
    expect(seen[0]!.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    })
  })

  it('remembers the negotiated protocol version and sends it afterwards', async () => {
    const { f, seen } = fakeFetch((b) => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: b.id,
        result: b.method === 'initialize' ? { protocolVersion: '2025-06-18' } : {},
      },
    }))
    const d = deps(f)
    await forward(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), d)
    await forward(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }), d)
    expect(seen[0]!.headers['mcp-protocol-version']).toBeUndefined()
    expect(seen[1]!.headers['mcp-protocol-version']).toBe('2025-06-18')
  })

  it('notifications produce no output (202)', async () => {
    const { f } = fakeFetch(() => ({ status: 202 }))
    const out = await forward(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      deps(f),
    )
    expect(out).toBe('')
  })

  it('a notification that fails still produces no output', async () => {
    const out = await forward(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      deps(async () => {
        throw new Error('down')
      }),
    )
    expect(out).toBe('')
  })

  it('HTTP failures become a JSON-RPC error for the request id', async () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' })
    const expectErr = (out: string) =>
      expect(JSON.parse(out)).toEqual({
        jsonrpc: '2.0',
        id: 9,
        error: { code: -32603, message: 'agent-office is not reachable' },
      })
    expectErr(await forward(line, deps(fakeFetch(() => ({ status: 401 })).f)))
    expectErr(await forward(line, deps(fakeFetch(() => ({ status: 500, body: 'x' })).f)))
    expectErr(
      await forward(
        line,
        deps(async () => {
          throw new Error('ECONNREFUSED')
        }),
      ),
    )
    // A 200 that isn't JSON-RPC.
    expectErr(await forward(line, deps(fakeFetch(() => ({ status: 200, body: [1] })).f)))
    // Missing token or a non-loopback URL: the token is never sent anywhere.
    const { f, seen } = fakeFetch(() => ({ status: 200, body: {} }))
    expectErr(await forward(line, deps(f, { token: '' })))
    expectErr(await forward(line, deps(f, { url: 'https://evil.example/mcp' })))
    expect(seen).toEqual([])
  })

  it('passes a server JSON-RPC error through with the request id', async () => {
    const { f } = fakeFetch(() => ({
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } },
    }))
    const out = await forward(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'x' }), deps(f))
    expect(JSON.parse(out)).toEqual({
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32600, message: 'invalid request' },
    })
  })

  it('unparseable input gets a parse error; blank lines are ignored', async () => {
    const { f, seen } = fakeFetch(() => ({ status: 200 }))
    expect(JSON.parse(await forward('{nope', deps(f)))).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'parse error' },
    })
    expect(await forward('   ', deps(f))).toBe('')
    expect(seen).toEqual([])
  })
})

describe('loopbackUrl', () => {
  it('accepts only loopback http /mcp endpoints', () => {
    expect(loopbackUrl('http://127.0.0.1:4317/mcp')).toBe(true)
    expect(loopbackUrl('http://localhost:1/mcp')).toBe(false)
    expect(loopbackUrl('http://localhost:12/mcp')).toBe(true)
    expect(loopbackUrl('http://[::1]:4317/mcp')).toBe(true)
    expect(loopbackUrl('http://127.0.0.1.evil.example:4317/mcp')).toBe(false)
    expect(loopbackUrl('https://127.0.0.1:4317/mcp')).toBe(false)
    expect(loopbackUrl(undefined)).toBe(false)
  })
})

describe('runBridge (line framing)', () => {
  it('splits NDJSON across chunks and writes one line per response', async () => {
    const { f } = fakeFetch((b) => ({
      status: b.id === undefined ? 202 : 200,
      body: b.id === undefined ? undefined : { jsonrpc: '2.0', id: b.id, result: {} },
    }))
    const a = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    const n = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const b = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })
    async function* input() {
      yield `${a}\n${n.slice(0, 5)}`
      yield `${n.slice(5)}\r\n${b}` // last line without a newline
    }
    const out: string[] = []
    await runBridge(input(), (s: string) => out.push(s), deps(f))
    expect(out.map((l) => JSON.parse(l).id).sort()).toEqual([1, 2])
    expect(out.every((l) => l.endsWith('\n'))).toBe(true)
  })
})

// Process level: a real bridge child against a real HTTP server.
const servers: Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

function server(): Promise<{ url: string; bodies: string[] }> {
  const bodies: string[] = []
  const s = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      bodies.push(raw)
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end()
      const m = JSON.parse(raw)
      if (m.id === undefined) return res.writeHead(202).end()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { echoed: m.params ?? null } }))
    })
  })
  servers.push(s)
  return new Promise((resolve) =>
    s.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${(s.address() as { port: number }).port}/mcp`, bodies }),
    ),
  )
}

function runChild(env: Record<string, string>, input: string) {
  const child = spawn(process.execPath, [join(import.meta.dirname, 'agent-office-mcp.mjs')], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (c) => (out += c))
  child.stderr.on('data', (c) => (err += c))
  child.stdin.end(input)
  return new Promise<{ out: string; err: string; code: number | null }>((resolve) =>
    child.on('close', (code) => resolve({ out, err, code })),
  )
}

describe('the bridge process', () => {
  it('relays requests, stays silent for notifications, exits 0 when stdin closes', async () => {
    const srv = await server()
    const secret = 'super-secret-memory-body'
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { query: secret } },
    ]
      .map((m) => JSON.stringify(m))
      .join('\n')
    const r = await runChild(
      { AGENT_OFFICE_MCP_URL: srv.url, AGENT_OFFICE_MCP_TOKEN: TOKEN },
      `${input}\n`,
    )
    expect(r.code).toBe(0)
    const lines = r.out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines.map((l) => l.id).sort()).toEqual([1, 2])
    expect(srv.bodies).toHaveLength(3)
    // No-leak: nothing on stderr, in particular neither the token nor message content.
    expect(r.err).toBe('')
    expect(r.err).not.toContain(TOKEN)
    expect(r.err).not.toContain(secret)
  })

  it('answers requests with an error when the server is unreachable or the token is wrong', async () => {
    const srv = await server()
    const req = `${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping', params: { q: 'secret-q' } })}\n`
    for (const env of [
      { AGENT_OFFICE_MCP_URL: 'http://127.0.0.1:9/mcp', AGENT_OFFICE_MCP_TOKEN: TOKEN },
      { AGENT_OFFICE_MCP_URL: srv.url, AGENT_OFFICE_MCP_TOKEN: `mcp_${'d'.repeat(64)}` },
      { AGENT_OFFICE_MCP_URL: srv.url },
    ]) {
      const r = await runChild(env, req)
      expect(r.code).toBe(0)
      expect(JSON.parse(r.out)).toMatchObject({ id: 5, error: { code: -32603 } })
      expect(r.err).toBe('')
      expect(r.out).not.toContain(TOKEN)
      expect(r.out).not.toContain('secret-q')
    }
  })
})
