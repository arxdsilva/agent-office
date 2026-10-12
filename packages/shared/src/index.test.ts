import { describe, expect, it } from 'vitest'
import {
  AgentEventBatchSchema,
  AgentEventSchema,
  AgentReplySchema,
  ChatMessageSchema,
} from './index.ts'

describe('AgentEventSchema', () => {
  it('accepts the minimal payload {agentId} (compatibility guard)', () => {
    expect(AgentEventSchema.safeParse({ agentId: 'a' }).success).toBe(true)
  })

  it('accepts provider, topic, model and kind', () => {
    const r = AgentEventSchema.safeParse({
      agentId: 'a',
      provider: 'langgraph',
      topic: 'Support triage',
      model: 'gpt-x',
      kind: 'researcher',
    })
    expect(r.success).toBe(true)
  })

  it('rejects an unknown status and oversized text', () => {
    expect(AgentEventSchema.safeParse({ agentId: 'a', status: 'sleeping' }).success).toBe(false)
    expect(AgentEventSchema.safeParse({ agentId: 'a', text: 'x'.repeat(501) }).success).toBe(false)
  })

  it('ignores unknown fields so newer producers keep working', () => {
    const r = AgentEventSchema.safeParse({ agentId: 'a', futureField: 1 })
    expect(r.success).toBe(true)
  })
})

describe('AgentEventBatchSchema', () => {
  it('accepts a single event or an array', () => {
    expect(AgentEventBatchSchema.safeParse({ agentId: 'a' }).success).toBe(true)
    expect(AgentEventBatchSchema.safeParse([{ agentId: 'a' }, { agentId: 'b' }]).success).toBe(true)
  })

  it('rejects batches over 500 events', () => {
    const big = Array.from({ length: 501 }, (_, i) => ({ agentId: `a${i}` }))
    expect(AgentEventBatchSchema.safeParse(big).success).toBe(false)
  })
})

describe('ChatMessageSchema / AgentReplySchema', () => {
  it('requires 1..4000 chars of text', () => {
    expect(ChatMessageSchema.safeParse({ text: '' }).success).toBe(false)
    expect(ChatMessageSchema.safeParse({ text: 'hi' }).success).toBe(true)
    expect(ChatMessageSchema.safeParse({ text: 'x'.repeat(4001) }).success).toBe(false)
  })

  it('reply accepts an optional inReplyTo', () => {
    expect(AgentReplySchema.safeParse({ text: 'ok', inReplyTo: 'm1' }).success).toBe(true)
  })
})
