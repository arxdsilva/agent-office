import {
  DEFAULT_SETTINGS,
  type Agent,
  type ChatMessage,
  type ConnectionInfo,
} from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { applyMessage, emptyState } from './state.ts'
import { COPY } from './connect-copy.ts'
import { TEST_AGENT_ID, type ConnectVM, type EmptyPhase } from './connect-types.ts'
import {
  activityLabel,
  connectVM,
  emptyPhase,
  emptyStateVM,
  addContext,
  graphicsVM,
  composerVM,
  hintFor,
  hookVM,
  hudVM,
  newSessionVM,
  panelVM,
  permissionVM,
  sessionHeaderVM,
  settingsVM,
  startErrorText,
  toggleUse,
  useMenuVM,
} from './view-models.ts'
import { cap } from './__fixtures__/capabilities.ts'
import { CHROME_ID, MAX_MANAGED, type Draft, type NewSessionForm } from './session-types.ts'
import { SESSION_COPY } from './session-copy.ts'

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'a',
  name: 'Ada',
  provider: 'claude-code',
  topic: 'Refactor auth',
  model: 'claude-opus-5-5',
  kind: 'main',
  status: 'tool',
  tool: 'Bash',
  text: 'npm test',
  source: 'claude-code',
  since: 0,
  lastSeen: 50_000,
  interactive: true,
  unread: 0,
  ...over,
})
const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: 'm',
  agentId: 'a',
  from: 'user',
  text: 'hi',
  ts: 1,
  state: 'queued',
  ...over,
})
const stateWith = (agents: Agent[], messages: ChatMessage[] = []) =>
  applyMessage(emptyState(), { type: 'snapshot', agents, messages })

describe('panelVM', () => {
  it('describes the agent, its activity and thread', () => {
    const s = stateWith(
      [agent()],
      [
        msg({ id: 'm1', state: 'replied' }),
        msg({ id: 'm2', from: 'agent', text: 'done', state: 'replied' }),
      ],
    )
    const vm = panelVM(s, 'a', 60_000)!
    expect(vm).toMatchObject({
      id: 'a',
      present: true,
      name: 'Ada',
      subtitle: 'main · claude-code · claude-opus-5-5',
      // Chips send `{provider, id}` refs.
      provider: 'claude-code',
    })
    expect(panelVM(s, 'gone', 0).provider).toBe('')
    expect(vm.meta).toEqual([
      ['Topic', 'Refactor auth'],
      ['Status', 'tool (Bash)'],
      ['Activity', 'npm test'],
      ['Active', 'for 1m'],
      ['Last seen', '10s ago'],
    ])
    expect(vm.thread).toEqual([
      { id: 'm1', from: 'user', text: 'hi', stateLabel: '✓✓ replied' },
      { id: 'm2', from: 'agent', text: 'done' },
    ])
  })

  it('lists the capabilities the agent has used (chips), only when there are any', () => {
    const s = stateWith([agent()])
    const chip = { id: 'web', label: 'Web', count: 2, color: '#2CB6A0' }
    expect(panelVM(s, 'a', 0, undefined, { adapters: [chip], library: [] }).used).toEqual({
      adapters: [chip],
      library: [],
    })
    expect(panelVM(s, 'a', 0, undefined, { adapters: [], library: [] }).used).toBeUndefined()
    expect(panelVM(s, 'a', 0).used).toBeUndefined()
  })

  it('links the parent and handles agents that left', () => {
    const s = stateWith([agent({ id: 'p', name: 'Parent' }), agent({ id: 'c', parentId: 'p' })])
    expect(panelVM(s, 'c', 0)!.parent).toEqual({ id: 'p', name: 'Parent' })
    expect(panelVM(s, 'gone', 0)).toMatchObject({
      present: false,
      name: 'This agent has left the office',
    })
  })

  it('passes the hook status into the hint (the reported bug: installed but "not installed")', () => {
    const s = stateWith([agent({ interactive: false })])
    expect(panelVM(s, 'a', 0, undefined, undefined, { hook: 'installed' }).hint).toEqual({
      text: SESSION_COPY.hint.waitingCheckIn,
    })
  })
})

describe('hintFor (plan §2.5)', () => {
  const sub = agent({ id: 's', parentId: 'a' })
  it('HF-1: managed sessions need no hint', () => {
    const managed = { chrome: false, pending: 0, phase: 'running' as const }
    expect(hintFor(agent({ managed, interactive: false }), 'not-installed')).toBeNull()
  })
  it('HF-2: subagents point at their parent, whatever the hook', () => {
    for (const hook of ['installed', 'outdated', 'not-installed'] as const)
      expect(hintFor(sub, hook)).toEqual({
        text: SESSION_COPY.hint.subagent,
        action: 'open-parent',
        label: SESSION_COPY.hint.openParent,
      })
  })
  it('HF-3: hook not installed offers the install', () => {
    expect(hintFor(agent(), 'not-installed')).toEqual({
      text: SESSION_COPY.hint.notInstalled,
      action: 'install-hook',
      label: SESSION_COPY.hint.install,
    })
  })
  it('HF-4: an outdated hook offers the repair', () => {
    expect(hintFor(agent(), 'outdated')).toEqual({
      text: SESSION_COPY.hint.outdated,
      action: 'install-hook',
      label: SESSION_COPY.hint.repair,
    })
  })
  it('HF-5: installed but not checked in yet says so, without a button', () => {
    expect(hintFor(agent({ interactive: false }), 'installed')).toEqual({
      text: SESSION_COPY.hint.waitingCheckIn,
    })
  })
  it('HF-6: installed and reading, idle: delivered on the next prompt', () => {
    expect(hintFor(agent({ status: 'waiting' }), 'installed')?.text).toMatch(/next prompt/)
    expect(hintFor(agent({ status: 'idle' }), 'installed')?.action).toBeUndefined()
  })
  it('HF-7: installed and reading, busy: delivered when the turn ends', () => {
    expect(hintFor(agent(), 'installed')?.text).toMatch(/current turn ends/)
  })
  it('HF-8: other providers not reading their inbox point at Connect', () => {
    expect(hintFor(agent({ provider: 'langgraph', interactive: false }), 'installed')).toEqual({
      text: COPY.hint.notReading,
      action: 'open-connect',
    })
  })
  it('HF-9: other providers reading their inbox need no hint', () => {
    expect(hintFor(agent({ provider: 'langgraph' }), 'not-installed')).toBeNull()
  })
  it('defaults to "not installed" when the hook status is unknown', () => {
    expect(hintFor(agent())?.action).toBe('install-hook')
  })
})

