import type { ChatMessage } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { RateLimitedError, UnknownAgentError } from '../domain/errors.ts'
import {
  FakeAgentRepository,
  FakeClock,
  FakeEventBus,
  FakeMessageRepository,
  FakeSignal,
  ManualScheduler,
  SeqIds,
} from '../../test/fakes/index.ts'
import { ActivityService } from './activity-service.ts'
import { InboxService } from './inbox-service.ts'

function setup(rateLimitPerSec = 10) {
  const agents = new FakeAgentRepository()
  const messages = new FakeMessageRepository()
  const bus = new FakeEventBus()
  const clock = new FakeClock(0)
  const scheduler = new ManualScheduler()
  const policy = { idleAfterMs: 1e9, expireAfterMs: 1e9, doneTtlMs: 1e9, interactiveTtlMs: 1e9 }
  new ActivityService({ agents, messages, bus, clock, policy }).report([{ agentId: 'a' }])
  bus.events = []
  const svc = new InboxService({
    agents,
    messages,
    bus,
    clock,
    ids: new SeqIds(),
    scheduler,
    rateLimitPerSec,
  })
  return { svc, agents, messages, bus, clock, scheduler }
}
const chats = (bus: FakeEventBus) =>
  bus.events.flatMap((e) =>
    e.type === 'message.changed' ? [[e.message.from, e.message.state] as const] : [],
  )

describe('UserChat.send', () => {
  it('queues a message, signals the inbox and bumps unread', () => {
    const { svc, agents, bus } = setup()
    const m = svc.send('a', 'hello')
    expect(m).toMatchObject({
      id: 'id1',
      agentId: 'a',
      from: 'user',
      text: 'hello',
      state: 'queued',
    })
    expect(bus.events.map((e) => e.type)).toEqual([
      'message.changed',
      'inbox.queued',
      'agent.upserted',
    ])
    expect(agents.get('a')?.unread).toBe(1)
    expect(svc.history('a').map((x) => x.text)).toEqual(['hello'])
  })

  it('rejects unknown agents and rate-limits per agent', () => {
    const { svc } = setup(2)
    expect(() => svc.send('ghost', 'x')).toThrow(UnknownAgentError)
    svc.send('a', '1')
    svc.send('a', '2')
    expect(() => svc.send('a', '3')).toThrow(RateLimitedError)
  })
})

describe('AgentInbox', () => {
  it('claim delivers queued messages once, marks the agent interactive and clears unread', () => {
    const { svc, agents } = setup()
    svc.send('a', 'one')
    svc.send('a', 'two')
    const claimed = svc.claim('a')
    expect(claimed.map((m) => [m.text, m.state])).toEqual([
      ['one', 'delivered'],
      ['two', 'delivered'],
    ])
    expect(svc.claim('a')).toEqual([])
    expect(agents.get('a')).toMatchObject({ interactive: true, unread: 0 })
  })

  it('claim for an unknown agent returns nothing and does not throw', () => {
    const { svc } = setup()
    expect(svc.claim('ghost')).toEqual([])
  })

  it('peek shows queued messages without delivering', () => {
    const { svc, agents } = setup()
    svc.send('a', 'x')
    expect(svc.peek('a').map((m) => m.state)).toEqual(['queued'])
    expect(agents.get('a')?.unread).toBe(1)
    expect(agents.get('a')?.interactive).toBe(true)
  })

  it('reply answers delivered messages; requireAwaiting skips when nothing waits', () => {
    const { svc, bus } = setup()
    expect(svc.reply('a', 'unprompted', { requireAwaiting: true })).toBeNull()
    const m = svc.send('a', 'q')
    svc.claim('a')
    bus.events = []
    const r = svc.reply('a', 'answer', { requireAwaiting: true })
    expect(r).toMatchObject({ from: 'agent', text: 'answer', state: 'replied' })
    expect(chats(bus)).toEqual([
      ['user', 'replied'],
      ['agent', 'replied'],
    ])
    expect(svc.history('a').find((x: ChatMessage) => x.id === m.id)?.state).toBe('replied')
  })

  it('reply with inReplyTo answers only that message', () => {
    const { svc } = setup()
    const m1 = svc.send('a', 'q1')
    svc.send('a', 'q2')
    svc.claim('a')
    svc.reply('a', 'a1', { inReplyTo: m1.id })
    expect(svc.history('a').map((x) => x.state)).toEqual(['replied', 'delivered', 'replied'])
  })

  it('a spontaneous reply (no requireAwaiting) is still recorded', () => {
    const { svc } = setup()
    expect(svc.reply('a', 'fyi')?.text).toBe('fyi')
  })

  it('waitForMessages resolves on queue, immediately if already queued, on timeout and on abort', async () => {
    const { svc, scheduler } = setup()
    const woke = svc.waitForMessages('a', 5_000)
    svc.send('a', 'ping')
    await expect(woke).resolves.toBe(true)
    await expect(svc.waitForMessages('a', 5_000)).resolves.toBe(true)

    const timedOut = svc.waitForMessages('b', 10)
    scheduler.fireTimers()
    await expect(timedOut).resolves.toBe(false)

    const signal = new FakeSignal()
    const aborted = svc.waitForMessages('b', 5_000, signal)
    signal.abort()
    await expect(aborted).resolves.toBe(false)
    await expect(svc.waitForMessages('b', 5_000, signal)).resolves.toBe(false)
  })
})
