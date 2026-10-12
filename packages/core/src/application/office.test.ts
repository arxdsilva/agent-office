import { describe, expect, it } from 'vitest'
import {
  FakeAgentRepository,
  FakeCapabilityRepository,
  FakeClaudeSettingsStore,
  FakeClock,
  FakeEventBus,
  FakeHookRunner,
  FakeMessageRepository,
  FakeSettingsRepository,
  FakeWindow,
  fakePlatform,
  ManualScheduler,
  RecordingLoginItem,
  RecordingNotifier,
  RecordingTray,
  ScriptedUpdater,
  SeqIds,
} from '../../test/fakes/index.ts'
import { createOffice } from './office.ts'

describe('createOffice', () => {
  it('wires the services around shared repositories', async () => {
    const bus = new FakeEventBus()
    const office = createOffice({
      agents: new FakeAgentRepository(),
      capabilities: new FakeCapabilityRepository(),
      messages: new FakeMessageRepository(),
      bus,
      clock: new FakeClock(),
      ids: new SeqIds(),
      scheduler: new ManualScheduler(),
      settingsRepo: new FakeSettingsRepository(),
      loginItem: new RecordingLoginItem(),
      claudeSettings: new FakeClaudeSettingsStore(),
      hookRunner: new FakeHookRunner(),
      notifier: new RecordingNotifier(),
      tray: new RecordingTray(),
      window: new FakeWindow(),
      updater: new ScriptedUpdater(),
      platform: fakePlatform({ packaged: false }),
      releaseUrl: 'https://example.invalid',
    })
    office.activity.report([{ agentId: 'a' }])
    office.chat.send('a', 'hi')
    expect(office.inbox.claim('a')).toHaveLength(1)
    expect(office.query.snapshot().agents).toHaveLength(1)
    expect(await office.hooks.status()).toBe('not-installed')
    expect((await office.settings.get()).port).toBe(4317)
    expect(office.updates.state().policy).toBe('off')
    expect(office.attention).toBeDefined()
    // Capabilities: declared through the narrow port, observed from tool calls, in the snapshot.
    office.capabilities.declare('claude-code', [
      { id: 'skill:x', category: 'skill', kind: 'skill', label: 'x' },
    ])
    office.activity.report([
      { agentId: 'a', provider: 'claude-code', status: 'tool', tool: 'Bash' },
    ])
    expect(
      office.query
        .snapshot()
        .capabilities?.map((c) => c.id)
        .sort(),
    ).toEqual(['shell', 'skill:x'])
    expect(bus.events.some((e) => e.type === 'capabilities.changed')).toBe(true)
  })
})
