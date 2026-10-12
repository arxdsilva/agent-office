import type { Agent } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { fixtureManifest } from './__fixtures__/manifest.ts'
import {
  ACTIVITY_PRIORITY,
  ARRIVE_MS,
  DWELL_MS,
  IDLE_BREAK_MS,
  IDLE_WEIGHTS,
  LEAVE_MS,
  PINGPONG_IDLE_MS,
  TEAM_DISBAND_MS,
  TEAM_FORM_MS,
  WAITING_TO_BOOTH_MS,
  direct,
  emptyMemory,
  idleBreakKind,
  type DirectOutput,
} from './behavior.ts'
import { planBuilding } from './building.ts'
import type { Activity, BuildingLayout } from './office-types.ts'
import { reservationOf } from './reservations.ts'
import { assignDesks, emptySeating } from './seating.ts'

const agent = (id: string, over: Partial<Agent> = {}): Agent => ({
  id,
  name: id,
  provider: 'claude-code',
  topic: 'T',
  status: 'tool',
  source: 'test',
  since: 0,
  lastSeen: 0,
  interactive: false,
  unread: 0,
  ...over,
})

const layoutFor = (n = 10) =>
  planBuilding([{ provider: 'claude-code', agents: n }], fixtureManifest, undefined, 0)

/** Threads memory and seating through ticks, like the controller does. */
function office(layout: BuildingLayout = layoutFor()) {
  let memory = emptyMemory()
  let seating = emptySeating()
  let last: DirectOutput | undefined
  return {
    layout,
    tick(agents: Agent[], now: number) {
      seating = assignDesks(agents, layout, seating, now)
      last = direct({ agents, layout, seating: seating.seats, memory, now })
      memory = last.memory
      return last
    },
    /** Ticks at 4 Hz over [from, to] with the agents given by `at(t)`. */
    run(at: (t: number) => Agent[], from: number, to: number) {
      const seen: { t: number; out: DirectOutput }[] = []
      for (let t = from; t <= to; t += 250) seen.push({ t, out: this.tick(at(t), t) })
      return seen
    },
    get memory() {
      return memory
    },
    get seats() {
      return seating.seats
    },
  }
}
const act = (out: DirectOutput, id: string): Activity | undefined => out.intents.get(id)?.activity

