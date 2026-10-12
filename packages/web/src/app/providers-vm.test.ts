import type {
  Agent,
  ConnectionInfo,
  ProviderId,
  ProviderStatus,
  SessionCap,
} from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { COPY, PROVIDER_DOCS } from './connect-copy.ts'
import { SESSION_COPY } from './session-copy.ts'
import type { Draft, NewSessionForm } from './session-types.ts'
import { applyMessage, emptyState } from './state.ts'
import {
  composerVM,
  connectVM,
  emptyStateVM,
  hintFor,
  newSessionVM,
  panelVM,
  sessionHeaderVM,
  useMenuVM,
} from './view-models.ts'

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'cx:1',
  name: 'Cody',
  provider: 'codex',
  topic: 'x',
  kind: 'main',
  status: 'thinking',
  text: '',
  source: 'managed',
  since: 0,
  lastSeen: 0,
  interactive: true,
  unread: 0,
  ...over,
})
const MODES = [
  { id: 'read-only', label: 'Read only' },
  { id: 'ask', label: 'Ask before changes' },
  { id: 'full-access', label: 'Full access', dangerous: true },
]
const running = { chrome: false, pending: 0, phase: 'running' as const, modes: MODES }
const ALL: SessionCap[] = [
  'launch',
  'send-message',
  'interrupt',
  'stop',
  'approve-tools',
  'select-model',
  'change-mode',
  'attach-context',
]
const without = (...c: SessionCap[]) => ALL.filter((x) => !c.includes(x))
const draft: Draft = { text: '', context: [], use: [] }

const status = (id: ProviderId, over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id,
  label: {
    'claude-code': 'Claude Code',
    codex: 'Codex',
    cursor: 'Cursor',
    gemini: 'Gemini CLI',
    copilot: 'Copilot CLI',
    chatgpt: 'ChatGPT',
  }[id],
  state: 'managed-available',
  enabled: true,
  managedCaps: ALL,
  observedCaps: [],
  integration: { managed: 'app-server' },
  activeSessions: 0,
  ...over,
})

