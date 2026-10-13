import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { openSse, SseParser, type SseEvent, type SseState } from './sse.ts'

const parseAll = (chunks: string[], o?: { maxEventBytes?: number }) => {
  const p = new SseParser(o)
  const out: SseEvent[] = []
  for (const c of chunks) out.push(...p.feed(c))
  return { events: out, parser: p }
}

describe('SseParser', () => {
  const cases: { name: string; chunks: string[]; want: SseEvent[] }[] = [
    {
      name: 'one data line',
      chunks: ['data: hello\n\n'],
      want: [{ event: 'message', data: 'hello' }],
    },
    {
      name: 'multi-line data joined with \\n',
      chunks: ['data: a\ndata: b\n\n'],
      want: [{ event: 'message', data: 'a\nb' }],
    },
    {
      name: 'event type, id and CRLF line ends',
      chunks: ['event: ping\r\nid: 7\r\ndata: x\r\n\r\n'],
      want: [{ event: 'ping', data: 'x', id: '7' }],
    },
    {
      name: 'bare CR line ends, split CRLF across chunks',
      chunks: ['data: a\r', '\ndata: b\r\r'],
      want: [{ event: 'message', data: 'a\nb' }],
    },
    {
      name: 'comments and unknown fields are ignored',
      chunks: [': keep-alive\nfoo: bar\ndata: y\n\n'],
      want: [{ event: 'message', data: 'y' }],
    },
    {
      name: 'a field without a colon has an empty value',
      chunks: ['data\n\n'],
      want: [{ event: 'message', data: '' }],
    },
    {
      name: 'only one leading space is stripped',
      chunks: ['data:  two\n\n'],
      want: [{ event: 'message', data: ' two' }],
    },
    {
      name: 'split mid-line and mid-field across many chunks',
      chunks: ['da', 'ta: {"a"', ':1}', '\n', '\n'],
      want: [{ event: 'message', data: '{"a":1}' }],
    },
    {
      name: 'a blank line without data dispatches nothing and resets the type',
      chunks: ['event: x\n\ndata: z\n\n'],
      want: [{ event: 'message', data: 'z' }],
    },
    {
      name: 'the id persists to later events; an id with NUL is ignored',
      chunks: ['id: 1\ndata: a\n\ndata: b\n\nid: 2\u0000\ndata: c\n\n'],
      want: [
        { event: 'message', data: 'a', id: '1' },
        { event: 'message', data: 'b', id: '1' },
        { event: 'message', data: 'c', id: '1' },
      ],
    },
    {
      name: 'a leading BOM is stripped',
      chunks: ['﻿data: bom\n\n'],
      want: [{ event: 'message', data: 'bom' }],
    },
    {
      name: 'an unterminated event at the end is not dispatched',
      chunks: ['data: done\n\ndata: cut'],
      want: [{ event: 'message', data: 'done' }],
    },
  ]
  for (const c of cases)
    it(c.name, () => {
      expect(parseAll(c.chunks).events).toEqual(c.want)
    })

  it('reads retry (digits only) and remembers the last event id', () => {
    const { parser } = parseAll(['retry: 1500\nretry: x1\nid: abc\ndata: q\n\n'])
    expect(parser.retry).toBe(1500)
    expect(parser.lastEventId).toBe('abc')
  })

  it('drops an event over the cap (data lines) and keeps parsing after it', () => {
    const big = 'x'.repeat(200)
    const { events } = parseAll([`data: ${big}\ndata: ${big}\n\ndata: ok\n\n`], {
      maxEventBytes: 300,
    })
    expect(events).toEqual([{ event: 'message', data: 'ok' }])
  })

  it('drops an event whose single unterminated line grows past the cap', () => {
    const p = new SseParser({ maxEventBytes: 100 })
    const out: SseEvent[] = []
    for (let i = 0; i < 10; i++) out.push(...p.feed('data: ' + 'y'.repeat(50)))
    out.push(...p.feed('\n\ndata: after\n\n'))
    expect(out).toEqual([{ event: 'message', data: 'after' }])
  })

  it('has a 1 MB default cap', () => {
    const { events } = parseAll([`data: ${'z'.repeat(1024 * 1024 + 10)}\n\ndata: s\n\n`])
    expect(events).toEqual([{ event: 'message', data: 's' }])
  })
})

