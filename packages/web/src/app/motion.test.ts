import { describe, expect, it } from 'vitest'
import { fixtureManifest } from './__fixtures__/manifest.ts'
import { normalizeAngle, planBuilding } from './building.ts'
import {
  CROSSFADE,
  DEFAULT_CLIP_DURATIONS,
  choreograph,
  hiddenPose,
  poseAt,
  type ChoreoContext,
} from './choreography.ts'
import {
  CHARACTER_QUALITY,
  HEADING_OMEGA,
  MIN_WALK_TIMESCALE,
  SEPARATION,
  advanceMotion,
  animTier,
  appearanceOf,
  createMotion,
  impostorCell,
  impostorMask,
  fallbackLoop,
  isWalking,
  lodLevel,
  pairedOffset,
  paletteKey,
  poseRowOf,
  presetOf,
  separationPush,
  setSteps,
  springAngle,
  stepSeparation,
  tickDue,
  walkStartOffset,
  walkTimeScale,
  type ClipTable,
  type Motion,
  type MotionEvent,
} from './motion.ts'
import { timePath } from './navigation.ts'
import type { Activity, AgentPose, Intent, Step, Vec2 } from './office-types.ts'

const layout = planBuilding(
  [{ provider: 'claude-code', agents: 10 }],
  fixtureManifest,
  undefined,
  0,
)
const ctx: ChoreoContext = { layout, status: 'tool' }
const W = 'wing:claude-code:0'
const TARGETS: Partial<Record<Activity, string>> = {
  'desk-work': `${W}/seat:desk:2:1`,
  'desk-think': `${W}/seat:desk:2:1`,
  booth: `${W}/spot:booth:1`,
  kitchen: `${W}/spot:kitchen:3`,
  leaving: 'atrium/spot:elevator:2',
}
const intent = (activity: Activity, over: Partial<Intent> = {}): Intent => ({
  activity,
  target: TARGETS[activity]!,
  since: 0,
  ...over,
})
const CLIPS: ClipTable = {
  Walk: { duration: 1.0667, loop: true, speed: 1.4, footPlants: [0.25, 0.75] },
  Idle: { duration: 4, loop: true },
  StandUp: { duration: 1, loop: false },
  SitDown: { duration: 1.2, loop: false },
}
const DT = 1 / 60
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z)

/** Runs a motion for `seconds`, returning every event emitted. */
function run(m: Motion, seconds: number, each?: (t: number) => void): MotionEvent[] {
  const all: MotionEvent[] = []
  const out: MotionEvent[] = []
  const n = Math.round(seconds / DT)
  for (let i = 0; i < n; i++) {
    advanceMotion(m, DT, CLIPS, undefined, out)
    all.push(...out)
    each?.((i + 1) * DT)
  }
  return all
}
const clipsOf = (ev: MotionEvent[]) =>
  ev.filter((e) => e.kind === 'clip').map((e) => (e.kind === 'clip' ? e.clip : ''))

/** A motion settled at the desk (spawned in place), plus the pose the director predicts. */
function settledAt(activity: Activity): { m: Motion; pose: AgentPose } {
  const steps = choreograph(hiddenPose(), intent(activity, { spawn: true }), ctx)
  const m = createMotion()
  setSteps(m, steps)
  run(m, 1)
  return { m, pose: poseAt(hiddenPose(), steps, 1e6) }
}

describe('springAngle (critically damped heading)', () => {
  it('converges on the target without overshoot', () => {
    const s = { h: 0, v: 0 }
    let max = 0
    for (let i = 0; i < 120; i++) {
      springAngle(s, 1, HEADING_OMEGA, DT)
      max = Math.max(max, s.h)
    }
    expect(s.h).toBeCloseTo(1, 4)
    expect(max).toBeLessThanOrEqual(1 + 1e-9)
  })

  it('turns the short way across ±π and stays normalized', () => {
    const s = { h: 3, v: 0 }
    for (let i = 0; i < 120; i++) springAngle(s, -3, HEADING_OMEGA, DT)
    expect(normalizeAngle(s.h - -3)).toBeCloseTo(0, 4)
    // It went through π (increasing), not through 0.
    const t = { h: 3, v: 0 }
    springAngle(t, -3, HEADING_OMEGA, 0.05)
    expect(Math.abs(t.h)).toBeGreaterThan(3)
  })

  it('is stable for large time steps', () => {
    const s = { h: 0, v: 0 }
    springAngle(s, 2, HEADING_OMEGA, 5)
    expect(s.h).toBeCloseTo(2, 6)
    expect(Number.isFinite(s.v)).toBe(true)
  })
})

