import type { ChatMessage } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { applyEvent } from '../../src/domain/agent.ts'
import type {
  AgentRepository,
  EventPublisher,
  EventSubscriber,
  MessageRepository,
} from '../../src/ports/driven.ts'

const agent = (id: string, since = 1) => applyEvent(undefined, { agentId: id }, since)!
const msg = (id: string, agentId = 'a', over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  agentId,
  from: 'user',
  text: id,
  ts: 1,
  state: 'queued',
  ...over,
})

/** Every AgentRepository implementation must pass this. */
export function agentRepositoryContract(name: string, make: () => AgentRepository) {
  describe(`AgentRepository contract: ${name}`, () => {
    it('puts, gets, lists and deletes', () => {
      const r = make()
      r.put(agent('a'))
      r.put(agent('b'))
      expect(r.get('a')?.id).toBe('a')
      expect(
        r
          .list()
          .map((a) => a.id)
          .sort(),
      ).toEqual(['a', 'b'])
      r.delete('a')
      expect(r.get('a')).toBeUndefined()
      r.delete('missing')
      expect(r.list()).toHaveLength(1)
    })

    it('replaces on put with the same id', () => {
      const r = make()
      r.put(agent('a'))
      r.put({ ...agent('a'), name: 'Ada' })
      expect(r.list()).toHaveLength(1)
      expect(r.get('a')?.name).toBe('Ada')
    })

    it('returns copies that do not alias stored state', () => {
      const r = make()
      r.put(agent('a'))
      r.get('a')!.name = 'mutated'
      expect(r.get('a')?.name).toBe('a')
    })
  })
}

/** Every MessageRepository implementation must pass this. `make(cap)` caps history per agent. */
export function messageRepositoryContract(name: string, make: (cap: number) => MessageRepository) {
  describe(`MessageRepository contract: ${name}`, () => {
    it('appends in order per agent and updates in place', () => {
      const r = make(10)
      r.append(msg('m1'))
      r.append(msg('m2'))
      r.append(msg('x', 'b'))
      r.update({ ...msg('m1'), state: 'delivered' })
      r.update(msg('unknown'))
      expect(r.byAgent('a').map((m) => [m.id, m.state])).toEqual([
        ['m1', 'delivered'],
        ['m2', 'queued'],
      ])
      expect(r.byAgent('nobody')).toEqual([])
    })

    it('caps history per agent, dropping the oldest', () => {
      const r = make(2)
      for (const id of ['m1', 'm2', 'm3']) r.append(msg(id))
      expect(r.byAgent('a').map((m) => m.id)).toEqual(['m2', 'm3'])
    })

    it('recent() returns the last N of every agent; dropAgent forgets one', () => {
      const r = make(10)
      r.append(msg('a1'))
      r.append(msg('a2'))
      r.append(msg('b1', 'b'))
      expect(
        r
          .recent(1)
          .map((m) => m.id)
          .sort(),
      ).toEqual(['a2', 'b1'])
      r.dropAgent('a')
      expect(r.byAgent('a')).toEqual([])
    })

    it('returns copies', () => {
      const r = make(10)
      r.append(msg('m1'))
      r.byAgent('a')[0]!.text = 'mutated'
      expect(r.byAgent('a')[0]!.text).toBe('m1')
    })
  })
}

/** Every event bus implementation must pass this. */
export function eventBusContract(name: string, make: () => EventPublisher & EventSubscriber) {
  describe(`EventBus contract: ${name}`, () => {
    it('fans out to every subscriber until unsubscribed', () => {
      const bus = make()
      const a: string[] = []
      const b: string[] = []
      const offA = bus.subscribe((e) => a.push(e.type))
      bus.subscribe((e) => b.push(e.type))
      bus.publish({ type: 'agent.removed', id: 'x' })
      offA()
      bus.publish({ type: 'inbox.queued', agentId: 'x' })
      expect(a).toEqual(['agent.removed'])
      expect(b).toEqual(['agent.removed', 'inbox.queued'])
    })

    it('isolates a throwing subscriber', () => {
      const bus = make()
      const got: string[] = []
      bus.subscribe(() => {
        throw new Error('boom')
      })
      bus.subscribe((e) => got.push(e.type))
      expect(() => bus.publish({ type: 'agent.removed', id: 'x' })).not.toThrow()
      expect(got).toEqual(['agent.removed'])
    })
  })
}