describe('direct: arrival and desks', () => {
  it('spawns agents present at the first tick at their desks', () => {
    const o = office()
    const out = o.tick([agent('a', { status: 'thinking' }), agent('d', { status: 'done' })], 0)
    expect(out.intents.get('a')).toMatchObject({ activity: 'desk-think', spawn: true, since: 0 })
    expect(out.intents.get('a')!.target).toBe(o.seats.get('a'))
    // Already finished at startup: never shown.
    expect(out.intents.has('d')).toBe(false)
  })

  it('(new) → arriving: elevator, then reception, then the desk; desk-work after the arrival', () => {
    const o = office()
    o.tick([], 0)
    const out = o.tick([agent('n')], 250)
    const i = out.intents.get('n')!
    expect(i.activity).toBe('arriving')
    expect(i.target).toBe(o.seats.get('n'))
    expect(i.via![0]).toMatch(/^atrium\/spot:elevator:\d$/)
    expect(i.via![1]).toMatch(/^atrium\/spot:reception:\d$/)
    expect(act(o.tick([agent('n')], 250 + ARRIVE_MS - 1), 'n')).toBe('arriving')
    expect(act(o.tick([agent('n')], 250 + ARRIVE_MS), 'n')).toBe('desk-work')
  })

  it('maps statuses to desk activities: tool → desk-work, thinking → desk-think, error → desk-error, idle → desk-idle', () => {
    const o = office()
    for (const [status, activity] of [
      ['tool', 'desk-work'],
      ['thinking', 'desk-think'],
      ['error', 'desk-error'],
      ['idle', 'desk-idle'],
      ['waiting', 'desk-idle'],
    ] as const)
      expect(act(office().tick([agent('a', { status })], 0), 'a')).toBe(activity)
    expect(o).toBeDefined()
  })

  it('holds desk-work for 3 s and desk-error for 5 s before switching', () => {
    const o = office()
    o.tick([agent('a')], 0)
    expect(act(o.tick([agent('a', { status: 'thinking' })], 1000), 'a')).toBe('desk-work')
    expect(act(o.tick([agent('a', { status: 'thinking' })], DWELL_MS['desk-work'] - 1), 'a')).toBe(
      'desk-work',
    )
    expect(act(o.tick([agent('a', { status: 'thinking' })], DWELL_MS['desk-work']), 'a')).toBe(
      'desk-think',
    )
    const e = office()
    e.tick([agent('b', { status: 'error' })], 0)
    expect(act(e.tick([agent('b')], DWELL_MS['desk-error'] - 1), 'b')).toBe('desk-error')
    expect(act(e.tick([agent('b')], DWELL_MS['desk-error']), 'b')).toBe('desk-work')
  })

  it('absorbs tool ↔ thinking flapping every second: always desk-*, few intent changes', () => {
    const o = office()
    const seen = o.run(
      (t) => [agent('a', { status: Math.floor(t / 1000) % 2 ? 'thinking' : 'tool' })],
      0,
      30_000,
    )
    const changes = new Set(seen.map((s) => s.out.intents.get('a')!.since)).size
    for (const s of seen) expect(act(s.out, 'a')).toMatch(/^desk-(work|think)$/)
    expect(changes).toBeLessThanOrEqual(Math.ceil(30_000 / DWELL_MS['desk-work']) + 1)
    // The desk never changes.
    expect(new Set(seen.map((s) => s.out.intents.get('a')!.target)).size).toBe(1)
  })

  it('sends unseated agents to an atrium cafe seat as a hot desk', () => {
    const o = office(layoutFor(1))
    const many = Array.from({ length: 25 }, (_, i) => agent(`a${String(i).padStart(2, '0')}`))
    const out = o.tick(many, 0)
    const extra = [...out.intents.values()].filter((i) => i.target.startsWith('atrium/seat:cafe:'))
    expect(extra).toHaveLength(1)
    expect(extra[0]!.activity).toBe('desk-work')
  })
})

