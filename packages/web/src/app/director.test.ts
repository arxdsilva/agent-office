import type { Agent } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { fixtureManifest } from './__fixtures__/manifest.ts'
import { ARRIVE_MS, DWELL_MS, LEAVE_MS, WAITING_TO_BOOTH_MS } from './behavior.ts'
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
})

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
