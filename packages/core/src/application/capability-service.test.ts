import type { AgentEvent, Capability } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import {
  FakeAgentRepository,
  FakeCapabilityRepository,
  FakeClock,
  FakeEventBus,
  FakeMessageRepository,
  ManualScheduler,
} from '../../test/fakes/index.ts'
import type { OfficeEvent } from '../ports/driven.ts'
import { ActivityService } from './activity-service.ts'
import { CAPABILITY_DEBOUNCE_MS, CapabilityService } from './capability-service.ts'

function setup(opts: { maxPerProvider?: number } = {}) {
  const agents = new FakeAgentRepository()
  const bus = new FakeEventBus()
  const clock = new FakeClock(1_000)
  const scheduler = new ManualScheduler()
  const repo = new FakeCapabilityRepository()
  const policy = { idleAfterMs: 1e9, expireAfterMs: 1e9, doneTtlMs: 1e9, interactiveTtlMs: 1e9 }
  const activity = new ActivityService({
    agents,
    messages: new FakeMessageRepository(),
    bus,
    clock,
    policy,
  })
  const caps = new CapabilityService({ repo, bus, clock, scheduler, ...opts })
  const report = (e: Partial<AgentEvent>) => {
    clock.advance(1)
    activity.report([{ agentId: 'a', provider: 'claude-code', ...e }])
  }
  const changes = () =>
    bus.events.filter(
      (e): e is Extract<OfficeEvent, { type: 'capabilities.changed' }> =>
        e.type === 'capabilities.changed',
    )
  const get = (id: string, provider = 'claude-code') =>
    caps.list().find((c) => c.id === id && c.provider === provider)
  return { activity, caps, repo, bus, clock, scheduler, report, changes, get }
}

describe('CapabilityService: observed use', () => {
  it('records a use when an agent upserts with status tool, and marks it active', () => {
    const s = setup()
    s.report({ status: 'tool', tool: 'Bash', target: 'cmd:git' })
    expect(s.get('shell')).toMatchObject({
      category: 'adapter',
      declared: false,
      calls: 1,
      lastUsedAt: 1_001,
      sees: ['cmd: git'],
      tools: ['Bash'],
      active: ['a'],
    })
  })

  it('clears active when the agent leaves tool status or is removed', () => {
    const s = setup()
    s.report({ status: 'tool', tool: 'Read', target: 'project:shop' })
    s.report({ status: 'thinking' })
    expect(s.get('fs')!.active).toEqual([])
    s.report({ status: 'tool', tool: 'WebFetch', target: 'host:example.com' })
    expect(s.get('web')!.active).toEqual(['a'])
    s.bus.publish({ type: 'agent.removed', id: 'a' })
    expect(s.get('web')!.active).toEqual([])
  })

  it('moves the agent when it switches capability mid-tool', () => {
    const s = setup()
    s.report({ status: 'tool', tool: 'Read', target: 'project:shop' })
    s.report({ status: 'tool', tool: 'mcp__github__get_issue' })
    expect(s.get('fs')!.active).toEqual([])
    expect(s.get('mcp:github')).toMatchObject({
      active: ['a'],
      tools: ['get_issue'],
      label: 'Github',
    })
  })

  it('counts each new call once, not every upsert of the same call', () => {
    const s = setup()
    s.report({ status: 'tool', tool: 'Bash', target: 'cmd:git', text: 'one' })
    s.report({ status: 'tool', tool: 'Bash', target: 'cmd:git', text: 'still the same call' })
    expect(s.get('shell')!.calls).toBe(1)
    s.report({ status: 'thinking' })
    s.report({ status: 'tool', tool: 'Bash', target: 'cmd:git' })
    expect(s.get('shell')!.calls).toBe(2)
    // A different target on the same tool is a new call.
    s.report({ status: 'tool', tool: 'Bash', target: 'cmd:pnpm' })
    expect(s.get('shell')).toMatchObject({ calls: 3, sees: ['cmd: pnpm', 'cmd: git'] })
  })

  it('classifies skills and rules into the Library', () => {
    const s = setup()
    s.report({ status: 'tool', tool: 'Skill', target: 'skill:run-office' })
    s.report({ status: 'tool', tool: 'Read', target: 'rule:project:TESTING.md' })
    expect(s.get('skill:run-office')).toMatchObject({ category: 'skill', calls: 1, active: [] })
    expect(s.get('rule:project:TESTING.md')).toMatchObject({ category: 'rule', active: ['a'] })
  })

  it('uses the explicit capability of generic producers', () => {
    const s = setup()
    s.report({
      provider: 'langgraph',
      status: 'tool',
      tool: 'query',
      capability: 'mcp:warehouse_db',
    })
    expect(s.get('mcp:warehouse_db', 'langgraph')).toMatchObject({
      kind: 'database',
      tools: ['query'],
    })
  })

  it('ignores tool calls that are not capabilities, and other events', () => {
    const s = setup()
    s.report({ status: 'tool', tool: 'TodoWrite' })
    s.report({ status: 'thinking' })
    s.bus.publish({ type: 'inbox.queued', agentId: 'a' })
    expect(s.caps.list()).toEqual([])
    expect(s.changes()).toHaveLength(0)
  })

  it('caps the catalog per provider; known capabilities still update', () => {
    const s = setup({ maxPerProvider: 2 })
    s.report({ provider: 'p', status: 'tool', tool: 't1' })
    s.report({ provider: 'p', status: 'tool', tool: 't2' })
    s.report({ provider: 'p', status: 'tool', tool: 't3' })
    s.caps.declare('p', [{ id: 'x', category: 'adapter', kind: 'api', label: 'X' }])
    expect(s.caps.list().map((c) => c.id)).toEqual(['api:t1', 'api:t2'])
    s.report({ provider: 'p', status: 'tool', tool: 't1' })
    expect(s.get('api:t1', 'p')!.calls).toBe(2)
  })
})

