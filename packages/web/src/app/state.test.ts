import type { Agent, ChatMessage } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { applyMessage, emptyState } from './state.ts'

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
