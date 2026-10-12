import type { Agent, ChatMessage } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { noteForAgentChange, noteForMessage, THROTTLE_MS } from './attention.ts'

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'a', name: 'Ada', provider: 'p', topic: 'Refactor auth', status: 'thinking', source: 's',
  since: 0, lastSeen: 0, interactive: true, unread: 0, ...over,
})
const ctx = (over = {}) => ({ focused: false, enabled: true, now: 100_000, lastSentAt: new Map<string, number>(), ...over })

describe('noteForAgentChange', () => {
  it('notifies when a busy agent starts waiting', () => {
    expect(noteForAgentChange(agent({ status: 'tool' }), agent({ status: 'waiting' }), ctx())).toEqual({
      kind: 'waiting', agentId: 'a', title: 'Ada is waiting for you', body: 'Refactor auth',
    })
  })

  it('notifies on entering error', () => {
    expect(noteForAgentChange(agent(), agent({ status: 'error', text: 'boom' }), ctx())).toMatchObject({
      kind: 'error', title: 'Ada hit an error', body: 'boom',
    })
  })

  it('stays quiet for other transitions, new agents, focus, disabled, or throttle', () => {
    expect(noteForAgentChange(agent({ status: 'idle' }), agent({ status: 'waiting' }), ctx())).toBeNull()
    expect(noteForAgentChange(undefined, agent({ status: 'waiting' }), ctx())).toBeNull()
    expect(noteForAgentChange(agent(), agent({ status: 'waiting' }), ctx({ focused: true }))).toBeNull()
    expect(noteForAgentChange(agent(), agent({ status: 'waiting' }), ctx({ enabled: false }))).toBeNull()
    const recent = new Map([['a', 100_000 - THROTTLE_MS + 1]])
    expect(noteForAgentChange(agent(), agent({ status: 'waiting' }), ctx({ lastSentAt: recent }))).toBeNull()
    const old = new Map([['a', 100_000 - THROTTLE_MS]])
    expect(noteForAgentChange(agent(), agent({ status: 'waiting' }), ctx({ lastSentAt: old }))).not.toBeNull()
  })
})

describe('noteForMessage', () => {
  const reply: ChatMessage = { id: 'r', agentId: 'a', from: 'agent', text: 'x'.repeat(300), ts: 1, state: 'replied' }

  it('notifies on agent replies with a truncated body', () => {
    const n = noteForMessage(reply, agent(), ctx())!
    expect(n).toMatchObject({ kind: 'reply', title: 'Ada replied' })
    expect(n.body.length).toBeLessThanOrEqual(120)
  })

  it('ignores user messages, unknown agents, and focus', () => {
    expect(noteForMessage({ ...reply, from: 'user' }, agent(), ctx())).toBeNull()
    expect(noteForMessage(reply, undefined, ctx())).toBeNull()
    expect(noteForMessage(reply, agent(), ctx({ focused: true }))).toBeNull()
  })
})
