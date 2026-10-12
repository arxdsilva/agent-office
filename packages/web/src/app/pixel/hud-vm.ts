// The 2D HUD (plan §9): room, counts, the waiting-alert list and the selected-agent chip. Pure.
import type { Agent } from '@agent-office/shared'
import { PIXEL_COPY } from '../pixel-copy.ts'
import type { OfficeState } from '../state.ts'
import type { AlertVM, PixelHudVM } from './types.ts'

export const MAX_ALERTS = 4

const RANK: Record<AlertVM['kind'], number> = { approval: 0, waiting: 1, error: 2 }

const needsApproval = (s: OfficeState, a: Agent) =>
  !!s.permissions?.get(a.id)?.length || (a.managed?.pending ?? 0) > 0

/** Every alert: approvals, then waiting, then errors; newest (lastSeen) first within a kind. */
export function alertsVM(state: OfficeState): AlertVM[] {
  const out: (AlertVM & { at: number })[] = []
  for (const a of state.agents.values()) {
    const kind: AlertVM['kind'] | undefined = needsApproval(state, a)
      ? 'approval'
      : a.status === 'waiting'
        ? 'waiting'
        : a.status === 'error'
          ? 'error'
          : undefined
    if (!kind) continue
    out.push({
      agentId: a.id,
      kind,
      text: PIXEL_COPY.alerts[kind](a.name),
      opensPermission: kind === 'approval',
      at: a.lastSeen,
    })
  }
  out.sort((x, y) => RANK[x.kind] - RANK[y.kind] || y.at - x.at || (x.agentId < y.agentId ? -1 : 1))
  return out.map(({ at: _, ...a }) => a)
}

export function pixelHudVM(i: {
  state: OfficeState
  room: string
  selected?: string | null
}): PixelHudVM {
  const agents = [...i.state.agents.values()]
  const all = alertsVM(i.state)
  const vm: PixelHudVM = {
    room: i.room,
    counts: {
      agents: agents.length,
      waiting: agents.filter((a) => a.status === 'waiting').length,
      errors: agents.filter((a) => a.status === 'error').length,
    },
    alerts: all.slice(0, MAX_ALERTS),
    moreAlerts: Math.max(0, all.length - MAX_ALERTS),
  }
  const sel = i.selected ? i.state.agents.get(i.selected) : undefined
  if (sel) vm.selected = { id: sel.id, text: `${sel.name} · ${sel.status}` }
  return vm
}