describe('activityLabel', () => {
  it('says where the agent is and what it is doing', () => {
    expect(activityLabel('arriving')).toBe('Arriving')
    expect(activityLabel('leaving')).toBe('Leaving')
    expect(activityLabel('kitchen')).toBe('Getting coffee')
    expect(activityLabel('lounge')).toBe('Relaxing in the lounge')
    expect(activityLabel('cafe')).toBe('Taking a break at the cafe')
    expect(activityLabel('pingpong')).toBe('Playing ping-pong')
    expect(activityLabel('desk-work')).toBe('Working at their desk')
    expect(activityLabel('desk-think')).toBe('Thinking at their desk')
    expect(activityLabel('desk-error')).toBe('Stuck on an error at their desk')
    expect(activityLabel('desk-idle')).toBe('Idle at their desk')
    expect(activityLabel('desk-work', { room: 'pod-3' })).toBe('Working at their desk in pod 3')
  })

  it('names meeting rooms and booths, and counts the team', () => {
    expect(activityLabel('meeting', { room: 'meeting-A', subagents: 2 })).toBe(
      'In meeting room A with 2 subagents',
    )
    expect(activityLabel('meeting', { room: 'meeting-B', subagents: 1 })).toBe(
      'In meeting room B with 1 subagent',
    )
    expect(activityLabel('meeting', { room: 'meeting-A', with: 'Ada' })).toBe(
      "In meeting room A with Ada's team",
    )
    expect(activityLabel('meeting')).toBe('In a meeting')
    expect(activityLabel('booth', { room: 'booth-3' })).toBe('Waiting for you in booth 3')
    expect(activityLabel('booth')).toBe('Waiting for you in a phone booth')
  })

  it('names the capability an agent calls or visits (adapters room and library)', () => {
    const gmail = { label: 'Gmail', category: 'adapter' as const }
    expect(
      activityLabel('connection-call', { capability: { ...gmail, tool: 'search_threads' } }),
    ).toBe('Calling Gmail (search_threads)')
    expect(activityLabel('connection-call', { capability: gmail })).toBe('Calling Gmail')
    expect(activityLabel('connection-visit', { capability: gmail })).toBe(
      'Working at the Gmail station',
    )
    const skill = { label: 'run-office', category: 'skill' as const }
    const rule = { label: 'TESTING.md', category: 'rule' as const }
    expect(activityLabel('library-call', { capability: skill })).toBe(
      'Consulting run-office (skill)',
    )
    expect(activityLabel('library-call', { capability: rule })).toBe('Reading TESTING.md')
    expect(activityLabel('library-visit', { capability: skill })).toBe(
      'In the library reading run-office',
    )
    // Without capability details the sentence stays generic.
    expect(activityLabel('connection-call')).toBe('Calling an adapter')
    expect(activityLabel('connection-visit')).toBe('Working in the Adapters room')
    expect(activityLabel('library-call')).toBe('Consulting the library')
    expect(activityLabel('library-visit')).toBe('Reading in the library')
  })
})

describe('panelVM activity', () => {
  it('adds an activity line only when the director knows the activity', () => {
    const s = stateWith([agent()])
    expect(panelVM(s, 'a', 0).activity).toBeUndefined()
    const vm = panelVM(s, 'a', 0, { activity: 'booth', room: 'booth-3' })
    expect(vm.activity).toBe('Waiting for you in booth 3')
    expect(vm.meta[2]).toEqual(['Now', 'Waiting for you in booth 3'])
    expect(panelVM(s, 'gone', 0, { activity: 'leaving' }).activity).toBeUndefined()
  })
})

describe('hudVM', () => {
  it('counts agents per status', () => {
    const vm = hudVM(
      stateWith([
        agent(),
        agent({ id: 'b', status: 'waiting' }),
        agent({ id: 'c', status: 'tool' }),
      ]),
    )
    expect(vm.count).toBe('3 agents')
    expect(vm.statuses.find((s) => s.status === 'tool')).toMatchObject({
      count: 2,
      color: '#f5a524',
    })
    expect(hudVM(stateWith([agent()])).count).toBe('1 agent')
  })
})

describe('settingsVM', () => {
  const base = {
    settings: DEFAULT_SETTINGS,
    hook: 'not-installed' as const,
    version: '1.0.0',
    update: { policy: 'auto' as const, status: 'idle' as const },
  }

  it('carries the capability discovery switch (default on)', () => {
    expect(settingsVM(base).discoverCapabilities).toBe(true)
    expect(
      settingsVM({ ...base, settings: { ...DEFAULT_SETTINGS, discoverCapabilities: false } })
        .discoverCapabilities,
    ).toBe(false)
  })

  it('offers the right hook action', () => {
    // Same mapping as the Connect panel (hookVM).
    expect(settingsVM(base).hook).toEqual({
      label: 'Not installed',
      action: 'install',
      button: 'Install',
    })
    expect(settingsVM({ ...base, hook: 'installed' }).hook).toEqual({
      label: 'Installed ✓',
      action: 'uninstall',
      button: 'Uninstall',
    })
    expect(settingsVM({ ...base, hook: 'outdated' }).hook).toEqual({
      label: 'Needs repair (app moved, updated or port changed)',
      action: 'install',
      button: 'Repair',
    })
  })

  it('describes update state and action per policy', () => {
    expect(settingsVM(base).update).toEqual({ label: 'Not checked yet', action: 'check' })
    expect(
      settingsVM({ ...base, update: { policy: 'auto', status: 'ready', version: '2.0.0' } }).update,
    ).toEqual({
      label: 'Version 2.0.0 is ready',
      action: 'install',
    })
    expect(
      settingsVM({
        ...base,
        update: { policy: 'notify-only', status: 'available', version: '2.0.0', url: 'https://x' },
      }).update,
    ).toEqual({
      label: 'Version 2.0.0 is available',
      action: 'download',
      url: 'https://x',
    })
    expect(settingsVM({ ...base, update: { policy: 'off', status: 'idle' } }).update).toEqual({
      label: 'Updates are off in development builds',
      action: null,
    })
    expect(
      settingsVM({ ...base, update: { policy: 'auto', status: 'error', error: 'offline' } }).update
        .label,
    ).toBe('Update check failed: offline')
    expect(
      settingsVM({ ...base, update: { policy: 'auto', status: 'up-to-date' } }).update.label,
    ).toBe('Up to date')
    expect(settingsVM({ ...base, update: { policy: 'auto', status: 'checking' } }).update).toEqual({
      label: 'Checking…',
      action: null,
    })
    expect(
      settingsVM({ ...base, update: { policy: 'auto', status: 'downloading', version: '2' } })
        .update.action,
    ).toBeNull()
  })

  it('passes settings and version through', () => {
    expect(settingsVM(base)).toMatchObject({
      port: 4317,
      notifications: true,
      launchAtLogin: false,
      claudeAdapter: true,
      autoUpdate: true,
      version: 'v1.0.0',
      graphicsQuality: 'auto',
    })
    expect(
      settingsVM({ ...base, settings: { ...DEFAULT_SETTINGS, graphicsQuality: 'ultra' } })
        .graphicsQuality,
    ).toBe('ultra')
  })
})

