import { DEFAULT_SETTINGS, type Settings } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import {
  NotAllowedError,
  RateLimitedError,
  SessionStartError,
  UnknownAgentError,
} from '../domain/errors.ts'
import {
  FakeAgentRepository,
  FakeAgentRunner,
  FakeClock,
  FakeEventBus,
  FakeMessageRepository,
  ManualScheduler,
  SeqIds,
} from '../../test/fakes/index.ts'
import type { ComposedMessage, StartSession } from '../ports/driving.ts'
import { ActivityService } from './activity-service.ts'
import { InboxService } from './inbox-service.ts'
import {
  ComposeService,
  FALLBACK_MODELS,
  MAX_MANAGED,
  ManagedSessionService,
} from './managed-session-service.ts'

function setup(over: Partial<Settings> = {}) {
  const agents = new FakeAgentRepository()
  const messages = new FakeMessageRepository()
  const bus = new FakeEventBus()
  const clock = new FakeClock()
  const scheduler = new ManualScheduler()
  const ids = new SeqIds()
  const runner = new FakeAgentRunner()
  const policy = { idleAfterMs: 1e9, expireAfterMs: 1e9, doneTtlMs: 1e9, interactiveTtlMs: 1e9 }
  const activity = new ActivityService({ agents, messages, bus, clock, policy })
  const inbox = new InboxService({ agents, messages, bus, clock, ids, scheduler })
  const settings = { ...DEFAULT_SETTINGS, ...over }
  let n = 0
  const svc = new ManagedSessionService({
    runner,
    activity,
    agents,
    messages,
    inbox,
    settings: { get: async () => settings },
    bus,
    clock,
    scheduler,
    ids,
    permId: () => `perm_${String(++n).padStart(10, '0')}`,
    // Mirrors the composition root's never-absolute displayPathOf.
    displayPath: (p) =>
      p.startsWith('/Users/me/')
        ? p.replace('/Users/me', '~')
        : `…/${p.split('/').slice(-2).join('/')}`,
  })
  const compose = new ComposeService({ chat: inbox, messages, bus, sessions: svc })
  return {
    svc,
    compose,
    runner,
    agents,
    messages,
    bus,
    clock,
    scheduler,
    activity,
    settings,
    inbox,
  }
}

const first: ComposedMessage = { text: 'Plan the logout flow', context: [], use: [] }
const START: StartSession = {
  cwd: '/Users/me/code/shop-api',
  name: 'shop-api',
  mode: 'plan',
  model: 'sonnet',
  extraDirs: [],
  chrome: false,
  first,
}
const tick = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

async function started(over: Partial<Settings> = {}) {
  const t = setup(over)
  const agentId = await t.svc.start(START)
  return { ...t, agentId, session: t.runner.last() }
}

