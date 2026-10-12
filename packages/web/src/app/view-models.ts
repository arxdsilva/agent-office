// Pure view models: everything the DOM adapters show, computed from state. No DOM here.
import {
  AGENT_STATUSES,
  STATUS_COLORS,
  type Agent,
  type AgentStatus,
  type CapabilityCategory,
  type ChatMessage,
  type ConnectionInfo,
  type GraphicsQuality,
  type HookStatus,
  type Settings,
  type TestEventResult,
  type UpdateState,
} from '@agent-office/shared'
import type { Chip } from './capability-vm.ts'
import { COPY } from './connect-copy.ts'
import { snippet } from './connect-snippets.ts'
import {
  TEST_AGENT_ID,
  type ConnectTab,
  type ConnectVM,
  type EmptyPhase,
  type EmptyStateVM,
  type HookActionVM,
  type Pill,
  type SnippetLang,
} from './connect-types.ts'
import { ago } from './format.ts'
import type { Activity } from './office-types.ts'
import type { OfficeState } from './state.ts'

const STATE_LABEL: Record<ChatMessage['state'], string> = {
  queued: '⏳ queued',
  delivered: '✓ delivered',
  replied: '✓✓ replied',
}

export { ago } from './format.ts'

export interface Hint {
  text: string
  action?: 'install-hook' | 'open-connect'
}

export function hintFor(a: Agent): Hint | null {
  if (a.provider === 'claude-code') {
    if (!a.interactive) {
      return {
        text: 'Not connected: this session cannot read messages until the Claude Code hook is installed.',
        action: 'install-hook',
      }
    }
    if (a.status === 'waiting' || a.status === 'idle') {
      return {
        text: 'This session is idle: messages are delivered when you next prompt it in Claude Code.',
      }
    }
    return { text: 'Messages are delivered when the current turn ends.' }
  }
  if (!a.interactive) return { text: COPY.hint.notReading, action: 'open-connect' }
  return null
}

/** What the director knows about an agent's whereabouts (from its intent and target anchor). */
export interface ActivityInfo {
  activity: Activity
  /** Room id from the anchor (`meeting-A`, `booth-3`, `pod-2`, …). */
  room?: string
  /** For a parent in a meeting: how many of its subagents are with it. */
  subagents?: number
  /** For a subagent in a meeting: the parent's name. */
  with?: string
  /** For connection-* / library-*: what the agent is using. */
  capability?: { label: string; category: CapabilityCategory; tool?: string }
}

const ROOM_SUFFIX = (room: string | undefined, prefix: string) =>
  room?.startsWith(prefix) ? room.slice(prefix.length) : undefined

const DESK_LABEL: Record<'desk-work' | 'desk-think' | 'desk-error' | 'desk-idle', string> = {
  'desk-work': 'Working at their desk',
  'desk-think': 'Thinking at their desk',
  'desk-error': 'Stuck on an error at their desk',
  'desk-idle': 'Idle at their desk',
}

/** Human-readable sentence for an activity, e.g. "In meeting room A with 2 subagents". */
export function activityLabel(
  activity: Activity,
  details: Omit<ActivityInfo, 'activity'> = {},
): string {
  switch (activity) {
    case 'arriving':
      return 'Arriving'
    case 'leaving':
      return 'Leaving'
    case 'kitchen':
      return 'Getting coffee'
    case 'lounge':
      return 'Relaxing in the lounge'
    case 'cafe':
      return 'Taking a break at the cafe'
    case 'pingpong':
      return 'Playing ping-pong'
    case 'meeting': {
      const room = ROOM_SUFFIX(details.room, 'meeting-')
      const where = room ? `In meeting room ${room}` : 'In a meeting'
      if (details.with) return `${where} with ${details.with}'s team`
      const n = details.subagents ?? 0
      return n > 0 ? `${where} with ${n} subagent${n === 1 ? '' : 's'}` : where
    }
    case 'connection-call': {
      const c = details.capability
      if (!c) return 'Calling an adapter'
      return c.tool ? `Calling ${c.label} (${c.tool})` : `Calling ${c.label}`
    }
    case 'connection-visit':
      return details.capability
        ? `Working at the ${details.capability.label} station`
        : 'Working in the Adapters room'
    case 'library-call': {
      const c = details.capability
      if (!c) return 'Consulting the library'
      return c.category === 'skill' ? `Consulting ${c.label} (skill)` : `Reading ${c.label}`
    }
    case 'library-visit':
      return details.capability
        ? `In the library reading ${details.capability.label}`
        : 'Reading in the library'
    case 'booth': {
      const booth = ROOM_SUFFIX(details.room, 'booth-')
      return `Waiting for you in ${booth ? `booth ${booth}` : 'a phone booth'}`
    }
    default: {
      const pod = ROOM_SUFFIX(details.room, 'pod-')
      return DESK_LABEL[activity] + (pod ? ` in pod ${pod}` : '')
    }
  }
}

