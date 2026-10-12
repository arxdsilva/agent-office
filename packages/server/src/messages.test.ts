import { describe, expect, it, vi } from 'vitest'
import { MessageStore } from './messages.ts'

let n = 0
const newStore = (max = 200) => new MessageStore({ max, now: () => 1000, id: () => `m${++n}` })

describe('MessageStore', () => {
  it('enqueues as queued and emits chat', () => {
    const s = newStore()
    const spy = vi.fn()
    s.on('chat', spy)
    const m = s.enqueue('a', 'hello')
    expect(m).toMatchObject({
      agentId: 'a',
      from: 'user',
      text: 'hello',
      state: 'queued',
      ts: 1000,
    })
    expect(spy).toHaveBeenCalledWith(m)
    expect(s.unread('a')).toBe(1)
  })

  it('claim moves queued → delivered exactly once', () => {
    const s = newStore()
    s.enqueue('a', 'one')
    s.enqueue('a', 'two')
    const first = s.claim('a')
    expect(first.map((m) => m.text)).toEqual(['one', 'two'])
    expect(first.every((m) => m.state === 'delivered')).toBe(true)
    expect(s.claim('a')).toEqual([])
    expect(s.unread('a')).toBe(0)
  })

  it('reply adds an agent message and marks the referenced message replied', () => {
    const s = newStore()
    const m = s.enqueue('a', 'q')
    s.claim('a')
    const r = s.reply('a', 'answer', m.id)
    expect(r).toMatchObject({ from: 'agent', text: 'answer', inReplyTo: m.id, state: 'replied' })
    expect(s.history('a').find((x) => x.id === m.id)?.state).toBe('replied')
  })

  it('reply without inReplyTo marks every delivered message replied', () => {
    const s = newStore()
    s.enqueue('a', 'q1')
    s.enqueue('a', 'q2')
    s.claim('a')
    expect(s.awaitingReply('a')).toHaveLength(2)
    s.reply('a', 'both answered')
    expect(s.awaitingReply('a')).toHaveLength(0)
  })

  it('caps history per agent', () => {
    const s = newStore(3)
    for (let i = 0; i < 5; i++) s.enqueue('a', `m${i}`)
    expect(s.history('a').map((m) => m.text)).toEqual(['m2', 'm3', 'm4'])
  })

  it('recent returns the last N messages of every agent', () => {
    const s = newStore()
    s.enqueue('a', 'a1')
    s.enqueue('a', 'a2')
    s.enqueue('b', 'b1')
    expect(s.recent(1).map((m) => m.text)).toEqual(['a2', 'b1'])
  })

  it('drop forgets an agent', () => {
    const s = newStore()
    s.enqueue('a', 'x')
    s.drop('a')
    expect(s.history('a')).toEqual([])
  })

  it('waitFor resolves on enqueue, or on timeout', async () => {
    const s = newStore()
    const woke = s.waitFor('a', 5_000)
    s.enqueue('a', 'ping')
    await expect(woke).resolves.toBe(true)
    await expect(s.waitFor('other', 10)).resolves.toBe(false)
  })

  it('waitFor resolves immediately when messages are already queued', async () => {
    const s = newStore()
    s.enqueue('a', 'x')
    await expect(s.waitFor('a', 5_000)).resolves.toBe(true)
  })

  it('waitFor resolves false when aborted', async () => {
    const s = newStore()
    const ac = new AbortController()
    const p = s.waitFor('a', 5_000, ac.signal)
    ac.abort()
    await expect(p).resolves.toBe(false)
  })
})
