// The agent director: turns agent status over time into activities (where to be, doing what).
// Pure: one call per tick (4 Hz), memory in → memory out. Thresholds and dwell times are below.
import {
  byProviderAndTopic,
  type Agent,
  type AgentStatus,
  type Capability,
  type CapabilityCategory,
  type CapabilityKind,
} from '@agent-office/shared'
import { hash32, parseAnchorId } from './building.ts'
import { libraryKind, libraryShelf, type LibraryMap } from './library.ts'
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
import type { SlotMap } from './stations.ts'

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

// Capabilities (docs/capabilities.md §5).
/** Using the same adapter continuously this long sends the agent to its station. */
export const VISIT_SUSTAIN_MS = 20_000
/** …or this many calls to it within VISIT_WINDOW_MS. */
export const VISIT_CALLS = 4
export const VISIT_WINDOW_MS = 60_000
/** Back to the desk this long after the last use of the visited adapter. */
export const VISIT_RETURN_MS = 8_000
/** An adapter call link (and the connection-call overlay) lasts this long after the tool ends. */
export const CALL_FADE_MS = 600
/** Distinct skill/rule uses within LIBRARY_WINDOW_MS that send the agent to the Library. */
export const LIBRARY_VISIT_USES = 2
export const LIBRARY_WINDOW_MS = 60_000
/** A skill invoked after being idle/thinking this long also sends the agent to the Library. */
export const LIBRARY_IDLE_SKILL_MS = 10_000
/** Back to the desk this long after the last library use. */
export const LIBRARY_RETURN_MS = 10_000
/** The used spine, board or notebook glows this long. */
export const LIBRARY_GLOW_MS = 6_000
/** A library call link (and the library-call overlay) lasts this long after the use ends. */
export const LIBRARY_FADE_MS = 1_500
/** The second person at a shared shelf spot stands this far to the right. */
export const SHELF_SHARE_OFFSET = 0.6
/** Readers headed to a seat keep their shelf spot this long (enough to pick a book). */
export const SHELF_PICK_MS = 15_000
/** Tolerance between a status change and the matching capability update (separate messages). */
export const CALM_GRACE_MS = 2_000

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
  'connection-call': CALL_FADE_MS,
  'connection-visit': 15_000,
  'library-call': LIBRARY_FADE_MS,
  'library-visit': 20_000,
}

/** leaving > booth > meeting > connection-visit = library-visit > desk-* (and calls) > breaks. Changes to priority ≥ PREEMPT_PRIORITY that raise the priority skip the dwell. */
export const ACTIVITY_PRIORITY: Readonly<Record<Activity, number>> = {
  leaving: 5,
  booth: 4,
  meeting: 3,
  'desk-work': 2,
  'desk-think': 2,
  'desk-error': 2,
  'desk-idle': 2,
  'connection-call': 2,
  'library-call': 2,
  'connection-visit': 2.5,
  'library-visit': 2.5,
  kitchen: 1,
  lounge: 1,
  cafe: 1,
  pingpong: 1,
  arriving: 0,
}
export const PREEMPT_PRIORITY = 3

type BreakKind = 'kitchen' | 'lounge' | 'cafe'
const BREAKS = new Set<Activity>(['kitchen', 'lounge', 'cafe', 'pingpong'])
const DESK = new Set<Activity>(['desk-work', 'desk-think', 'desk-error', 'desk-idle'])
const OVERLAYS = new Set<Activity>(['connection-call', 'library-call'])
const VISITS = new Set<Activity>(['connection-visit', 'library-visit'])

