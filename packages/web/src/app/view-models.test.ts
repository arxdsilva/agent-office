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
  hookVM,
  hudVM,
  panelVM,
  settingsVM,
} from './view-models.ts'

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
    })
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

  it('explains message delivery, offering the hook install for unconnected Claude Code sessions', () => {
    expect(panelVM(stateWith([agent({ interactive: false })]), 'a', 0)!.hint).toEqual({
      text: 'Not connected: this session cannot read messages until the Claude Code hook is installed.',
      action: 'install-hook',
    })
    expect(panelVM(stateWith([agent({ status: 'waiting' })]), 'a', 0)!.hint?.text).toMatch(
      /next prompt/,
    )
    expect(panelVM(stateWith([agent()]), 'a', 0)!.hint?.text).toMatch(/current turn ends/)
    // Other frameworks not reading their inbox: point at the Connect panel instead of the README.
    expect(
      panelVM(stateWith([agent({ provider: 'langgraph', interactive: false })]), 'a', 0)!.hint,
    ).toEqual({ text: COPY.hint.notReading, action: 'open-connect' })
    expect(panelVM(stateWith([agent({ provider: 'langgraph' })]), 'a', 0)!.hint).toBeNull()
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
      text: 'Drag to orbit · scroll to zoom · click an agent to chat',
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
