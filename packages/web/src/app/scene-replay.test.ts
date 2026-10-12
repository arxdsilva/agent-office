import type { Agent, AgentStatus } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { fixtureManifest } from './__fixtures__/manifest.ts'
import { ARRIVE_MS } from './behavior.ts'
import { hiddenPose, poseAt } from './choreography.ts'
import { createDirector } from './director.ts'
import type { AgentPose, Step } from './office-types.ts'
import { remainingSteps } from './scene-replay.ts'
import { emptyState, type OfficeState } from './state.ts'

const agent = (id: string, status: AgentStatus = 'tool'): Agent => ({
  id,
  name: id,
  provider: 'p',
  topic: 't',
  status,
  source: 's',
  since: 0,
  lastSeen: 0,
  interactive: true,
  unread: 0,
})
const stateWith = (...agents: Agent[]): OfficeState => {
  const s = emptyState()
  for (const a of agents) s.agents.set(a.id, a)
  return s
}
const near = (a: AgentPose, b: AgentPose) => {
  expect(a.visible).toBe(b.visible)
  expect(Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z)).toBeLessThan(0.01)
}

describe('remainingSteps (RS)', () => {
  // RS-1: mid-walk, the resynced steps start where the director predicts (within 1 cm) and walk on.
  it('continues a walk from the predicted pose', () => {
    const d = createDirector(fixtureManifest)
    // A new agent arriving after the office opened walks in from the elevator.
    d.update(stateWith(agent('a')), 0)
    d.update(stateWith(agent('a'), agent('b')), 1000)
    const issued = d.issued('b')!
    const move = issued.steps.findIndex((s) => s.kind === 'move')
    expect(move).toBeGreaterThanOrEqual(0)
    // Find a moment while it walks.
    let t = 1000
    while (d.pose('b', t)!.clip !== 'Walk' && t < 1000 + ARRIVE_MS) t += 100
    t += 700
    expect(d.pose('b', t)!.clip).toBe('Walk')
    const steps = remainingSteps(issued, t - issued.at)
    near(poseAt(hiddenPose(), steps, 0), d.pose('b', t)!)
    expect(steps[0]!.kind).toBe('teleport')
    expect(steps.some((s) => s.kind === 'move')).toBe(true)
    // The resync plans for every agent carry these steps.
    const plans = d.resync(t)
    expect(plans.get('b')!.steps).toEqual(steps)
    expect(plans.get('b')!.intent).toEqual(issued.intent)
    near(poseAt(hiddenPose(), plans.get('a')!.steps!, 0), d.pose('a', t)!)
  })

  // RS-2: finished steps are dropped.
  it('drops completed steps', () => {
    const from = { ...hiddenPose(), visible: true }
    const steps: Step[] = [
      { kind: 'clip', clip: 'Wave', loop: false, fadeIn: 0.2, duration: 1 },
      { kind: 'face', heading: 1, duration: 0.5 },
      { kind: 'clip', clip: 'Idle', loop: true, fadeIn: 0.2 },
    ]
    const r = remainingSteps({ from, steps, at: 0 }, 2000)
    expect(r.map((s) => s.kind)).toEqual(['teleport', 'clip'])
    expect(r[1]).toMatchObject({ clip: 'Idle', loop: true })
    expect((r[0] as Extract<Step, { kind: 'teleport' }>).heading).toBeCloseTo(1)
  })

  // RS-3: a seated agent: teleport to the seat, then the sit loop.
  it('replays a seated agent as teleport + sit loop', () => {
    const from = { ...hiddenPose(), visible: true, pos: { x: 1, z: 2 } }
    const steps: Step[] = [
      { kind: 'clip', clip: 'SitDown', loop: false, fadeIn: 0.15, duration: 1, anchor: 'w/seat' },
      { kind: 'prop', prop: 'laptop', on: true },
      { kind: 'clip', clip: 'SitType', loop: true, fadeIn: 0.25, anchor: 'w/seat' },
    ]
    const r = remainingSteps({ from, steps, at: 0 }, 60_000)
    expect(r[0]).toMatchObject({ kind: 'teleport', pos: { x: 1, z: 2 }, anchor: 'w/seat' })
    expect(r).toContainEqual({ kind: 'prop', prop: 'laptop', on: true })
    expect(r.at(-1)).toMatchObject({ kind: 'clip', clip: 'SitType', loop: true, fadeIn: 0 })
    expect(poseAt(hiddenPose(), r, 0).posture).toBe('sit')
  })

  // RS-4: a one-shot in progress resumes at its offset for the rest of its length.
  it('resumes an in-progress one-shot with an offset', () => {
    const from = { ...hiddenPose(), visible: true }
    const steps: Step[] = [
      { kind: 'clip', clip: 'DrinkCoffee', loop: false, fadeIn: 0.25, duration: 4 },
      { kind: 'clip', clip: 'Idle', loop: true, fadeIn: 0.25 },
    ]
    const r = remainingSteps({ from, steps, at: 0 }, 1500)
    expect(r[1]).toMatchObject({ clip: 'DrinkCoffee', offset: 1.5, duration: 2.5 })
    expect(poseAt(hiddenPose(), r, 1).clipTime).toBeCloseTo(poseAt(from, steps, 2.5).clipTime!)
    // Nothing elapsed: the steps are replayed as issued.
    expect(remainingSteps({ from, steps, at: 0 }, 0)).toBe(steps)
  })

  it('keeps fades, face turns and hidden agents consistent', () => {
    const from = { ...hiddenPose(), visible: true }
    const turning = remainingSteps(
      { from, steps: [{ kind: 'face', heading: 2, duration: 2 }], at: 0 },
      1000,
    )
    expect(turning[1]).toMatchObject({ kind: 'face', heading: 2, duration: 1 })
    const leaving = remainingSteps(
      {
        from,
        steps: [
          { kind: 'fade', to: 0, duration: 1 },
          { kind: 'clip', clip: 'Idle', loop: true, fadeIn: 0 },
        ],
        at: 0,
      },
      400,
    )
    expect(leaving).toContainEqual({ kind: 'fade', to: 0, duration: 0.6 })
    const gone = remainingSteps(
      {
        from,
        steps: [
          { kind: 'fade', to: 0, duration: 1 },
          { kind: 'clip', clip: 'Idle', loop: true, fadeIn: 0 },
        ],
        at: 0,
      },
      5000,
    )
    expect(poseAt(hiddenPose(), gone, 0.01).visible).toBe(false)
    expect(remainingSteps({ from: hiddenPose(), steps: [], at: 0 }, 1000)).toEqual([])
  })
})
