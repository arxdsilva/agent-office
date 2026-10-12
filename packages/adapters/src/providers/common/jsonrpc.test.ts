import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { JsonRpcPeer, PeerClosedError, RpcError, RpcTimeoutError } from './jsonrpc.ts'

/** A peer wired to in-memory streams: `toPeer` is what the remote writes, `sent()` what we wrote. */
function wire(dialect: 'jsonrpc2' | 'codex' = 'codex', timeoutMs?: number) {
  const toPeer = new PassThrough()
  const fromPeer = new PassThrough()
  const lines: string[] = []
  let buf = ''
  fromPeer.on('data', (c: Buffer) => {
    buf += c.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
  })
  const peer = new JsonRpcPeer(toPeer, fromPeer, {
    dialect,
    ...(timeoutMs ? { timeoutMs } : {}),
  })
  const sent = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>)
  const send = (m: unknown) => toPeer.write(JSON.stringify(m) + '\n')
  return { peer, toPeer, sent, send }
}

const flush = () => new Promise((r) => setImmediate(r))

describe('JsonRpcPeer', () => {
  // RPC-1: responses are matched to requests by id, whatever order they arrive in.
  it('correlates responses by id', async () => {
    const { peer, sent, send } = wire()
    const a = peer.request('a', { x: 1 })
    const b = peer.request('b', {})
    await flush()
    const [ra, rb] = sent()
    send({ id: rb!.id, result: 'B' })
    send({ id: ra!.id, result: 'A' })
    await expect(a).resolves.toBe('A')
    await expect(b).resolves.toBe('B')
    expect(ra).toMatchObject({ method: 'a', params: { x: 1 } })
  })

  // RPC-2: Codex speaks JSON-RPC without the "jsonrpc" field; jsonrpc2 peers include it.
  it('omits "jsonrpc" in the codex dialect and includes it in jsonrpc2', async () => {
    const c = wire('codex')
    void c.peer.request('m', {}).catch(() => {})
    c.peer.notify('n', { y: 2 })
    const j = wire('jsonrpc2')
    void j.peer.request('m', {}).catch(() => {})
    await flush()
    expect(c.sent()[0]).not.toHaveProperty('jsonrpc')
    expect(c.sent()[1]).toEqual({ method: 'n', params: { y: 2 } })
    expect(j.sent()[0]).toMatchObject({ jsonrpc: '2.0', method: 'm' })
    c.send({ id: c.sent()[0]!.id, result: 1 }) // accepted without the field
    j.send({ jsonrpc: '2.0', id: j.sent()[0]!.id, result: 1 })
  })

  // RPC-3: a message split across chunks (and CRLF endings) is reassembled.
  it('reassembles partial frames over several chunks', async () => {
    const { peer, toPeer } = wire()
    const got: unknown[] = []
    peer.onNotification('evt', (p) => got.push(p))
    toPeer.write('{"method":"evt","par')
    toPeer.write('ams":{"n":1}}\r\n{"method":"evt",')
    toPeer.write('"params":{"n":2}}\n\n')
    await flush()
    expect(got).toEqual([{ n: 1 }, { n: 2 }])
  })

  // RPC-4: garbage lines are counted and skipped; the session keeps going.
  it('skips malformed lines and counts them', async () => {
    const { peer, toPeer } = wire()
    const got: unknown[] = []
    peer.onNotification('*', (p, m) => got.push(m))
    toPeer.write('not json\n[1,2]\n{"neither":"request nor response"}\n{"method":"ok"}\n')
    await flush()
    expect(got).toEqual(['ok'])
    expect(peer.stats.malformed).toBe(3)
  })

  // RPC-5: a line over 1 MB is dropped (counted, never buffered forever); the next line works.
  it('drops oversized lines', async () => {
    const { peer, toPeer } = wire()
    const got: unknown[] = []
    peer.onNotification('ok', () => got.push(1))
    const big = '{"method":"ok","params":"' + 'x'.repeat(600_000)
    toPeer.write(big)
    toPeer.write(big + '"}\n{"method":"ok"}\n')
    await flush()
    expect(got).toEqual([1])
    expect(peer.stats.oversized).toBe(1)
  })

  // RPC-6: a call without an answer rejects after its timeout (per-call or the peer default).
  it('times out unanswered requests', async () => {
    const { peer } = wire('codex', 30)
    await expect(peer.request('slow', {})).rejects.toBeInstanceOf(RpcTimeoutError)
    await expect(peer.request('slower', {}, { timeoutMs: 10 })).rejects.toBeInstanceOf(
      RpcTimeoutError,
    )
  })

  // RPC-6b: an error response rejects with its code.
  it('rejects with the remote error', async () => {
    const { peer, sent, send } = wire()
    const p = peer.request('bad', {})
    await flush()
    send({ id: sent()[0]!.id, error: { code: -32600, message: 'Invalid' } })
    await expect(p).rejects.toMatchObject({ code: -32600 })
    await expect(p).rejects.toBeInstanceOf(RpcError)
  })

  // RPC-7: server→client requests reach handlers; unknown methods get -32601 so nobody hangs.
  it('answers server requests and rejects unknown ones', async () => {
    const { peer, sent, send } = wire()
    peer.onRequest('approve', async (p) => ({
      decision: (p as { ok: boolean }).ok ? 'accept' : 'decline',
    }))
    peer.onRequest('boom', () => {
      throw new Error('secret /Users/x')
    })
    peer.onRequest('typed', () => {
      throw new RpcError(-32000, 'nope')
    })
    send({ id: 7, method: 'approve', params: { ok: true } })
    send({ id: 'eight', method: 'item/tool/requestUserInput', params: {} })
    send({ id: 9, method: 'boom' })
    send({ id: 10, method: 'typed' })
    await flush()
    await flush()
    const replies = sent()
    expect(replies).toContainEqual({ id: 7, result: { decision: 'accept' } })
    expect(replies).toContainEqual({
      id: 'eight',
      error: { code: -32601, message: 'Method not found' },
    })
    expect(replies).toContainEqual({ id: 9, error: { code: -32603, message: 'Internal error' } })
    expect(replies).toContainEqual({ id: 10, error: { code: -32000, message: 'nope' } })
    expect(JSON.stringify(replies)).not.toContain('/Users/x')
  })

  // RPC-8: close() rejects every pending call; later calls fail fast; writes stop.
  it('close rejects pending requests', async () => {
    const { peer, sent } = wire()
    const p = peer.request('x', {})
    let closed = 0
    peer.onClose(() => closed++)
    peer.close()
    peer.close()
    await expect(p).rejects.toBeInstanceOf(PeerClosedError)
    await expect(peer.request('y', {})).rejects.toBeInstanceOf(PeerClosedError)
    peer.notify('z', {})
    await flush()
    expect(sent().map((m) => m.method)).toEqual(['x'])
    expect(closed).toBe(1)
    expect(peer.closed).toBe(true)
  })

  // RPC-9: the remote dying mid-call (stream ends) rejects the call instead of hanging.
  it('rejects pending calls when the stream ends', async () => {
    const { peer, toPeer } = wire()
    const p = peer.request('x', {})
    toPeer.end('{"method":"last"}')
    await expect(p).rejects.toBeInstanceOf(PeerClosedError)
  })

  // RPC-10: notifications are delivered in arrival order, interleaved with responses.
  it('keeps notification order', async () => {
    const { peer, toPeer, sent } = wire()
    const order: string[] = []
    peer.onNotification('*', (_p, m) => order.push(m))
    peer.onNotification('b', () => order.push('b-specific'))
    const r = peer.request('call', {}).then(() => order.push('response'))
    await flush()
    const id = sent()[0]!.id
    toPeer.write(
      `{"method":"a"}\n{"method":"b"}\n{"id":${JSON.stringify(id)},"result":null}\n{"method":"c"}\n`,
    )
    await r
    expect(order).toEqual(['a', 'b-specific', 'b', 'c', 'response'])
  })

  it('works with a plain event source and sink (no Node streams)', () => {
    const listeners: Record<string, ((x?: unknown) => void)[]> = {}
    const src = {
      on: (ev: string, fn: (x?: unknown) => void) => void (listeners[ev] ??= []).push(fn),
    }
    const written: string[] = []
    const peer = new JsonRpcPeer(
      src,
      { write: (s: string) => void written.push(s) },
      {
        dialect: 'jsonrpc2',
      },
    )
    const got: unknown[] = []
    peer.onNotification('n', (p) => got.push(p))
    listeners.data!.forEach((f) => f('{"jsonrpc":"2.0","method":"n","params":1}\n'))
    expect(got).toEqual([1]) // delivered synchronously
    listeners.close!.forEach((f) => f())
    expect(peer.closed).toBe(true)
  })
})
