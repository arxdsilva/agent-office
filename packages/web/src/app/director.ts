// Façade for the controller: building + seating + behavior (with reservations) + choreography.
// Deterministic given its inputs; keeps its memory between calls. `now` is epoch ms.
import { byProviderAndTopic, type Grouping } from '@agent-office/shared'
import { direct, emptyMemory, type DirectorMemory } from './behavior.ts'
import { planBuilding, type ProviderDemand } from './building.ts'
import { choreograph, hiddenPose, poseAt } from './choreography.ts'
import type { Manifest } from './manifest.ts'
import type {
  AgentPlan,
  AgentPose,
  BuildingLayout,
  ClipName,
  Intent,
  Step,
} from './office-types.ts'
import { assignDesks, emptySeating, type SeatingState } from './seating.ts'
import type { OfficeState } from './state.ts'

export interface DirectorOptions {
  grouping?: Grouping
  /** One-shot clip lengths from character.json (seconds). */
  clipDurations?: Partial<Record<ClipName, number>>
}

export interface DirectorUpdate {
  layout: BuildingLayout
  /** True when placements changed since the last update (call `scene.setBuilding`). */
  layoutChanged: boolean
  /** One plan per visible agent; `steps` only when its intent changed this update. */
  plans: Map<string, AgentPlan>
  /** Agents whose walk-out finished: remove them from the scene. */
  departed: string[]
}

export interface Director {
  update(state: OfficeState, now: number): DirectorUpdate
  /** Predicted pose of an agent at `now` (from the last steps issued). */
  pose(id: string, now: number): AgentPose | undefined
  /** Last planned layout. */
  readonly layout: BuildingLayout | undefined
}

interface Track {
  intent: Intent
  from: AgentPose
  steps: Step[]
  startedAt: number
}

const sameIntent = (a: Intent, b: Intent) =>
  a.activity === b.activity && a.target === b.target && a.since === b.since

export function createDirector(manifest: Manifest, opts: DirectorOptions = {}): Director {
  const grouping = opts.grouping ?? byProviderAndTopic
  let layout: BuildingLayout | undefined
  let seating: SeatingState = emptySeating()
  let memory: DirectorMemory = emptyMemory()
  const tracks = new Map<string, Track>()
  const pose = (id: string, now: number) => {
    const t = tracks.get(id)
    return t && poseAt(t.from, t.steps, (now - t.startedAt) / 1000)
  }

  return {
    get layout() {
      return layout
    },
    pose,
    update(state, now) {
      const agents = [...state.agents.values()]
      const counts = new Map<string, number>()
      for (const a of agents) {
        const zone = grouping(a, (id) => state.agents.get(id)).zone
        counts.set(zone, (counts.get(zone) ?? 0) + 1)
      }
      const demand: ProviderDemand[] = [...counts].map(([provider, n]) => ({ provider, agents: n }))
      const prev = layout
      layout = planBuilding(demand, manifest, prev, now)
      seating = assignDesks(agents, layout, seating, now, grouping)
      const out = direct({ agents, layout, seating: seating.seats, memory, now })
      memory = out.memory

      const plans = new Map<string, AgentPlan>()
      for (const [id, intent] of out.intents) {
        const agent = memory.agents.get(id)!.agent
        const plan: AgentPlan = { agent, intent }
        if (agent.parentId) plan.teamOf = agent.parentId
        const track = tracks.get(id)
        if (!track || !sameIntent(track.intent, intent)) {
          const from = (track && pose(id, now)) ?? hiddenPose()
          const ctx: Parameters<typeof choreograph>[2] = { layout, status: agent.status }
          if (opts.clipDurations) ctx.clipDurations = opts.clipDurations
          const steps = choreograph(from, intent, ctx)
          tracks.set(id, { intent, from, steps, startedAt: now })
          plan.steps = steps
        }
        plans.set(id, plan)
      }
      for (const id of [...tracks.keys()]) if (!out.intents.has(id)) tracks.delete(id)
      return {
        layout,
        layoutChanged: !prev || prev.key !== layout.key,
        plans,
        departed: out.departed,
      }
    },
  }
}
