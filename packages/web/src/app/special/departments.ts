// Departments and staging (plan §5.4, docs/special-3d/world-layout.md). Each provider gets the
// department matching its classic wing order; the director's intents (computed on the classic
// building) are mapped onto Night City anchors: the director's desk → the same workstation in the
// provider's department, a booth → a secure comm booth, a team meeting → one shared glass room,
// breaks → lounge seats, capability visits → a provider terminal. Shared spots are held by one
// agent at a time; with none free the agent stays at its workstation. Pure (no three.js).
import { parseAnchorId } from '../building.ts'
import type { AgentPlan, AnchorId, BuildingLayout, Intent } from '../office-types.ts'
import type { SpecialWorld } from './world.ts'

/** Departments in the R1 Command Center; later providers share any free workstation. */
export const MAX_DEPARTMENTS = 6

/** Providers in classic wing order (slot index: pinned or hash order), main wings only. */
export function departmentOrder(
  layout: BuildingLayout | null,
  providers: Iterable<string>,
): string[] {
  const slots = [...(layout?.slots ?? [])].sort((a, b) => a.index - b.index)
  const out: string[] = []
  for (const s of slots) if (s.annex === 0 && !out.includes(s.provider)) out.push(s.provider)
  if (out.length) return out
  return [...new Set(providers)].sort()
}

/** The provider's department index, or null (overflow / unknown). */
export function departmentOf(provider: string, order: readonly string[]): number | null {
  const i = order.indexOf(provider)
  return i >= 0 && i < MAX_DEPARTMENTS ? i : null
}

const DESK = /^wing:([^/]+):(\d+)\/seat:desk:(\d+):(\d+)$/
const MEETING = /^(wing:[^/]+:\d+)\/seat:meeting:([A-Za-z0-9]+):(\d+)$/
const BOOTH = /\/spot:booth:(\d+)$/

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

export interface StageMap {
  /** The Night City intent for a classic plan (stable assignments; shared spots held). */
  map(plan: AgentPlan, order: readonly string[]): Intent
  /** Frees everything the agent holds (it left the scene). */
  drop(agentId: string): void
  /** The agent's workstation anchor (monitor status), if it has one. */
  deskOf(agentId: string): AnchorId | undefined
}