describe('walk timing', () => {
  it('scales the Walk clip with ground speed so the feet do not slide', () => {
    expect(walkTimeScale(1.4, 1.4)).toBe(1)
    expect(walkTimeScale(0.7, 1.4)).toBe(0.5)
    expect(walkTimeScale(0, 1.4)).toBe(MIN_WALK_TIMESCALE)
    expect(walkTimeScale(10, 1.4)).toBe(2)
    expect(walkTimeScale(1, 0)).toBe(1)
  })

  it('starts a walk on the first foot plant', () => {
    expect(walkStartOffset(CLIPS.Walk)).toBeCloseTo(0.25 * 1.0667)
    expect(walkStartOffset({ duration: 1 })).toBe(0)
    expect(walkStartOffset(undefined)).toBe(0)
  })
})

describe('paired loops (ping-pong)', () => {
  it('phase-locks both players to a shared clock, player B half a cycle later', () => {
    expect(pairedOffset(10, 1.6, 0.5, false)).toBeCloseTo(0.4)
    expect(pairedOffset(10, 1.6, 0.5, true)).toBeCloseTo(1.2)
    expect(pairedOffset(3, 0, 0.5, true)).toBe(0)
  })

  it('stays within [0, duration) and half a cycle apart across the wrap', () => {
    for (const clock of [10.4, 11.2, 0, 7.9999999, 1e5 + 0.3]) {
      const a = pairedOffset(clock, 1.6, 0.5, false)
      const b = pairedOffset(clock, 1.6, 0.5, true)
      for (const t of [a, b]) {
        expect(t).toBeGreaterThanOrEqual(0)
        expect(t).toBeLessThan(1.6)
      }
      const gap = (((b - a) % 1.6) + 1.6) % 1.6
      expect(Math.min(gap, 1.6 - gap)).toBeCloseTo(0.8, 6)
    }
    expect(pairedOffset(-0.4, 1.6, 0.5, false)).toBeCloseTo(1.2)
  })
})

describe('separation', () => {
  it('pushes away from walkers inside two personal radii, softly', () => {
    const xs = [0, 0.4, 5]
    const zs = [0, 0, 0]
    const out = { x: 0, z: 0 }
    separationPush(xs, zs, 3, 0, SEPARATION.radius, out)
    expect(out.x).toBeLessThan(0)
    expect(out.x).toBeCloseTo(-0.5) // 1 − 0.4 / 0.8
    expect(out.z).toBe(0)
    separationPush(xs, zs, 3, 2, SEPARATION.radius, out)
    expect(out).toEqual({ x: 0, z: 0 })
  })

  it('separates coincident walkers deterministically in opposite directions', () => {
    const a = { x: 0, z: 0 }
    const b = { x: 0, z: 0 }
    separationPush([1, 1], [1, 1], 2, 0, SEPARATION.radius, a)
    separationPush([1, 1], [1, 1], 2, 1, SEPARATION.radius, b)
    expect(Math.hypot(a.x, a.z)).toBeGreaterThan(0)
    expect(a.x).toBeCloseTo(-b.x)
    expect(a.z).toBeCloseTo(-b.z)
  })

  it('accumulates a bounded offset that fades with the weight and decays without a push', () => {
    const off = { x: 0, z: 0 }
    for (let i = 0; i < 600; i++) stepSeparation(off, { x: 1, z: 0 }, DT, 1)
    expect(off.x).toBeGreaterThan(0)
    expect(off.x).toBeLessThanOrEqual(SEPARATION.maxOffset + 1e-9)
    stepSeparation(off, { x: 1, z: 0 }, DT, 0.5)
    expect(off.x).toBeLessThanOrEqual(SEPARATION.maxOffset * 0.5 + 1e-9)
    for (let i = 0; i < 600; i++) stepSeparation(off, { x: 0, z: 0 }, DT, 1)
    expect(Math.abs(off.x)).toBeLessThan(1e-3)
    stepSeparation(off, { x: 1, z: 1 }, DT, 0)
    expect(off).toEqual({ x: 0, z: 0 })
  })
})

