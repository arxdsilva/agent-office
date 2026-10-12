// NPC identity (plan §7): one entity per agent id, created on its first plan and removed only
// after `departed` plus the leave fade. Status updates mutate the entity; they never recreate it.
import type { AgentStatus } from '@agent-office/shared'
import { FADE_S } from '../choreography.ts'
import { appearanceOf, type Appearance } from '../motion.ts'
import type { AgentPlan } from '../office-types.ts'

/** The elevator fade-out before a departed NPC is dropped. */
export const NPC_FADE_MS = FADE_S * 1000

export interface NpcEntity {
  id: string
  name: string
  status: AgentStatus
  appearance: Appearance
  teamOf?: string
  /** Departed: fading out at the elevator until `removeAt`. */
  leaving?: boolean
  removeAt?: number
}

export function createNpcs() {
  const entities = new Map<string, NpcEntity>()
  return {
    get: (id: string) => entities.get(id),
    ids: () => [...entities.keys()],
    /** Applies one director update; returns the ids created and the ids now gone. */
    sync(plans: ReadonlyMap<string, AgentPlan>, departed: readonly string[], now: number) {
      const added: string[] = []
      const removed: string[] = []
      for (const [id, p] of plans) {
        let e = entities.get(id)
        if (!e) {
          e = {
            id,
            name: p.agent.name,
            status: p.agent.status,
            appearance: appearanceOf(id, p.teamOf),
          }
          if (p.teamOf) e.teamOf = p.teamOf
          entities.set(id, e)
          added.push(id)
        }
        e.name = p.agent.name
        e.status = p.agent.status
        delete e.leaving
        delete e.removeAt
      }
      for (const id of departed) {
        const e = entities.get(id)
        if (e && !plans.has(id)) {
          e.leaving = true
          e.removeAt = now + NPC_FADE_MS
        }
      }
      for (const [id, e] of entities)
        if (e.removeAt !== undefined && now >= e.removeAt) {
          entities.delete(id)
          removed.push(id)
        }
      return { added, removed }
    },
  }
}
