import type { Agent, Capability } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { builtins, cap } from './__fixtures__/capabilities.ts'
import { fixtureManifest, fixtureManifestJson } from './__fixtures__/manifest.ts'
import { parseManifest } from './manifest.ts'
import { ARRIVE_MS, CALL_FADE_MS, DWELL_MS, LEAVE_MS, WAITING_TO_BOOTH_MS } from './behavior.ts'
import { poseAt } from './choreography.ts'
import { createDirector } from './director.ts'
import type { OfficeState } from './state.ts'

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
const state = (...agents: Agent[]): OfficeState => ({
  agents: new Map(agents.map((a) => [a.id, a])),
  messages: new Map(),
  capabilities: new Map(),
})
/** Claude Code capabilities with `active` set from `uses` (capability id → agent ids). */
const withCaps = (s: OfficeState, uses: Record<string, string[]> = {}): OfficeState => {
  const caps: Capability[] = [
    ...builtins(),
    cap('mcp:github'),
    cap('skill:run-office'),
    cap('rule:project:TESTING.md'),
  ]
  return {
    ...s,
    capabilities: new Map([['claude-code', caps.map((c) => ({ ...c, active: uses[c.id] ?? [] }))]]),
  }
}

describe('createDirector', () => {
  it('plans the building and spawns agents present at startup', () => {
    const d = createDirector(fixtureManifest)
    const u = d.update(
      state(agent('a'), agent('b', { provider: 'langgraph', status: 'thinking' })),
      0,
    )
    expect(u.layoutChanged).toBe(true)
    expect(u.layout.wingsByProvider.get('claude-code')).toEqual(['wing:claude-code:0'])
    expect(u.plans.get('a')).toMatchObject({ intent: { activity: 'desk-work', spawn: true } })
    expect(u.plans.get('a')!.steps![0]!.kind).toBe('teleport')
    expect(u.plans.get('b')!.intent.target).toMatch(/^wing:langgraph:0\/seat:desk:/)
    expect(d.layout).toBe(u.layout)
  })

  it('reports layout changes only when placements change, and steps only for changed intents', () => {
    const d = createDirector(fixtureManifest)
    d.update(state(agent('a')), 0)
    const same = d.update(state(agent('a')), 250)
    expect(same.layoutChanged).toBe(false)
    expect(same.plans.get('a')!.steps).toBeUndefined()
    const grown = d.update(state(agent('a'), agent('o', { provider: 'openai-agents' })), 500)
    expect(grown.layoutChanged).toBe(true)
    expect(grown.plans.get('o')!.intent.activity).toBe('arriving')
    expect(
      grown.plans
        .get('o')!
        .steps!.map((s) => s.kind)
        .slice(0, 2),
    ).toEqual(['teleport', 'fade'])
  })

  it('chains plans from the predicted pose: a status change at the desk only swaps the loop clip', () => {
    const d = createDirector(fixtureManifest)
    d.update(state(agent('a')), 0)
    d.update(state(agent('a', { status: 'thinking' })), 1000)
    const u = d.update(state(agent('a', { status: 'thinking' })), DWELL_MS['desk-work'])
    expect(u.plans.get('a')!.intent.activity).toBe('desk-think')
    expect(u.plans.get('a')!.steps).toEqual([
      {
        kind: 'clip',
        clip: 'SitThink',
        loop: true,
        fadeIn: 0.25,
        anchor: u.plans.get('a')!.intent.target,
      },
    ])
    expect(d.pose('a', DWELL_MS['desk-work'] + 500)).toMatchObject({
      clip: 'SitThink',
      posture: 'sit',
    })
    expect(d.pose('nobody', 0)).toBeUndefined()
  })

  it('re-plans an arrival mid-walk without a jump', () => {
    const d = createDirector(fixtureManifest)
    d.update(state(), 0)
    d.update(state(agent('n', { status: 'waiting' })), 250)
    const t = 250 + ARRIVE_MS
    const predicted = d.pose('n', t)!
    const u = d.update(state(agent('n', { status: 'waiting' })), t)
    const plan = u.plans.get('n')!
    expect(['booth', 'desk-idle']).toContain(plan.intent.activity)
    expect(t - 250).toBeGreaterThanOrEqual(WAITING_TO_BOOTH_MS)
    const start = poseAt(predicted, plan.steps!, 0)
    expect(Math.hypot(start.pos.x - predicted.pos.x, start.pos.z - predicted.pos.z)).toBeLessThan(
      1e-3,
    )
  })

  it('walks removed agents out and reports them departed', () => {
    const d = createDirector(fixtureManifest)
    d.update(state(agent('a'), agent('s', { parentId: 'a' })), 0)
    const u = d.update(state(agent('s', { parentId: 'a' })), 1000)
    expect(u.plans.get('a')!.intent.activity).toBe('leaving')
    expect(u.plans.get('a')!.steps!.at(-1)).toMatchObject({ kind: 'fade', to: 0 })
    expect(u.plans.get('s')!.teamOf).toBe('a')
    const gone = d.update(state(agent('s', { parentId: 'a' })), 1000 + LEAVE_MS)
    expect(gone.departed).toEqual(['a'])
    expect(gone.plans.has('a')).toBe(false)
    expect(d.pose('a', 1000 + LEAVE_MS)).toBeUndefined()
  })

  it('is deterministic', () => {
    const script = (t: number) =>
      state(
        agent('a', { status: t > 20_000 ? 'waiting' : 'tool' }),
        agent('b', { parentId: 'a' }),
        agent('c', { status: 'idle' }),
      )
    const run = () => {
      const d = createDirector(fixtureManifest)
      const out: unknown[] = []
      for (let t = 0; t <= 40_000; t += 250) out.push([...d.update(script(t), t).plans])
      return out
    }
    expect(run()).toEqual(run())
  })
})

