// Pure view models: everything the DOM adapters show, computed from state. No DOM here.
import {
  AGENT_STATUSES,
  STATUS_COLORS,
  type Agent,
  type AgentStatus,
  type ChatMessage,
  type HookStatus,
  type Settings,
  type UpdateState,
} from '@agent-office/shared'
import type { OfficeState } from './state.ts'

const STATE_LABEL: Record<ChatMessage['state'], string> = { queued: '⏳ queued', delivered: '✓ delivered', replied: '✓✓ replied' }

export function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

export interface Hint {
  text: string
  action?: 'install-hook'
}

export function hintFor(a: Agent): Hint | null {
  if (a.provider === 'claude-code') {
    if (!a.interactive) {
      return { text: 'Not connected: this session cannot read messages until the Claude Code hook is installed.', action: 'install-hook' }
    }
    if (a.status === 'waiting' || a.status === 'idle') {
      return { text: 'This session is idle: messages are delivered when you next prompt it in Claude Code.' }
    }
    return { text: 'Messages are delivered when the current turn ends.' }
  }
  if (!a.interactive) return { text: "This agent isn't reading its inbox. See README → Inbox API." }
  return null
}

export interface PanelVM {
  id: string
  present: boolean
  name: string
  subtitle: string
  meta: [string, string][]
  parent?: { id: string; name: string }
  hint: Hint | null
  thread: { id: string; from: 'user' | 'agent'; text: string; stateLabel?: string }[]
}

export function panelVM(state: OfficeState, id: string, now: number): PanelVM {
  const a = state.agents.get(id)
  if (!a) return { id, present: false, name: 'This agent has left the office', subtitle: '', meta: [], hint: null, thread: [] }
  const parent = a.parentId ? state.agents.get(a.parentId) : undefined
  return {
    id,
    present: true,
    name: a.name,
    subtitle: [a.kind, a.provider, a.model].filter(Boolean).join(' · '),
    meta: [
      ['Topic', a.topic],
      ['Status', a.status + (a.tool ? ` (${a.tool})` : '')],
      ['Activity', a.text || '—'],
      ['Active', `for ${ago(a.since, now).replace(' ago', '')}`],
      ['Last seen', ago(a.lastSeen, now)],
    ],
    ...(a.parentId ? { parent: { id: a.parentId, name: parent?.name ?? a.parentId } } : {}),
    hint: hintFor(a),
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
    statuses: AGENT_STATUSES.map((status) => ({ status, color: STATUS_COLORS[status], count: counts.get(status) ?? 0 })),
  }
}

export interface SettingsVM {
  port: number
  notifications: boolean
  launchAtLogin: boolean
  claudeAdapter: boolean
  autoUpdate: boolean
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
    autoUpdate: i.settings.autoUpdate,
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
        ? { label: `Version ${u.version} is available`, action: 'download', ...(u.url ? { url: u.url } : {}) }
        : { label: `Version ${u.version} is available`, action: null }
    case 'up-to-date':
      return { label: 'Up to date', action: 'check' }
    case 'error':
      return { label: `Update check failed: ${u.error ?? 'unknown error'}`, action: 'check' }
    default:
      return { label: 'Not checked yet', action: 'check' }
  }
}
