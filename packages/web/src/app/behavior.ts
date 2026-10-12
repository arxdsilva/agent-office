// The agent director: turns agent status over time into activities (where to be, doing what).
// Pure: one call per tick (4 Hz), memory in → memory out. Thresholds and dwell times are below.
import { byProviderAndTopic, type Agent, type AgentStatus } from '@agent-office/shared'
import { hash32, parseAnchorId } from './building.ts'
import type { Activity, AnchorId, BuildingLayout, Intent, Seating } from './office-types.ts'
import {
  emptyReservations,
  expire,
  release,
  reservationOf,
  reserve,
  type ReservationState,
  type ResourceKind,
} from './reservations.ts'

/** An arriving agent walks elevator → reception → desk; other activities can take over after this. */
export const ARRIVE_MS = 15_000
/** A leaving agent's walk to the elevator, the doors and the fade fit in this; then it has departed. */
export const LEAVE_MS = 25_000
/** A parent needs ≥ 1 non-done subagent this long before the team takes a meeting room. */
export const TEAM_FORM_MS = 5_000
/** A meeting ends after this long without active subagents. */
export const TEAM_DISBAND_MS = 8_000
/** Waiting this long sends an agent to a phone booth. */
export const WAITING_TO_BOOTH_MS = 4_000
/** Idle this long sends an agent on a break (kitchen, lounge or cafe). */
export const IDLE_BREAK_MS = 45_000
/** Two agents idle this long, on a break in the same wing, play ping-pong. */
export const PINGPONG_IDLE_MS = 90_000
export const IDLE_WEIGHTS = { kitchen: 0.5, lounge: 0.35, cafe: 0.15 } as const

/** Minimum time in an activity before a lower- or equal-priority change is accepted (absorbs flapping). */
export const DWELL_MS: Readonly<Record<Activity, number>> = {
  arriving: ARRIVE_MS,
  'desk-work': 3_000,
  'desk-think': 3_000,
  'desk-error': 5_000,
  'desk-idle': 3_000,
  meeting: 15_000,
  booth: 10_000,
  kitchen: 20_000,
  lounge: 20_000,
  cafe: 20_000,
  pingpong: 30_000,
  leaving: 0,
}

/** leaving > booth > meeting > desk-* > breaks. Changes to priority ≥ PREEMPT_PRIORITY that raise the priority skip the dwell. */
export const ACTIVITY_PRIORITY: Readonly<Record<Activity, number>> = {
  leaving: 5,
  booth: 4,
  meeting: 3,
  'desk-work': 2,
  'desk-think': 2,
  'desk-error': 2,
  'desk-idle': 2,
  kitchen: 1,
  lounge: 1,
  cafe: 1,
  pingpong: 1,
  arriving: 0,
}
export const PREEMPT_PRIORITY = 3

type BreakKind = 'kitchen' | 'lounge' | 'cafe'
const BREAKS = new Set<Activity>(['kitchen', 'lounge', 'cafe', 'pingpong'])

export interface AgentMemory {
  /** Last seen version of the agent (kept while a removed agent walks out). */
  agent: Agent
  intent: Intent
  /** When the current status started (as observed by the director). */
  statusSince: number
  /** Set when the agent disappeared from state. */
  removedAt?: number
  /** The leave finished; no more intents. Kept as a tombstone while a `done` agent stays in state. */
  departed?: boolean
  /** As a parent: since when it has had ≥ 1 non-done subagent. */
  teamSince?: number
  /** As a parent holding a room: since when it has had no active subagents. */
  lonelySince?: number
  meetingSeat?: AnchorId
  /** Ping-pong reservation holder shared with the partner. */
  pairHolder?: string
  /** Number of breaks taken (varies the hashed break choice). */
  breaks: number
}

export interface DirectorMemory {
  agents: Map<string, AgentMemory>
  reservations: ReservationState
  /** Ticks run so far. Agents present at the first tick spawn in place instead of arriving. */
  ticks: number
}