describe('capability gating (docs/provider-integrations.md §3)', () => {
  it('header: modes need change-mode, models need select-model, buttons need interrupt/stop', () => {
    const models = [{ id: 'gpt', label: 'GPT' }]
    const full = sessionHeaderVM(
      agent({ caps: ALL, managed: running, modeId: 'ask' }),
      models,
      false,
    )!
    expect(full.modes.map((m) => [m.id, m.checked])).toEqual([
      ['read-only', false],
      ['ask', true],
      ['full-access', false],
    ])
    expect(full.mode.text).toContain('Ask before changes')
    expect(full.models).toHaveLength(1)
    expect(full.canInterrupt).toBe(true)
    expect(full.canStop).toBe(true)

    const bare = sessionHeaderVM(
      agent({
        caps: without('change-mode', 'select-model', 'interrupt', 'stop'),
        managed: running,
      }),
      models,
      false,
    )!
    expect(bare).toMatchObject({ modes: [], models: [], canInterrupt: false, canStop: false })
  })

  it('header: dangerous provider modes only with allowBypass', () => {
    const vm = sessionHeaderVM(agent({ caps: ALL, managed: running }), [], true)!
    expect(vm.modes.map((m) => [m.id, m.dangerous, m.disabled])).toEqual([
      ['read-only', undefined, undefined],
      ['ask', undefined, undefined],
      ['full-access', true, undefined],
    ])
    const off = sessionHeaderVM(agent({ caps: ALL, managed: running }), [], false)!
    expect(off.modes.map((m) => [m.id, m.disabled])).toEqual([
      ['read-only', undefined],
      ['ask', undefined],
      ['full-access', true],
    ])
  })

  it('header: Claude managed session without modes keeps PERMISSION_MODES', () => {
    const vm = sessionHeaderVM(
      agent({
        provider: 'claude-code',
        caps: ALL,
        managed: { chrome: false, pending: 0, phase: 'running' },
      }),
      [],
      false,
    )!
    expect(vm.modes.map((m) => m.id)).toContain('plan')
  })

  it('composer: send-message else observation only with the provider label', () => {
    const observed = agent({ id: 'cu:1', provider: 'cursor', caps: ['observe'], source: 'hook' })
    const vm = composerVM(observed, draft, [], 'Cursor')
    expect(vm.disabled).toBe(true)
    expect(vm.placeholder).toBe('Observation only — reply in Cursor')
    expect(vm.canAddContext).toBe(false)
    const ok = composerVM(agent({ caps: ALL, managed: running }), draft, [], 'Codex')
    expect(ok.disabled).toBe(false)
    expect(
      composerVM(agent({ caps: ALL, managed: { ...running, phase: 'ended' } }), draft, [], 'Codex')
        .placeholder,
    ).toBe(SESSION_COPY.composer.ended)
  })

  it('composer: attach-context gates the context picker', () => {
    const vm = composerVM(agent({ caps: without('attach-context'), managed: running }), draft, [])
    expect(vm).toMatchObject({ disabled: false, canAddContext: false, canAddUse: true })
  })

  it('permission card needs approve-tools', () => {
    const mk = (caps: SessionCap[]) =>
      applyMessage(
        applyMessage(emptyState(), {
          type: 'snapshot',
          agents: [agent({ caps, managed: { ...running, pending: 1 } })],
          messages: [],
        }),
        {
          type: 'permission',
          agentId: 'cx:1',
          requests: [{ id: 'p', tool: 'Bash', summary: 's' }],
        } as never,
      )
    const withCap = panelVM(mk(ALL), 'cx:1', 1)
    const noCap = panelVM(mk(without('approve-tools')), 'cx:1', 1)
    expect(withCap.permission?.request.id).toBe('p')
    expect(noCap.permission).toBeNull()
  })

  it('Use… menu: Chrome only with the chrome cap when caps are known', () => {
    const entries = (caps?: SessionCap[]) =>
      useMenuVM([], 'cursor', [], false, caps).groups.flatMap((g) => g.entries.map((e) => e.id))
    expect(entries([...ALL, 'chrome'])).toContain('mcp:claude-in-chrome')
    expect(entries(ALL)).not.toContain('mcp:claude-in-chrome')
    // Legacy: no caps → provider decides.
    expect(useMenuVM([], 'claude-code', []).groups[0]!.id).toBe('browser')
  })

  it('hintFor: capability-aware agents get no hook hint (the composer explains)', () => {
    expect(hintFor(agent({ provider: 'cursor', caps: ['observe'], interactive: false }))).toBeNull()
    // Without caps the legacy hint stays.
    expect(
      hintFor(agent({ provider: 'langgraph', interactive: false, managed: undefined }))?.action,
    ).toBe('open-connect')
  })

  it('without caps nothing changes for Claude', () => {
    const a = agent({
      provider: 'claude-code',
      managed: { chrome: false, pending: 0, phase: 'running' },
    })
    expect(sessionHeaderVM(a, [], false)!.canStop).toBe(true)
    expect(composerVM(a, draft).disabled).toBe(false)
  })

  it('panelVM passes the provider label into the observation-only copy', () => {
    const s = applyMessage(emptyState(), {
      type: 'snapshot',
      agents: [agent({ id: 'gm:1', provider: 'gemini', caps: ['observe'], source: 'hook' })],
      messages: [],
    })
    const vm = panelVM(s, 'gm:1', 1, undefined, undefined, { providers: [status('gemini')] })
    expect(vm.composer.placeholder).toBe('Observation only — reply in Gemini CLI')
  })
})

const info = (providers?: ProviderStatus[]): ConnectionInfo => ({
  api: { host: '127.0.0.1', port: 4317, listening: true, portBusy: false, tokenFile: 't' },
  claude: { enabled: true, projectsDir: '~/p', projectsDirFound: true, activeSessions: 0 },
  hook: 'not-installed',
  mock: { enabled: false },
  ...(providers && { providers }),
})
const cards = (providers?: ProviderStatus[]) =>
  connectVM({ info: info(providers), state: emptyState(), tab: 'providers', lang: 'curl', now: 0 })