// ---------------------------------------------------------------------------------------------
// Connect panel, empty state and HUD hint (plan §2)

const info = (over: DeepPartial<ConnectionInfo> = {}): ConnectionInfo => ({
  api: {
    host: '127.0.0.1',
    port: 4317,
    listening: true,
    portBusy: false,
    tokenFile: '~/.agent-office/token',
    ...over.api,
  },
  claude: {
    enabled: true,
    projectsDir: '~/.claude/projects',
    projectsDirFound: true,
    activeSessions: 0,
    ...over.claude,
  } as ConnectionInfo['claude'],
  hook: over.hook ?? 'not-installed',
  mock: { enabled: false, ...over.mock } as ConnectionInfo['mock'],
})
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] }

const vmOf = (
  over: Partial<Parameters<typeof connectVM>[0]> & { agents?: Agent[] } = {},
): ConnectVM =>
  connectVM({
    info: info(),
    state: stateWith(over.agents ?? []),
    tab: 'claude',
    lang: 'curl',
    now: 60_000,
    ...over,
  })

describe('connectVM: Claude Code tab', () => {
  it('pill: sessions, none yet, off, forced off, folder missing', () => {
    const pill = (i: ConnectionInfo) => vmOf({ info: i }).claude.pill
    expect(pill(info({ claude: { activeSessions: 2 } }))).toEqual({
      text: '● 2 active sessions',
      tone: 'ok',
    })
    expect(pill(info({ claude: { activeSessions: 1 } })).text).toBe('● 1 active session')
    expect(pill(info())).toEqual({ text: '○ No sessions yet', tone: 'off' })
    expect(pill(info({ claude: { enabled: false } }))).toEqual({ text: 'Off', tone: 'off' })
    expect(pill(info({ claude: { enabled: false, override: 'off' } }))).toEqual({
      text: 'Off (AGENT_OFFICE_CLAUDE=0)',
      tone: 'off',
    })
    expect(pill(info({ claude: { projectsDirFound: false } }))).toEqual({
      text: '⚠ Projects folder not found',
      tone: 'warn',
    })
  })

  it('toggle carries the env override note; folder line says found or missing', () => {
    expect(vmOf().claude.toggle).toEqual({ on: true })
    expect(
      vmOf({ info: info({ claude: { enabled: false, override: 'off' } }) }).claude.toggle,
    ).toEqual({ on: false, disabledNote: 'Controlled by AGENT_OFFICE_CLAUDE=0 for this run' })
    expect(vmOf({ info: info({ claude: { override: 'on' } }) }).claude.toggle.disabledNote).toBe(
      'Controlled by AGENT_OFFICE_CLAUDE=1 for this run',
    )
    expect(vmOf().claude.folder).toEqual({ ok: true, text: '✓ Found ~/.claude/projects' })
    expect(vmOf({ info: info({ claude: { projectsDirFound: false } }) }).claude.folder).toEqual({
      ok: false,
      text: '⚠ ~/.claude/projects not found: install Claude Code and run claude once',
    })
  })

  it('hook button for each status (hookVM)', () => {
    expect(hookVM('not-installed')).toEqual({
      label: 'Not installed',
      action: 'install',
      button: 'Install',
    })
    expect(hookVM('outdated')).toMatchObject({ action: 'install', button: 'Repair' })
    expect(hookVM('installed')).toEqual({
      label: 'Installed ✓',
      action: 'uninstall',
      button: 'Uninstall',
    })
    expect(vmOf({ info: info({ hook: 'installed' }) }).claude.hook.button).toBe('Uninstall')
  })

  it('verified line: hidden without the hook, pending until a session reads its inbox', () => {
    const cc = agent({ interactive: false, lastSeen: 55_000 })
    expect(vmOf({ agents: [cc] }).claude.verified).toBeUndefined()
    expect(vmOf({ info: info({ hook: 'installed' }), agents: [cc] }).claude.verified).toEqual({
      text: '○ Not verified yet: prompt a session once after installing',
      tone: 'pending',
    })
    expect(
      vmOf({ info: info({ hook: 'installed' }), agents: [{ ...cc, interactive: true }] }).claude
        .verified,
    ).toEqual({ text: '✓ Verified: a session read its inbox 5s ago', tone: 'ok' })
  })

  it('idle note when sessions exist but no claude-code agent is in the office', () => {
    const busy = info({ claude: { activeSessions: 1 } })
    expect(vmOf({ info: busy }).claude.idleNote).toBe(
      'Sessions found but idle. Prompt `claude` and it will walk in.',
    )
    expect(vmOf({ info: busy, agents: [agent()] }).claude.idleNote).toBeUndefined()
    expect(vmOf().claude.idleNote).toBeUndefined()
  })
})

