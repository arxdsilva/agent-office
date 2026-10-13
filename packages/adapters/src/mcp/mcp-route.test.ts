import { afterEach, describe, expect, it } from 'vitest'
import { fakeMcpAccess, GOOD_TOKEN, PREFACE } from '../../test/fakes/fake-mcp-access.ts'
import { makeOffice } from '../../test/support.ts'
import { createAuth } from '../http/auth.ts'
import { buildHttpApi } from '../http/http-api.ts'
import { MCP_BODY_LIMIT, MCP_PROTOCOL_VERSIONS } from './mcp-route.ts'

const API_TOKEN = 'a'.repeat(64)
const HOST = 'localhost:4317'
const headers = {
  host: HOST,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: `Bearer ${GOOD_TOKEN}`,
}

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

function setup(opts: { mcp?: boolean } = {}) {
  const { office, scheduler } = makeOffice()
  const access = fakeMcpAccess()
  const app = buildHttpApi(
    {
      activity: office.activity,
      inbox: office.inbox,
      chat: office.chat,
      query: office.query,
      ...(opts.mcp === false ? {} : { mcp: access }),
    },
    createAuth({ token: API_TOKEN, port: 4317 }),
  )
  cleanups.push(
    () => app.close(),
    () => scheduler.dispose(),
  )
  const rpc = (body: unknown, h: Record<string, string> = headers) =>
    app.inject({ method: 'POST', url: '/mcp', headers: h, payload: JSON.stringify(body) })
  return { app, access, rpc }
}

const req = (method: string, params?: unknown, id: number | string = 1) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params === undefined ? {} : { params }),
})

describe('POST /mcp: auth', () => {
  it('does not exist without the mcp port', async () => {
    const { rpc } = setup({ mcp: false })
    expect((await rpc(req('ping'))).statusCode).toBe(404)
  })

  it('401 with an empty body for a missing, unknown, non-mcp or revoked token', async () => {
    const { rpc, access } = setup()
    const { authorization: _a, ...noAuth } = headers
    const cases = [
      noAuth,
      { ...headers, authorization: `Bearer mcp_${'b'.repeat(64)}` },
      // The API token is a different secret: it never opens /mcp.
      { ...headers, authorization: `Bearer ${API_TOKEN}` },
      { ...headers, authorization: GOOD_TOKEN },
    ]
    for (const h of cases) {
      const res = await rpc(req('ping'), h)
      expect(res.statusCode).toBe(401)
      expect(res.body).toBe('')
    }
    access.revoke()
    const res = await rpc(req('ping'))
    expect(res.statusCode).toBe(401)
    expect(res.body).toBe('')
    expect(access.calls).toEqual([])
  })

  it('401 comes before the body is parsed (no parse error leaks for anonymous callers)', async () => {
    const { app } = setup()
    const { authorization: _a, ...noAuth } = headers
    const res = await app.inject({ method: 'POST', url: '/mcp', headers: noAuth, payload: '{oops' })
    expect(res.statusCode).toBe(401)
    expect(res.body).toBe('')
  })

  it('keeps the Host (421) and Origin (403) guards', async () => {
    const { rpc } = setup()
    expect((await rpc(req('ping'), { ...headers, host: 'evil.example:4317' })).statusCode).toBe(421)
    expect(
      (await rpc(req('ping'), { ...headers, origin: 'https://evil.example' })).statusCode,
    ).toBe(403)
  })
})

describe('POST /mcp: lifecycle', () => {
  it('initialize echoes a supported protocol version and declares tools only', async () => {
    const { rpc } = setup()
    const res = await rpc(
      req('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      }),
    )
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-office', version: '1' },
      },
    })
  })

  it('initialize answers its latest version for an unknown one', async () => {
    const { rpc } = setup()
    const res = await rpc(req('initialize', { protocolVersion: '1999-01-01' }))
    expect(res.json().result.protocolVersion).toBe(MCP_PROTOCOL_VERSIONS[0])
  })

  it('notifications and client responses get 202 with no body', async () => {
    const { rpc } = setup()
    for (const m of [
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
      { jsonrpc: '2.0', id: 7, result: {} },
    ]) {
      const res = await rpc(m)
      expect(res.statusCode).toBe(202)
      expect(res.body).toBe('')
    }
  })

  it('ping returns an empty result; string ids are echoed', async () => {
    const { rpc } = setup()
    expect((await rpc(req('ping', undefined, 'abc'))).json()).toEqual({
      jsonrpc: '2.0',
      id: 'abc',
      result: {},
    })
  })

  it('GET and DELETE are 405 (no SSE stream, no sessions)', async () => {
    const { app } = setup()
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/mcp', headers })
      expect(res.statusCode).toBe(405)
      expect(res.headers.allow).toBe('POST')
    }
  })

  it('400 for an unsupported MCP-Protocol-Version header', async () => {
    const { rpc } = setup()
    const res = await rpc(req('ping'), { ...headers, 'mcp-protocol-version': '1999-01-01' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe(-32600)
    expect(
      (await rpc(req('ping'), { ...headers, 'mcp-protocol-version': '2025-06-18' })).statusCode,
    ).toBe(200)
  })
})