export interface PanelVM {
  id: string
  present: boolean
  name: string
  subtitle: string
  /** Where the agent is in the office and what it is doing there (when the director knows). */
  activity?: string
  meta: [string, string][]
  parent?: { id: string; name: string }
  hint: Hint | null
  thread: { id: string; from: 'user' | 'agent'; text: string; stateLabel?: string }[]
  /** Connections, skills and rules this agent used this session (chips). */
  used?: UsedChips
}

export interface UsedChips {
  adapters: Chip[]
  library: Chip[]
}

export function panelVM(
  state: OfficeState,
  id: string,
  now: number,
  info?: ActivityInfo,
  used?: UsedChips,
): PanelVM {
  const a = state.agents.get(id)
  if (!a)
    return {
      id,
      present: false,
      name: 'This agent has left the office',
      subtitle: '',
      meta: [],
      hint: null,
      thread: [],
    }
  const parent = a.parentId ? state.agents.get(a.parentId) : undefined
  const activity = info ? activityLabel(info.activity, info) : undefined
  return {
    id,
    present: true,
    name: a.name,
    subtitle: [a.kind, a.provider, a.model].filter(Boolean).join(' · '),
    ...(activity ? { activity } : {}),
    meta: [
      ['Topic', a.topic],
      ['Status', a.status + (a.tool ? ` (${a.tool})` : '')],
      ...(activity ? [['Now', activity] as [string, string]] : []),
      ['Activity', a.text || '—'],
      ['Active', `for ${ago(a.since, now).replace(' ago', '')}`],
      ['Last seen', ago(a.lastSeen, now)],
    ],
    ...(a.parentId ? { parent: { id: a.parentId, name: parent?.name ?? a.parentId } } : {}),
    hint: hintFor(a),
    ...(used && (used.adapters.length || used.library.length) ? { used } : {}),
    thread: (state.messages.get(id) ?? []).map((m) => ({
      id: m.id,
      from: m.from,
      text: m.text,
      ...(m.from === 'user' ? { stateLabel: STATE_LABEL[m.state] } : {}),
    })),
  }
}

export interface HudVM {
  count: string
  statuses: { status: AgentStatus; color: string; count: number }[]
  /** Controls help, or "No agents right now · [Connect…]" once the office is empty again. */
  hint: { text: string; action?: 'connect' }
}

const CONTROLS_HELP = 'Drag to orbit · scroll to zoom · click an agent to chat'

export function hudVM(state: OfficeState, phase?: EmptyPhase): HudVM {
  const counts = new Map<AgentStatus, number>()
  for (const a of state.agents.values()) counts.set(a.status, (counts.get(a.status) ?? 0) + 1)
  const n = state.agents.size
  return {
    count: `${n} agent${n === 1 ? '' : 's'}`,
    statuses: AGENT_STATUSES.map((status) => ({
      status,
      color: STATUS_COLORS[status],
      count: counts.get(status) ?? 0,
    })),
    hint:
      n === 0 && (phase === 'empty-again' || phase === 'dismissed')
        ? { text: COPY.hud.noAgents, action: 'connect' }
        : { text: CONTROLS_HELP },
  }
}

export interface SettingsVM {
  port: number
  notifications: boolean
  launchAtLogin: boolean
  claudeAdapter: boolean
  discoverCapabilities: boolean
  autoUpdate: boolean
  graphicsQuality: GraphicsQuality
  version: string
  restartNote: boolean
  hook: HookActionVM
  update: { label: string; action: 'check' | 'install' | 'download' | null; url?: string }
}

export function settingsVM(i: {
  settings: Settings
  hook: HookStatus
  version: string
  update: UpdateState
  restartNote?: boolean
}): SettingsVM {
  const hook = hookVM(i.hook)
  return {
    port: i.settings.port,
    notifications: i.settings.notifications,
    launchAtLogin: i.settings.launchAtLogin,
    claudeAdapter: i.settings.claudeAdapter,
    discoverCapabilities: i.settings.discoverCapabilities,
    autoUpdate: i.settings.autoUpdate,
    graphicsQuality: i.settings.graphicsQuality,
    version: `v${i.version}`,
    restartNote: !!i.restartNote,
    hook,
    update: updateVM(i.update),
  }
}