describe('quality and animation LOD', () => {
  it('maps presets to LOD distances and animated budgets (plan §4.2)', () => {
    expect(CHARACTER_QUALITY.low).toMatchObject({
      near: 8,
      far: 20,
      maxAnimated: 60,
      shadows: false,
    })
    expect(CHARACTER_QUALITY.medium).toMatchObject({ near: 15, far: 35, maxAnimated: 120 })
    expect(CHARACTER_QUALITY.high).toMatchObject({
      near: 20,
      far: 45,
      maxAnimated: 150,
      shadows: true,
    })
    expect(CHARACTER_QUALITY.ultra).toMatchObject({ near: 30, far: 60, maxAnimated: 250 })
    expect(presetOf('auto')).toBe('high')
    expect(presetOf('low')).toBe('low')
  })

  it('picks the update tier from distance and visibility', () => {
    const q = CHARACTER_QUALITY.medium
    expect(animTier(5, true, q)).toBe('full')
    expect(animTier(20, true, q)).toBe('half')
    expect(animTier(40, true, q)).toBe('far')
    expect(animTier(5, false, q)).toBe('frozen')
  })

  it('turns agents into impostors beyond the impostor distance (far + 10 m) or the budget', () => {
    const q = CHARACTER_QUALITY.medium
    expect(q.impostorDist).toBe(45)
    expect(CHARACTER_QUALITY.low.impostorDist).toBe(30)
    expect(lodLevel(10, true, q, false, true, false)).toBe('full')
    expect(lodLevel(40, true, q, false, true, false)).toBe('far')
    expect(lodLevel(46, true, q, false, true, false)).toBe('impostor')
    expect(lodLevel(10, true, q, true, true, false)).toBe('impostor')
    // Hysteresis: an impostor comes back only once clearly inside the distance.
    expect(lodLevel(44, true, q, false, true, true)).toBe('impostor')
    expect(lodLevel(42, true, q, false, true, true)).toBe('far')
    // Without impostors (no renderer to bake them): LOD1 at the far rate instead.
    expect(lodLevel(60, true, q, false, false, false)).toBe('far')
    expect(lodLevel(10, true, q, true, false, false)).toBe('far')
    expect(lodLevel(60, false, q, true, true, false)).toBe('frozen')
  })

  it('ticks full every frame, half every other frame (staggered), far at 10 Hz, frozen never', () => {
    expect(tickDue('full', 7, 0, 0)).toBe(true)
    expect([0, 1, 2, 3].map((f) => tickDue('half', f, 0, 0))).toEqual([true, false, true, false])
    expect([0, 1, 2, 3].map((f) => tickDue('half', f, 1, 0))).toEqual([false, true, false, true])
    expect(tickDue('far', 0, 0, 0.05)).toBe(false)
    expect(tickDue('far', 0, 0, 0.1)).toBe(true)
    expect(tickDue('frozen', 0, 0, 10)).toBe(false)
  })

  it('turns the farthest on-screen agents beyond the budget into impostors, with hysteresis', () => {
    const d = [10, 50, 30, 40, 5]
    const on = [true, true, true, true, false]
    const out = new Uint8Array(5)
    const scratch: number[] = []
    expect(impostorMask(d, on, 5, 2, out, scratch)).toBe(2)
    expect([...out]).toEqual([0, 1, 0, 1, 0])
    // An impostor stays one until it is clearly nearer than an animated agent.
    d[3] = 29
    impostorMask(d, on, 5, 2, out, scratch)
    expect([...out]).toEqual([0, 1, 0, 1, 0])
    d[3] = 20
    impostorMask(d, on, 5, 2, out, scratch)
    expect([...out]).toEqual([0, 1, 1, 0, 0])
    expect(impostorMask(d, on, 5, 10, out, scratch)).toBe(0)
    expect([...out]).toEqual([0, 0, 0, 0, 0])
  })

  it('chooses the impostor view cell from the camera direction relative to the heading', () => {
    const at = { x: 0, z: 0 }
    expect(impostorCell({ x: 0, z: 10 }, at, 0, 8)).toBe(0) // seen from the front
    expect(impostorCell({ x: 10, z: 0 }, at, 0, 8)).toBe(2)
    expect(impostorCell({ x: 0, z: -10 }, at, 0, 8)).toBe(4)
    expect(impostorCell({ x: -10, z: 0 }, at, 0, 8)).toBe(6)
    expect(impostorCell({ x: 10, z: 0 }, at, Math.PI / 2, 8)).toBe(0)
  })

  it('maps clips to impostor pose rows', () => {
    expect(poseRowOf('Walk')).toBe(0)
    expect(poseRowOf(undefined)).toBe(0)
    expect(poseRowOf('SitType')).toBe(1)
    expect(poseRowOf('LoungeSit')).toBe(2)
    expect(poseRowOf('SitRead')).toBe(1)
    expect(poseRowOf('StandInteract')).toBe(0)
  })

  it('falls back to the posture-matching loop when the glb lacks a clip', () => {
    expect(fallbackLoop('SitRead')).toBe('SitIdle')
    expect(fallbackLoop('LoungeSit')).toBe('SitIdle')
    expect(fallbackLoop('StandInteract')).toBe('Idle')
  })
})

