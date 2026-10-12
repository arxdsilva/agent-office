import type { ServerMessage } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { FakeAgentRepository, FakeClock, FakeEventBus, FakeMessageRepository, ManualScheduler, SeqIds } from '../../test/fakes/index.ts'
import { ActivityService } from './activity-service.ts'
import { InboxService } from './inbox-service.ts'
import { OfficeQueryService } from './office-query.ts'

function setup() {
  const agents = new FakeAgentRepository()
  const messages = new FakeMessageRepository()
  const bus = new FakeEventBus()
  const clock = new FakeClock(0)
  const policy = { idleAfterMs: 1e9, expireAfterMs: 10, doneTtlMs: 1e9, interactiveTtlMs: 1e9 }
  const activity = new ActivityService({ agents, messages, bus, clock, policy })
  const inbox = new InboxService({ agents, messages, bus, clock, ids: new SeqIds(), scheduler: new ManualScheduler() })
  return { activity, inbox, clock, query: new OfficeQueryService({ agents, messages, bus }) }
}

describe('OfficeQueryService', () => {
  it('lists agents sorted by provider, topic, since — without internal fields', () => {
    const { activity, inbox, query, clock } = setup()
    activity.report([{ agentId: '3', provider: 'b', topic: 'x' }])
    clock.advance(1)
    activity.report([{ agentId: '1', provider: 'a', topic: 'y' }])
    activity.report([{ agentId: '2', provider: 'a', topic: 'y', ts: 1 }])
    inbox.claim('1')
    expect(query.agents().map((a) => a.id)).toEqual(['1', '2', '3'])
    expect(query.agent('1')).not.toHaveProperty('inboxReadAt')
    expect(query.agent('nope')).toBeUndefined()
  })

  it('snapshot includes recent messages', () => {
    const { activity, inbox, query } = setup()
    activity.report([{ agentId: 'a' }])
    inbox.send('a', 'hi')
    expect(query.snapshot().messages.map((m) => m.text)).toEqual(['hi'])
  })

  it('watch maps domain events to UI messages and stops after unsubscribe', () => {
    const { activity, inbox, query, clock } = setup()
    const got: ServerMessage['type'][] = []
    const off = query.watch((m) => got.push(m.type))
    activity.report([{ agentId: 'a' }])
    inbox.send('a', 'hi')
    clock.advance(11)
    activity.sweep()
    off()
    activity.report([{ agentId: 'b' }])
    expect(got).toEqual(['upsert', 'chat', 'upsert', 'remove'])
  })
})