describe('direct: rooms', () => {
  const team = (sub: Partial<Agent> = {}) => [agent('p'), agent('s1', { parentId: 'p', ...sub })]

  it('desk-* → meeting: a parent with an active subagent for 5 s takes the whole team to a room', () => {
    const o = office()
    o.tick(team(), 0)
    expect(act(o.tick(team(), TEAM_FORM_MS - 1), 'p')).toBe('desk-work')
    const out = o.tick(team(), TEAM_FORM_MS)
    expect(act(out, 'p')).toBe('meeting')
    expect(act(out, 's1')).toBe('meeting')
    expect(out.intents.get('p')!.target).toBe('wing:claude-code:0/seat:meeting:A:0')
    expect(out.intents.get('s1')!.target).toBe('wing:claude-code:0/seat:meeting:A:1')
    expect(reservationOf(out.memory.reservations, 'team:p')!.kind).toBe('meeting')
  })

  it('meeting → desk-*: no active subagents for 8 s releases the room', () => {
    const o = office()
    o.tick(team(), 0)
    o.tick(team(), TEAM_FORM_MS)
    // The subagent finishes at 20 s: it leaves, the parent stays until 8 s without subagents.
    const done = team({ status: 'done' })
    const t = 20_000
    const out = o.tick(done, t)
    expect(act(out, 's1')).toBe('leaving')
    expect(act(out, 'p')).toBe('meeting')
    expect(act(o.tick(done, t + TEAM_DISBAND_MS - 1), 'p')).toBe('meeting')
    const after = o.tick(done, t + TEAM_DISBAND_MS)
    expect(act(after, 'p')).toBe('desk-work')
    expect(reservationOf(after.memory.reservations, 'team:p')).toBeUndefined()
  })

  it('keeps a team at desks when both rooms are taken or the team is too big', () => {
    const o = office()
    const teams = ['p', 'q', 'r'].flatMap((p) => [agent(p), agent(`${p}-sub`, { parentId: p })])
    o.tick(teams, 0)
    const out = o.tick(teams, TEAM_FORM_MS)
    expect(['p', 'q', 'r'].map((p) => act(out, p))).toEqual(['meeting', 'meeting', 'desk-work'])
    const big = office()
    const crowd = [
      agent('b'),
      ...Array.from({ length: 6 }, (_, i) => agent(`b${i}`, { parentId: 'b' })),
    ]
    big.tick(crowd, 0)
    expect(act(big.tick(crowd, TEAM_FORM_MS), 'b')).toBe('desk-work')
  })

  it('desk-* → booth after waiting 4 s, and stays 10 s even if the status changes', () => {
    const o = office()
    o.tick([agent('w', { status: 'waiting' })], 0)
    expect(act(o.tick([agent('w', { status: 'waiting' })], WAITING_TO_BOOTH_MS - 1), 'w')).toBe(
      'desk-idle',
    )
    const out = o.tick([agent('w', { status: 'waiting' })], WAITING_TO_BOOTH_MS)
    expect(out.intents.get('w')).toMatchObject({
      activity: 'booth',
      target: 'wing:claude-code:0/spot:booth:0',
    })
    const t = WAITING_TO_BOOTH_MS
    expect(act(o.tick([agent('w')], t + 1000), 'w')).toBe('booth')
    expect(act(o.tick([agent('w')], t + DWELL_MS.booth - 1), 'w')).toBe('booth')
    const back = o.tick([agent('w')], t + DWELL_MS.booth)
    expect(act(back, 'w')).toBe('desk-work')
    expect(reservationOf(back.memory.reservations, 'w')).toBeUndefined()
  })

  it('leaves waiting agents at their desks when every booth is taken', () => {
    const o = office()
    const waiting = Array.from({ length: 5 }, (_, i) => agent(`w${i}`, { status: 'waiting' }))
    o.tick(waiting, 0)
    const out = o.tick(waiting, WAITING_TO_BOOTH_MS)
    expect(waiting.map((a) => act(out, a.id))).toEqual([
      'booth',
      'booth',
      'booth',
      'booth',
      'desk-idle',
    ])
  })

  it('a meeting member that starts waiting leaves for a booth while the meeting continues', () => {
    const o = office()
    o.tick(team(), 0)
    o.tick(team(), TEAM_FORM_MS)
    const t = 6000
    o.tick(team({ status: 'waiting' }), t)
    const out = o.tick(team({ status: 'waiting' }), t + WAITING_TO_BOOTH_MS)
    expect(act(out, 's1')).toBe('booth')
    expect(act(out, 'p')).toBe('meeting')
    // Back to tool after the booth dwell: the subagent returns to its meeting seat.
    o.tick(team(), t + WAITING_TO_BOOTH_MS + 1000)
    const back = o.tick(team(), t + WAITING_TO_BOOTH_MS + DWELL_MS.booth)
    expect(back.intents.get('s1')).toMatchObject({
      activity: 'meeting',
      target: 'wing:claude-code:0/seat:meeting:A:1',
    })
  })
})