describe('POST /mcp: tools', () => {
  it('tools/list returns the principal’s tools', async () => {
    const { rpc } = setup()
    const res = await rpc(req('tools/list', {}))
    const tools = res.json().result.tools as { name: string; inputSchema: unknown }[]
    expect(tools.map((t) => t.name)).toContain('search_memory')
    expect(tools[0]).toMatchObject({ name: 'search_memory', inputSchema: { type: 'object' } })
  })

  it('tools/call returns text + structured content and passes the principal', async () => {
    const { rpc, access } = setup()
    const res = await rpc(
      req('tools/call', { name: 'search_memory', arguments: { query: 'pnpm' } }),
    )
    expect(res.json().result).toEqual({
      content: [{ type: 'text', text: `${PREFACE}\n- Use pnpm, not npm` }],
      structuredContent: {
        items: [{ id: 'mem_1', title: 'Use pnpm, not npm', version: 1, kind: 'fact' }],
      },
    })
    expect(access.calls[0]).toMatchObject({
      tool: 'search_memory',
      args: { query: 'pnpm' },
      principal: { projectId: 'pr_1', sessionId: 'ms_1' },
    })
  })

  it('tools/call without arguments passes an empty object', async () => {
    const { rpc, access } = setup()
    await rpc(req('tools/call', { name: 'search_memory' }))
    expect(access.calls[0]!.args).toEqual({})
  })

  it('-32602 for an unknown tool or bad params; the port is not called', async () => {
    const { rpc, access } = setup()
    for (const params of [
      { name: 'drop_tables' },
      {},
      { name: 'search_memory', arguments: 'x' },
      { name: 'search_memory', arguments: [1] },
      undefined,
    ]) {
      const res = await rpc(req('tools/call', params))
      expect(res.statusCode).toBe(200)
      expect(res.json().error.code).toBe(-32602)
    }
    expect(access.calls).toEqual([])
  })

  it('maps port failures without leaking internal detail', async () => {
    const { rpc } = setup()
    const call = async (name: string) => (await rpc(req('tools/call', { name }))).json()
    const boom = await call('boom')
    expect(boom.error).toEqual({ code: -32603, message: 'internal error' })
    expect(JSON.stringify(boom)).not.toContain('/Users')
    expect((await call('invalid')).error).toEqual({ code: -32602, message: 'query is required' })
    const limited = await call('limited')
    expect(limited.result.isError).toBe(true)
    expect(limited.result.content[0].text).toMatch(/rate limit/i)
    const denied = await call('denied')
    expect(denied.result).toEqual({
      content: [{ type: 'text', text: 'Not allowed for this session.' }],
      isError: true,
    })
  })

  it('passes isError from the port through', async () => {
    const { office, scheduler } = makeOffice()
    const access = fakeMcpAccess()
    access.call = async () => ({ structured: {}, text: 'nope', isError: true })
    const app = buildHttpApi(
      { ...office, mcp: access },
      createAuth({ token: API_TOKEN, port: 4317 }),
    )
    cleanups.push(
      () => app.close(),
      () => scheduler.dispose(),
    )
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers,
      payload: JSON.stringify(req('tools/call', { name: 'search_memory' })),
    })
    expect(res.json().result).toEqual({
      content: [{ type: 'text', text: 'nope' }],
      structuredContent: {},
      isError: true,
    })
  })
})

describe('POST /mcp: JSON-RPC errors and limits', () => {
  it('-32601 for an unknown method', async () => {
    const { rpc } = setup()
    expect((await rpc(req('resources/list'))).json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'method not found' },
    })
  })

  it('-32600 (HTTP 400) for invalid requests and batches', async () => {
    const { rpc } = setup()
    for (const body of [
      { id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 1, method: 5 },
      { jsonrpc: '2.0', id: { x: 1 }, method: 'ping' },
      [req('ping')],
      'hello',
      null,
    ]) {
      const res = await rpc(body)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'invalid request' },
      })
    }
  })

  it('-32700 (HTTP 400) for malformed JSON from an authorized caller', async () => {
    const { app } = setup()
    const res = await app.inject({ method: 'POST', url: '/mcp', headers, payload: '{oops' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'parse error' },
    })
  })

  it('413 above 64 KB', async () => {
    const { rpc } = setup()
    expect(MCP_BODY_LIMIT).toBe(64 * 1024)
    const big = req('tools/call', {
      name: 'search_memory',
      arguments: { query: 'x'.repeat(MCP_BODY_LIMIT) },
    })
    const res = await rpc(big)
    expect(res.statusCode).toBe(413)
    expect(res.json().error.code).toBe(-32600)
  })

  it('415 for a non-JSON content type; plain text is just an invalid request', async () => {
    const { app } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...headers, 'content-type': 'application/xml' },
      payload: '<ping/>',
    })
    expect(res.statusCode).toBe(415)
    const text = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...headers, 'content-type': 'text/plain' },
      payload: 'ping',
    })
    expect(text.statusCode).toBe(400)
  })
})