export const emptyMemory = (): DirectorMemory => ({
  agents: new Map(),
  reservations: emptyReservations(),
  ticks: 0,
})

export interface DirectInput {
  agents: Agent[]
  layout: BuildingLayout
  seating: Seating
  memory: DirectorMemory
  now: number
}

export interface DirectOutput {
  memory: DirectorMemory
  /** One intent per visible agent (including ones walking out), keyed by agent id, sorted by id. */
  intents: Map<string, Intent>
  /** Agents whose leave finished this tick: the scene can drop them. */
  departed: string[]
}

/** Hashed break choice: 50% kitchen, 35% lounge, 15% cafe. */
export function idleBreakKind(id: string, n: number): BreakKind {
  const r = (hash32(`${id}#${n}`) % 10_000) / 10_000
  return r < IDLE_WEIGHTS.kitchen
    ? 'kitchen'
    : r < IDLE_WEIGHTS.kitchen + IDLE_WEIGHTS.lounge
      ? 'lounge'
      : 'cafe'
}

export function deskActivity(status: AgentStatus): Activity {
  return status === 'tool'
    ? 'desk-work'
    : status === 'thinking'
      ? 'desk-think'
      : status === 'error'
        ? 'desk-error'
        : 'desk-idle'
}

const elevatorCache = new WeakMap<BuildingLayout, AnchorId[]>()
function elevators(layout: BuildingLayout): AnchorId[] {
  let e = elevatorCache.get(layout)
  if (!e)
    elevatorCache.set(
      layout,
      (e = [...layout.anchors.values()]
        .filter((a) => /^spot:elevator:/.test(a.local))
        .map((a) => a.id)),
    )
  return e
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function direct(input: DirectInput): DirectOutput {
  const { agents, layout, seating, now } = input
  let res = expire(input.memory.reservations, now)
  const first = input.memory.ticks === 0
  const present = new Map(agents.map((a) => [a.id, a]))
  const mem = new Map<string, AgentMemory>()
  const departed: string[] = []
  const lookup = (id: string) => present.get(id) ?? input.memory.agents.get(id)?.agent
  const wingsOf = (a: Agent) => layout.wingsByProvider.get(byProviderAndTopic(a, lookup).zone) ?? []
  const elevatorFor = (id: string) => {
    const e = elevators(layout)
    return e.length ? e[hash32(id) % e.length]! : ''
  }
  const deskTarget = (id: string): AnchorId => {
    const seat = seating.get(id)
    if (seat) {
      res = release(res, `${id}#desk`)
      return seat
    }
    // No desk (provider without a wing, or wings full): hot-desk at the atrium cafe.
    const r = reserve(res, layout, { kind: 'cafe', holder: `${id}#desk` }, now)
    res = r.state
    return r.grant?.[0] ?? ''
  }
  const fresh = (a: Agent): AgentMemory => {
    if (first) {
      const m: AgentMemory = {
        agent: a,
        statusSince: now,
        breaks: 0,
        intent: { activity: deskActivity(a.status), target: '', since: now },
      }
      if (a.status === 'done') m.departed = true
      else
        m.intent = {
          activity: deskActivity(a.status),
          target: deskTarget(a.id),
          since: now,
          spawn: true,
        }
      return m
    }
    const r = reserve(
      res,
      layout,
      { kind: 'reception', holder: `${a.id}#arrive`, ttl: ARRIVE_MS },
      now,
    )
    res = r.state
    const via = [elevatorFor(a.id), r.grant?.[0]].filter((x): x is string => !!x)
    return {
      agent: a,
      statusSince: now,
      breaks: 0,
      intent: { activity: 'arriving', target: deskTarget(a.id), since: now, via },
    }
  }

  // 1. Carry memory over; note removals and status changes.
  for (const [id, old] of input.memory.agents) {
    const a = present.get(id)
    if (!a) {
      if (!old.departed) mem.set(id, { ...old, removedAt: old.removedAt ?? now })
      continue
    }
    if (old.departed && a.status !== 'done') continue // came back: arrives again below
    const m: AgentMemory = { ...old, agent: a }
    delete m.removedAt
    if (a.status !== old.agent.status) m.statusSince = now
    mem.set(id, m)
  }
  for (const a of [...agents].sort((x, y) => byId(x.id, y.id)))
    if (!mem.has(a.id)) mem.set(a.id, fresh(a))

  const ids = [...mem.keys()].sort(byId)
  const active = (m: AgentMemory) =>
    !m.departed && m.removedAt === undefined && m.agent.status !== 'done'

  // 2. Teams: a parent with active subagents for TEAM_FORM_MS gets a whole meeting room.
  const kids = new Map<string, string[]>()
  for (const id of ids) {
    const m = mem.get(id)!
    const p = m.agent.parentId
    if (p && active(m) && mem.has(p)) kids.set(p, [...(kids.get(p) ?? []), id])
  }
  const meetingSeat = new Map<string, AnchorId>()
  for (const id of ids) {
    const m = mem.get(id)!
    const team = kids.get(id) ?? []
    const holder = `team:${id}`
    if (team.length) {
      m.teamSince ??= now
      delete m.lonelySince
    } else {
      delete m.teamSince
      if (reservationOf(res, holder)) m.lonelySince ??= now
    }
    const held = reservationOf(res, holder)
    if (
      held &&
      (!active(m) || (m.lonelySince !== undefined && now - m.lonelySince >= TEAM_DISBAND_MS))
    ) {
      res = release(res, holder)
      delete m.lonelySince
    } else if (active(m) && team.length && now - m.teamSince! >= TEAM_FORM_MS) {
      res = reserve(
        res,
        layout,
        { kind: 'meeting', holder, wings: wingsOf(m.agent), seats: 1 + team.length },
        now,
      ).state
    }
    const room = reservationOf(res, holder)
    if (!room) continue
    const members = [
      id,
      ...team.sort((a, b) => mem.get(a)!.agent.since - mem.get(b)!.agent.since || byId(a, b)),
    ]
    const used = new Set<AnchorId>()
    for (const k of members) {
      const s = mem.get(k)!.meetingSeat
      if (s && room.anchors.includes(s) && !used.has(s)) (used.add(s), meetingSeat.set(k, s))
    }
    for (const k of members) {
      if (meetingSeat.has(k)) continue
      const s = room.anchors.find((x) => !used.has(x))
      if (s) (used.add(s), meetingSeat.set(k, s))
    }
  }
  for (const id of ids) {
    const m = mem.get(id)!
    const s = meetingSeat.get(id)
    if (s) m.meetingSeat = s
    else delete m.meetingSeat
  }

  const set = (m: AgentMemory, activity: Activity, target: AnchorId) => {
    if (m.intent.activity === 'pingpong' && activity !== 'pingpong' && m.pairHolder) {
      res = release(res, m.pairHolder)
      delete m.pairHolder
    }
    m.intent = { activity, target, since: now }
  }

  // 3. Ping-pong: pairs of long-idle agents on a break in the same wing.
  const decided = new Set<string>()
  const byWing = new Map<string, string[]>()
  for (const id of ids) {
    const m = mem.get(id)!
    const { activity, since, target } = m.intent
    if (
      !active(m) ||
      m.agent.status !== 'idle' ||
      (activity !== 'kitchen' && activity !== 'lounge')
    )
      continue
    if (now - m.statusSince < PINGPONG_IDLE_MS || now - since < DWELL_MS[activity]) continue
    const wing = parseAnchorId(target).placement
    byWing.set(wing, [...(byWing.get(wing) ?? []), id])
  }
  for (const [, group] of [...byWing].sort(([a], [b]) => byId(a, b))) {
    for (let i = 0; i + 1 < group.length; i += 2) {
      const [a, b] = [group[i]!, group[i + 1]!]
      const holder = `pingpong:${a}|${b}`
      const r = reserve(res, layout, { kind: 'pingpong', holder }, now)
      if (!r.grant) break
      res = release(release(r.state, a), b)
      for (const [k, spot] of [
        [a, r.grant[0]!],
        [b, r.grant[1]!],
      ] as const) {
        const m = mem.get(k)!
        set(m, 'pingpong', spot)
        m.pairHolder = holder
        decided.add(k)
      }
    }
  }

  // 4. Everyone else, in priority order: leaving > booth > meeting > desk-* > breaks.
  for (const id of ids) {
    if (decided.has(id)) continue
    const m = mem.get(id)!
    if (m.departed) continue
    const a = m.agent
    const cur = m.intent

    if (m.removedAt !== undefined || a.status === 'done') {
      if (cur.activity !== 'leaving') {
        for (const h of [id, `${id}#desk`, `${id}#arrive`]) res = release(res, h)
        const r = reserve(res, layout, { kind: 'elevator', holder: id }, now)
        res = r.state
        set(m, 'leaving', r.grant?.[0] ?? elevatorFor(id))
      } else if (now - cur.since >= LEAVE_MS) {
        res = release(res, id)
        m.departed = true
        departed.push(id)
        if (m.removedAt !== undefined) mem.delete(id)
      }
      continue
    }

    const valid =
      cur.activity === 'meeting'
        ? m.meetingSeat === cur.target
        : cur.activity === 'pingpong'
          ? !!m.pairHolder && !!reservationOf(res, m.pairHolder)
          : cur.activity === 'booth' ||
              cur.activity === 'kitchen' ||
              cur.activity === 'lounge' ||
              cur.activity === 'cafe'
            ? !!reservationOf(res, id)?.anchors.includes(cur.target)
            : true
    const allowed = (to: Activity) => {
      if (!valid || cur.activity === 'leaving') return true
      if (cur.activity === 'arriving') return now - cur.since >= ARRIVE_MS
      const pt = ACTIVITY_PRIORITY[to]
      if (pt >= PREEMPT_PRIORITY && pt > ACTIVITY_PRIORITY[cur.activity]) return true
      return now - cur.since >= DWELL_MS[cur.activity]
    }
    const statusFor = now - m.statusSince
    const wantBooth = a.status === 'waiting' && statusFor >= WAITING_TO_BOOTH_MS
    const wantBreak = a.status === 'idle' && statusFor >= IDLE_BREAK_MS

    decide: {
      if (wantBooth) {
        if (cur.activity === 'booth' && valid) break decide
        if (!allowed('booth')) break decide
        const r = reserve(res, layout, { kind: 'booth', holder: id, wings: wingsOf(a) }, now)
        if (r.grant) {
          res = r.state
          set(m, 'booth', r.grant[0]!)
          break decide
        }
      }
      if (m.meetingSeat) {
        if (cur.activity === 'meeting' && valid) break decide
        if (!allowed('meeting')) break decide
        res = release(res, id)
        set(m, 'meeting', m.meetingSeat)
        break decide
      }
      if (wantBreak) {
        if (BREAKS.has(cur.activity) && valid) break decide
        const kind = idleBreakKind(id, m.breaks)
        if (!allowed(kind)) break decide
        const r = reserve(
          res,
          layout,
          { kind: kind as ResourceKind, holder: id, wings: wingsOf(a) },
          now,
        )
        if (r.grant) {
          res = r.state
          m.breaks++
          set(m, r.kind as Activity, r.grant[0]!)
          break decide
        }
      }
      const activity = deskActivity(a.status)
      if (cur.activity === activity && valid && cur.target === deskTarget(id)) break decide
      if (!allowed(activity)) break decide
      res = release(res, id)
      set(m, activity, deskTarget(id))
    }
  }

  const intents = new Map<string, Intent>()
  for (const id of [...mem.keys()].sort(byId)) {
    const m = mem.get(id)!
    if (!m.departed) intents.set(id, m.intent)
  }
  return {
    memory: { agents: mem, reservations: res, ticks: input.memory.ticks + 1 },
    intents,
    departed,
  }
}
