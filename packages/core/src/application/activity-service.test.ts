import { describe, expect, it } from 'vitest'
import {
  FakeAgentRepository,
  FakeClock,
  FakeEventBus,
  FakeMessageRepository,
} from '../../test/fakes/index.ts'
import { ActivityService } from './activity-service.ts'

const policy = {
  idleAfterMs: 60_000,
  expireAfterMs: 600_000,
  doneTtlMs: 30_000,
  interactiveTtlMs: 600_000,
}
function setup() {
  const deps = {
    agents: new FakeAgentRepository(),
    messages: new FakeMessageRepository(),
    bus: new FakeEventBus(),
    clock: new FakeClock(0),
    policy,
  }
  return { ...deps, svc: new ActivityService(deps) }
}

describe('ActivityService.report', () => {
  it('stores agents and publishes only visible changes', () => {
    const { svc, agents, bus } = setup()
    expect(
      svc.report([
        { agentId: 'a', status: 'thinking' },
        { agentId: 'a', status: 'thinking' },
      ]),
    ).toBe(2)
    expect(agents.get('a')?.status).toBe('thinking')
    expect(bus.events.map((e) => e.type)).toEqual(['agent.upserted'])
  })

  it('drops out-of-order events from the count', () => {
    const { svc } = setup()
    svc.report([{ agentId: 'a', ts: 200 }])
    expect(svc.report([{ agentId: 'a', ts: 100 }])).toBe(0)
  })
})

describe('ActivityService.sweep', () => {
  it('idles, then removes agents and drops their messages', () => {
    const { svc, agents, messages, bus, clock } = setup()
    svc.report([{ agentId: 'a', status: 'tool', tool: 'Bash' }])
    messages.append({ id: 'm', agentId: 'a', from: 'user', text: 'x', ts: 0, state: 'queued' })
    clock.advance(60_001)
    svc.sweep()
    expect(agents.get('a')?.status).toBe('idle')
    clock.advance(600_000)
    svc.sweep()
    expect(agents.get('a')).toBeUndefined()
    expect(messages.byAgent('a')).toEqual([])
    expect(bus.events.map((e) => e.type)).toEqual([
      'agent.upserted',
      'agent.upserted',
      'agent.removed',
    ])
  })

  it('does nothing for fresh agents', () => {
    const { svc, bus } = setup()
    svc.report([{ agentId: 'a' }])
    svc.sweep()
    expect(bus.events).toHaveLength(1)
  })
})

describe('ActivityService.owned (de-duplicating managed sessions)', () => {
  const make = (owned: (id: string) => boolean) => {
    const deps = {
      agents: new FakeAgentRepository(),
      messages: new FakeMessageRepository(),
      bus: new FakeEventBus(),
      clock: new FakeClock(0),
      policy,
      owned,
    }
    return { ...deps, svc: new ActivityService(deps) }
  }

  it('AS-O1 drops hook/HTTP events for an id a managed session owns, keeps the managed ones', () => {
    const { svc, agents } = make((id) => id === 'cu:abc')
    expect(svc.report([{ agentId: 'cu:abc', source: 'hook', status: 'tool', tool: 'Bash' }])).toBe(
      0,
    )
    expect(svc.report([{ agentId: 'cu:abc', status: 'tool', tool: 'Bash' }])).toBe(0)
    expect(agents.get('cu:abc')).toBeUndefined()
    expect(svc.report([{ agentId: 'cu:abc', source: 'managed', status: 'thinking' }])).toBe(1)
    expect(agents.get('cu:abc')?.status).toBe('thinking')
  })

  it('AS-O2 a different id is not affected', () => {
    const { svc, agents } = make((id) => id === 'cu:abc')
    expect(svc.report([{ agentId: 'cu:other', source: 'hook', status: 'idle' }])).toBe(1)
    expect(agents.get('cu:other')?.source).toBe('hook')
  })
})
