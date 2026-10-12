import { describe, expect, it } from 'vitest'
import {
  FakeAgentRunner,
  FakeAgentRepository,
  FakeCapabilityRepository,
  FakeClaudeSettingsStore,
  FakeClock,
  FakeEventBus,
  FakeHookRunner,
  FakeJsonConfigStore,
  FakeMessageRepository,
  FakeProviderProbe,
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

function deps(over: Record<string, unknown> = {}) {
  return {
    agents: new FakeAgentRepository(),
    capabilities: new FakeCapabilityRepository(),
    messages: new FakeMessageRepository(),
    bus: new FakeEventBus(),
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
    ...over,
  }
}

describe('createOffice: managed sessions', () => {
  it('without a runner, there are no sessions and compose goes to the inbox', async () => {
    const office = createOffice(deps())
    expect(office.sessions).toBeUndefined()
    office.activity.report([{ agentId: 'a' }])
    const m = await office.compose.send('a', { text: 'hi', context: [], use: [] })
    expect(m.state).toBe('queued')
  })

  it('with a runner, sessions start, compose routes to them and watch streams permissions', async () => {
    const runner = new FakeAgentRunner()
    const office = createOffice(deps({ runner }))
    const got: string[] = []
    office.query.watch((m) => m.type === 'permission' && got.push(m.requests[0]?.summary ?? ''))
    const id = await office.sessions!.start({
      cwd: '/w/shop',
      name: 'shop',
      mode: 'default',
      extraDirs: [],
      chrome: false,
      first: { text: 'go', context: [], use: [] },
    })
    const m = await office.compose.send(id, { text: 'more', context: [], use: [] })
    expect(m.state).toBe('delivered')
    expect(runner.last().prompts).toEqual(['go', 'more'])
    void runner.last().ask('Bash', { command: 'pnpm test' })
    expect(got).toEqual(['pnpm test'])
  })
})

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

describe('createOffice: providers', () => {
  const first = { text: 'go', context: [], use: [] }
  const start = {
    cwd: '/w/shop',
    name: 'shop',
    mode: 'default' as const,
    extraDirs: [],
    chrome: false,
    first,
  }
  const codex = () =>
    new FakeAgentRunner({ provider: 'codex', prefix: 'cx:', caps: ['launch', 'send-message'] })

  it('always exposes a provider catalog (Claude-only binding by default)', async () => {
    const office = createOffice(deps({ runner: new FakeAgentRunner() }))
    const list = await office.providers.list()
    expect(list).toHaveLength(6)
    expect(list.find((p) => p.id === 'claude-code')).toMatchObject({
      state: 'managed-available',
      managedCaps: expect.arrayContaining(['chrome']),
    })
    expect(office.providerHooks).toBeUndefined()
    expect(await office.providers.models('claude-code')).toHaveLength(4)
  })

  it('runtimes start sessions per provider, attach to bindings, and own their ids', async () => {
    const runner = codex()
    const changes: number[] = []
    const settingsRepo = new FakeSettingsRepository()
    settingsRepo.saved = { ...(await settingsRepo.load()), providers: { codex: { enabled: true } } }
    const office = createOffice(
      deps({
        settingsRepo,
        runtimes: new Map([['codex', runner]]),
        providers: [{ provider: 'codex', probe: new FakeProviderProbe('codex') }],
        onProvidersChange: () => changes.push(1),
      }),
    )
    expect(office.sessions).toBeDefined()
    await expect(office.sessions!.start(start)).rejects.toMatchObject({ code: 'runtime' })
    const id = await office.sessions!.start({ ...start, provider: 'codex' })
    expect(id).toBe('cx:sess-1')
    // an observer event for the same id is dropped
    expect(office.activity.report([{ agentId: id, source: 'hook', status: 'idle' }])).toBe(0)
    const codexStatus = (await office.providers.refresh('codex')).find((p) => p.id === 'codex')
    expect(codexStatus).toMatchObject({ state: 'connected', activeSessions: 1 })
    expect(changes).toEqual([1])
  })

  it('wires provider hooks when hook targets are given', async () => {
    const store = new FakeJsonConfigStore()
    const office = createOffice(
      deps({
        providerHookTargets: {
          cursor: {
            format: 'cursor-json',
            store,
            runner: new FakeHookRunner('"/u/agent-office-observe-cursor.sh"'),
          },
        },
      }),
    )
    expect(await office.providerHooks!.install('cursor')).toBe('installed')
    await office.providers.setEnabled('cursor', true)
    const cursor = (await office.providers.list()).find((p) => p.id === 'cursor')
    expect(cursor).toMatchObject({ hooks: 'installed', state: 'observe-only' })
  })
})
