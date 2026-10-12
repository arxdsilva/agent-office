// Façade for the controller: building + seating + behavior (with reservations) + choreography,
// plus capability rooms (stations, library slots) and links.
// Deterministic given its inputs; keeps its memory between calls. `now` is epoch ms.
import { byProviderAndTopic, type Grouping } from '@agent-office/shared'
import {
  CALL_FADE_MS,
  LIBRARY_FADE_MS,
  direct,
  emptyMemory,
  type DirectorMemory,
} from './behavior.ts'
import { parseAnchorId, planBuilding, type ProviderDemand } from './building.ts'
import { choreograph, hiddenPose, poseAt } from './choreography.ts'
import { LIBRARY_CAPACITY, assignLibrary, type LibraryMap } from './library.ts'
import { agentPort, handPort, planLinks, type LinkCall } from './links.ts'
import type { Manifest } from './manifest.ts'
import type {
  AgentPlan,
  AgentPose,
  BuildingLayout,
  ClipName,
  Intent,
  Link,
  Step,
} from './office-types.ts'
import { assignDesks, emptySeating, type SeatingState } from './seating.ts'
import { assignStations, type SlotMap } from './stations.ts'
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
  /** Links to draw this update (calls fading out included). */
  links: Link[]
  /** Station slots per provider (same in every wing of the provider). */
  stations: Map<string, SlotMap>
  /** Book / board / notebook slots per provider. */
  library: Map<string, LibraryMap>
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
  let stations = new Map<string, SlotMap>()
  let library = new Map<string, LibraryMap>()
  const cap = manifest.modules.wing.capacity
  const libraryCapacity = {
    books: cap.books ?? LIBRARY_CAPACITY.books,
    boards: cap.boards ?? LIBRARY_CAPACITY.boards,
    notebooks: cap.notebooks ?? LIBRARY_CAPACITY.notebooks,
  }
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
      const nextStations = new Map<string, SlotMap>()
      const nextLibrary = new Map<string, LibraryMap>()
      for (const [provider, caps] of state.capabilities) {
        nextStations.set(provider, assignStations(caps, stations.get(provider)))
        nextLibrary.set(provider, assignLibrary(caps, library.get(provider), libraryCapacity))
      }
      stations = nextStations
      library = nextLibrary
      const out = direct({
        agents,
        layout,
        seating: seating.seats,
        memory,
        now,
        capabilities: state.capabilities,
        stations,
        library,
      })
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

      // Links: every use still in use or fading, from where the agent is now.
      const calls: LinkCall[] = []
      const here = layout
      for (const [id, intent] of out.intents) {
        const m = memory.agents.get(id)!
        const zone = grouping(m.agent, (x) => state.agents.get(x)).zone
        const wings = here.wingsByProvider.get(zone) ?? []
        const seat = seating.seats.get(id)
        const seatWing = seat && parseAnchorId(seat).placement
        const wing = seatWing && wings.includes(seatWing) ? seatWing : wings[0]
        const p = pose(id, now)! // every intent has a track (set above)
        if (!wing) continue
        const list = state.capabilities.get(zone) ?? state.capabilities.get(m.agent.provider) ?? []
        for (const [cid, u] of m.uses ?? []) {
          const capability = list.find((c) => c.id === cid)
          if (!capability) continue
          const visiting =
            (intent.activity === 'connection-visit' || intent.activity === 'library-visit') &&
            intent.capability === cid
          const fade = u.category === 'adapter' ? CALL_FADE_MS : LIBRARY_FADE_MS
          if (!visiting && now - u.last >= fade) continue
          const arrived = visiting && p.anchor === intent.target && p.speed === 0
          calls.push({
            agentId: id,
            capability,
            wing: visiting ? parseAnchorId(intent.target).placement : wing,
            from: arrived ? handPort(p) : agentPort(p, here),
            since: u.calls.at(-1) ?? u.last,
            last: u.since !== undefined ? now : u.last,
            visiting,
          })
        }
      }
      return {
        layout,
        layoutChanged: !prev || prev.key !== layout.key,
        plans,
        departed: out.departed,
        links: planLinks(calls, { layout, stations, library }, now),
        stations,
        library,
      }
    },
  }
}