describe('createDirector: capabilities', () => {
  it('assigns stations and library slots per provider, stable across updates', () => {
    const d = createDirector(fixtureManifest)
    const u = d.update(withCaps(state(agent('a'))), 0)
    expect(u.stations.get('claude-code')!.slot.get('mcp:github')).toBe(4)
    expect(u.library.get('claude-code')!.books.slot.get('skill:run-office')).toBe(0)
    expect(u.library.get('claude-code')!.boards.slot.get('rule:project:TESTING.md')).toBe(0)
    const again = d.update(withCaps(state(agent('a'))), 250)
    expect(again.stations.get('claude-code')!.slot).toEqual(u.stations.get('claude-code')!.slot)
    expect(u.links).toEqual([])
  })

  it('draws a call link from the desk monitor to the station while the adapter is in use', () => {
    const d = createDirector(fixtureManifest)
    d.update(withCaps(state(agent('a'))), 0)
    const u = d.update(withCaps(state(agent('a')), { fs: ['a'] }), 250)
    expect(u.plans.get('a')!.intent).toMatchObject({
      activity: 'connection-call',
      capability: 'fs',
    })
    const seat = u.plans.get('a')!.intent.target
    const desk = seat.replace('seat:desk:', 'port:desk:')
    expect(u.links).toHaveLength(1)
    expect(u.links[0]).toMatchObject({
      agentId: 'a',
      capabilityId: 'fs',
      from: u.layout.ports!.get(desk),
      to: u.layout.ports!.get('wing:claude-code:0/port:station:0'),
      state: 'calling',
      opacity: 1,
    })
    // Gone after the fade.
    d.update(withCaps(state(agent('a'))), 500)
    expect(d.update(withCaps(state(agent('a'))), 250 + CALL_FADE_MS + 250).links).toEqual([])
  })

  it('keeps a visiting link from the hand once the agent is at the station', () => {
    const d = createDirector(fixtureManifest)
    let u = d.update(withCaps(state(agent('a'))), 0)
    for (let t = 250; t <= 60_000; t += 250)
      u = d.update(withCaps(state(agent('a')), { fs: ['a'] }), t)
    expect(u.plans.get('a')!.intent.activity).toBe('connection-visit')
    const link = u.links[0]!
    expect(link.state).toBe('visiting')
    const station = u.layout.anchors.get('wing:claude-code:0/spot:station:0')!
    expect(Math.hypot(link.from.x - station.pos.x, link.from.z - station.pos.z)).toBeLessThan(0.5)
  })

  it('drops links to capabilities that disappeared, and links library visits to the book', () => {
    const d = createDirector(fixtureManifest)
    d.update(withCaps(state(agent('a'))), 0)
    const using = d.update(withCaps(state(agent('a')), { 'mcp:github': ['a'] }), 250)
    expect(using.links).toHaveLength(1)
    const gone = {
      ...withCaps(state(agent('a'))),
      capabilities: new Map([['claude-code', builtins()]]),
    }
    expect(d.update(gone, 300).links).toEqual([])
    // Two library uses → a visit; the link stays (visiting) and points at the book.
    const lib = createDirector(fixtureManifest)
    lib.update(withCaps(state(agent('b'))), 0)
    lib.update(withCaps(state(agent('b')), { 'skill:run-office': ['b'] }), 1000)
    lib.update(withCaps(state(agent('b'))), 1500)
    let u = lib.update(withCaps(state(agent('b')), { 'rule:project:TESTING.md': ['b'] }), 2000)
    expect(u.plans.get('b')!.intent.activity).toBe('library-visit')
    for (let t = 2250; t <= 9000; t += 250) u = lib.update(withCaps(state(agent('b'))), t)
    const visit = u.links.find((l) => l.state === 'visiting')!
    expect(visit).toMatchObject({ capabilityId: 'rule:project:TESTING.md', style: 'particles' })
    expect(visit.to).toEqual(u.layout.ports!.get('wing:claude-code:0/port:board:0'))
  })

  it('works with an older manifest (default library capacity) and character clip lengths', () => {
    const j = fixtureManifestJson() as { modules: { wing: { capacity: Record<string, number> } } }
    for (const k of ['stations', 'books', 'boards', 'notebooks', 'readingSeats'])
      delete j.modules.wing.capacity[k]
    const d = createDirector(parseManifest(j), { clipDurations: { StandUp: 2 } })
    d.update(withCaps(state(agent('a'))), 0)
    d.update(withCaps(state(agent('a', { status: 'thinking' }))), 1000)
    const u = d.update(withCaps(state(agent('a', { status: 'error' }))), 3000)
    expect(u.plans.get('a')!.steps![0]).toMatchObject({
      kind: 'clip',
      clip: 'StandUp',
      duration: 2,
    })
    expect(u.library.get('claude-code')!.books.occupant).toHaveLength(24)
  })
})
