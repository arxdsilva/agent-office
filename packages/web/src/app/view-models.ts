// Pure view models: everything the DOM adapters show, computed from state. No DOM here.
import {
  AGENT_STATUSES,
  STATUS_COLORS,
  type Agent,
  type AgentStatus,
  type CapabilityCategory,
  type ChatMessage,
  type GraphicsQuality,
  type HookStatus,
  type Settings,
  type UpdateState,
} from '@agent-office/shared'
import type { Chip } from './capability-vm.ts'
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
  action?: 'install-hook'
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
  if (!a.interactive) return { text: "This agent isn't reading its inbox. See README → Inbox API." }
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
}

export function hudVM(state: OfficeState): HudVM {
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
  hook: { label: string; action: 'install' | 'uninstall' }
  update: { label: string; action: 'check' | 'install' | 'download' | null; url?: string }
}

export function settingsVM(i: {
  settings: Settings
  hook: HookStatus
  version: string
  update: UpdateState
  restartNote?: boolean
}): SettingsVM {
  const hook: SettingsVM['hook'] =
    i.hook === 'installed'
      ? { label: 'Installed ✓', action: 'uninstall' }
      : i.hook === 'outdated'
        ? { label: 'Needs repair (app moved or updated)', action: 'install' }
        : { label: 'Not installed', action: 'install' }
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