describe('connectVM: Providers tab', () => {
  it('absent providers: empty cards, tab present and off', () => {
    const vm = cards()
    expect(vm.providers.cards).toEqual([])
    expect(vm.tabs.find((t) => t.id === 'providers')).toEqual({
      id: 'providers',
      label: 'Providers',
      tone: 'off',
    })
  })

  it.each([
    ['connected', 'ok'],
    ['managed-available', 'ok'],
    ['observe-only', 'ok'],
    ['installed', 'pending'],
    ['needs-auth', 'warn'],
    ['needs-setup', 'warn'],
    ['unsupported-version', 'warn'],
    ['disconnected', 'warn'],
    ['error', 'error'],
    ['not-installed', 'off'],
    ['disabled', 'off'],
  ] as const)('state %s → tone %s', (state, tone) => {
    const card = cards([status('codex', { state })]).providers.cards[0]!
    expect(card.pill.tone).toBe(tone)
    expect(card.pill.text.length).toBeGreaterThan(0)
  })

  it('card: version, integration, sessions, chips, toggle, docs', () => {
    const c = cards([
      status('cursor', {
        version: '2026.10.01',
        testedVersion: '2026.10.01',
        activeSessions: 2,
        managedCaps: ['launch', 'send-message', 'approve-tools'],
        observedCaps: ['observe'],
        integration: { managed: 'acp', observe: 'hooks' },
        hooks: 'installed',
      }),
    ]).providers.cards[0]!
    expect(c).toMatchObject({
      id: 'cursor',
      label: 'Cursor',
      version: 'v2026.10.01 · tested 2026.10.01',
      integration: 'Managed: ACP · Observed: hooks',
      sessions: '2 active sessions',
      managedCaps: ['Start', 'Send', 'Approve tools'],
      observedCaps: ['Observe'],
      toggle: { on: true },
      hooks: {
        status: { text: 'Installed ✓', tone: 'ok' },
        action: 'uninstall',
        button: 'Remove hooks',
      },
      docsUrl: PROVIDER_DOCS.cursor,
    })
    expect(cards([status('codex', { activeSessions: 1 })]).providers.cards[0]!.sessions).toBe(
      '1 active session',
    )
    expect(cards([status('codex')]).providers.cards[0]!.sessions).toBeUndefined()
    expect(cards([status('codex')]).providers.cards[0]!.version).toBeUndefined()
  })

  it('hooks row only when status.hooks is defined; outdated → repair; missing → install', () => {
    expect(cards([status('codex')]).providers.cards[0]!.hooks).toBeUndefined()
    expect(
      cards([status('gemini', { hooks: 'outdated' })]).providers.cards[0]!.hooks,
    ).toMatchObject({
      action: 'repair',
      button: 'Repair hooks',
      status: { tone: 'warn' },
    })
    expect(
      cards([status('gemini', { hooks: 'not-installed' })]).providers.cards[0]!.hooks,
    ).toMatchObject({
      action: 'install',
      button: 'Install hooks',
      status: { tone: 'off' },
    })
  })

  it('chatgpt has no toggle; hint copy per provider', () => {
    expect(
      cards([status('chatgpt', { state: 'disabled', enabled: false })]).providers.cards[0]!.toggle,
    ).toBeUndefined()
    const hint = (id: ProviderId) =>
      cards([status(id, { state: 'needs-auth', hint: 'login-required' })]).providers.cards[0]!.hint
    expect(hint('codex')).toBe('Run `codex login` in a terminal, then Check again')
    expect(hint('cursor')).toContain('`agent login`')
    expect(hint('gemini')).toContain('`gemini`')
    expect(hint('copilot')).toContain('/login')
    for (const h of [
      'install-cli',
      'update-cli',
      'hooks-invalid-config',
      'hooks-outdated',
      'hooks-need-enable',
      'probe-timeout',
      'probe-failed',
      'opt-in-tunnel',
      'no-observation-surface',
    ] as const)
      expect(cards([status('codex', { hint: h })]).providers.cards[0]!.hint).toBeTruthy()
  })

  it('canStart: enabled, launch cap, and a ready state', () => {
    const can = (over: Partial<ProviderStatus>) =>
      cards([status('codex', over)]).providers.cards[0]!.canStart
    expect(can({})).toBe(true)
    expect(can({ state: 'connected' })).toBe(true)
    expect(can({ state: 'installed' })).toBe(true)
    expect(can({ state: 'needs-auth' })).toBe(false)
    expect(can({ enabled: false })).toBe(false)
    expect(can({ managedCaps: ['observe'] })).toBe(false)
  })

  it('tab tone is the worst enabled provider', () => {
    const tone = (p: ProviderStatus[]) => cards(p).tabs.find((t) => t.id === 'providers')!.tone
    expect(tone([status('codex'), status('cursor', { state: 'needs-auth' })])).toBe('warn')
    expect(tone([status('codex'), status('cursor', { state: 'error' })])).toBe('error')
    expect(tone([status('codex', { state: 'error', enabled: false })])).toBe('off')
    expect(tone([status('codex')])).toBe('ok')
  })
})