describe('openSse', () => {
  let servers: { close(): void }[] = []
  afterEach(() => {
    for (const s of servers) s.close()
    servers = []
  })

  async function serve(handler: (req: IncomingMessage, res: ServerResponse, n: number) => void) {
    let n = 0
    const srv = createServer((req, res) => handler(req, res, n++))
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    servers.push({
      close: () => {
        srv.closeAllConnections()
        srv.close()
      },
    })
    return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
  }

  const until = async (fn: () => boolean, ms = 3000) => {
    const end = Date.now() + ms
    while (!fn()) {
      if (Date.now() > end) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  it('streams events, reconnects with Last-Event-ID and stops on close', async () => {
    const seen: (string | undefined)[] = []
    const url = await serve((req, res, n) => {
      seen.push(req.headers['last-event-id'] as string | undefined)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`retry: 5\nid: ${n + 1}\ndata: e${n}\n\n`)
    })
    const got: string[] = []
    const states: SseState[] = []
    const s = openSse({
      url: `${url}/ev`,
      headers: { authorization: 'Basic x' },
      onEvent: (e) => void got.push(e.data),
      onState: (st) => states.push(st),
      backoff: { initialMs: 5, maxMs: 20 },
    })
    await until(() => got.length >= 3)
    s.close()
    expect(got.slice(0, 3)).toEqual(['e0', 'e1', 'e2'])
    expect(seen.slice(0, 3)).toEqual([undefined, '1', '2'])
    expect(s.lastEventId).toBeDefined()
    expect(states).toContain('open')
    expect(states.at(-1)).toBe('closed')
  })

  it('reports auth on 401 and keeps retrying with backoff', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(401)
      res.end()
    })
    const states: SseState[] = []
    const s = openSse({
      url,
      onEvent: () => {},
      onState: (st) => states.push(st),
      backoff: { initialMs: 5, maxMs: 10 },
    })
    await until(() => states.filter((x) => x === 'auth').length >= 2)
    s.close()
  })

  it('reports error when the server is unreachable or not an event stream', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    const states: SseState[] = []
    const s = openSse({
      url,
      onEvent: () => {},
      onState: (st) => states.push(st),
      backoff: { initialMs: 5, maxMs: 10 },
    })
    await until(() => states.includes('error'))
    s.close()

    const dead: SseState[] = []
    const d = openSse({
      url: 'http://127.0.0.1:1/none',
      onEvent: () => {},
      onState: (st) => dead.push(st),
      backoff: { initialMs: 5, maxMs: 10 },
    })
    await until(() => dead.includes('error'))
    d.close()
  })

  it('stops reconnecting on 204 (server says no more)', async () => {
    let hits = 0
    const url = await serve((_req, res) => {
      hits++
      res.writeHead(204)
      res.end()
    })
    const states: SseState[] = []
    openSse({
      url,
      onEvent: () => {},
      onState: (st) => states.push(st),
      backoff: { initialMs: 5, maxMs: 10 },
    })
    await until(() => states.includes('closed'))
    await new Promise((r) => setTimeout(r, 50))
    expect(hits).toBe(1)
  })

  it('waits for an async handler before reading on (backpressure)', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: 1\n\ndata: 2\n\n')
    })
    const order: string[] = []
    const s = openSse({
      url,
      onEvent: async (e) => {
        order.push(`start ${e.data}`)
        await new Promise((r) => setTimeout(r, 20))
        order.push(`end ${e.data}`)
      },
    })
    await until(() => order.length >= 4)
    s.close()
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2'])
  })

  it('refuses a non-loopback URL', () => {
    expect(() => openSse({ url: 'http://example.com/ev', onEvent: () => {} })).toThrow(/loopback/)
  })
})