describe('direct: idle breaks', () => {
  it('desk-idle → kitchen/lounge/cafe after 45 s idle, weighted by hash', () => {
    const o = office()
    const a = agent('idler', { status: 'idle' })
    o.tick([a], 0)
    expect(act(o.tick([a], IDLE_BREAK_MS - 1), 'idler')).toBe('desk-idle')
    const out = o.tick([a], IDLE_BREAK_MS)
    const kind = idleBreakKind('idler', 0)
    expect(act(out, 'idler')).toBe(kind)
    expect(out.intents.get('idler')!.target).toMatch(
      kind === 'cafe' ? /^atrium\/seat:cafe:/ : /^wing:claude-code:0\//,
    )
    // The weights hold over many ids.
    const counts = { kitchen: 0, lounge: 0, cafe: 0 }
    for (let i = 0; i < 2000; i++) counts[idleBreakKind(`agent-${i}`, 0)]++
    expect(counts.kitchen / 2000).toBeCloseTo(IDLE_WEIGHTS.kitchen, 1)
    expect(counts.lounge / 2000).toBeCloseTo(IDLE_WEIGHTS.lounge, 1)
    expect(counts.cafe / 2000).toBeCloseTo(IDLE_WEIGHTS.cafe, 1)
  })

  it('stays on a break for 20 s even when work starts', () => {
    const o = office()
    const a = agent('k', { status: 'idle' })
    o.tick([a], 0)
    o.tick([a], IDLE_BREAK_MS)
    const brk = act(o.tick([a], IDLE_BREAK_MS + 250), 'k')
    expect(['kitchen', 'lounge', 'cafe']).toContain(brk)
    expect(act(o.tick([agent('k')], IDLE_BREAK_MS + 1000), 'k')).toBe(brk)
    expect(act(o.tick([agent('k')], IDLE_BREAK_MS + DWELL_MS[brk!] - 1), 'k')).toBe(brk)
    expect(act(o.tick([agent('k')], IDLE_BREAK_MS + DWELL_MS[brk!]), 'k')).toBe('desk-work')
  })

  it('falls back to the atrium cafe when the kitchen and lounge are full', () => {
    const o = office(layoutFor(24))
    const idle = Array.from({ length: 24 }, (_, i) =>
      agent(`i${String(i).padStart(2, '0')}`, { status: 'idle' }),
    )
    o.tick(idle, 0)
    const out = o.tick(idle, IDLE_BREAK_MS)
    const acts = idle.map((a) => act(out, a.id)!)
    expect(acts.filter((x) => x === 'kitchen').length).toBeLessThanOrEqual(6)
    expect(acts.filter((x) => x === 'lounge').length).toBeLessThanOrEqual(8)
    expect(acts.every((x) => ['kitchen', 'lounge', 'cafe'].includes(x))).toBe(true)
    // More idlers want the kitchen than it holds, so some end up in the cafe.
    expect(acts.filter((x) => x === 'cafe').length).toBeGreaterThan(
      idle.filter((a) => idleBreakKind(a.id, 0) === 'cafe').length,
    )
  })

  it('lounge/kitchen → pingpong: two idle agents in the same wing past 90 s play at a free table', () => {
    const o = office()
    const pair = [agent('x', { status: 'idle' }), agent('y', { status: 'idle' })]
    o.run(() => pair, 0, PINGPONG_IDLE_MS - 250)
    const before = o.tick(pair, PINGPONG_IDLE_MS - 1)
    const breaks = pair.map((a) => act(before, a.id))
    const out = o.tick(pair, PINGPONG_IDLE_MS)
    // x and y hash to kitchen and lounge, both inside the wing.
    expect(breaks).toEqual(['kitchen', 'lounge'])
    expect(act(out, 'x')).toBe('pingpong')
    expect(act(out, 'y')).toBe('pingpong')
    expect(out.intents.get('x')!.target).toBe('atrium/spot:pingpong:0:A')
    expect(out.intents.get('y')!.target).toBe('atrium/spot:pingpong:0:B')
    // One player leaves after the 30 s dwell; the partner goes back to a break.
    const t = PINGPONG_IDLE_MS + DWELL_MS.pingpong
    expect(act(o.tick(pair, t - 1), 'y')).toBe('pingpong')
    const later = o.tick([agent('x'), pair[1]!], t)
    expect(act(later, 'x')).toBe('desk-work')
    expect(['kitchen', 'lounge', 'cafe']).toContain(act(later, 'y'))
    expect(reservationOf(later.memory.reservations, 'pingpong:x|y')).toBeUndefined()
  })
})

