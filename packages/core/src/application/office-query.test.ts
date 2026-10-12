import type { Capability, ServerMessage } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import {
  FakeAgentRepository,
  FakeClock,
  FakeEventBus,
  FakeMessageRepository,
  ManualScheduler,
  SeqIds,
} from '../../test/fakes/index.ts'
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
  const inbox = new InboxService({
    agents,
    messages,
    bus,
    clock,
    ids: new SeqIds(),
    scheduler: new ManualScheduler(),
  })
  return { activity, inbox, clock, bus, query: new OfficeQueryService({ agents, messages, bus }) }
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

describe('OfficeQueryService: capabilities', () => {
  const cap: Capability = {
    id: 'fs',
    provider: 'p',
    category: 'adapter',
    kind: 'filesystem',
    label: 'Filesystem',
    sees: [],
    tools: [],
    declared: true,
    calls: 0,
    active: [],
  }

  it('snapshot includes capabilities when a catalog is wired, and none otherwise', () => {
    const bus = new FakeEventBus()
    const deps = { agents: new FakeAgentRepository(), messages: new FakeMessageRepository(), bus }
    expect(new OfficeQueryService(deps).snapshot()).not.toHaveProperty('capabilities')
    const q = new OfficeQueryService({ ...deps, capabilities: { list: () => [cap] } })
    expect(q.snapshot().capabilities).toEqual([cap])
  })

  it('watch maps capabilities.changed to a capabilities message', () => {
    const { query, bus } = setup()
    const got: ServerMessage[] = []
    query.watch((m) => got.push(m))
    bus.publish({ type: 'capabilities.changed', provider: 'p', capabilities: [cap] })
    expect(got).toEqual([{ type: 'capabilities', provider: 'p', capabilities: [cap] }])
  })
})

describe('OfficeQueryService: permissions', () => {
  it('watch maps permission.changed to the pending requests of that agent', () => {
    const agents = new FakeAgentRepository()
    const messages = new FakeMessageRepository()
    const bus = new FakeEventBus()
    const requests = [{ id: 'perm_0000000001', tool: 'Bash', summary: 'pnpm test' }]
    const query = new OfficeQueryService({
      agents,
      messages,
      bus,
      permissions: { pending: (id) => (id === 'a' ? requests : []) },
    })
    const got: ServerMessage[] = []
    query.watch((m) => got.push(m))
    bus.publish({ type: 'permission.changed', agentId: 'a' })
    bus.publish({ type: 'permission.changed', agentId: 'b' })
    expect(got).toEqual([
      { type: 'permission', agentId: 'a', requests },
      { type: 'permission', agentId: 'b', requests: [] },
    ])
  })

  it('without a permissions source, permission changes carry no requests', () => {
    const bus = new FakeEventBus()
    const query = new OfficeQueryService({
      agents: new FakeAgentRepository(),
      messages: new FakeMessageRepository(),
      bus,
    })
    const got: ServerMessage[] = []
    query.watch((m) => got.push(m))
    bus.publish({ type: 'permission.changed', agentId: 'a' })
    expect(got).toEqual([{ type: 'permission', agentId: 'a', requests: [] }])
  })
})
