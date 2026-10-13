// The Night City stage: the director's plans (classic anchors) → Night City intents and steps,
// choreographed on the special nav graph with the same choreography the other modes use.
import type { Agent } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { fixtureManifest } from '../../special-3d/fixtures/manifest.ts'
import type { AgentPlan, Intent } from '../office-types.ts'
import { createStage } from './stage.ts'
import { buildSpecialWorld, parseSpecialManifest } from './world.ts'

const world = buildSpecialWorld(parseSpecialManifest(fixtureManifest()))
const order = ['claude-code', 'codex']
const plan = (
  id: string,
  intent: Partial<Intent>,
  status: Agent['status'] = 'tool',
): AgentPlan => ({
  agent: { id, provider: 'claude-code', name: id, status } as Agent,
  intent: {
    activity: 'desk-work',
    target: 'wing:claude-code:0/seat:desk:1:0',
    since: 0,
    ...intent,
  },
  steps: [],
})
const plans = (...p: AgentPlan[]) => new Map(p.map((x) => [x.agent.id, x]))

describe('createStage', () => {
  it('agents present when the scene opens appear at their workstation (no arrival walk)', () => {
    const stage = createStage(world)
    const out = stage.direct(plans(plan('a', {})), [], 0, order)
    const p = out.plans.get('a')!
    expect(p.intent.target).toBe('command/ws:0:1:0')
    expect(p.steps![0]).toMatchObject({ kind: 'teleport', anchor: 'command/ws:0:1:0' })
    expect(p.steps!.some((s) => s.kind === 'move')).toBe(false)
  })

  it('later arrivals come out of an elevator and walk to their desk', () => {
    const stage = createStage(world)
    stage.direct(plans(), [], 0, order)
    const out = stage.direct(
      plans(
        plan('b', {
          activity: 'arriving',
          target: 'wing:claude-code:0/seat:desk:1:1',
          via: ['atrium/spot:elevator:0', 'atrium/spot:reception:0'],
        }),
      ),
      [],
      1000,
      order,
    )
    const steps = out.plans.get('b')!.steps!
    expect(steps[0]).toMatchObject({ kind: 'teleport' })
    expect(String((steps[0] as { anchor?: string }).anchor)).toMatch(/spot:elevator:/)
    expect(steps.filter((s) => s.kind === 'move').length).toBeGreaterThanOrEqual(2)
  })

  it('only re-plans when the Night City target or activity changes', () => {
    const stage = createStage(world)
    stage.direct(plans(plan('a', {})), [], 0, order)
    // Same desk, same activity (the classic plan may still carry steps): nothing new to play.
    expect(stage.direct(plans(plan('a', {})), [], 500, order).plans.get('a')!.steps).toBeUndefined()
    // Thinking at the same desk: a new loop, no walk.
    const think = stage.direct(
      plans(plan('a', { activity: 'desk-think' }, 'thinking')),
      [],
      900,
      order,
    )
    const steps = think.plans.get('a')!.steps!
    expect(steps.some((s) => s.kind === 'move')).toBe(false)
    expect(steps.some((s) => s.kind === 'clip')).toBe(true)
  })

  it('a waiting agent walks from its desk to a comm booth, from where it is now', () => {
    const stage = createStage(world)
    stage.direct(plans(plan('a', {})), [], 0, order)
    const out = stage.direct(
      plans(plan('a', { activity: 'booth', target: 'wing:claude-code:0/spot:booth:0' }, 'waiting')),
      [],
      5000,
      order,
    )
    const p = out.plans.get('a')!
    expect(p.intent.target).toBe('command/booth:0')
    expect(p.steps!.some((s) => s.kind === 'move')).toBe(true)
    expect(stage.entries(5000)).toEqual([
      expect.objectContaining({ id: 'a', anchor: 'booth:0', activity: 'booth', desk: 'ws:0:1:0' }),
    ])
  })

  it('drops departed and missing agents, freeing their seats', () => {
    const stage = createStage(world)
    stage.direct(
      plans(plan('a', {}), plan('b', { target: 'wing:claude-code:0/seat:desk:1:1' })),
      [],
      0,
      order,
    )
    const out = stage.direct(
      plans(plan('b', { target: 'wing:claude-code:0/seat:desk:1:1' })),
      ['x'],
      10,
      order,
    )
    expect(out.dropped).toEqual(['a'])
    expect(stage.entries(10).map((e) => e.id)).toEqual(['b'])
    const c = stage.direct(plans(plan('b', {}), plan('c', {})), [], 20, order)
    expect(c.plans.get('c')!.intent.target).toBe('command/ws:0:1:0')
  })

  it('poses are sampled from the issued steps (the camera follows them)', () => {
    const stage = createStage(world)
    stage.direct(plans(plan('a', {})), [], 0, order)
    const pose = stage.pose('a', 2000)!
    const ws = world.layout.anchors.get('command/ws:0:1:0')!
    expect(pose.pos.x).toBeCloseTo(ws.pos.x)
    expect(pose.pos.z).toBeCloseTo(ws.pos.z)
    expect(stage.pose('nobody', 0)).toBeUndefined()
  })
})
