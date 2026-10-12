import { describe, expect, it, vi } from 'vitest'
import { AgentStore } from './store.ts'

const opts = {
  idleAfterMs: 60_000,
  expireAfterMs: 600_000,
  doneTtlMs: 30_000,
  interactiveTtlMs: 600_000,
}
const newStore = () => new AgentStore(opts)

describe('AgentStore.apply', () => {
  it('creates an agent with defaults; provider falls back to source', () => {
    const s = newStore()
    const a = s.apply({ agentId: 'a', source: 'mock' }, 1000)
    expect(a).toMatchObject({
      id: 'a',
      name: 'a',
      provider: 'mock',
      topic: 'untitled',
      status: 'idle',
      source: 'mock',
      since: 1000,
      lastSeen: 1000,
      interactive: false,
      unread: 0,
    })
  })

  it('defaults source to http', () => {
    expect(newStore().apply({ agentId: 'a' }, 1)?.provider).toBe('http')
  })

  it('merges only defined fields', () => {
    const s = newStore()
    s.apply({ agentId: 'a', name: 'Ada', topic: 'T', status: 'thinking' }, 1)
    const a = s.apply({ agentId: 'a', status: 'tool', tool: 'Bash' }, 2)
    expect(a).toMatchObject({ name: 'Ada', topic: 'T', status: 'tool', tool: 'Bash', lastSeen: 2 })
  })

  it('clears the tool when leaving tool status', () => {
    const s = newStore()
    s.apply({ agentId: 'a', status: 'tool', tool: 'Bash' }, 1)
    expect(s.apply({ agentId: 'a', status: 'thinking' }, 2)?.tool).toBeUndefined()
  })

  it('ignores events older than lastSeen', () => {
    const s = newStore()
    s.apply({ agentId: 'a', status: 'waiting', ts: 200 }, 300)
    s.apply({ agentId: 'a', status: 'thinking', ts: 100 }, 300)
    expect(s.get('a')?.status).toBe('waiting')
  })

  it('emits upsert only when a visible field changed', () => {
    const s = newStore()
    const spy = vi.fn()
    s.on('upsert', spy)
    s.apply({ agentId: 'a', status: 'thinking' }, 1)
    s.apply({ agentId: 'a', status: 'thinking' }, 2)
    expect(spy).toHaveBeenCalledTimes(1)
    s.apply({ agentId: 'a', status: 'tool' }, 3)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('lists agents sorted by provider, topic, since', () => {
    const s = newStore()
    s.apply({ agentId: '3', provider: 'b', topic: 'x' }, 3)
    s.apply({ agentId: '1', provider: 'a', topic: 'y' }, 2)
    s.apply({ agentId: '2', provider: 'a', topic: 'y' }, 1)
    expect(s.list().map((a) => a.id)).toEqual(['2', '1', '3'])
  })
})

describe('AgentStore.sweep', () => {
  it('marks busy agents idle after idleAfterMs', () => {
    const s = newStore()
    s.apply({ agentId: 'a', status: 'tool', tool: 'Bash' }, 0)
    s.apply({ agentId: 'w', status: 'waiting' }, 0)
    s.sweep(60_001)
    expect(s.get('a')?.status).toBe('idle')
    expect(s.get('a')?.tool).toBeUndefined()
    expect(s.get('w')?.status).toBe('waiting')
  })

  it('removes agents after expireAfterMs and done agents after doneTtlMs', () => {
    const s = newStore()
    const removed = vi.fn()
    s.on('remove', removed)
    s.apply({ agentId: 'old' }, 0)
    s.apply({ agentId: 'fin', status: 'done' }, 500_000)
    s.sweep(530_001)
    expect(removed).toHaveBeenCalledWith('fin')
    s.sweep(600_001)
    expect(removed).toHaveBeenCalledWith('old')
    expect(s.list()).toEqual([])
  })

  it('turns interactive off after interactiveTtlMs without inbox reads', () => {
    const s = newStore()
    s.apply({ agentId: 'a' }, 0)
    s.markInteractive('a', 0)
    expect(s.get('a')?.interactive).toBe(true)
    s.apply({ agentId: 'a', status: 'thinking' }, 599_000)
    s.sweep(600_001)
    expect(s.get('a')?.interactive).toBe(false)
  })
})

describe('AgentStore.setUnread / markInteractive', () => {
  it('updates and emits; ignores unknown agents', () => {
    const s = newStore()
    const spy = vi.fn()
    s.apply({ agentId: 'a' }, 0)
    s.on('upsert', spy)
    s.setUnread('a', 2)
    s.setUnread('a', 2)
    s.setUnread('nope', 1)
    s.markInteractive('nope', 0)
    expect(s.get('a')?.unread).toBe(2)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
