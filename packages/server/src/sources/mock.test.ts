import { describe, expect, it } from 'vitest'
import { MessageStore } from '../messages.ts'
import { AgentStore } from '../store.ts'
import { MockSource } from './mock.ts'

const opts = { idleAfterMs: 1e12, expireAfterMs: 1e12, doneTtlMs: 1e12, interactiveTtlMs: 1e12 }

function setup() {
  const store = new AgentStore(opts)
  const messages = new MessageStore()
  let r = 0
  const random = () => ((r = (r + 0.37) % 1), r)
  const mock = new MockSource({ store, messages, random, replyDelayMs: 1 })
  return { store, messages, mock }
}

describe('MockSource', () => {
  it('seeds agents across three providers with a subagent', () => {
    const { store, mock } = setup()
    mock.seed()
    const agents = store.list()
    expect(new Set(agents.map((a) => a.provider))).toEqual(
      new Set(['claude-code', 'openai-agents', 'langgraph']),
    )
    expect(agents.some((a) => a.parentId)).toBe(true)
    expect(agents.every((a) => a.interactive)).toBe(true)
  })

  it('tick changes statuses with a tool when status is tool', () => {
    const { store, mock } = setup()
    mock.seed()
    for (let i = 0; i < 5; i++) mock.tick()
    for (const a of store.list()) {
      if (a.status === 'tool') expect(a.tool).toBeTruthy()
    }
  })

  it('answers messages sent to mock agents', async () => {
    const { store, messages, mock } = setup()
    mock.seed()
    mock.start(60_000)
    const id = store.list()[0]!.id
    messages.enqueue(id, 'hello')
    await new Promise((r) => setTimeout(r, 30))
    mock.stop()
    const h = messages.history(id)
    expect(h.map((m) => [m.from, m.state])).toEqual([
      ['user', 'replied'],
      ['agent', 'replied'],
    ])
    expect(h[1]!.text).toBe('(mock) got it: hello')
  })

  it('ignores messages for non-mock agents', async () => {
    const { store, messages, mock } = setup()
    mock.seed()
    mock.start(60_000)
    store.apply({ agentId: 'real' })
    messages.enqueue('real', 'hi')
    await new Promise((r) => setTimeout(r, 20))
    mock.stop()
    expect(messages.unread('real')).toBe(1)
  })

  it('spawn adds extra agents for perf testing', () => {
    const { store, mock } = setup()
    mock.spawn(25)
    expect(store.list()).toHaveLength(25)
  })

  it('recycles the subagent when it finishes', () => {
    const { store, mock } = setup()
    mock.seed()
    const before = store.list().find((a) => a.parentId)!.id
    mock.recycleSubagent()
    expect(store.get(before)?.status).toBe('done')
    expect(store.list().filter((a) => a.parentId && a.status !== 'done')).toHaveLength(1)
  })
})