export function createStageMap(world: Pick<SpecialWorld, 'layout'>): StageMap {
  const ids = [...world.layout.anchors.keys()]
  const byLocal = new Map<string, AnchorId>()
  for (const id of ids) byLocal.set(parseAnchorId(id).local, id)
  const pool = (re: RegExp) => ids.filter((id) => re.test(parseAnchorId(id).local)).sort()
  const ws = pool(/^ws:\d+:\d+:\d+$/)
  const booths = pool(/^booth:\d+$/)
  const lounges = pool(/^(seat:lounge|seat:cafe|spot:lounge):/)
  const terminals = pool(/^spot:terminal:/)
  const elevators = pool(/^spot:elevator:/)
  const reception = pool(/^spot:reception:/)
  const rooms = new Map<string, AnchorId[]>()
  for (const id of pool(/^meet:/)) {
    const [, room] = parseAnchorId(id).local.split(':')
    rooms.set(room!, [...(rooms.get(room!) ?? []), id])
  }
  for (const seats of rooms.values())
    seats.sort(
      (p, q) => Number(p.slice(p.lastIndexOf(':') + 1)) - Number(q.slice(q.lastIndexOf(':') + 1)),
    )

  /** anchor → holder; agent → its workstation and its current shared spot. */
  const held = new Map<AnchorId, string>()
  const desks = new Map<string, AnchorId>()
  const shared = new Map<string, AnchorId>()
  /** classic team key (`wing…|room`) → special room, and its members. */
  const teamRoom = new Map<string, string>()
  const members = new Map<string, Set<string>>()
  const memberOf = new Map<string, string>()

  const free = (id: AnchorId, agent: string) => {
    const h = held.get(id)
    return h === undefined || h === agent
  }

  function deskFor(
    agent: string,
    provider: string,
    target: string,
    order: readonly string[],
  ): AnchorId | undefined {
    const known = desks.get(agent)
    if (known) return known
    // The desk's wing names the department (the grouping zone), else the agent's provider.
    const m = DESK.exec(target)
    const dept = departmentOf(m?.[1] ?? provider, order)
    let pick: AnchorId | undefined
    if (m && dept !== null && m[2] === '0') {
      const want = byLocal.get(`ws:${dept}:${m[3]}:${m[4]}`)
      if (want && free(want, agent)) pick = want
    }
    if (!pick && dept !== null)
      pick = ws.find((id) => free(id, agent) && parseAnchorId(id).local.startsWith(`ws:${dept}:`))
    // Overflow: any free workstation, starting from a stable offset so agents spread out.
    if (!pick && ws.length) {
      const start = hash(agent) % ws.length
      for (let i = 0; i < ws.length && !pick; i++) {
        const id = ws[(start + i) % ws.length]!
        if (free(id, agent)) pick = id
      }
    }
    if (pick) {
      held.set(pick, agent)
      desks.set(agent, pick)
    }
    return pick
  }

  function releaseShared(agent: string) {
    const s = shared.get(agent)
    if (s && held.get(s) === agent) held.delete(s)
    shared.delete(agent)
  }

  function leaveTeam(agent: string) {
    const key = memberOf.get(agent)
    if (!key) return
    memberOf.delete(agent)
    const set = members.get(key)
    set?.delete(agent)
    if (set && !set.size) {
      members.delete(key)
      teamRoom.delete(key)
    }
  }

  function holdShared(agent: string, candidates: AnchorId[], prefer: number): AnchorId | undefined {
    const current = shared.get(agent)
    if (current && candidates.includes(current)) return current
    releaseShared(agent)
    if (!candidates.length) return undefined
    for (let i = 0; i < candidates.length; i++) {
      const id = candidates[(prefer + i) % candidates.length]!
      if (free(id, agent)) {
        held.set(id, agent)
        shared.set(agent, id)
        return id
      }
    }
    return undefined
  }

  function meetingSeat(agent: string, target: string): AnchorId | undefined {
    const m = MEETING.exec(target)
    if (!m) return undefined
    const key = `${m[1]}|${m[2]}`
    if (memberOf.get(agent) !== key) leaveTeam(agent)
    let room = teamRoom.get(key)
    if (!room) {
      const busy = new Set(teamRoom.values())
      room = [...rooms.keys()].sort().find((r) => !busy.has(r))
      if (!room) return undefined
      teamRoom.set(key, room)
    }
    members.set(key, (members.get(key) ?? new Set()).add(agent))
    memberOf.set(agent, key)
    const seats = rooms.get(room)!
    return holdShared(agent, seats, Number(m[3]) % seats.length)
  }

  return {
    map(plan, order) {
      const { agent, intent } = plan
      const id = agent.id
      const desk = deskFor(id, agent.provider, intent.target, order)
      const out: Intent = {
        activity: intent.activity,
        target: desk ?? intent.target,
        since: intent.since,
      }
      if (intent.spawn) out.spawn = true
      if (intent.capability) out.capability = intent.capability
      let target: AnchorId | undefined
      switch (intent.activity) {
        case 'meeting':
          target = meetingSeat(id, intent.target)
          break
        case 'booth': {
          leaveTeam(id)
          const n = Number(BOOTH.exec(intent.target)?.[1] ?? 0)
          target = holdShared(id, booths, n % Math.max(1, booths.length))
          break
        }
        case 'kitchen':
        case 'lounge':
        case 'cafe':
        case 'pingpong':
          leaveTeam(id)
          target = holdShared(id, lounges, hash(id) % Math.max(1, lounges.length))
          break
        case 'connection-visit':
        case 'library-visit':
          leaveTeam(id)
          target = holdShared(id, terminals, hash(id) % Math.max(1, terminals.length))
          break
        case 'leaving':
          leaveTeam(id)
          releaseShared(id)
          target = elevators.length ? elevators[hash(id) % elevators.length] : undefined
          break
        case 'arriving': {
          leaveTeam(id)
          releaseShared(id)
          const via: AnchorId[] = []
          if (elevators.length) via.push(elevators[hash(id) % elevators.length]!)
          if (reception.length) via.push(reception[0]!)
          if (via.length) out.via = via
          break
        }
        default:
          // Desk activities (and capability calls, which are overlays at the desk).
          leaveTeam(id)
          releaseShared(id)
      }
      if (target) out.target = target
      return out
    },
    drop(agentId) {
      leaveTeam(agentId)
      releaseShared(agentId)
      const d = desks.get(agentId)
      if (d && held.get(d) === agentId) held.delete(d)
      desks.delete(agentId)
    },
    deskOf: (agentId) => desks.get(agentId),
  }
}
