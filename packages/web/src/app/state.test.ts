import type { Agent, Capability, ChatMessage, ServerMessage } from '@agent-office/shared'
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

  it('keeps capabilities per provider from capabilities messages and snapshots', () => {
    const cap = (id: string, provider = 'p'): Capability => ({
      id,
      provider,
      category: 'adapter',
      kind: 'filesystem',
      label: id,
      sees: [],
      tools: [],
      declared: true,
      calls: 0,
      active: [],
    })
    expect(emptyState().capabilities.size).toBe(0)
    let s = applyMessage(emptyState(), {
      type: 'capabilities',
      provider: 'p',
      capabilities: [cap('fs')],
    })
    s = applyMessage(s, { type: 'capabilities', provider: 'q', capabilities: [cap('web', 'q')] })
    expect([...s.capabilities.keys()]).toEqual(['p', 'q'])
    // A newer list for a provider replaces the old one; an empty list drops the provider.
    s = applyMessage(s, {
      type: 'capabilities',
      provider: 'p',
      capabilities: [cap('fs'), cap('shell')],
    })
    expect(s.capabilities.get('p')!.map((c) => c.id)).toEqual(['fs', 'shell'])
    s = applyMessage(s, { type: 'capabilities', provider: 'q', capabilities: [] })
    expect(s.capabilities.has('q')).toBe(false)
    // Agent updates keep capabilities.
    s = applyMessage(s, { type: 'upsert', agent: agent('a') })
    s = applyMessage(s, { type: 'remove', id: 'a' })
    expect(s.capabilities.get('p')).toHaveLength(2)
    // A snapshot with capabilities replaces them, grouped by provider.
    const snap = applyMessage(s, {
      type: 'snapshot',
      agents: [],
      messages: [],
      capabilities: [cap('web', 'x'), cap('fs', 'y'), cap('shell', 'x')],
    })
    expect(snap.capabilities.get('x')!.map((c) => c.id)).toEqual(['web', 'shell'])
    expect(snap.capabilities.has('p')).toBe(false)
    // A snapshot without them (older backend) keeps the current ones.
    expect(applyMessage(s, { type: 'snapshot', agents: [], messages: [] }).capabilities).toBe(
      s.capabilities,
    )
  })

  it('ignores unknown message types', () => {
    const s = emptyState()
    expect(applyMessage(s, { type: 'future-thing' } as unknown as ServerMessage)).toBe(s)
  })
})
