import { AGENT_STATUSES, type Agent, type AgentStatus } from '@agent-office/shared'

export type TrayAction =
  | { type: 'open' }
  | { type: 'select'; agentId: string }
  | { type: 'settings' }
  | { type: 'install-hook' }
  | { type: 'quit' }

export interface TrayItem {
  label: string
  action?: TrayAction
  enabled?: boolean
}

/** Tray content as data; the Electron adapter turns it into a native menu. */
export interface TrayModel {
  /** Short text next to the icon (macOS menu bar), e.g. "⚙3 ✔1". Empty when nothing is going on. */
  title: string
  tooltip: string
  items: (TrayItem | 'separator')[]
}

const MAX_WAITING = 8
const ICON: Partial<Record<AgentStatus, string>> = { thinking: '💭', tool: '⚙', waiting: '✔', error: '⚠' }

export function trayModel(agents: Agent[], hookInstalled: boolean): TrayModel {
  const counts = new Map<AgentStatus, number>()
  for (const a of agents) counts.set(a.status, (counts.get(a.status) ?? 0) + 1)
  const busy = (counts.get('thinking') ?? 0) + (counts.get('tool') ?? 0)
  const waiting = agents.filter((a) => a.status === 'waiting').sort((a, b) => b.lastSeen - a.lastSeen)

  const titleParts = [busy ? `⚙${busy}` : '', waiting.length ? `✔${waiting.length}` : ''].filter(Boolean)
  const summary = AGENT_STATUSES.filter((s) => counts.get(s)).map((s) => `${ICON[s] ?? ''}${counts.get(s)} ${s}`.trim())

  const items: (TrayItem | 'separator')[] = [
    { label: 'Open agent-office', action: { type: 'open' } },
    'separator',
    { label: `${agents.length} agent${agents.length === 1 ? '' : 's'}${summary.length ? ` — ${summary.join(', ')}` : ''}`, enabled: false },
  ]
  if (waiting.length) {
    items.push('separator', { label: 'Waiting for you', enabled: false })
    for (const a of waiting.slice(0, MAX_WAITING)) items.push({ label: `  ${a.name} — ${a.topic}`, action: { type: 'select', agentId: a.id } })
    if (waiting.length > MAX_WAITING) items.push({ label: `  …and ${waiting.length - MAX_WAITING} more`, enabled: false })
  }
  items.push(
    'separator',
    hookInstalled
      ? { label: 'Claude Code hook: installed ✓', enabled: false }
      : { label: 'Install Claude Code hook…', action: { type: 'install-hook' } },
    { label: 'Settings…', action: { type: 'settings' } },
    'separator',
    { label: 'Quit agent-office', action: { type: 'quit' } },
  )
  return {
    title: titleParts.join(' '),
    tooltip: `agent-office — ${agents.length} agents${waiting.length ? `, ${waiting.length} waiting` : ''}`,
    items,
  }
}