describe('emptyStateVM: providers tile', () => {
  it('a fourth tile opens the Providers tab', () => {
    const t = emptyStateVM(info([status('codex')]), 'idle').tiles[3]!
    expect(t).toMatchObject({
      id: 'providers',
      title: COPY.empty.providers.title,
      body: 'Codex, Cursor, Gemini CLI, Copilot CLI',
      button: 'Set up',
    })
    expect(t.pill.tone).toBe('ok')
    expect(emptyStateVM(info(), 'idle').tiles[3]!.pill.tone).toBe('off')
  })
})

describe('newSessionVM: providers', () => {
  const form = (over: Partial<NewSessionForm> = {}): NewSessionForm => ({
    provider: 'claude-code',
    name: '',
    mode: 'default',
    extraFolders: [],
    chrome: false,
    text: '',
    context: [],
    use: [],
    ...over,
  })
  const provs = [
    status('claude-code', { managedCaps: [...ALL, 'chrome'] }),
    status('codex', { modes: MODES }),
    status('cursor', { state: 'needs-auth', modes: MODES }),
    status('gemini', { enabled: false }),
    status('copilot', { managedCaps: ['observe'] }),
    status('chatgpt', { state: 'disabled', enabled: false, managedCaps: [] }),
  ]

  it('lists only ready, enabled, launch-capable providers; marks the selected one', () => {
    const vm = newSessionVM(form({ provider: 'codex' }), undefined, false, 0, { providers: provs })
    expect(vm.providers).toEqual([
      { id: 'claude-code', label: 'Claude Code', selected: false },
      { id: 'codex', label: 'Codex', selected: true },
    ])
  })

  it('Claude: existing modes, fallback models, Chrome available', () => {
    const vm = newSessionVM(form(), undefined, false, 0, { providers: provs })
    expect(vm.modes.map((m) => m.id)).toContain('plan')
    expect(vm.models.map((m) => m.id)).toContain('opus')
    expect(vm.chrome.available).toBe(true)
    expect(vm.attachAvailable).toBe(true)
  })

  it('Codex: provider modes (default first non-dangerous), its models, no Chrome', () => {
    const vm = newSessionVM(
      form({ provider: 'codex' }),
      [{ id: 'gpt-5', label: 'GPT-5' }],
      false,
      0,
      { providers: provs },
    )
    expect(vm.modes.map((m) => [m.id, m.checked, m.disabled])).toEqual([
      ['read-only', true, undefined],
      ['ask', false, undefined],
      ['full-access', false, true],
    ])
    expect(vm.models.map((m) => m.id)).toEqual(['', 'gpt-5'])
    expect(vm.chrome.available).toBe(false)
    const picked = newSessionVM(form({ provider: 'codex', modeId: 'ask' }), [], true, 0, {
      providers: provs,
    })
    expect(picked.modes.map((m) => [m.id, m.checked])).toEqual([
      ['read-only', false],
      ['ask', true],
      ['full-access', false],
    ])
  })

  it('title: Claude keeps its heading; others use the provider label', () => {
    expect(newSessionVM(form(), undefined, false, 0, { providers: provs }).title).toBe(
      'New Claude Code session',
    )
    expect(
      newSessionVM(form({ provider: 'codex' }), [], false, 0, { providers: provs }).title,
    ).toBe('New Codex session')
  })

  it('attachAvailable follows the attach-context cap', () => {
    const p = [status('codex', { managedCaps: without('attach-context') })]
    const vm = newSessionVM(form({ provider: 'codex' }), [], false, 0, { providers: p })
    expect(vm.attachAvailable).toBe(false)
    expect(vm.composer.canAddContext).toBe(false)
  })

  it('without provider info: Claude only (older main)', () => {
    const vm = newSessionVM(form(), undefined, false, 0)
    expect(vm.providers).toEqual([{ id: 'claude-code', label: 'Claude Code', selected: true }])
    expect(vm.attachAvailable).toBe(true)
  })
})
