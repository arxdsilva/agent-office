// Builds a real core (createOffice) on in-memory adapters + recording fakes, for adapter tests.
import { createOffice, type SweepPolicy } from '@agent-office/core'
import {
  FakeClaudeSettingsStore, FakeHookRunner, FakeSettingsRepository, FakeWindow, fakePlatform,
  RecordingLoginItem, RecordingNotifier, RecordingTray, ScriptedUpdater,
} from '@agent-office/core/testing'
import { InMemoryAgentRepository, InMemoryEventBus, InMemoryMessageRepository } from '../src/memory/index.ts'
import { RandomIds, SystemClock, TimerScheduler } from '../src/system/index.ts'

export function makeOffice(opts: { policy?: Partial<SweepPolicy>; rateLimitPerSec?: number } = {}) {
  const scheduler = new TimerScheduler()
  const bus = new InMemoryEventBus()
  const office = createOffice({
    agents: new InMemoryAgentRepository(),
    messages: new InMemoryMessageRepository(),
    bus,
    clock: new SystemClock(),
    ids: new RandomIds(),
    scheduler,
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
    policy: { idleAfterMs: 60_000, expireAfterMs: 600_000, doneTtlMs: 30_000, interactiveTtlMs: 600_000, ...opts.policy },
    ...(opts.rateLimitPerSec ? { rateLimitPerSec: opts.rateLimitPerSec } : {}),
  })
  return { office, bus, scheduler }
}
