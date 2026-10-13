// The Night City HUD (plan §5.4): project, active and waiting counts, location, the selected agent
// and the interaction prompt. Counts and names only; rendered with textContent.
import { STATUS_COLORS, type AgentStatus } from '@agent-office/shared'
import { interactionPrompt } from '../interactions.ts'
import type { InteractionKind } from '../office-types.ts'
import { SPECIAL_COPY } from './copy.ts'

export type SpecialCamera = 'third' | 'first' | 'overview'

export interface HudInput {
  agents: readonly { id: string; name: string; status: AgentStatus }[]
  selectedId: string | null
  room: string | null
  prompt: InteractionKind | null
  camera: SpecialCamera
  projectName?: string | null
}

export interface SpecialHudVM {
  project: string
  active: number
  waiting: number
  location: string
  selected: { id: string; name: string; status: AgentStatus; label: string; color: string } | null
  prompt: string | null
  camera: string
}

const MAX = 40
/** Plain one-line text: no control characters, at most 40 characters. */
export function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return t.length > MAX ? `${t.slice(0, MAX - 1)}…` : t
}

export function specialHudVM(i: HudInput): SpecialHudVM {
  let active = 0
  let waiting = 0
  for (const a of i.agents) {
    if (a.status === 'thinking' || a.status === 'tool') active++
    if (a.status === 'waiting') waiting++
  }
  const sel = i.selectedId ? i.agents.find((a) => a.id === i.selectedId) : undefined
  return {
    project: i.projectName ? plain(i.projectName) : SPECIAL_COPY.allProjects,
    active,
    waiting,
    location: i.room ? plain(i.room) : SPECIAL_COPY.unknownPlace,
    selected: sel
      ? {
          id: sel.id,
          name: plain(sel.name),
          status: sel.status,
          label: SPECIAL_COPY.status[sel.status],
          color: STATUS_COLORS[sel.status],
        }
      : null,
    prompt: i.prompt ? interactionPrompt(i.prompt) : null,
    camera: SPECIAL_COPY.camera[i.camera],
  }
}