describe('ManagedSessionService.start', () => {
  it('MS-start creates a managed claude-code agent and delivers + pushes the first message', async () => {
    const { agentId, agents, messages, session, svc } = await started()
    expect(agentId).toBe('cc:sess-1')
    expect(session.options).toMatchObject({
      cwd: '/Users/me/code/shop-api',
      mode: 'plan',
      model: 'sonnet',
      allowBypass: false,
    })
    expect(agents.get(agentId)).toMatchObject({
      provider: 'claude-code',
      source: 'managed',
      name: 'shop-api',
      status: 'thinking',
      permissionMode: 'plan',
      managed: { phase: 'running', chrome: false, pending: 0, modelId: 'sonnet' },
    })
    expect(messages.byAgent(agentId)).toMatchObject([
      { from: 'user', text: 'Plan the logout flow', state: 'delivered' },
    ])
    expect(session.prompts).toEqual(['Plan the logout flow'])
    expect(svc.isManaged(agentId)).toBe(true)
    expect(svc.count()).toBe(1)
  })

  it('MS-limit refuses a 7th session', async () => {
    const { svc } = setup()
    for (let i = 0; i < MAX_MANAGED; i++) await svc.start(START)
    await expect(svc.start(START)).rejects.toMatchObject({ code: 'limit' })
    await expect(svc.start(START)).rejects.toBeInstanceOf(SessionStartError)
  })

  it('MS-exit maps an exit before the session id to its code and creates no agent', async () => {
    for (const [error, code] of [
      ['auth', 'auth'],
      ['runtime', 'runtime'],
      ['folder', 'folder'],
      ['crash', 'other'],
    ] as const) {
      const { svc, runner, agents } = setup()
      runner.failNext = { error }
      await expect(svc.start(START)).rejects.toMatchObject({ code })
      expect(agents.list()).toHaveLength(0)
      expect(svc.count()).toBe(0)
    }
  })

  it('times out when the session never initializes and closes the runner', async () => {
    const { svc, runner, scheduler } = setup()
    runner.autoInit = false
    const p = svc.start(START)
    await tick()
    scheduler.fireTimers()
    await expect(p).rejects.toMatchObject({ code: 'other' })
    expect(runner.last().closed).toBe(true)
  })

  it('maps a runner that throws while starting', async () => {
    const { svc, runner } = setup()
    runner.start = () => {
      throw new Error('spawn ENOENT')
    }
    await expect(svc.start(START)).rejects.toMatchObject({ code: 'other' })
    expect(svc.count()).toBe(0)
  })

  it('MS-bypass refuses to start in bypass mode while the setting is off', async () => {
    const { svc } = setup()
    await expect(svc.start({ ...START, mode: 'bypassPermissions' })).rejects.toBeInstanceOf(
      NotAllowedError,
    )
    const on = setup({ allowBypassPermissions: true })
    await on.svc.start({ ...START, mode: 'bypassPermissions' })
    expect(on.runner.last().options.allowBypass).toBe(true)
  })
})

describe('messages', () => {
  it('MS-send delivers to the runner with chips; the result becomes a reply', async () => {
    const { compose, agentId, session, messages, agents } = await started()
    const m = await compose.send(agentId, {
      text: 'review these',
      context: [
        {
          kind: 'folder',
          path: '/Users/me/code/shop-api/src/auth',
          label: 'auth',
          hint: '~/code/shop-api/src/auth',
        },
      ],
      use: [{ id: 'mcp:claude-in-chrome', label: 'Chrome browser' }],
    })
    expect(m).toMatchObject({
      from: 'user',
      state: 'delivered',
      text: 'review these',
      context: [
        { kind: 'folder', label: 'auth' },
        { kind: 'capability', label: 'Chrome browser', hint: 'mcp:claude-in-chrome' },
      ],
    })
    expect(session.prompts.at(-1)).toContain('- folder: /Users/me/code/shop-api/src/auth')
    expect(session.prompts.at(-1)).toContain('claude-in-chrome (mcp__claude-in-chrome__*)')
    session.result('All good.')
    const thread = messages.byAgent(agentId)
    expect(thread.at(-1)).toMatchObject({ from: 'agent', text: 'All good.' })
    expect(thread.filter((x) => x.from === 'user').every((x) => x.state === 'replied')).toBe(true)
    expect(agents.get(agentId)?.status).toBe('waiting')
  })

  it('an error result without text marks the agent errored and adds no reply', async () => {
    const { agentId, session, messages, agents } = await started()
    session.result('', true)
    expect(messages.byAgent(agentId).some((x) => x.from === 'agent')).toBe(false)
    expect(agents.get(agentId)?.status).toBe('error')
  })

  it('MS-route sends to a terminal agent through the inbox with the preamble and chips', async () => {
    const { compose, activity, messages, bus } = setup()
    activity.report([{ agentId: 'cc:term', provider: 'claude-code' }])
    const m = await compose.send('cc:term', {
      text: 'look',
      context: [{ kind: 'file', path: '/abs/README.md', label: 'README.md', hint: '~/README.md' }],
      use: [],
    })
    expect(m.state).toBe('queued')
    expect(m.text).toContain('- file: /abs/README.md')
    expect(m.context).toEqual([{ kind: 'file', label: 'README.md', hint: '~/README.md' }])
    expect(messages.byAgent('cc:term')[0]?.context).toHaveLength(1)
    const last = bus.events.filter((e) => e.type === 'message.changed').at(-1)
    expect(last?.type === 'message.changed' && last.message.context).toBeTruthy()
  })

  it('without sessions, compose routes plain text to the inbox unchanged', async () => {
    const t = setup()
    const compose = new ComposeService({ chat: t.inbox, messages: t.messages, bus: t.bus })
    t.activity.report([{ agentId: 'x' }])
    const m = await compose.send('x', { text: 'hi', context: [], use: [] })
    expect(m).toMatchObject({ text: 'hi', state: 'queued' })
    expect(m.context).toBeUndefined()
  })

  it('maps runner activity onto the agent, keeping the user-chosen name and the managed source', async () => {
    const { agentId, session, agents } = await started()
    session.emit({
      status: 'tool',
      tool: 'Bash',
      name: 'other',
      source: 'claude-code',
      provider: 'x',
    })
    expect(agents.get(agentId)).toMatchObject({
      status: 'tool',
      tool: 'Bash',
      name: 'shop-api',
      source: 'managed',
      provider: 'claude-code',
      managed: { phase: 'running' },
    })
  })
})

