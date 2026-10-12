import type { Agent } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { fixtureManifest } from './__fixtures__/manifest.ts'
import { planBuilding } from './building.ts'
import type { BuildingLayout } from './office-types.ts'
import { SEAT_REUSE_MS, assignDesks, deskOf, emptySeating, type SeatingState } from './seating.ts'

let seq = 0
const agent = (id: string, over: Partial<Agent> = {}): Agent => ({
  id,
  name: id,
  provider: 'claude-code',
  topic: 'T',
  status: 'idle',
  source: 'test',
  since: ++seq,
  lastSeen: seq,
  interactive: false,
  unread: 0,
  ...over,
})

const building = (...demand: [string, number][]): BuildingLayout =>
  planBuilding(
    demand.map(([provider, agents]) => ({ provider, agents })),
    fixtureManifest,
    undefined,
    0,
  )
const L = building(['claude-code', 10], ['langgraph', 2])
const pod = (s: SeatingState, id: string) => {
  const d = deskOf(s.seats.get(id)!)!
  return `${d.placement}#${d.pod}`
}
const dist = (l: BuildingLayout, a: string, b: string) => {
  const p = l.anchors.get(a)!.pos
  const q = l.anchors.get(b)!.pos
  return Math.hypot(p.x - q.x, p.z - q.z)
}