function updateVM(u: UpdateState): SettingsVM['update'] {
  if (u.policy === 'off') return { label: 'Updates are off in development builds', action: null }
  switch (u.status) {
    case 'checking':
      return { label: 'Checking…', action: null }
    case 'downloading':
      return { label: `Downloading ${u.version ?? 'update'}…`, action: null }
    case 'ready':
      return { label: `Version ${u.version} is ready`, action: 'install' }
    case 'available':
      return u.policy === 'notify-only'
        ? {
            label: `Version ${u.version} is available`,
            action: 'download',
            ...(u.url ? { url: u.url } : {}),
          }
        : { label: `Version ${u.version} is available`, action: null }
    case 'up-to-date':
      return { label: 'Up to date', action: 'check' }
    case 'error':
      return { label: `Update check failed: ${u.error ?? 'unknown error'}`, action: 'check' }
    default:
      return { label: 'Not checked yet', action: 'check' }
  }
}

/** The hook row in Settings and in Connect → Claude Code. */
export function hookVM(h: HookStatus): HookActionVM {
  const c = COPY.claude.hook
  if (h === 'installed') return { ...c.installed, action: 'uninstall' }
  if (h === 'outdated') return { ...c.outdated, action: 'install' }
  return { ...c.missing, action: 'install' }
}

// ---------------------------------------------------------------------------------------------
// Connect panel and empty state (plan §2.1–§2.2)

const pill = (text: string, tone: Pill['tone']): Pill => ({ text, tone })

function claudePill(c: ConnectionInfo['claude']): Pill {
  if (!c.enabled)
    return pill(c.override === 'off' ? COPY.claude.offOverride : COPY.claude.off, 'off')
  if (!c.projectsDirFound) return pill(COPY.claude.folderMissingPill, 'warn')
  if (c.activeSessions > 0) return pill(COPY.claude.sessions(c.activeSessions), 'ok')
  return pill(COPY.claude.noSessions, 'off')
}

function httpPill(a: ConnectionInfo['api']): Pill {
  if (a.listening) return pill(COPY.http.listening(a.host, a.port), 'ok')
  if (a.portBusy) return pill(COPY.http.busy(a.port), 'error')
  return pill(COPY.http.starting, 'pending')
}

function demoPill(m: ConnectionInfo['mock'], agents: number): Pill {
  if (m.override === 'on') return pill(COPY.demo.onOverride, 'ok')
  return m.enabled ? pill(COPY.demo.on(agents), 'ok') : pill(COPY.demo.off, 'off')
}

const agentsOf = (state: OfficeState) => [...state.agents.values()]

export interface ConnectInput {
  info: ConnectionInfo
  state: OfficeState
  tab: ConnectTab
  lang: SnippetLang
  now: number
  /** Newest non-test provider seen over HTTP this session (survives its agents leaving). */
  lastHttp?: { provider: string; ts: number }
  /** Result of the last "Send a test agent". */
  test?: TestEventResult
  /** Adds the PowerShell note to the curl snippet. */
  isWindows?: boolean
}