describe('mode and model', () => {
  it('MS-mode changes the mode live with a system line', async () => {
    const { svc, agentId, session, agents, messages } = await started()
    await svc.setMode(agentId, 'acceptEdits')
    expect(session.mode).toBe('acceptEdits')
    expect(agents.get(agentId)?.permissionMode).toBe('acceptEdits')
    expect(messages.byAgent(agentId).at(-1)).toMatchObject({
      from: 'system',
      text: 'Mode → Accept edits',
    })
  })

  it('MS-bypass rejects bypass while the setting is off, allows it when on', async () => {
    const off = await started()
    await expect(off.svc.setMode(off.agentId, 'bypassPermissions')).rejects.toBeInstanceOf(
      NotAllowedError,
    )
    expect(off.session.calls).toEqual([])
    const on = await started({ allowBypassPermissions: true })
    await on.svc.setMode(on.agentId, 'bypassPermissions')
    expect(on.session.mode).toBe('bypassPermissions')
  })

  it('MS-model changes the model, records its id and label, with a system line', async () => {
    const { svc, agentId, session, agents, messages } = await started()
    expect(await svc.models(agentId)).toEqual(session.models)
    await svc.setModel(agentId, 'opus')
    expect(session.model).toBe('opus')
    expect(agents.get(agentId)).toMatchObject({ model: 'Opus', managed: { modelId: 'opus' } })
    expect(messages.byAgent(agentId).at(-1)?.text).toBe('Model → Opus')
    // Without an id: the last list seen.
    expect(await svc.models()).toEqual(session.models)
  })

  it('falls back to alias models when the runner cannot list them', async () => {
    const { svc, agentId, session } = await started()
    expect(await setup().svc.models()).toEqual(FALLBACK_MODELS)
    session.supportedModels = async () => {
      throw new Error('nope')
    }
    expect(await svc.models(agentId)).toEqual(FALLBACK_MODELS)
    await svc.setModel(agentId, 'custom-model')
    expect(session.model).toBe('custom-model')
  })

  it('unknown agents throw UnknownAgentError', async () => {
    const { svc } = setup()
    await expect(svc.setMode('cc:nope', 'plan')).rejects.toBeInstanceOf(UnknownAgentError)
    await expect(svc.stop('cc:nope')).rejects.toBeInstanceOf(UnknownAgentError)
    expect(() => svc.answer('cc:nope', 'perm_0000000001', 'allow')).toThrow(UnknownAgentError)
    expect(svc.pending('cc:nope')).toEqual([])
  })
})

