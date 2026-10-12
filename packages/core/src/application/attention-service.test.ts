import { describe, expect, it } from 'vitest'
import { FakeAgentRepository, FakeClock, FakeEventBus, FakeMessageRepository, FakeWindow, ManualScheduler, RecordingNotifier, RecordingTray, SeqIds } from '../../test/fakes/index.ts'
import { ActivityService } from './activity-service.ts'
import { AttentionService } from './attention-service.ts'
import { InboxService } from './inbox-service.ts'
import { OfficeQueryService } from './office-query.ts'

function setup(focused = false) {
  const agents = new FakeAgentRepository()
  const messages = new FakeMessageRepository()
  const bus = new FakeEventBus()
  const clock = new FakeClock(0)
  const policy = { idleAfterMs: 1e9, expireAfterMs: 1e9, doneTtlMs: 1e9, interactiveTtlMs: 1e9 }
  const activity = new ActivityService({ agents, messages, bus, clock, policy })
  const inbox = new InboxService({ agents, messages, bus, clock, ids: new SeqIds(), scheduler: new ManualScheduler() })
  const notifier = new RecordingNotifier()
  const tray = new RecordingTray()
  const scheduler = new ManualScheduler()
  const window = new FakeWindow(focused)
  const attention = new AttentionService({
    bus, query: new OfficeQueryService({ agents, messages, bus }), notifier, tray, window, clock, scheduler,
  })
  return { activity, inbox, notifier, tray, scheduler, attention, clock, window }
}

describe('AttentionService', () => {
  it('notifies once when a busy agent starts waiting, throttled per agent', () => {
    const { activity, notifier, attention, clock } = setup()
    attention.start()
    activity.report([{ agentId: 'a', name: 'Ada', topic: 'Auth', status: 'tool' }])
    activity.report([{ agentId: 'a', status: 'waiting' }])
    clock.advance(1000)
    activity.report([{ agentId: 'a', status: 'thinking' }])
    activity.report([{ agentId: 'a', status: 'waiting' }])
    expect(notifier.notes.map((n) => n.title)).toEqual(['Ada is waiting for you'])
  })

  it('notifies on replies, and not while the window is focused or notifications are off', () => {
    const { activity, inbox, notifier, attention, window } = setup()
    attention.start()
    activity.report([{ agentId: 'a', name: 'Ada' }])
    inbox.send('a', 'q')
    inbox.claim('a')
    window.focused = true
    inbox.reply('a', 'focused: no note')
    window.focused = false
    attention.setNotificationsEnabled(false)
    inbox.reply('a', 'disabled: no note')
    attention.setNotificationsEnabled(true)
    inbox.reply('a', 'answer')
    expect(notifier.notes.map((n) => [n.kind, n.body])).toEqual([['reply', 'answer']])
  })

  it('renders the tray on start and at most once per scheduler tick when dirty', () => {
    const { activity, tray, scheduler, attention } = setup()
    attention.start()
    expect(tray.models).toHaveLength(1)
    activity.report([{ agentId: 'a', status: 'waiting' }])
    activity.report([{ agentId: 'b', status: 'tool' }])
    scheduler.runAll()
    scheduler.runAll()
    expect(tray.models).toHaveLength(2)
    expect(tray.last?.title).toBe('⚙1 ✔1')
    attention.setHookInstalled(true)
    scheduler.runAll()
    expect(tray.last?.items).toContainEqual({ label: 'Claude Code hook: installed ✓', enabled: false })
  })

  it('forgets removed agents and stops cleanly', () => {
    const { activity, attention, scheduler, notifier, clock } = setup()
    attention.start()
    activity.report([{ agentId: 'a', status: 'tool' }])
    attention.stop()
    activity.report([{ agentId: 'a', status: 'waiting' }])
    expect(notifier.notes).toEqual([])
    expect(scheduler.jobs.every((j) => j.cancelled)).toBe(true)
    clock.advance(1)
  })
})
