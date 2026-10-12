import type { Agent, ChatMessage, ServerMessage } from '@agent-office/shared'
import { describe, expect, it, vi } from 'vitest'
import { applyMessage, backoff, connect, emptyState } from './socket.ts'

const agent = (id: string): Agent => ({
  id,
  name: id,
  provider: 'p',
  topic: 't',
  status: 'idle',
  source: 's',
  since: 1,
  lastSeen: 1,
  interactive: false,
  unread: 0,
})
const msg = (id: string, agentId = 'a', state: ChatMessage['state'] = 'queued'): ChatMessage => ({
  id,
  agentId,
  from: 'user',
  text: id,
  ts: 1,
  state,
})

describe('applyMessage', () => {
  it('replaces everything on snapshot, grouping messages by agent', () => {
    const s = applyMessage(emptyState(), {
      type: 'snapshot',
      agents: [agent('a'), agent('b')],
      messages: [msg('m1', 'a'), msg('m2', 'b')],
    })
    expect([...s.agents.keys()]).toEqual(['a', 'b'])
    expect(s.messages.get('a')!.map((m) => m.id)).toEqual(['m1'])
  })

  it('upserts and removes agents (and their messages)', () => {
    let s = applyMessage(emptyState(), { type: 'upsert', agent: agent('a') })
    s = applyMessage(s, { type: 'chat', message: msg('m1') })
    s = applyMessage(s, { type: 'upsert', agent: { ...agent('a'), status: 'tool' } })
    expect(s.agents.get('a')!.status).toBe('tool')
    s = applyMessage(s, { type: 'remove', id: 'a' })
    expect(s.agents.size).toBe(0)
    expect(s.messages.has('a')).toBe(false)
  })

  it('appends new chat messages and updates existing ones in place', () => {
    let s = applyMessage(emptyState(), { type: 'chat', message: msg('m1') })
    s = applyMessage(s, { type: 'chat', message: msg('m2') })
    s = applyMessage(s, { type: 'chat', message: msg('m1', 'a', 'replied') })
    expect(s.messages.get('a')!.map((m) => [m.id, m.state])).toEqual([
      ['m1', 'replied'],
      ['m2', 'queued'],
    ])
  })
})

describe('backoff', () => {
  it('doubles from 500ms and caps at 10s', () => {
    expect([0, 1, 2, 5, 10].map(backoff)).toEqual([500, 1000, 2000, 10_000, 10_000])
  })
})

class FakeWs {
  static last: FakeWs
  onopen?: () => void
  onmessage?: (e: { data: string }) => void
  onclose?: () => void
  closed = false
  constructor(public url: string) {
    FakeWs.last = this
  }
  close() {
    this.closed = true
  }
}

describe('connect', () => {
  it('reports status, forwards parsed messages, ignores garbage and reconnects with backoff', () => {
    const onMessage = vi.fn()
    const onStatus = vi.fn()
    const timers: [() => void, number][] = []
    const conn = connect({
      url: 'ws://x/ws?token=t',
      WebSocketImpl: FakeWs as unknown as typeof WebSocket,
      onMessage,
      onStatus,
      schedule: (fn, ms) => timers.push([fn, ms]),
    })
    const first = FakeWs.last
    expect(first.url).toBe('ws://x/ws?token=t')
    first.onopen!()
    expect(onStatus).toHaveBeenLastCalledWith('open')
    const m: ServerMessage = { type: 'remove', id: 'a' }
    first.onmessage!({ data: JSON.stringify(m) })
    first.onmessage!({ data: '{bad' })
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(onMessage).toHaveBeenCalledWith(m)

    first.onclose!()
    expect(onStatus).toHaveBeenLastCalledWith('reconnecting')
    expect(timers[0]![1]).toBe(500)
    timers[0]![0]()
    expect(FakeWs.last).not.toBe(first)

    conn.close()
    expect(FakeWs.last.closed).toBe(true)
    FakeWs.last.onclose!()
    expect(timers).toHaveLength(1) // no reconnect after an explicit close
  })
})
