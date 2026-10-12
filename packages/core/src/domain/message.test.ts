import { describe, expect, it } from 'vitest'
import { DomainError } from './errors.ts'
import { deliver, isAwaitingReply, markReplied, newReply, newUserMessage } from './message.ts'

describe('message state machine', () => {
  it('queued → delivered → replied', () => {
    const m = newUserMessage('m1', 'a', 'hi', 10)
    expect(m).toEqual({ id: 'm1', agentId: 'a', from: 'user', text: 'hi', ts: 10, state: 'queued' })
    const d = deliver(m)
    expect(d.state).toBe('delivered')
    expect(isAwaitingReply(d)).toBe(true)
    expect(markReplied(d).state).toBe('replied')
    expect(m.state).toBe('queued') // immutable
  })

  it('rejects invalid transitions', () => {
    const m = newUserMessage('m1', 'a', 'hi', 10)
    expect(() => markReplied(m)).toThrow(DomainError)
    expect(() => deliver(deliver(m))).toThrow(DomainError)
  })

  it('creates agent replies, optionally linked to a message', () => {
    expect(newReply('r1', 'a', 'ok', 20, 'm1')).toEqual({
      id: 'r1',
      agentId: 'a',
      from: 'agent',
      text: 'ok',
      ts: 20,
      state: 'replied',
      inReplyTo: 'm1',
    })
    expect(newReply('r2', 'a', 'ok', 20)).not.toHaveProperty('inReplyTo')
    expect(isAwaitingReply(newReply('r3', 'a', 'x', 1))).toBe(false)
  })
})