describe('connectVM: Any framework tab', () => {
  it('pill: listening, busy (with the inline port form), starting', () => {
    expect(vmOf().http.pill).toEqual({ text: '● Listening on 127.0.0.1:4317', tone: 'ok' })
    expect(vmOf().http.portBusy).toBeUndefined()
    const busy = vmOf({ info: info({ api: { listening: false, portBusy: true } }) }).http
    expect(busy.pill).toEqual({ text: '✗ Port 4317 busy', tone: 'error' })
    expect(busy.portBusy).toEqual({ port: 4317 })
    expect(vmOf({ info: info({ api: { listening: false } }) }).http.pill).toEqual({
      text: '◌ Starting…',
      tone: 'pending',
    })
  })

  it('endpoint, token file and the snippet for the chosen language', () => {
    const vm = vmOf({ lang: 'python' }).http
    expect(vm.endpoint).toBe('http://127.0.0.1:4317/api/events')
    expect(vm.tokenFile).toBe('~/.agent-office/token')
    expect(vm.lang).toBe('python')
    expect(vm.snippet).toMatch(/^import json, pathlib, urllib\.request/)
    expect(vm.snippetNote).toBeUndefined()
  })

  it('adds the PowerShell note to curl on Windows', () => {
    expect(vmOf({ isWindows: true }).http.snippetNote).toBe(
      'On PowerShell, use the Python snippet.',
    )
    expect(vmOf({ isWindows: true, lang: 'python' }).http.snippetNote).toBeUndefined()
  })

  it('live line: waiting → received → test result', () => {
    expect(vmOf().http.live).toEqual({ text: '◌ Waiting for the first event…', tone: 'pending' })
    const seen = { provider: 'langgraph', ts: 51_000 }
    expect(vmOf({ lastHttp: seen }).http.live).toEqual({
      text: '✓ Received from langgraph · 9s ago',
      tone: 'ok',
    })
    expect(vmOf({ lastHttp: seen, test: { ok: true } }).http.live).toEqual({
      text: '✓ Test agent received',
      tone: 'ok',
    })
    expect(vmOf({ test: { ok: false, error: 'port busy' } }).http.live).toEqual({
      text: '✗ Test failed: port busy',
      tone: 'error',
    })
  })

  it('never puts the token in any snippet', () => {
    const SENTINEL = 'tok-3f9a2c-SENTINEL'
    // A token can't be in ConnectionInfo by contract; even a hostile one stays out of the output.
    const hostile = { ...info(), token: SENTINEL } as ConnectionInfo
    for (const lang of ['curl', 'python', 'js'] as const)
      expect(JSON.stringify(vmOf({ info: hostile, lang }))).not.toContain(SENTINEL)
  })
})

describe('connectVM: Demo tab', () => {
  const mock = (id: string) => agent({ id, provider: 'langgraph', source: 'mock' })
  it('off, on with its agent count, forced on by env', () => {
    expect(vmOf().demo).toEqual({ pill: { text: '○ Off', tone: 'off' }, toggle: { on: false } })
    expect(
      vmOf({ info: info({ mock: { enabled: true } }), agents: [mock('m1'), mock('m2'), agent()] })
        .demo,
    ).toEqual({ pill: { text: '● On (2 agents)', tone: 'ok' }, toggle: { on: true } })
    expect(vmOf({ info: info({ mock: { enabled: true, override: 'on' } }) }).demo).toEqual({
      pill: { text: '● On (AGENT_OFFICE_MOCK=1)', tone: 'ok' },
      toggle: { on: true, disabledNote: 'Controlled by AGENT_OFFICE_MOCK for this run' },
    })
    expect(vmOf({ info: info({ mock: { override: 'off' } }) }).demo.toggle.disabledNote).toBe(
      'Controlled by AGENT_OFFICE_MOCK for this run',
    )
  })
})

describe('connectVM: Connected tab and tab rail', () => {
  it('one row per provider, by count, with how it connected and its status dots', () => {
    const vm = vmOf({
      info: info({ hook: 'installed' }),
      agents: [
        agent({ id: 'c1', lastSeen: 58_000 }),
        agent({ id: 'c2', status: 'waiting', interactive: false }),
        agent({
          id: 'l1',
          provider: 'langgraph',
          source: 'http',
          status: 'thinking',
          lastSeen: 51_000,
        }),
        agent({ id: 'o1', provider: 'openai-agents', source: 'mock' }),
        agent({ id: 'o2', provider: 'openai-agents', source: 'mock' }),
        agent({ id: 'o3', provider: 'openai-agents', source: 'mock' }),
        agent({ id: TEST_AGENT_ID, provider: TEST_AGENT_ID, source: 'http' }),
        agent({ id: 'x', provider: 'custom', source: 'otel' }),
      ],
    })
    expect(vm.connected.rows.map((r) => r.provider)).toEqual([
      'openai-agents',
      'claude-code',
      TEST_AGENT_ID,
      'custom',
      'langgraph',
    ])
    expect(vm.connected.rows[1]).toEqual({
      provider: 'claude-code',
      count: 2,
      dots: ['#f5a524', '#3ccf91'],
      via: 'via transcripts + hook ✓',
      lastSeen: 'last seen 2s ago',
    })
    const via = Object.fromEntries(vm.connected.rows.map((r) => [r.provider, r.via]))
    expect(via).toMatchObject({
      'openai-agents': 'via demo',
      langgraph: 'via HTTP',
      [TEST_AGENT_ID]: 'via test',
      custom: 'via otel',
    })
    expect(vmOf({ agents: [agent({ interactive: false })] }).connected.rows[0]!.via).toBe(
      'via transcripts',
    )
  })

  it('tab rail: labels, the provider count and one tone per tab', () => {
    expect(vmOf({ tab: 'http' }).tab).toBe('http')
    expect(vmOf().tabs).toEqual([
      { id: 'claude', label: 'Claude Code', tone: 'off' },
      { id: 'http', label: 'Any framework', tone: 'ok' },
      { id: 'demo', label: 'Demo', tone: 'off' },
      { id: 'connected', label: 'Connected (0)', tone: 'off' },
    ])
    expect(vmOf({ agents: [agent()] }).tabs[3]).toEqual({
      id: 'connected',
      label: 'Connected (1)',
      tone: 'ok',
    })
  })
})