describe('assignDesks', () => {
  it('seats nobody when there are no agents', () => {
    expect(assignDesks([], L, emptySeating(), 0).seats.size).toBe(0)
  })

  it('gives each topic its own pod in the provider wing', () => {
    const agents = [
      agent('a', { topic: 'X' }),
      agent('b', { topic: 'Y' }),
      agent('c', { topic: 'X' }),
    ]
    const s = assignDesks(agents, L, emptySeating(), 0)
    expect(pod(s, 'a')).toBe('wing:claude-code:0#1')
    expect(pod(s, 'c')).toBe(pod(s, 'a'))
    expect(pod(s, 'b')).toBe('wing:claude-code:0#2')
    const lg = assignDesks([agent('l', { provider: 'langgraph' })], L, emptySeating(), 0)
    expect(pod(lg, 'l')).toBe('wing:langgraph:0#1')
  })

  it('overflows a full topic into the nearest free pod', () => {
    const agents = Array.from({ length: 5 }, (_, i) => agent(`t${i}`, { topic: 'Big' }))
    const s = assignDesks([...agents, agent('o', { topic: 'Other' })], L, emptySeating(), 0)
    expect(new Set(agents.slice(0, 4).map((a) => pod(s, a.id)))).toEqual(
      new Set(['wing:claude-code:0#1']),
    )
    // Pods 2 and 4 are both 6 m from pod 1; ties go to the lower pod number.
    expect(pod(s, 't4')).toBe('wing:claude-code:0#2')
    // The next topic claims the next empty pod.
    expect(pod(s, 'o')).toBe('wing:claude-code:0#3')
  })

  it('shares a pod with another topic only when no pod is empty, and uses the annex last', () => {
    const big = building(['claude-code', 30])
    const agents = Array.from({ length: 30 }, (_, i) => agent(`a${i}`, { topic: 'T' }))
    const s = assignDesks(agents, big, emptySeating(), 0)
    expect(s.seats.size).toBe(30)
    for (let i = 0; i < 24; i++) expect(pod(s, `a${i}`)).toMatch(/^wing:claude-code:0#/)
    for (let i = 24; i < 30; i++) expect(pod(s, `a${i}`)).toMatch(/^wing:claude-code:1#/)
    // Wing full, no annex: newcomers stay unseated.
    const s2 = assignDesks([...agents.slice(0, 24), agent('late')], L, emptySeating(), 0)
    expect(s2.seats.has('late')).toBe(false)
  })

  it('mixes topics into partially used pods when every pod is claimed', () => {
    const agents = Array.from({ length: 7 }, (_, i) => agent(`p${i}`, { topic: `topic${i}` }))
    const s = assignDesks(agents, L, emptySeating(), 0)
    // Six topics take six pods; the seventh shares the pod nearest the wing entrance order.
    expect(new Set(agents.slice(0, 6).map((a) => pod(s, a.id))).size).toBe(6)
    expect(s.seats.has('p6')).toBe(true)
  })

  it('seats a subagent next to its parent, in the same pod', () => {
    const p = agent('p')
    const o = agent('o')
    const c = agent('c', { parentId: 'p', provider: 'other', topic: 'other' })
    const s = assignDesks([c, o, p], L, emptySeating(), 0)
    expect(pod(s, 'c')).toBe(pod(s, 'p'))
    const free = [...L.anchors.keys()].filter(
      (id) =>
        id.startsWith('wing:claude-code:0/seat:desk:1:') && ![...s.seats.values()].includes(id),
    )
    const best = Math.min(
      dist(L, s.seats.get('p')!, s.seats.get('c')!),
      ...free.map((f) => dist(L, s.seats.get('p')!, f)),
    )
    expect(dist(L, s.seats.get('p')!, s.seats.get('c')!)).toBe(best)
  })

  it('seats a subagent at the nearest free desk when its parent pod is full', () => {
    const team = [agent('p'), agent('x1'), agent('x2'), agent('x3')]
    const first = assignDesks(team, L, emptySeating(), 0)
    const c = agent('c', { parentId: 'p' })
    const s = assignDesks([...team, c], L, first, 1000)
    expect(pod(s, 'c')).not.toBe(pod(s, 'p'))
    const parentSeat = s.seats.get('p')!
    const others = [...L.anchors.values()].filter(
      (a) =>
        a.placement === 'wing:claude-code:0' &&
        a.local.startsWith('seat:desk:') &&
        ![...s.seats.values()].includes(a.id),
    )
    for (const a of others)
      expect(dist(L, parentSeat, s.seats.get('c')!)).toBeLessThanOrEqual(dist(L, parentSeat, a.id))
  })

  it('keeps desks stable when agents join, and for an agent whose topic changes', () => {
    const a = agent('a')
    const b = agent('b')
    const first = assignDesks([a, b], L, emptySeating(), 0)
    const second = assignDesks([a, b, agent('c')], L, first, 1000)
    expect(second.seats.get('a')).toBe(first.seats.get('a'))
    expect(second.seats.get('b')).toBe(first.seats.get('b'))
    const moved = assignDesks([{ ...a, topic: 'New' }, b], L, second, 2000)
    expect(moved.seats.get('a')).toBe(first.seats.get('a'))
    // Input order does not matter.
    const shuffled = assignDesks([agent('c2'), b, a].reverse(), L, first, 1000)
    expect(shuffled.seats.get('a')).toBe(first.seats.get('a'))
  })

  it('reuses a freed desk only after 10 s', () => {
    const a = agent('a')
    const b = agent('b')
    const s0 = assignDesks([a, b], L, emptySeating(), 0)
    const seatA = s0.seats.get('a')!
    // a leaves at t = 1 s.
    const s1 = assignDesks([b], L, s0, 1000)
    expect(s1.freed.get(seatA)).toBe(1000)
    const early = assignDesks([b, agent('d')], L, s1, 1000 + SEAT_REUSE_MS - 1)
    expect(early.seats.get('d')).not.toBe(seatA)
    const late = assignDesks([b, agent('e')], L, s1, 1000 + SEAT_REUSE_MS)
    expect(late.seats.get('e')).toBe(seatA)
    expect(late.freed.has(seatA)).toBe(false)
  })

  it('reseats an agent whose desk disappeared or whose provider changed', () => {
    const big = building(['claude-code', 30])
    const agents = Array.from({ length: 30 }, (_, i) => agent(`z${i}`))
    const s0 = assignDesks(agents, big, emptySeating(), 0)
    // 20 agents leave; their desks free up after 10 s, then the annex goes away.
    const gone = assignDesks(agents.slice(20), big, s0, 1000)
    const small = building(['claude-code', 10])
    const s1 = assignDesks(agents.slice(20), small, gone, 1000 + SEAT_REUSE_MS)
    for (const a of agents.slice(20)) expect(s1.seats.get(a.id)).toMatch(/^wing:claude-code:0\//)
    const lg = assignDesks([{ ...agents[0]!, provider: 'langgraph' }], L, s0, 1000)
    expect(lg.seats.get('z0')).toMatch(/^wing:langgraph:0\//)
  })

  it('leaves agents of a provider without a wing unseated', () => {
    expect(assignDesks([agent('q', { provider: 'nobody' })], L, emptySeating(), 0).seats.size).toBe(
      0,
    )
  })
})

describe('deskOf', () => {
  it('parses desk anchor ids', () => {
    expect(deskOf('wing:a:0/seat:desk:3:2')).toEqual({ placement: 'wing:a:0', pod: 3, index: 2 })
    expect(deskOf('wing:a:0/seat:lounge:1')).toBeUndefined()
  })
})