describe('direct: leaving', () => {
  it('any → leaving on done, ignoring dwell; the leave completes after LEAVE_MS', () => {
    const o = office()
    o.tick([agent('a')], 0)
    const out = o.tick([agent('a', { status: 'done' })], 500)
    expect(out.intents.get('a')).toMatchObject({
      activity: 'leaving',
      target: 'atrium/spot:elevator:0',
    })
    expect(o.tick([agent('a', { status: 'done' })], 500 + LEAVE_MS - 1).intents.has('a')).toBe(true)
    const gone = o.tick([agent('a', { status: 'done' })], 500 + LEAVE_MS)
    expect(gone.departed).toEqual(['a'])
    expect(gone.intents.has('a')).toBe(false)
    expect(reservationOf(gone.memory.reservations, 'a')).toBeUndefined()
    // Still in state but finished: stays hidden; removing it drops the memory.
    expect(o.tick([agent('a', { status: 'done' })], 500 + LEAVE_MS + 250).intents.has('a')).toBe(
      false,
    )
    o.tick([], 500 + LEAVE_MS + 500)
    expect(o.memory.agents.has('a')).toBe(false)
  })

  it('a removed agent leaves, keeping its memory until the leave finishes', () => {
    const o = office()
    o.tick([agent('a'), agent('b')], 0)
    const out = o.tick([agent('b')], 1000)
    expect(act(out, 'a')).toBe('leaving')
    expect(out.memory.agents.get('a')!.agent.id).toBe('a')
    expect(act(o.tick([agent('b')], 1000 + LEAVE_MS - 1), 'a')).toBe('leaving')
    const gone = o.tick([agent('b')], 1000 + LEAVE_MS)
    expect(gone.departed).toEqual(['a'])
    expect(gone.memory.agents.has('a')).toBe(false)
  })

  it('an agent that becomes active again while leaving returns; a departed one arrives again', () => {
    const o = office()
    o.tick([agent('a')], 0)
    o.tick([agent('a', { status: 'done' })], 1000)
    expect(act(o.tick([agent('a')], 2000), 'a')).toBe('desk-work')
    o.tick([agent('a', { status: 'done' })], 3000)
    o.tick([agent('a', { status: 'done' })], 3000 + LEAVE_MS)
    expect(act(o.tick([agent('a')], 4000 + LEAVE_MS), 'a')).toBe('arriving')
  })
})

describe('priorities', () => {
  it('orders leaving > booth > meeting > desk-* > idle breaks', () => {
    const p = ACTIVITY_PRIORITY
    expect(p.leaving).toBeGreaterThan(p.booth)
    expect(p.booth).toBeGreaterThan(p.meeting)
    expect(p.meeting).toBeGreaterThan(p['desk-work'])
    expect(p['desk-idle']).toBeGreaterThan(p.kitchen)
    expect(p.kitchen).toBe(p.pingpong)
  })

  it('a waiting parent with an active team goes to a booth rather than the meeting', () => {
    const o = office()
    const t = [agent('p', { status: 'waiting' }), agent('s', { parentId: 'p' })]
    o.tick(t, 0)
    const out = o.tick(t, TEAM_FORM_MS)
    expect(act(out, 'p')).toBe('booth')
    expect(act(out, 's')).toBe('meeting')
  })

  it('is deterministic', () => {
    const script = (t: number) => [
      agent('a', { status: t > 50_000 ? 'idle' : 'tool' }),
      agent('b', { status: 'waiting' }),
      agent('c', { parentId: 'a' }),
    ]
    const one = office()
      .run(script, 0, 60_000)
      .map((s) => [...s.out.intents])
    const two = office()
      .run(script, 0, 60_000)
      .map((s) => [...s.out.intents])
    expect(one).toEqual(two)
  })
})