describe('permissions', () => {
  it('MS-perm-where: the card location is never absolute for a cwd outside home', async () => {
    const t = setup()
    const agentId = await t.svc.start({ ...START, cwd: '/srv/work/acme-api' })
    void t.runner.last().ask('Bash', { command: 'pnpm test' })
    const where = t.svc.pending(agentId)[0]!.where
    expect(where).toBe('…/work/acme-api')
    expect(where).not.toMatch(/^(\/|[A-Za-z]:)/)
  })
  it('MS-perm-allow: pending → waiting + published; allow resolves and returns to thinking', async () => {
    const { svc, agentId, session, agents, bus } = await started()
    bus.events = []
    const decision = session.ask('Bash', { command: 'pnpm test\nrm -rf /' })
    expect(svc.pending(agentId)).toEqual([
      { id: 'perm_0000000001', tool: 'Bash', summary: 'pnpm test', where: '~/code/shop-api' },
    ])
    expect(agents.get(agentId)).toMatchObject({
      status: 'waiting',
      text: 'Needs approval',
      managed: { pending: 1 },
    })
    expect(bus.events.some((e) => e.type === 'permission.changed' && e.agentId === agentId)).toBe(
      true,
    )
    svc.answer(agentId, 'perm_0000000001', 'allow')
    await expect(decision).resolves.toEqual({ behavior: 'allow' })
    expect(agents.get(agentId)).toMatchObject({ status: 'thinking', managed: { pending: 0 } })
    // Unknown request ids are ignored.
    svc.answer(agentId, 'perm_9999999999', 'allow')
  })

  it('MS-perm-session: allow-session auto-allows the same tool (Bash by first word)', async () => {
    const { svc, agentId, session } = await started()
    const a = session.ask('Bash', { command: 'pnpm test' })
    const b = session.ask('Bash', { command: 'pnpm lint' })
    const c = session.ask('Bash', { command: 'git push' })
    svc.answer(agentId, 'perm_0000000001', 'allow-session')
    await expect(a).resolves.toEqual({ behavior: 'allow' })
    await expect(b).resolves.toEqual({ behavior: 'allow' }) // same first word, already pending
    expect(svc.pending(agentId).map((p) => p.summary)).toEqual(['git push'])
    await expect(session.ask('Bash', { command: 'pnpm build' })).resolves.toEqual({
      behavior: 'allow',
    })
    svc.answer(agentId, 'perm_0000000003', 'deny')
    await expect(c).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('MS-perm-deny resolves with a deny message', async () => {
    const { svc, agentId, session } = await started()
    const d = session.ask('Write', { file_path: '/Users/me/code/shop-api/a.txt' })
    expect(svc.pending(agentId)[0]?.summary).toBe('a.txt')
    svc.answer(agentId, 'perm_0000000001', 'deny')
    const r = await d
    expect(r.behavior).toBe('deny')
    expect(r.behavior === 'deny' && r.message).toBeTruthy()
  })

  it('MS-interrupt cancels pending requests, interrupts and adds a system line', async () => {
    const { svc, agentId, session, agents, messages } = await started()
    const d = session.ask('Bash', { command: 'sleep 100' })
    await svc.interrupt(agentId)
    await expect(d).resolves.toEqual({ behavior: 'deny', message: 'Interrupted' })
    expect(session.calls).toContain('interrupt')
    expect(svc.pending(agentId)).toEqual([])
    expect(agents.get(agentId)?.status).toBe('idle')
    expect(messages.byAgent(agentId).at(-1)).toMatchObject({ from: 'system', text: 'Interrupted' })
    // The aborted turn's result does not flip the agent to error.
    session.result('', true)
    expect(agents.get(agentId)?.status).toBe('idle')
  })
})

describe('lifecycle', () => {
  it('MS-stop closes the runner, ends the session and lets the agent leave', async () => {
    const { svc, agentId, session, agents, messages } = await started()
    const d = session.ask('Bash', { command: 'ls' })
    await svc.stop(agentId)
    await expect(d).resolves.toMatchObject({ behavior: 'deny' })
    expect(session.closed).toBe(true)
    expect(agents.get(agentId)).toMatchObject({ status: 'done', managed: { phase: 'ended' } })
    expect(messages.byAgent(agentId).at(-1)?.text).toBe('Session ended')
    expect(svc.isManaged(agentId)).toBe(false)
    expect(svc.count()).toBe(0)
    // The runner's own exit after close is ignored.
    session.exit({})
    expect(agents.get(agentId)?.status).toBe('done')
  })

  it('a crash mid-session marks the agent errored; stop then removes it', async () => {
    const { svc, agentId, session, agents, messages } = await started()
    session.exit({ error: 'crash' })
    expect(agents.get(agentId)).toMatchObject({
      status: 'error',
      text: 'Session ended unexpectedly',
      managed: { phase: 'ended' },
    })
    expect(messages.byAgent(agentId).at(-1)?.text).toBe('Session ended unexpectedly')
    await svc.stop(agentId)
    expect(agents.get(agentId)?.status).toBe('done')
  })

  it('a clean runner exit ends the session as done', async () => {
    const { agentId, session, agents } = await started()
    session.exit({})
    expect(agents.get(agentId)?.status).toBe('done')
  })

  it('MS-skip knows managed session ids while running', async () => {
    const { svc, agentId } = await started()
    expect(svc.isManagedSession('sess-1')).toBe(true)
    expect(svc.isManagedSession('other')).toBe(false)
    await svc.stop(agentId)
    expect(svc.isManagedSession('sess-1')).toBe(false)
  })

  it('stopAll stops every session', async () => {
    const { svc, runner } = setup()
    await svc.start(START)
    await svc.start(START)
    await svc.stopAll()
    expect(svc.count()).toBe(0)
    expect(runner.sessions.every((s) => s.closed)).toBe(true)
  })

  it('keeps running sessions from expiring with a heartbeat', async () => {
    const { agentId, agents, clock, scheduler, svc } = await started()
    clock.advance(5 * 60_000)
    scheduler.runAll()
    expect(agents.get(agentId)?.lastSeen).toBe(clock.now())
    await svc.stop(agentId)
    expect(scheduler.jobs.every((j) => j.cancelled)).toBe(true)
  })

  it('MS-rate limits calls per agent to 10 per second', async () => {
    const { svc, agentId, clock } = await started()
    for (let i = 0; i < 10; i++) await svc.setMode(agentId, 'plan')
    await expect(svc.setMode(agentId, 'plan')).rejects.toBeInstanceOf(RateLimitedError)
    clock.advance(1000)
    await svc.setMode(agentId, 'plan')
  })

  it('refuses to send to an ended session', async () => {
    const { compose, svc, agentId, session } = await started()
    session.exit({ error: 'crash' })
    expect(svc.isManaged(agentId)).toBe(false)
    // It now routes through the inbox like any agent (the composer is disabled in the UI).
    const m = await compose.send(agentId, { text: 'hi', context: [], use: [] })
    expect(m.state).toBe('queued')
  })
})

// ── multi-provider runtimes (plan §2, MS-P) ──

const CODEX_DECL = {
  provider: 'codex' as const,
  prefix: 'cx:',
  caps: ['launch', 'send-message', 'interrupt', 'stop', 'change-mode'] as (
    'launch' | 'send-message' | 'interrupt' | 'stop' | 'change-mode'
  )[],
  modes: [
    { id: 'read-only', label: 'Read only' },
    { id: 'ask', label: 'Ask before changes' },
    { id: 'full-access', label: 'Full access (dangerous)', dangerous: true },
  ],
  defaultModeId: 'ask',
  fallbackModels: [{ id: 'gpt-5', label: 'GPT-5' }],
}

function setupMulti(over: Partial<Settings> = {}) {
  const t = setup(over)
  const codex = new FakeAgentRunner(CODEX_DECL)
  const svc = new ManagedSessionService({
    runner: t.runner,
    runtimes: new Map([['codex', codex]]),
    activity: t.activity,
    agents: t.agents,
    messages: t.messages,
    inbox: t.inbox,
    settings: { get: async () => t.settings },
    bus: t.bus,
    clock: t.clock,
    scheduler: t.scheduler,
    ids: new SeqIds(),
  })
  return { ...t, svc, codex }
}

const CODEX_START: StartSession = { ...START, provider: 'codex', model: 'gpt-5' }

describe('multi-provider runtimes', () => {
  it('MS-P1 a Codex runtime gives cx: ids, provider codex, and maps its events', async () => {
    const t = setupMulti()
    const id = await t.svc.start(CODEX_START)
    expect(id).toBe('cx:sess-1')
    expect(t.agents.get(id)).toMatchObject({ provider: 'codex', source: 'managed' })
    t.codex.last().emit({ status: 'tool', tool: 'Bash' })
    expect(t.agents.get(id)).toMatchObject({ provider: 'codex', status: 'tool', tool: 'Bash' })
    expect(t.svc.isManagedSession('sess-1')).toBe(false) // Claude-only (the tailer)
    await expect(t.svc.start({ ...START, provider: 'cursor' })).rejects.toMatchObject({
      code: 'runtime',
    })
  })

  it('MS-P2 sets caps, modes and the default mode; Claude agents keep caps undefined', async () => {
    const t = setupMulti()
    const id = await t.svc.start(CODEX_START)
    const a = t.agents.get(id)!
    expect(a.caps).toEqual(CODEX_DECL.caps)
    expect(a.modeId).toBe('ask')
    expect(a.managed?.modes).toEqual(CODEX_DECL.modes)
    expect(t.codex.last().options).toMatchObject({ modeId: 'ask', allowBypass: false })
    t.codex.last().models = []
    expect(await t.svc.models(id)).toEqual(CODEX_DECL.fallbackModels)
    const claude = await t.svc.start(START)
    expect(t.agents.get(claude)?.caps).toBeUndefined()
    expect(t.agents.get(claude)?.modeId).toBeUndefined()
    expect(t.agents.get(claude)?.managed?.modes).toBeUndefined()
    expect(t.runner.last().options.modeId).toBeUndefined()
    await t.svc.stop(id)
    expect(t.agents.get(id)?.caps).toEqual(['observe', 'stop'])
  })

  it('MS-P3 dangerous modes need allowBypassPermissions, at start and in setModeId', async () => {
    const off = setupMulti()
    await expect(off.svc.start({ ...CODEX_START, modeId: 'full-access' })).rejects.toBeInstanceOf(
      NotAllowedError,
    )
    await expect(off.svc.start({ ...CODEX_START, modeId: 'nope' })).rejects.toThrow(/mode/)
    const id = await off.svc.start(CODEX_START)
    await expect(off.svc.setModeId(id, 'full-access')).rejects.toBeInstanceOf(NotAllowedError)
    await expect(off.svc.setModeId(id, 'nope')).rejects.toThrow(/mode/)
    await off.svc.setModeId(id, 'read-only')
    expect(off.codex.last().calls).toContain('modeId:read-only')
    expect(off.agents.get(id)?.modeId).toBe('read-only')
    expect(off.messages.byAgent(id).at(-1)).toMatchObject({
      from: 'system',
      text: 'Mode → Read only',
    })
    const on = setupMulti({ allowBypassPermissions: true })
    const id2 = await on.svc.start({ ...CODEX_START, modeId: 'full-access' })
    expect(on.codex.last().options).toMatchObject({ modeId: 'full-access', allowBypass: true })
    await on.svc.setModeId(id2, 'ask')
    await on.svc.setModeId(id2, 'full-access')
    const claude = await on.svc.start(START)
    await expect(on.svc.setModeId(claude, 'ask')).rejects.toThrow(/mode/)
  })

  it('MS-P4 the session cap of 6 applies across providers', async () => {
    const t = setupMulti()
    for (let i = 0; i < 3; i++) await t.svc.start(START)
    for (let i = 0; i < 3; i++) await t.svc.start(CODEX_START)
    await expect(t.svc.start(CODEX_START)).rejects.toMatchObject({ code: 'limit' })
    await expect(t.svc.start(START)).rejects.toMatchObject({ code: 'limit' })
  })

  it('MS-P5 owns covers every live managed id, of any provider', async () => {
    const t = setupMulti()
    const cx = await t.svc.start(CODEX_START)
    const cc = await t.svc.start(START)
    expect([t.svc.owns(cx), t.svc.owns(cc), t.svc.owns('cu:x')]).toEqual([true, true, false])
    await t.svc.stop(cx)
    expect(t.svc.owns(cx)).toBe(false)
  })

  it('MS-P6 Claude ids, provider and fallback models are unchanged; chrome needs the cap', async () => {
    const t = setupMulti()
    const cc = await t.svc.start(START)
    expect(cc).toBe('cc:sess-1')
    expect(t.agents.get(cc)?.provider).toBe('claude-code')
    expect(await t.svc.models()).toEqual(FALLBACK_MODELS)
    await expect(t.svc.start({ ...CODEX_START, chrome: true })).rejects.toBeInstanceOf(
      NotAllowedError,
    )
    expect(t.svc.knownModels('codex')).toBeUndefined()
    const cx = await t.svc.start(CODEX_START)
    await t.svc.models(cx)
    expect(t.svc.knownModels('codex')).toEqual(t.codex.last().models)
    expect(await t.svc.models()).toEqual(FALLBACK_MODELS) // Codex models never leak into Claude's
  })
})