export function connectVM(i: ConnectInput): ConnectVM {
  const { info, now } = i
  const agents = agentsOf(i.state)
  const claudeAgents = agents.filter((a) => a.provider === 'claude-code')

  const claudeOverride = info.claude.override
  const verified = (): Pill | undefined => {
    if (info.hook === 'not-installed') return undefined
    const reading = claudeAgents.filter((a) => a.interactive)
    if (!reading.length) return pill(COPY.claude.notVerified, 'pending')
    const last = Math.max(...reading.map((a) => a.lastSeen))
    return pill(COPY.claude.verified(ago(last, now)), 'ok')
  }
  const v = verified()
  const claude: ConnectVM['claude'] = {
    pill: claudePill(info.claude),
    toggle: {
      on: info.claude.enabled,
      ...(claudeOverride && {
        disabledNote:
          claudeOverride === 'on' ? COPY.claude.onOverrideNote : COPY.claude.offOverrideNote,
      }),
    },
    folder: info.claude.projectsDirFound
      ? { ok: true, text: COPY.claude.folderFound(info.claude.projectsDir) }
      : { ok: false, text: COPY.claude.folderMissing(info.claude.projectsDir) },
    hook: hookVM(info.hook),
    ...(v && { verified: v }),
    ...(info.claude.enabled &&
      info.claude.activeSessions > 0 &&
      !claudeAgents.length && { idleNote: COPY.claude.idle }),
  }

  const live = (): Pill => {
    if (i.test)
      return i.test.ok
        ? pill(COPY.http.testOk, 'ok')
        : pill(COPY.http.testFailed(i.test.error), 'error')
    if (i.lastHttp)
      return pill(COPY.http.received(i.lastHttp.provider, ago(i.lastHttp.ts, now)), 'ok')
    return pill(COPY.http.waiting, 'pending')
  }
  const { host, port, tokenFile } = info.api
  const http: ConnectVM['http'] = {
    pill: httpPill(info.api),
    endpoint: `http://${host}:${port}/api/events`,
    tokenFile,
    lang: i.lang,
    snippet: snippet(i.lang, { host, port, tokenFile }),
    ...(i.isWindows && i.lang === 'curl' && { snippetNote: COPY.http.powershell }),
    ...(info.api.portBusy && { portBusy: { port } }),
    live: live(),
  }

  const demo: ConnectVM['demo'] = {
    pill: demoPill(info.mock, agents.filter((a) => a.source === 'mock').length),
    toggle: {
      on: info.mock.enabled,
      ...(info.mock.override && { disabledNote: COPY.demo.overrideNote }),
    },
  }

  const rows = connectedRows(agents, now)
  const tabs: ConnectVM['tabs'] = [
    { id: 'claude', label: COPY.panel.tabs.claude, tone: claude.pill.tone },
    { id: 'http', label: COPY.panel.tabs.http, tone: http.pill.tone },
    { id: 'demo', label: COPY.panel.tabs.demo, tone: demo.pill.tone },
    {
      id: 'connected',
      label: `${COPY.panel.tabs.connected} (${rows.length})`,
      tone: rows.length ? 'ok' : 'off',
    },
  ]
  return { tab: i.tab, tabs, claude, http, demo, connected: { rows } }
}

/** How a provider's agents reach the office, from `agent.source` (plan §2.2, Connected tab). */
function viaOf(provider: string, group: Agent[]): string {
  if (provider === TEST_AGENT_ID) return COPY.connected.viaText(COPY.connected.via.test!)
  const ways = [...new Set(group.map((a) => a.source))].map((s) => {
    const how = COPY.connected.via[s] ?? s
    return s === 'claude-code' && group.some((a) => a.interactive)
      ? how + COPY.connected.hookOk
      : how
  })
  return COPY.connected.viaText(ways.join(' + '))
}

function connectedRows(agents: Agent[], now: number): ConnectVM['connected']['rows'] {
  const byProvider = new Map<string, Agent[]>()
  for (const a of agents) byProvider.set(a.provider, [...(byProvider.get(a.provider) ?? []), a])
  return [...byProvider]
    .map(([provider, group]) => ({
      provider,
      count: group.length,
      dots: group.map((a) => STATUS_COLORS[a.status]),
      via: viaOf(provider, group),
      lastSeen: COPY.connected.lastSeen(ago(Math.max(...group.map((a) => a.lastSeen)), now)),
    }))
    .sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider))
}

/**
 * The empty card's state machine (plan §2.1): `loading` until `ready()` plus the first connection
 * push (or the grace period), then `first-run`; any agent → `active`; back to 0 → `empty-again`.
 */
export function emptyPhase(p: {
  prev: EmptyPhase
  ready: boolean
  infoReceived: boolean
  graceElapsed: boolean
  agents: number
  dismissed: boolean
}): EmptyPhase {
  if (p.agents > 0) return 'active'
  if (p.prev === 'active' || p.prev === 'empty-again') return 'empty-again'
  if (p.prev === 'loading')
    return p.ready && (p.infoReceived || p.graceElapsed)
      ? p.dismissed
        ? 'dismissed'
        : 'first-run'
      : 'loading'
  return p.dismissed ? 'dismissed' : 'first-run'
}

export type DemoStart = 'idle' | 'starting' | 'failed'

export function emptyStateVM(info: ConnectionInfo, demo: DemoStart): EmptyStateVM {
  const e = COPY.empty
  const demoPillNow = demo === 'failed' ? pill(e.demo.failed, 'error') : demoPill(info.mock, 0)
  return {
    tiles: [
      { id: 'claude', ...e.claude, pill: claudePill(info.claude) },
      { id: 'http', ...e.http, pill: httpPill(info.api) },
      {
        id: 'demo',
        title: e.demo.title,
        body: e.demo.body,
        pill: demoPillNow,
        button: demo === 'starting' ? e.demo.starting : e.demo.button,
        ...(demo === 'starting' && { busy: true }),
      },
    ],
    listening: e.listening,
  }
}