describe('emptyPhase', () => {
  const base = {
    prev: 'loading' as EmptyPhase,
    ready: false,
    infoReceived: false,
    graceElapsed: false,
    agents: 0,
    dismissed: false,
  }
  it('stays loading until ready() and (the first push or the grace period)', () => {
    expect(emptyPhase(base)).toBe('loading')
    expect(emptyPhase({ ...base, graceElapsed: true })).toBe('loading')
    expect(emptyPhase({ ...base, ready: true })).toBe('loading')
    expect(emptyPhase({ ...base, ready: true, infoReceived: true })).toBe('first-run')
    expect(emptyPhase({ ...base, ready: true, graceElapsed: true })).toBe('first-run')
  })
  it('an agent makes it active, from any phase (sessions found during the grace: no flash)', () => {
    for (const prev of ['loading', 'first-run', 'empty-again', 'dismissed'] as const)
      expect(emptyPhase({ ...base, prev, agents: 1 })).toBe('active')
  })
  it('active → empty-again when the office empties, and stays there', () => {
    const again = { ...base, ready: true, graceElapsed: true }
    expect(emptyPhase({ ...again, prev: 'active' })).toBe('empty-again')
    expect(emptyPhase({ ...again, prev: 'empty-again' })).toBe('empty-again')
    expect(emptyPhase({ ...again, prev: 'active', dismissed: true })).toBe('empty-again')
  })
  it('✕ on the first-run card dismisses it', () => {
    const first = { ...base, ready: true, graceElapsed: true, prev: 'first-run' as const }
    expect(emptyPhase(first)).toBe('first-run')
    expect(emptyPhase({ ...first, dismissed: true })).toBe('dismissed')
    expect(emptyPhase({ ...first, prev: 'dismissed', dismissed: true })).toBe('dismissed')
  })
})

describe('emptyStateVM', () => {
  it('three tiles with live pills and the listening line', () => {
    const vm = emptyStateVM(info(), 'idle')
    expect(vm.listening).toBe('◌ Listening for agents…')
    expect(vm.tiles.map((t) => [t.id, t.title, t.pill.text, t.button])).toEqual([
      ['claude', '▶ Claude Code', '○ No sessions yet', 'Set up →'],
      ['http', '</> Any framework', '● Listening on 127.0.0.1:4317', 'Show me how →'],
      ['demo', '✦ Demo office', '○ Off', 'Try the demo'],
    ])
    expect(vm.tiles[2]!.busy).toBeUndefined()
  })
  it('demo tile: starting (busy) and failed', () => {
    const starting = emptyStateVM(info(), 'starting').tiles[2]!
    expect(starting).toMatchObject({ button: 'Starting demo…', busy: true })
    expect(emptyStateVM(info(), 'failed').tiles[2]!.pill).toEqual({
      text: "Demo didn't start: check the logs.",
      tone: 'error',
    })
  })
})