describe('CapabilityService: declarations', () => {
  it('declares, keeps observed counters and lists by provider in sorted order', () => {
    const s = setup()
    s.report({ status: 'tool', tool: 'Bash', target: 'cmd:git' })
    s.caps.declare('claude-code', [
      {
        id: 'skill:run-office',
        category: 'skill',
        kind: 'skill',
        label: 'run-office',
        summary: 'Run it',
      },
      { id: 'shell', category: 'adapter', kind: 'shell', label: 'Shell' },
      { id: 'fs', category: 'adapter', kind: 'filesystem', label: 'Filesystem' },
    ])
    expect(s.caps.list('claude-code').map((c) => c.id)).toEqual(['fs', 'shell', 'skill:run-office'])
    expect(s.get('shell')).toMatchObject({ declared: true, calls: 1, active: ['a'] })
    expect(s.caps.list('nobody')).toEqual([])
  })

  it('an empty declaration changes nothing and publishes nothing', () => {
    const s = setup()
    s.caps.declare('p', [])
    expect(s.changes()).toHaveLength(0)
  })
})

describe('CapabilityService: capabilities.changed', () => {
  const decl = (id: string) => [
    { id, category: 'adapter' as const, kind: 'api' as const, label: id },
  ]

  it('publishes the provider full list right away, then at most once per 250 ms', () => {
    const s = setup()
    s.caps.declare('p', decl('a'))
    expect(s.changes()).toHaveLength(1)
    expect(s.changes()[0]).toMatchObject({ provider: 'p', capabilities: [{ id: 'a' }] })
    // Two more changes inside the window: nothing yet, one trailing publish is scheduled.
    s.caps.declare('p', decl('b'))
    s.caps.declare('p', decl('c'))
    expect(s.changes()).toHaveLength(1)
    expect(s.scheduler.timers.filter((t) => !t.cancelled)).toHaveLength(1)
    expect(s.scheduler.timers[0]!.ms).toBe(CAPABILITY_DEBOUNCE_MS)
    s.clock.advance(250)
    s.scheduler.fireTimers()
    expect(s.changes()).toHaveLength(2)
    expect(s.changes()[1]!.capabilities.map((c: Capability) => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('providers are debounced independently', () => {
    const s = setup()
    s.caps.declare('p', decl('a'))
    s.caps.declare('q', decl('a'))
    expect(s.changes().map((e) => e.provider)).toEqual(['p', 'q'])
  })

  it('publishes immediately again once the window has passed', () => {
    const s = setup()
    s.caps.declare('p', decl('a'))
    s.clock.advance(300)
    s.caps.declare('p', decl('b'))
    expect(s.changes()).toHaveLength(2)
    expect(s.scheduler.timers).toHaveLength(0)
  })

  it('schedules only the remaining part of the window', () => {
    const s = setup()
    s.caps.declare('p', decl('a'))
    s.clock.advance(100)
    s.caps.declare('p', decl('b'))
    expect(s.scheduler.timers[0]!.ms).toBe(150)
  })

  it('stop() unsubscribes and cancels a pending publish', () => {
    const s = setup()
    s.caps.declare('p', decl('a'))
    s.caps.declare('p', decl('b'))
    s.caps.stop()
    s.scheduler.fireTimers()
    s.report({ status: 'tool', tool: 'Bash' })
    expect(s.changes()).toHaveLength(1)
    expect(s.get('shell')).toBeUndefined()
  })
})