/** One agent's use of one capability (from `Capability.active`). */
export interface CapabilityUse {
  category: CapabilityCategory
  kind: CapabilityKind
  /** Start of the current continuous use (undefined while not in use). */
  since?: number
  /** Last time it was in use. */
  last: number
  /** Start times of uses (calls) within the last 60 s. */
  calls: number[]
}

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
  /** Capability use history (calls, continuous use, last use), keyed by capability id. */
  uses?: Map<string, CapabilityUse>
  /** The latest continuous idle/thinking run (end set when it stopped). */
  calm?: { start: number; end?: number }
  /** When a skill was invoked after ≥ LIBRARY_IDLE_SKILL_MS calm (a library-visit trigger). */
  calmSkillAt?: number
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
  /** Capabilities per provider; `active` tells who uses what right now. */
  capabilities?: Map<string, Capability[]>
  /** Station slots per provider (assignStations). */
  stations?: Map<string, SlotMap>
  /** Library slots per provider (assignLibrary). */
  library?: Map<string, LibraryMap>
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

  // 1b. Capability use (from `Capability.active`) and calm (idle/thinking) runs.
  const inUse = new Map<string, Capability[]>()
  for (const list of input.capabilities?.values() ?? [])
    for (const c of list) for (const who of c.active) inUse.set(who, [...(inUse.get(who) ?? []), c])
  for (const id of ids) {
    const m = mem.get(id)!
    if (!active(m)) continue
    const calmNow = m.agent.status === 'idle' || m.agent.status === 'thinking'
    const running = m.calm && m.calm.end === undefined
    if (calmNow && !running) m.calm = { start: now }
    else if (!calmNow && running) m.calm = { start: m.calm!.start, end: now }
    const calmEnough = () => {
      if (!m.calm) return false
      const end = m.calm.end ?? now
      return end - m.calm.start >= LIBRARY_IDLE_SKILL_MS && now - end <= CALM_GRACE_MS
    }
    const uses = new Map<string, CapabilityUse>()
    for (const [k, u] of m.uses ?? []) {
      const calls = u.calls.filter((t) => now - t < VISIT_WINDOW_MS)
      if (u.since === undefined && !calls.length && now - u.last >= VISIT_WINDOW_MS) continue
      uses.set(k, { ...u, calls })
    }
    const using = inUse.get(id) ?? []
    for (const c of using) {
      const u = uses.get(c.id) ?? { category: c.category, kind: c.kind, last: now, calls: [] }
      if (u.since === undefined) {
        u.since = now
        u.calls = [...u.calls, now]
        if (c.category === 'skill' && calmEnough()) m.calmSkillAt = now
      }
      u.last = now
      uses.set(c.id, u)
    }
    for (const [k, u] of uses)
      if (u.since !== undefined && !using.some((c) => c.id === k)) {
        const ended: CapabilityUse = {
          category: u.category,
          kind: u.kind,
          last: u.last,
          calls: u.calls,
        }
        uses.set(k, ended)
      }
    m.uses = uses
  }

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

  const set = (
    m: AgentMemory,
    activity: Activity,
    target: AnchorId,
    extra: Partial<Intent> = {},
  ) => {
    if (m.intent.activity === 'pingpong' && activity !== 'pingpong' && m.pairHolder) {
      res = release(res, m.pairHolder)
      delete m.pairHolder
    }
    if (m.intent.activity === 'library-visit') res = release(res, `${m.agent.id}#shelf`)
    m.intent = { activity, target, since: now, ...extra }
  }
  const deskWing = (a: Agent): string | undefined => {
    const wings = wingsOf(a)
    const seat = seating.get(a.id)
    const p = seat && parseAnchorId(seat).placement
    return p && wings.includes(p) ? p : wings[0]
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
        for (const h of [id, `${id}#desk`, `${id}#arrive`, `${id}#shelf`]) res = release(res, h)
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
            : VISITS.has(cur.activity)
              ? !!reservationOf(res, id)?.anchors.includes(cur.target) ||
                !!reservationOf(res, `${id}#shelf`)?.anchors.includes(cur.target)
              : true
    const allowed = (to: Activity) => {
      if (!valid || cur.activity === 'leaving') return true
      if (cur.activity === 'arriving') return now - cur.since >= ARRIVE_MS
      // A call overlay starts at once from the desk: the agent doesn't move.
      if (DESK.has(cur.activity) && OVERLAYS.has(to)) return true
      // …and anything more important (a visit) may follow it at once.
      if (OVERLAYS.has(cur.activity) && ACTIVITY_PRIORITY[to] > ACTIVITY_PRIORITY[cur.activity])
        return true
      const pt = ACTIVITY_PRIORITY[to]
      if (pt >= PREEMPT_PRIORITY && pt > ACTIVITY_PRIORITY[cur.activity]) return true
      return now - cur.since >= DWELL_MS[cur.activity]
    }
    const statusFor = now - m.statusSince
    const wantBooth = a.status === 'waiting' && statusFor >= WAITING_TO_BOOTH_MS
    const wantBreak = a.status === 'idle' && statusFor >= IDLE_BREAK_MS
    const uses = m.uses ?? new Map<string, CapabilityUse>()
    const isLib = (u: CapabilityUse) => u.category !== 'adapter'
    // The call overlay: the most recently started use still in use or within its fade.
    let call: { activity: Activity; capability: string; at: number } | undefined
    for (const [cid, u] of uses) {
      if (now - u.last > (isLib(u) ? LIBRARY_FADE_MS : CALL_FADE_MS)) continue
      const at = u.since ?? u.last
      if (!call || at > call.at || (at === call.at && cid < call.capability))
        call = { activity: isLib(u) ? 'library-call' : 'connection-call', capability: cid, at }
    }
    // Visit triggers (adapter: sustained or repeated; library: distinct uses or a calm skill).
    let visit: { activity: Activity; capability: string; at: number } | undefined
    const offer = (activity: Activity, capability: string, at: number) => {
      if (!visit || at < visit.at) visit = { activity, capability, at }
    }
    const libUses = [...uses].filter(([, u]) => isLib(u))
    for (const [cid, u] of uses) {
      if (isLib(u)) continue
      if (u.since !== undefined && now - u.since >= VISIT_SUSTAIN_MS)
        offer('connection-visit', cid, u.since + VISIT_SUSTAIN_MS)
      else if (u.calls.length >= VISIT_CALLS && now - u.last < VISIT_RETURN_MS)
        offer('connection-visit', cid, u.calls.at(-1)!)
    }
    const latestLib = libUses.sort(([x, a], [y, b]) => b.last - a.last || byId(x, y))[0]?.[0]
    const firsts = libUses
      .map(([, u]) => u.calls.find((t) => now - t < LIBRARY_WINDOW_MS))
      .filter((t): t is number => t !== undefined)
      .sort((x, y) => x - y)
    // Old uses alone don't trigger: the latest one must be recent (else the agent would just return).
    const libRecent = libUses.some(([, u]) => now - u.last < LIBRARY_RETURN_MS)
    if (latestLib && libRecent && firsts.length >= LIBRARY_VISIT_USES)
      offer('library-visit', latestLib, firsts[LIBRARY_VISIT_USES - 1]!)
    const calmSkill = libUses.find(([, u]) => u.category === 'skill' && u.since !== undefined)?.[0]
    if (calmSkill && m.calmSkillAt !== undefined && now - m.calmSkillAt < LIBRARY_RETURN_MS)
      offer('library-visit', calmSkill, m.calmSkillAt)
    const ongoing = () => {
      if (cur.activity === 'connection-visit') {
        const u = uses.get(cur.capability ?? '')
        return !!u && (u.since !== undefined || now - u.last < VISIT_RETURN_MS)
      }
      return libUses.some(([, u]) => u.since !== undefined || now - u.last < LIBRARY_RETURN_MS)
    }

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
      if (VISITS.has(cur.activity) && valid && ongoing()) break decide
      if (visit && allowed(visit.activity)) {
        const zone = byProviderAndTopic(a, lookup).zone
        const wing = deskWing(a)
        const extra: Partial<Intent> = { capability: visit.capability }
        if (wing && visit.activity === 'connection-visit') {
          const slot = input.stations?.get(zone)?.slot.get(visit.capability)
          const anchor = `${wing}/spot:station:${slot}`
          const r =
            slot === undefined
              ? undefined
              : reserve(res, layout, { kind: 'station', holder: id, wings: [wing], anchor }, now)
          if (r?.grant) {
            res = r.state
            set(m, 'connection-visit', anchor, extra)
            break decide
          }
        } else if (wing) {
          const u = uses.get(visit.capability)!
          const kind = libraryKind({ id: visit.capability, category: u.category, kind: u.kind })!
          const lib = input.library?.get(zone)
          const slots =
            kind === 'skill' ? lib?.books : kind === 'rule' ? lib?.boards : lib?.notebooks
          const shelf = `${wing}/spot:shelf:${libraryShelf(kind, slots?.slot.get(visit.capability) ?? 0)}`
          const shelfReq = {
            kind: 'shelf-spot' as const,
            holder: `${id}#shelf`,
            wings: [wing],
            anchor: shelf,
          }
          const seat = reserve(
            res,
            layout,
            { kind: 'reading-seat', holder: id, wings: [wing] },
            now,
          )
          // Seated reader: pick the book on the way when the shelf has room; else go straight to the seat.
          // No seat: read standing at the shelf. Neither: stay with a call.
          const sh = reserve(
            seat.grant ? seat.state : res,
            layout,
            seat.grant ? { ...shelfReq, ttl: SHELF_PICK_MS } : shelfReq,
            now,
          )
          if (sh.grant && sh.share) extra.lateral = sh.share * SHELF_SHARE_OFFSET
          if (seat.grant) {
            res = sh.grant ? sh.state : seat.state
            if (sh.grant) extra.via = [shelf]
            set(m, 'library-visit', seat.grant[0]!, extra)
            break decide
          }
          if (sh.grant) {
            res = sh.state
            set(m, 'library-visit', shelf, extra)
            break decide
          }
        }
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
      const activity = call ? call.activity : deskActivity(a.status)
      if (cur.activity === activity && valid && cur.target === deskTarget(id)) {
        // Another capability on the same overlay: relabel without re-planning (same `since`).
        if (call && cur.capability !== call.capability)
          m.intent = { ...cur, capability: call.capability }
        break decide
      }
      if (!allowed(activity)) break decide
      res = release(res, id)
      set(m, activity, deskTarget(id), call ? { capability: call.capability } : {})
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