describe('appearance', () => {
  it('is deterministic per id and varies across ids', () => {
    expect(appearanceOf('agent-1')).toEqual(appearanceOf('agent-1'))
    const keys = new Set(Array.from({ length: 50 }, (_, i) => paletteKey(appearanceOf(`a${i}`))))
    expect(keys.size).toBeGreaterThan(30)
    const styles = new Set(Array.from({ length: 50 }, (_, i) => appearanceOf(`a${i}`).hairStyle))
    expect(styles).toEqual(new Set(['hairA', 'hairB', 'hairC', 'hairD']))
  })

  it("gives subagents a badge in the parent's shirt color", () => {
    expect(appearanceOf('solo').badge).toBeUndefined()
    const kid = appearanceOf('kid', 'parent')
    expect(kid.badge).toBe(appearanceOf('parent').shirt)
    expect(paletteKey(kid)).not.toBe(paletteKey(appearanceOf('kid')))
  })
})

describe('step player', () => {
  it('spawns in place: teleport, fade in, straight into the loop', () => {
    const steps = choreograph(hiddenPose(), intent('desk-work', { spawn: true }), ctx)
    const m = createMotion()
    expect(m.visible).toBe(false)
    setSteps(m, steps)
    const out: MotionEvent[] = []
    advanceMotion(m, DT, CLIPS, undefined, out)
    expect(out[0]).toEqual({ kind: 'teleport' })
    expect(clipsOf(out).at(-1)).toBe('SitType')
    expect(m.visible).toBe(true)
    expect(m.opacity).toBeLessThan(0.1)
    const seat = layout.anchors.get(TARGETS['desk-work']!)!
    expect(dist(m.pos, seat.pos)).toBeLessThan(1e-9)
    expect(m.heading).toBeCloseTo(seat.heading)
    expect(m.anchor).toBe(seat.id)
    run(m, 1)
    expect(m.opacity).toBe(1)
  })

  it('tracks the predicted pose through a full transition (stand up, walk, face, settle)', () => {
    const { m, pose } = settledAt('desk-work')
    const steps = choreograph(pose, intent('booth'), ctx)
    setSteps(m, steps)
    let maxErr = 0
    let maxHeadingErr = 0
    let maxJump = 0
    let prev = { ...m.pos }
    let lastH = pose.heading
    let steadySince = 0
    const events = run(m, 30, (t) => {
      const p = poseAt(pose, steps, t)
      maxErr = Math.max(maxErr, dist(m.pos, p.pos))
      // Once the planned heading has been steady for 0.5 s, the spring has caught up.
      if (Math.abs(normalizeAngle(p.heading - lastH)) > 0.02) steadySince = t
      lastH = p.heading
      if (t - steadySince > 0.5)
        maxHeadingErr = Math.max(maxHeadingErr, Math.abs(normalizeAngle(m.heading - p.heading)))
      maxJump = Math.max(maxJump, dist(prev, m.pos))
      prev = { ...m.pos }
    })
    expect(maxErr).toBeLessThan(1e-6)
    expect(maxHeadingErr).toBeLessThan(0.05)
    expect(maxJump).toBeLessThan(1.5 * DT * 1.01)
    const end = poseAt(pose, steps, 1e6)
    expect(m.anchor).toBe(end.anchor)
    expect(normalizeAngle(m.heading - end.heading)).toBeCloseTo(0, 3)
    expect(m.props).toEqual(['phone'])
    expect(events).toContainEqual({ kind: 'prop', prop: 'phone', on: true })
    const cs = clipsOf(events)
    expect(cs[0]).toBe('StandUp')
    expect(cs).toContain('Walk')
    expect(cs.at(-1)).toBe('PhoneCall')
    expect(isWalking(m)).toBe(false)
    expect(m.speed).toBe(0)
  })

  it('starts walking on a foot plant with the idle→walk crossfade, and blends Walk→stand on arrival', () => {
    const { m, pose } = settledAt('desk-work')
    setSteps(m, choreograph(pose, intent('kitchen'), ctx))
    const events = run(m, 30)
    const walk = events.find((e) => e.kind === 'clip' && e.clip === 'Walk')
    expect(walk).toMatchObject({ loop: true, fadeIn: CROSSFADE.default })
    expect(walk && walk.kind === 'clip' && walk.offset).toBeCloseTo(walkStartOffset(CLIPS.Walk))
    // Leaving the walk: either a turn-in-place, an idle while facing, or the loop clip itself.
    const after = clipsOf(events).slice(clipsOf(events).lastIndexOf('Walk') + 1)
    expect(after.at(-1)).toBe('DrinkCoffee')
  })

  it('reports ground speed while walking and marks it as walking (for separation)', () => {
    const { m, pose } = settledAt('desk-work')
    const steps = choreograph(pose, intent('kitchen'), ctx)
    setSteps(m, steps)
    let walked = false
    run(m, 30, () => {
      if (isWalking(m)) {
        walked = true
        expect(m.speed).toBeGreaterThan(0)
      }
    })
    expect(walked).toBe(true)
  })

  it('re-plans mid-walk from the actual pose without snapping position or restarting Walk', () => {
    const { m, pose } = settledAt('desk-work')
    const steps = choreograph(pose, intent('booth'), ctx)
    setSteps(m, steps)
    let t = 0
    run(m, 4, (tt) => (t = tt))
    expect(isWalking(m)).toBe(true)
    // The director predicts slightly differently from where the mover actually is.
    const predicted = poseAt(pose, steps, t)
    const drifted: AgentPose = {
      ...predicted,
      pos: { x: predicted.pos.x + 0.2, z: predicted.pos.z },
    }
    const re = choreograph(drifted, intent('kitchen'), ctx)
    expect(re[0]!.kind).toBe('move')
    const before = { ...m.pos }
    setSteps(m, re)
    const out: MotionEvent[] = []
    advanceMotion(m, DT, CLIPS, undefined, out)
    expect(dist(before, m.pos)).toBeLessThan(0.05)
    expect(clipsOf(out)).not.toContain('Walk')
    let maxJump = 0
    let prev = { ...m.pos }
    run(m, 30, () => {
      maxJump = Math.max(maxJump, dist(prev, m.pos))
      prev = { ...m.pos }
    })
    expect(maxJump).toBeLessThan(0.05)
    expect(m.anchor).toBe(TARGETS.kitchen)
    expect(dist(m.pos, layout.anchors.get(TARGETS.kitchen!)!.pos)).toBeLessThan(1e-3)
  })

  it('finishes a one-shot in progress before a new sequence, without restarting it', () => {
    const { m, pose } = settledAt('desk-work')
    const steps = choreograph(pose, intent('booth'), ctx)
    setSteps(m, steps)
    run(m, 0.4) // halfway through StandUp
    expect(m.clip).toBe('StandUp')
    // The director resumes StandUp at its offset: the mover keeps the playing action.
    const mid = poseAt(pose, steps, 0.4)
    const re = choreograph(mid, intent('kitchen'), ctx)
    expect(re[0]).toMatchObject({ kind: 'clip', clip: 'StandUp', offset: expect.any(Number) })
    setSteps(m, re)
    const ev = run(m, 0.3)
    expect(clipsOf(ev)).not.toContain('StandUp')
    expect(m.clip).toBe('StandUp')
    const rest = run(m, 30)
    expect(clipsOf(rest)).toContain('Walk')
    expect(m.anchor).toBe(TARGETS.kitchen)
  })

  it('prepends the rest of a one-shot when the new sequence does not resume it', () => {
    const { m, pose } = settledAt('desk-work')
    setSteps(m, choreograph(pose, intent('booth'), ctx))
    run(m, 0.5)
    expect(m.clip).toBe('StandUp')
    // A plan built from a pose that already finished standing up (director drift).
    const loopOnly: Step[] = [{ kind: 'clip', clip: 'Idle', loop: true, fadeIn: 0.25 }]
    setSteps(m, loopOnly)
    run(m, 0.3)
    expect(m.clip).toBe('StandUp')
    const ev = run(m, 0.5)
    expect(clipsOf(ev)).toEqual(['Idle'])
  })

  it('cuts a loop immediately with the step crossfade', () => {
    const { m, pose } = settledAt('desk-work')
    setSteps(m, choreograph(pose, intent('desk-think'), ctx))
    const out: MotionEvent[] = []
    advanceMotion(m, DT, CLIPS, undefined, out)
    expect(out).toContainEqual({
      kind: 'clip',
      clip: 'SitThink',
      loop: true,
      fadeIn: expect.any(Number),
      offset: 0,
    })
  })

  it('fades out in parallel and becomes invisible at the end (leaving)', () => {
    const steps: Step[] = [
      { kind: 'teleport', pos: { x: 1, z: 2 }, heading: 0 },
      { kind: 'fade', to: 1, duration: 0.5 },
      { kind: 'clip', clip: 'ElevatorIn', loop: false, fadeIn: 0.25, duration: 1 },
      { kind: 'fade', to: 0, duration: 0.5 },
    ]
    const m = createMotion()
    setSteps(m, steps)
    run(m, 0.9)
    expect(m.visible).toBe(true)
    expect(m.opacity).toBe(1)
    run(m, 0.35)
    expect(m.opacity).toBeGreaterThan(0)
    expect(m.opacity).toBeLessThan(1)
    run(m, 0.5)
    expect(m.opacity).toBe(0)
    expect(m.visible).toBe(false)
  })

  it('a fallback teleport of a visible agent dips the opacity and fades back in', () => {
    const { m } = settledAt('desk-work')
    setSteps(m, [{ kind: 'teleport', pos: { x: 9, z: 9 }, heading: 1 }])
    const out: MotionEvent[] = []
    advanceMotion(m, DT, CLIPS, undefined, out)
    expect(m.pos).toEqual({ x: 9, z: 9 })
    expect(m.opacity).toBeLessThan(0.2)
    expect(clipsOf(out)).toEqual(['Idle'])
    expect(m.anchor).toBeUndefined()
    run(m, 1)
    expect(m.opacity).toBe(1)
  })

  it('rotates through a face step over its duration, playing a turn for large angles', () => {
    const m = createMotion()
    setSteps(m, [
      { kind: 'teleport', pos: { x: 0, z: 0 }, heading: 0 },
      { kind: 'face', heading: Math.PI / 2, duration: 0.6 },
      { kind: 'face', heading: Math.PI / 2 + 0.2, duration: 0.15 },
    ])
    const ev = run(m, 0.3)
    expect(m.heading).toBeGreaterThan(0.2)
    expect(m.heading).toBeLessThan(Math.PI / 2)
    expect(clipsOf(ev)).toEqual(['Idle', 'TurnL90'])
    const ev2 = run(m, 1)
    expect(m.heading).toBeCloseTo(Math.PI / 2 + 0.2, 2)
    expect(clipsOf(ev2)).toEqual(['Idle'])
  })

  it('applies separation only while walking, never at the anchor', () => {
    const path = timePath(
      [
        { x: 0, z: 0 },
        { x: 0, z: 5 },
      ],
      { endHeading: 0 },
    )
    const steps: Step[] = [
      { kind: 'teleport', pos: { x: 0, z: 0 }, heading: 0 },
      { kind: 'move', path },
      { kind: 'clip', clip: 'Idle', loop: true, fadeIn: 0.3 },
    ]
    const m = createMotion()
    setSteps(m, steps)
    const out: MotionEvent[] = []
    let maxOff = 0
    for (let i = 0; i < 600; i++) {
      advanceMotion(m, DT, CLIPS, { x: 1, z: 0 }, out)
      maxOff = Math.max(maxOff, m.pos.x)
    }
    expect(maxOff).toBeGreaterThan(0.05)
    expect(maxOff).toBeLessThanOrEqual(SEPARATION.maxOffset + 1e-9)
    expect(dist(m.pos, { x: 0, z: 5 })).toBeLessThan(1e-6)
  })

  it('holds the last frame of a one-shot marked `hold` (ShelfPick) until new steps arrive', () => {
    const m = createMotion()
    setSteps(m, [
      { kind: 'teleport', pos: { x: 0, z: 0 }, heading: 0 },
      { kind: 'prop', prop: 'book', on: true },
      { kind: 'clip', clip: 'ShelfPick', loop: false, fadeIn: 0.25, duration: 1.5, hold: true },
      { kind: 'clip', clip: 'Idle', loop: true, fadeIn: 0.25 },
    ])
    const ev = run(m, 5)
    expect(m.clip).toBe('ShelfPick')
    expect(m.clipTime).toBeCloseTo(1.5)
    expect(m.props).toEqual(['book'])
    expect(clipsOf(ev)).toEqual(['Idle', 'ShelfPick'])
    // Held (finished) → a new sequence cuts in at once, like a loop.
    setSteps(m, [{ kind: 'clip', clip: 'StandInteract', loop: true, fadeIn: 0.25 }])
    const out: MotionEvent[] = []
    advanceMotion(m, DT, CLIPS, undefined, out)
    expect(clipsOf(out)).toEqual(['StandInteract'])
  })

  it('finishes a held one-shot still in progress before new steps, then moves on', () => {
    const m = createMotion()
    setSteps(m, [
      { kind: 'teleport', pos: { x: 0, z: 0 }, heading: 0 },
      { kind: 'clip', clip: 'ShelfPick', loop: false, fadeIn: 0, duration: 1.5, hold: true },
    ])
    run(m, 0.5)
    setSteps(m, [{ kind: 'clip', clip: 'Idle', loop: true, fadeIn: 0.25 }])
    expect(clipsOf(run(m, 0.9))).toEqual([])
    expect(m.clip).toBe('ShelfPick')
    expect(clipsOf(run(m, 0.2))).toEqual(['Idle'])
  })

  it('uses clip lengths from the step, then the clip table, then the defaults', () => {
    const m = createMotion()
    setSteps(m, [
      { kind: 'teleport', pos: { x: 0, z: 0 }, heading: 0 },
      { kind: 'clip', clip: 'SitDown', loop: false, fadeIn: 0 },
      { kind: 'clip', clip: 'Wave', loop: false, fadeIn: 0 },
      { kind: 'clip', clip: 'Idle', loop: true, fadeIn: 0 },
    ])
    run(m, 1.15)
    expect(m.clip).toBe('SitDown') // 1.2 s from CLIPS
    run(m, 0.1)
    expect(m.clip).toBe('Wave')
    run(m, DEFAULT_CLIP_DURATIONS.Wave! - 0.1)
    expect(m.clip).toBe('Wave')
    run(m, 0.1)
    expect(m.clip).toBe('Idle')
  })
})
