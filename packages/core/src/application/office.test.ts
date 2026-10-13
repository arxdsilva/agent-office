import { PROVIDER_IDS } from '@agent-office/shared'
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
  FakeRecordLog,
  FakeRepoIdentity,
  FakeTranscriptReader,
  SeqRandom,
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
    expect(list).toHaveLength(PROVIDER_IDS.length)
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

describe('createOffice: projects (docs/projects.md)', () => {
  const identity = {
    commonDirKey: 'cd-shop',
    rootKey: 'rk-shop',
    rootCommit: 'c0',
    remotes: ['github.com/acme/shop'],
    name: 'shop',
    isWorktree: false,
    relPath: '',
  }

  it('OF-projects is absent without a vault', () => {
    expect(createOffice(deps()).projects).toBeUndefined()
  })

  it('OF-the vertical slice: project → managed codex session with MCP → retrieves approved memory → restart', async () => {
    const vault = new FakeRecordLog()
    const codex = new FakeAgentRunner({
      provider: 'codex',
      prefix: 'cx:',
      caps: ['launch', 'send-message', 'stop'],
    })
    const settingsRepo = new FakeSettingsRepository()
    const d = deps({
      vault,
      runtimes: new Map([['codex', codex]]),
      runner: new FakeAgentRunner(),
      settingsRepo,
      repoIdentity: new FakeRepoIdentity().set('/work/shop', identity),
      transcripts: new FakeTranscriptReader(),
      random: new SeqRandom(),
      mcpLaunch: (token: string) => ({
        name: 'agent-office-memory',
        command: '/w/mcp',
        args: [],
        env: { AGENT_OFFICE_MCP_TOKEN: token },
      }),
    })
    await settingsRepo.save({
      ...(await settingsRepo.load()),
      providers: { codex: { enabled: true } },
    })
    const office = createOffice(d)
    const projects = office.projects!
    await projects.load()
    const p = await projects.catalog.create({ name: 'Shop', folders: ['/work/shop'] })
    expect(projects.catalog.get(p.id).policy.providers).toEqual({
      'claude-code': 'read-propose',
      codex: 'read-propose',
    })
    await projects.memory.create({
      projectId: p.id,
      scope: 'project',
      kind: 'decision',
      title: 'Use JWT',
      body: 'JWT for auth',
    })

    const agentId = await office.sessions!.start({
      provider: 'codex',
      projectId: p.id,
      cwd: '/work/shop',
      name: 'cx',
      mode: 'default',
      extraDirs: [],
      chrome: false,
      first: { text: 'go', context: [], use: [] },
    })
    const token = codex.last().options.mcp!.env.AGENT_OFFICE_MCP_TOKEN!
    const principal = projects.mcp.principal(token)!
    expect(principal).toMatchObject({ projectId: p.id, provider: 'codex' })
    expect(principal.sessionId).toMatch(/^ses_/)
    expect(d.agents.get(agentId)?.projectId).toBe(p.id)
    const r = await projects.mcp.call(principal, 'search_memory', { query: 'jwt' })
    expect((r.structured.items as { title: string }[]).map((i) => i.title)).toEqual(['Use JWT'])
    expect(projects.context.inspect(agentId).retrieved).toHaveLength(1)
    expect(d.capabilities.get('codex', 'mcp:agent-office-memory')?.label).toBe('Context Hub')
    expect(projects.workspace.dashboard(p.id).active.map((a) => a.agentId)).toEqual([agentId])

    await office.sessions!.stop(agentId)
    expect(projects.mcp.principal(token)).toBeNull()
    await projects.store.flush()

    const again = createOffice({
      ...d,
      agents: new FakeAgentRepository(),
      bus: new FakeEventBus(),
      vault: vault.reopen(),
    })
    await again.projects!.load()
    expect(again.projects!.catalog.list().map((x) => x.name)).toEqual(['Shop'])
    expect(again.projects!.sessions.list({ scope: p.id })).toMatchObject([
      { provider: 'codex', origin: 'managed', state: 'inactive' },
    ])
    expect(again.projects!.memory.list({ scope: p.id }).map((m) => m.title)).toEqual(['Use JWT'])
    expect(again.projects!.workspace.overview().vault).toBe('encrypted')
  })
})