describe('hudVM hint', () => {
  it('normal controls help, or a Connect link once the office is empty again', () => {
    expect(hudVM(stateWith([])).hint).toEqual({
      text: 'Drag to orbit · WASD to move · scroll to zoom · click an agent to chat',
    })
    expect(hudVM(stateWith([]), 'first-run').hint.action).toBeUndefined()
    for (const phase of ['empty-again', 'dismissed'] as const)
      expect(hudVM(stateWith([]), phase).hint).toEqual({
        text: 'No agents right now ·',
        action: 'connect',
      })
    expect(hudVM(stateWith([agent()]), 'dismissed').hint.action).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------------------------
// Managed sessions: header, composer, Use… menu, permission card, new-session dialog (plan §2.1–2.4)

const running = { chrome: false, pending: 0, phase: 'running' as const, modelId: 'sonnet' }
const MODELS = [
  { id: 'opus', label: 'Opus', description: 'Most capable' },
  { id: 'sonnet', label: 'Sonnet', description: 'Fast' },
]
const ref = (n: string, kind: 'file' | 'folder' = 'folder') => ({
  ref: `ctx_${n.padEnd(12, '0')}`,
  kind,
  label: n,
  hint: `~/code/${n}`,
})
const draft = (over: Partial<Draft> = {}): Draft => ({ text: '', context: [], use: [], ...over })

describe('settingsVM: appearance and bypass', () => {
  it('passes the theme and the bypass permission through', () => {
    const vm = settingsVM({
      settings: { ...DEFAULT_SETTINGS, theme: 'dark', allowBypassPermissions: true },
      hook: 'installed',
      version: '1.0.0',
      update: { policy: 'off', status: 'idle' },
    })
    expect(vm.theme).toBe('dark')
    expect(vm.allowBypassPermissions).toBe(true)
  })
})

describe('sessionHeaderVM', () => {
  it('SH-VM-1: managed header with live pills, modes without bypass unless allowed', () => {
    const vm = sessionHeaderVM(
      agent({ managed: running, permissionMode: 'plan', status: 'thinking' }),
      MODELS,
      false,
    )!
    expect(vm.managed).toBe(true)
    expect(vm.mode.text).toBe('◐ Plan')
    expect(vm.model.text).toBe('✦ Sonnet')
    expect(vm.modes.map((m) => m.id)).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk'])
    expect(vm.modes.find((m) => m.checked)?.id).toBe('plan')
    expect(vm.models.find((m) => m.checked)?.id).toBe('sonnet')
    expect(vm.canInterrupt).toBe(true)
    expect(vm.canStop).toBe(true)
    expect(vm.readOnlyNote).toBeUndefined()

    const allowed = sessionHeaderVM(agent({ managed: running }), MODELS, true)!
    expect(allowed.modes.map((m) => m.id)).toContain('bypassPermissions')
    expect(allowed.mode.text).toBe('◯ Default')
  })

  it('SH-VM-1: Interrupt only while busy or waiting for approval', () => {
    const idle = agent({ managed: running, status: 'idle' })
    expect(sessionHeaderVM(idle, MODELS, false)!.canInterrupt).toBe(false)
    const asking = agent({ managed: { ...running, pending: 1 }, status: 'waiting' })
    expect(sessionHeaderVM(asking, MODELS, false)!.canInterrupt).toBe(true)
    const ended = agent({ managed: { ...running, phase: 'ended' }, status: 'tool' })
    expect(sessionHeaderVM(ended, MODELS, false)!.canInterrupt).toBe(false)
  })

  it('SH-VM-1: model falls back to the display model, then "unknown", while models load', () => {
    const noId = { chrome: false, pending: 0, phase: 'running' as const }
    expect(sessionHeaderVM(agent({ managed: noId }), undefined, false)!.model.text).toBe(
      '✦ claude-opus-5-5',
    )
    expect(
      sessionHeaderVM(agent({ managed: noId, model: undefined }), undefined, false)!.model.text,
    ).toBe(SESSION_COPY.modelUnknown)
    expect(sessionHeaderVM(agent({ managed: running }), undefined, false)!.models).toEqual([])
  })

  it('SH-VM-2: terminal sessions get read-only pills with a note; unknown mode text', () => {
    const vm = sessionHeaderVM(agent({ permissionMode: 'acceptEdits' }), MODELS, true)!
    expect(vm).toMatchObject({
      managed: false,
      mode: { text: '✎ Accept edits' },
      model: { text: '✦ claude-opus-5-5' },
      modes: [],
      models: [],
      readOnlyNote: SESSION_COPY.readOnly,
      canInterrupt: false,
      canStop: false,
    })
    expect(sessionHeaderVM(agent(), MODELS, false)!.mode.text).toBe(SESSION_COPY.modeUnknown)
  })

  it('no header for subagents or other providers (unless they report a mode)', () => {
    expect(sessionHeaderVM(agent({ parentId: 'p' }), MODELS, false)).toBeNull()
    expect(sessionHeaderVM(agent({ provider: 'langgraph' }), MODELS, false)).toBeNull()
    expect(
      sessionHeaderVM(agent({ provider: 'langgraph', permissionMode: 'plan' }), MODELS, false)
        ?.readOnlyNote,
    ).toBe(SESSION_COPY.readOnly)
  })
})

describe('composerVM', () => {
  it('CM-1: disabled for subagents, starting and ended sessions, each with its reason', () => {
    expect(composerVM(agent({ parentId: 'p' }), draft())).toMatchObject({
      disabled: true,
      placeholder: SESSION_COPY.composer.subagent,
      canAddContext: false,
      canAddUse: false,
    })
    const starting = agent({ managed: { ...running, phase: 'starting' } })
    expect(composerVM(starting, draft()).placeholder).toBe(SESSION_COPY.composer.starting)
    const ended = agent({ managed: { ...running, phase: 'ended' } })
    expect(composerVM(ended, draft())).toMatchObject({
      disabled: true,
      placeholder: SESSION_COPY.composer.ended,
    })
    expect(composerVM(undefined, draft()).disabled).toBe(true)
    expect(composerVM(agent(), draft())).toMatchObject({
      disabled: false,
      placeholder: SESSION_COPY.composer.placeholder,
      canAddContext: true,
      canAddUse: true,
    })
  })

  it('shows context and Use… chips; warns when Chrome is off for a managed session', () => {
    const caps = [cap('mcp:github', { label: 'GitHub' })]
    const vm = composerVM(
      agent({ managed: running }),
      draft({ context: [ref('auth'), ref('README.md', 'file')], use: ['mcp:github', CHROME_ID] }),
      caps,
    )
    expect(vm.chips).toEqual([
      { kind: 'folder', key: 'ctx_auth00000000', label: 'auth', hint: '~/code/auth' },
      { kind: 'file', key: 'ctx_README.md000', label: 'README.md', hint: '~/code/README.md' },
      { kind: 'capability', key: 'mcp:github', label: 'GitHub' },
      {
        kind: 'capability',
        key: CHROME_ID,
        label: SESSION_COPY.composer.chrome,
        warn: SESSION_COPY.composer.chromeOff,
      },
    ])
    const on = composerVM(
      agent({ managed: { ...running, chrome: true } }),
      draft({ use: [CHROME_ID] }),
    )
    expect(on.chips[0]!.warn).toBeUndefined()
  })

  it('stops offering pickers at the limits (10 context items, 5 tools)', () => {
    const full = draft({
      context: Array.from({ length: 10 }, (_, i) => ref(`f${i}`)),
      use: ['shell', 'web', 'subagents', 'mcp:a', 'mcp:b'],
    })
    expect(composerVM(agent(), full)).toMatchObject({ canAddContext: false, canAddUse: false })
  })
})

describe('useMenuVM', () => {
  const caps = [
    cap('shell'),
    cap('mcp:github', { label: 'GitHub' }),
    cap('skill:run-office', { label: 'run-office' }),
    cap('rule:project:CLAUDE.md'),
  ]
  it('U-1: groups entries; Chrome pinned for claude-code; seen dots from capabilities', () => {
    const vm = useMenuVM(caps, 'claude-code', ['shell'])
    expect(vm.groups.map((g) => g.id)).toEqual(['browser', 'mcp', 'builtin', 'skill'])
    expect(vm.groups[0]).toEqual({
      id: 'browser',
      label: SESSION_COPY.composer.groups.browser,
      entries: [
        { id: CHROME_ID, label: SESSION_COPY.composer.chrome, seen: false, selected: false },
      ],
    })
    expect(vm.groups[1]!.entries).toEqual([
      { id: 'mcp:github', label: 'GitHub', seen: true, selected: false },
    ])
    expect(vm.groups[2]!.entries.map((e) => [e.id, e.seen, e.selected])).toEqual([
      ['shell', true, true],
      ['web', false, false],
      ['subagents', false, false],
    ])
    expect(vm.groups[3]!.entries[0]!.label).toBe('Use skill run-office')
  })

  it('U-1: a managed session started with Chrome counts it as seen; other providers get no Chrome', () => {
    expect(useMenuVM([], 'claude-code', [], true).groups[0]!.entries[0]!.seen).toBe(true)
    const other = useMenuVM([cap('mcp:x', { provider: 'langgraph' })], 'langgraph', [])
    expect(other.groups.map((g) => g.id)).toEqual(['mcp', 'builtin'])
  })

  it('U-2: toggling caps at 5 tools; toggling again removes', () => {
    expect(toggleUse(['a', 'b'], 'a')).toEqual({ use: ['b'] })
    expect(toggleUse(['a'], 'b')).toEqual({ use: ['a', 'b'] })
    const five = ['shell', 'web', 'subagents', 'mcp:a', 'mcp:b']
    expect(toggleUse(five, 'mcp:c')).toEqual({ use: five, error: SESSION_COPY.composer.maxUse })
  })

  it('adds picked context without duplicates, truncating at 10', () => {
    const a = ref('a')
    expect(addContext([a], [a, ref('b')])).toEqual({ context: [a, ref('b')] })
    const nine = Array.from({ length: 9 }, (_, i) => ref(`f${i}`))
    expect(addContext(nine, [ref('x'), ref('y')])).toEqual({
      context: [...nine, ref('x')],
      error: SESSION_COPY.composer.maxContext,
    })
  })
})

describe('permissionVM', () => {
  const req = (id: string, tool = 'Bash') => ({ id, tool, summary: 'pnpm test', where: '~/x' })
  it('PM-1: first request with a counter when several are queued', () => {
    expect(permissionVM([])).toBeNull()
    expect(permissionVM([req('perm_1')])).toEqual({
      request: req('perm_1'),
      allowSessionLabel: 'Always allow Bash this session',
    })
    expect(permissionVM([req('perm_1'), req('perm_2', 'Edit')])).toMatchObject({
      request: { id: 'perm_1' },
      counter: '1 of 2',
    })
  })
})

describe('newSessionVM', () => {
  const form = (over: Partial<NewSessionForm> = {}): NewSessionForm => ({
    name: '',
    mode: 'default',
    extraFolders: [],
    chrome: false,
    text: '',
    context: [],
    use: [],
    ...over,
  })
  it('NS-1: Start is disabled until the folder and the message are set', () => {
    expect(newSessionVM(form({ text: 'hi' }), undefined, false, 0).canStart).toBe(false)
    expect(newSessionVM(form({ folder: ref('shop-api') }), undefined, false, 0).canStart).toBe(
      false,
    )
    const ok = newSessionVM(form({ folder: ref('shop-api'), text: 'Plan it' }), undefined, false, 0)
    expect(ok).toMatchObject({
      canStart: true,
      folder: { label: 'shop-api', hint: '~/code/shop-api' },
      namePlaceholder: 'shop-api',
      starting: false,
    })
    expect(
      newSessionVM(form({ folder: ref('x'), text: 'y' }), undefined, false, 0, { starting: true })
        .canStart,
    ).toBe(false)
  })

  it('NS-1: limit message at 6 running sessions', () => {
    const vm = newSessionVM(form({ folder: ref('x'), text: 'y' }), undefined, false, MAX_MANAGED)
    expect(vm.limit).toBe('Stop a session first (6 running)')
    expect(vm.canStart).toBe(false)
  })

  it('NS-1: fallback models before any session reported its list; default first', () => {
    const vm = newSessionVM(form(), undefined, false, 0)
    expect(vm.models.map((m) => [m.id, m.label, m.selected])).toEqual([
      ['', SESSION_COPY.newSession.modelDefault, true],
      ['opus', 'Opus', false],
      ['sonnet', 'Sonnet', false],
      ['haiku', 'Haiku', false],
    ])
    const cached = newSessionVM(form({ model: 'sonnet' }), MODELS, false, 0)
    expect(cached.models.filter((m) => m.selected).map((m) => m.id)).toEqual(['sonnet'])
    expect(cached.models).toHaveLength(3)
  })

  it('modes, extra folders, chips, Chrome and errors', () => {
    const vm = newSessionVM(
      form({
        mode: 'plan',
        extraFolders: [ref('docs')],
        chrome: true,
        context: [ref('README.md', 'file')],
        use: [CHROME_ID],
        name: 'api',
        text: 'go',
      }),
      undefined,
      true,
      0,
      { error: 'boom' },
    )
    expect(vm.modes.find((m) => m.checked)?.id).toBe('plan')
    expect(vm.modes.map((m) => m.id)).toContain('bypassPermissions')
    expect(vm.extraFolders).toEqual([
      { key: 'ctx_docs00000000', label: 'docs', hint: '~/code/docs' },
    ])
    expect(vm.chrome).toEqual({ checked: true, available: true })
    expect(vm.composer.chips.map((c) => c.key)).toEqual(['ctx_README.md000', CHROME_ID])
    expect(vm.composer.chips[1]!.warn).toBeUndefined()
    expect(vm).toMatchObject({ name: 'api', text: 'go', error: 'boom' })
  })

  it('maps start errors to their copy', () => {
    const e = SESSION_COPY.newSession.errors
    expect(startErrorText({ ok: false, code: 'auth', error: 'x' }, 0)).toBe(e.auth)
    expect(startErrorText({ ok: false, code: 'runtime', error: 'x' }, 0)).toBe(e.runtime)
    expect(startErrorText({ ok: false, code: 'folder', error: 'x' }, 0)).toBe(e.folder)
    expect(startErrorText({ ok: false, code: 'limit', error: 'x' }, 6)).toBe(
      SESSION_COPY.newSession.limit(6),
    )
    expect(startErrorText({ ok: false, code: 'other', error: 'boom' }, 0)).toBe(
      "Couldn't start: boom",
    )
  })
})

describe('panelVM: sessions, composer, permission and system lines', () => {
  it('carries the session header, composer, permission card, draft and thread chips', () => {
    let s = stateWith(
      [agent({ managed: running, permissionMode: 'plan' })],
      [
        msg({ id: 'm1', context: [{ kind: 'folder', label: 'auth', hint: '~/auth' }] }),
        msg({ id: 'm2', from: 'system', text: 'Mode → Plan', state: 'delivered' }),
      ],
    )
    s = applyMessage(s, {
      type: 'permission',
      agentId: 'a',
      requests: [{ id: 'perm_1', tool: 'Bash', summary: 'pnpm test' }],
    })
    const vm = panelVM(s, 'a', 0, undefined, undefined, {
      hook: 'installed',
      models: MODELS,
      allowBypass: false,
      draft: draft({ text: 'half', context: [ref('auth')] }),
    })
    expect(vm.session?.mode.text).toBe('◐ Plan')
    expect(vm.composer.chips).toHaveLength(1)
    expect(vm.draftText).toBe('half')
    expect(vm.permission?.request.id).toBe('perm_1')
    expect(vm.hint).toBeNull()
    expect(vm.thread).toEqual([
      {
        id: 'm1',
        from: 'user',
        text: 'hi',
        stateLabel: '⏳ queued',
        context: [{ kind: 'folder', label: 'auth', hint: '~/auth' }],
      },
      { id: 'm2', from: 'system', text: 'Mode → Plan' },
    ])
  })

  it('an absent agent has no session, a disabled composer and no card', () => {
    const vm = panelVM(stateWith([]), 'gone', 0)
    expect(vm).toMatchObject({ session: null, permission: null, draftText: '' })
    expect(vm.composer.disabled).toBe(true)
  })
})

describe('graphicsVM', () => {
  const settings = DEFAULT_SETTINGS
  const stats = {
    fps: 61.6,
    drawCalls: 300,
    triangles: 500_000,
    textureMB: 120.4,
    geometryMB: 19.8,
    width: 1280,
    height: 720,
  }

  it('VM-1: the auto note names the preset Auto picked and why, per tier', () => {
    const low = { start: 'low', ceiling: 'medium', why: 'integrated' } as const
    expect(graphicsVM({ settings, tier: low }).autoNote).toBe('Auto picked: Low (integrated GPU)')
    // The governor stepped up: the note follows.
    expect(graphicsVM({ settings, tier: low, autoPreset: 'medium' }).autoNote).toBe(
      'Auto picked: Medium (integrated GPU)',
    )
    expect(
      graphicsVM({ settings, tier: { start: 'minimal', ceiling: 'low', why: 'software' } })
        .autoNote,
    ).toBe('Software rendering detected: using Minimal')
    expect(
      graphicsVM({ settings, tier: { start: 'high', ceiling: 'ultra', why: 'capable' } }).autoNote,
    ).toBe('Auto picked: High (capable GPU)')
    // Hidden for a manual preset, and before the tier is known.
    expect(
      graphicsVM({ settings: { ...settings, graphicsQuality: 'high' }, tier: low }).autoNote,
    ).toBeNull()
    expect(graphicsVM({ settings }).autoNote).toBeNull()
  })

  it('VM-2: "(custom)" shows when any advanced option is set; Reset clears it', () => {
    const plain = graphicsVM({ settings })
    expect(plain.custom).toBe(false)
    expect(plain.advancedSummary).toBe('Advanced')
    const custom = graphicsVM({
      settings: { ...settings, graphicsAdvanced: { ...settings.graphicsAdvanced, fps: '30' } },
    })
    expect(custom.custom).toBe(true)
    expect(custom.advancedSummary).toBe('Advanced (custom)')
    expect(custom.advanced.find((r) => r.key === 'fps')!.value).toBe('30')
  })

  it('VM-3: every advanced option offers "Auto · <preset value>" first', () => {
    const vm = graphicsVM({ settings: { ...settings, graphicsQuality: 'minimal' } })
    const autoOf = (k: string) => vm.advanced.find((r) => r.key === k)!.options[0]
    expect(vm.advanced.map((r) => r.key)).toEqual([
      'resolution',
      'fps',
      'shadows',
      'effects',
      'characters',
      'labels',
      'links',
      'building',
    ])
    expect(autoOf('fps')).toEqual({ value: 'auto', label: 'Auto · 30' })
    expect(autoOf('resolution')!.label).toBe('Auto · 75%')
    expect(autoOf('shadows')!.label).toBe('Auto · Off')
    expect(autoOf('effects')!.label).toBe('Auto · Off')
    expect(autoOf('characters')!.label).toBe('Auto · Low')
    expect(autoOf('labels')!.label).toBe('Auto · Nearby')
    expect(autoOf('links')!.label).toBe('Auto · Static')
    expect(autoOf('building')!.label).toBe('Auto · Low')
    expect(vm.autoHints.fps).toBe('Auto · 30')
    expect(vm.autoHints.links).toBe('Auto · Static')
    const high = graphicsVM({ settings: { ...settings, graphicsQuality: 'high' } })
    const h = (k: string) => high.advanced.find((r) => r.key === k)!
    expect(h('fps').options.map((o) => o.label)).toEqual([
      'Auto · Unlimited',
      '30',
      '60',
      'Unlimited',
    ])
    expect(h('resolution').options.map((o) => o.label)).toEqual([
      'Auto · 100%',
      '50%',
      '67%',
      '75%',
      '100%',
    ])
    expect(h('effects').options[0]!.label).toBe('Auto · On')
    expect(h('shadows').options[0]!.label).toBe('Auto · Full')
    expect(h('effects').help).toBe('glow, ambient occlusion, anti-aliasing')
    // Auto follows the governor's preset.
    const auto = graphicsVM({ settings, autoPreset: 'low' })
    expect(auto.advanced.find((r) => r.key === 'fps')!.options[0]!.label).toBe('Auto · 60')
  })

  it('VM-4: the stats line, with "(battery)" while the battery preset is in force', () => {
    expect(graphicsVM({ settings }).now).toBeUndefined()
    expect(graphicsVM({ settings, stats, autoPreset: 'low' }).now).toBe(
      '62 fps · Low · GPU memory ≈ 140 MB · 1280×720',
    )
    const battery = { ...settings, batteryPreset: 'minimal' as const }
    expect(graphicsVM({ settings: battery, stats, onBattery: true }).now).toBe(
      '62 fps · Minimal (battery) · GPU memory ≈ 140 MB · 1280×720',
    )
    expect(graphicsVM({ settings: battery, stats, onBattery: false }).now).toBe(
      '62 fps · High · GPU memory ≈ 140 MB · 1280×720',
    )
  })

  it('carries the quality, power saver, battery and hardware controls', () => {
    const vm = graphicsVM({ settings })
    expect(vm.quality).toBe('auto')
    expect(vm.qualityOptions.map((o) => o.label)).toEqual([
      'Auto',
      'Minimal',
      'Low',
      'Medium',
      'High',
      'Ultra',
    ])
    expect(vm.qualityOptions[1]!.help).toBe(
      'For very old or software-rendered computers. 30 fps, no effects.',
    )
    expect(vm).toMatchObject({
      saverBlur: true,
      saverHidden: true,
      batteryPreset: 'off',
      hardwareAcceleration: true,
    })
    expect(vm.batteryOptions).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'minimal', label: 'Minimal' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
    ])
  })

  it('settingsVM includes the graphics block', () => {
    const vm = settingsVM({
      settings,
      hook: 'installed',
      version: '1.0.0',
      update: { policy: 'off', status: 'idle' },
      graphics: { stats, autoPreset: 'medium' },
    })
    expect(vm.graphics.now).toBe('62 fps · Medium · GPU memory ≈ 140 MB · 1280×720')
    expect(vm.graphicsQuality).toBe('auto')
    expect(vm).toMatchObject({
      graphicsAdvanced: settings.graphicsAdvanced,
      powerSaverBlur: true,
      powerSaverHidden: true,
      batteryPreset: 'off',
      hardwareAcceleration: true,
    })
  })
})

describe('settingsVM: hardware acceleration toggle', () => {
  const base = {
    settings: DEFAULT_SETTINGS,
    hook: 'not-installed' as const,
    version: '1.0.0',
    update: { policy: 'auto' as const, status: 'idle' as const },
  }
  // macOS has no working software WebGL (SwiftShader fails on Electron 44), so turning
  // acceleration off there would leave no 3D at all: the toggle is hidden on macOS.
  it('offers the toggle except on macOS', () => {
    expect(settingsVM(base).showHardwareAcceleration).toBe(true)
    expect(settingsVM({ ...base, isMac: true }).showHardwareAcceleration).toBe(false)
  })
})
