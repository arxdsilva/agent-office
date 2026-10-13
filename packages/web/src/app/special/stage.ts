// The Night City stage (docs/special-3d/architecture.md): the director's plans arrive with classic
// anchors; `createStageMap` turns each intent into a Night City intent, and the same choreography
// the other modes use (`choreograph`, `poseAt`) plans the steps on the special nav graph. Only real
// intents move agents: nothing here invents activity. Pure.
import { choreograph, hiddenPose, poseAt } from '../choreography.ts'
import { parseAnchorId } from '../building.ts'
import type {
  Activity,
  AgentPlan,
  AgentPose,
  ClipName,
  Intent,
  Step,
  Vec2,
} from '../office-types.ts'
import { createStageMap } from './departments.ts'
import type { SpecialWorld } from './world.ts'

interface Track {
  intent: Intent
  from: AgentPose
  steps: Step[]
  startedAt: number
}

export interface StageEntry {
  id: string
  /** Local anchor id (e.g. `ws:0:1:2`, `booth:1`). */
  anchor: string
  activity: Activity
  /** The agent's workstation (local id), if it has one. */
  desk?: string
  pos: Vec2
}

export interface Stage {
  /**
   * Night City plans for the scene's characters (steps only when the Night City intent changed)
   * and the agents to remove. The first call places everyone already in the office directly.
   */
  direct(
    plans: Map<string, AgentPlan>,
    departed: string[],
    now: number,
    order: readonly string[],
  ): { plans: Map<string, AgentPlan>; dropped: string[] }
  pose(id: string, now: number): AgentPose | undefined
  /** Where each agent is mapped (debug, the HUD and the monitors). */
  entries(now: number): StageEntry[]
  deskOf(id: string): string | undefined
  setClipDurations(d: Partial<Record<ClipName, number>> | undefined): void
}

export function createStage(world: Pick<SpecialWorld, 'layout'>): Stage {
  const map = createStageMap(world)
  const tracks = new Map<string, Track>()
  let first = true
  let clipDurations: Partial<Record<ClipName, number>> | undefined
  const pose = (id: string, now: number) => {
    const t = tracks.get(id)
    return t && poseAt(t.from, t.steps, (now - t.startedAt) / 1000)
  }
  const drop = (id: string) => {
    tracks.delete(id)
    map.drop(id)
  }

  return {
    direct(plans, departed, now, order) {
      const dropped: string[] = []
      for (const id of departed) if (tracks.has(id)) (drop(id), dropped.push(id))
      for (const id of [...tracks.keys()]) if (!plans.has(id)) (drop(id), dropped.push(id))
      const spawnAll = first
      first = false
      const out = new Map<string, AgentPlan>()
      for (const [id, plan] of plans) {
        const intent = map.map(plan, order)
        if (spawnAll) intent.spawn = true
        const track = tracks.get(id)
        const next: AgentPlan = { agent: plan.agent, intent }
        if (plan.teamOf) next.teamOf = plan.teamOf
        if (
          !track ||
          track.intent.target !== intent.target ||
          track.intent.activity !== intent.activity
        ) {
          const from = (track && pose(id, now)) ?? hiddenPose()
          const ctx: Parameters<typeof choreograph>[2] = {
            layout: world.layout,
            status: plan.agent.status,
          }
          if (clipDurations) ctx.clipDurations = clipDurations
          const steps = choreograph(from, intent, ctx)
          tracks.set(id, { intent, from, steps, startedAt: now })
          next.steps = steps
        }
        out.set(id, next)
      }
      return { plans: out, dropped }
    },
    pose,
    entries(now) {
      return [...tracks].map(([id, t]) => {
        const p = pose(id, now)!
        const desk = map.deskOf(id)
        return {
          id,
          anchor: parseAnchorId(t.intent.target).local,
          activity: t.intent.activity,
          ...(desk && { desk: parseAnchorId(desk).local }),
          pos: { x: p.pos.x, z: p.pos.z },
        }
      })
    },
    deskOf: (id) => map.deskOf(id),
    setClipDurations(d) {
      clipDurations = d
    },
  }
}
