import { describe, expect, it } from 'vitest'
import { fixtureManifest } from './__fixtures__/manifest.ts'
import { planBuilding } from './building.ts'
import {
  ACTIVITY_LOOKS,
  CROSSFADE,
  DEFAULT_CLIP_DURATIONS,
  FADE_S,
  choreograph,
  crossfade,
  hiddenPose,
  poseAt,
  stepsDuration,
  type ChoreoContext,
} from './choreography.ts'
import type { Activity, AgentPose, Intent, Step } from './office-types.ts'

const layout = planBuilding(
  [{ provider: 'claude-code', agents: 10 }],
  fixtureManifest,
  undefined,
  0,
)
const ctx: ChoreoContext = { layout, status: 'tool' }
const W = 'wing:claude-code:0'
const DESK = `${W}/seat:desk:2:1`
const TARGETS: Record<Activity, string> = {
  arriving: DESK,
  'desk-work': DESK,
  'desk-think': DESK,
  'desk-idle': DESK,
  'desk-error': DESK,
  meeting: `${W}/seat:meeting:A:2`,
  booth: `${W}/spot:booth:1`,
  kitchen: `${W}/spot:kitchen:3`,
  lounge: `${W}/seat:lounge:4`,
  cafe: 'atrium/seat:cafe:5',
  pingpong: 'atrium/spot:pingpong:0:B',
  leaving: 'atrium/spot:elevator:2',
}
const ALL = Object.keys(TARGETS) as Activity[]
const intent = (activity: Activity, over: Partial<Intent> = {}): Intent => ({
  activity,
  target: TARGETS[activity],
  since: 0,
  ...over,
})
const END = 1e6

/** Pose of an agent settled in `activity` (spawned in place). */
const settled = (activity: Activity): AgentPose =>
  poseAt(hiddenPose(), choreograph(hiddenPose(), intent(activity, { spawn: true }), ctx), END)

const kinds = (steps: Step[]) => steps.map((s) => (s.kind === 'clip' ? s.clip : s.kind))
const vel = (p: AgentPose) => ({
  x: p.speed * Math.sin(p.heading),
  z: p.speed * Math.cos(p.heading),
})

describe('crossfade', () => {
  it('uses 0.15 s between sit and stand, 0.3 s from walk to idle, 0.25 s otherwise', () => {
    expect(crossfade('SitType', 'StandUp')).toBe(CROSSFADE.sitStand)
    expect(crossfade('SitDown', 'SitIdle')).toBe(CROSSFADE.sitStand)
    expect(crossfade('Walk', 'Idle')).toBe(CROSSFADE.walkToIdle)
    expect(crossfade('Walk', 'PhoneCall')).toBe(CROSSFADE.walkToIdle)
    expect(crossfade('SitType', 'SitThink')).toBe(CROSSFADE.default)
    expect(crossfade(undefined, 'Idle')).toBe(0)
    expect([CROSSFADE.sitStand, CROSSFADE.walkToIdle, CROSSFADE.default]).toEqual([0.15, 0.3, 0.25])
  })
})

describe('choreograph: spawn and arrival', () => {
  it('spawns in place with a teleport and a fade-in, already seated', () => {
    const steps = choreograph(hiddenPose(), intent('desk-work', { spawn: true }), ctx)
    expect(kinds(steps)).toEqual(['teleport', 'fade', 'SitType'])
    const p = poseAt(hiddenPose(), steps, END)
    expect(p).toMatchObject({
      visible: true,
      posture: 'sit',
      anchor: DESK,
      clip: 'SitType',
      speed: 0,
    })
    expect(p.pos).toEqual(layout.anchors.get(DESK)!.pos)
  })

  it('arrives from the elevator, waves at reception, then walks to the desk and sits', () => {
    const steps = choreograph(
      hiddenPose(),
      intent('arriving', { via: ['atrium/spot:elevator:1', 'atrium/spot:reception:2'] }),
      { ...ctx, status: 'thinking' },
    )
    // Face steps appear only when the walk does not already end facing the anchor.
    expect(kinds(steps).filter((k) => k !== 'face')).toEqual([
      'teleport',
      'fade',
      'move',
      'Wave',
      'move',
      'SitDown',
      'SitThink',
    ])
    expect(steps[0]).toMatchObject({
      kind: 'teleport',
      pos: layout.anchors.get('atrium/spot:elevator:1')!.pos,
    })
    expect(steps[1]).toEqual({ kind: 'fade', to: 1, duration: FADE_S })
    const end = poseAt(hiddenPose(), steps, END)
    expect(end).toMatchObject({ posture: 'sit', anchor: DESK, clip: 'SitThink' })
    expect(stepsDuration(steps)).toBe(Infinity)
  })

  it('teleports straight to the target when no route exists', () => {
    const empty = { ...layout, nav: { nodes: new Map(), adj: new Map() } }
    const steps = choreograph(settled('desk-work'), intent('booth'), { layout: empty })
    expect(kinds(steps)).toContain('teleport')
    expect(poseAt(settled('desk-work'), steps, END).anchor).toBe(TARGETS.booth)
  })
})

describe('choreograph: every activity pair', () => {
  for (const from of ALL.filter((a) => a !== 'leaving' && a !== 'arriving'))
    for (const to of ALL.filter((a) => a !== 'arriving'))
      it(`${from} → ${to}`, () => {
        const start = settled(from)
        const steps = choreograph(start, intent(to), ctx)
        const k = kinds(steps)
        const look = ACTIVITY_LOOKS[to]
        const target = layout.anchors.get(TARGETS[to])!
        const sameAnchor = TARGETS[from] === TARGETS[to]
        // Seated agents stand up before walking anywhere.
        if (!sameAnchor && start.posture !== 'stand')
          expect(k.find((x) => x !== 'prop')).toBe('StandUp')
        expect(k.includes('move')).toBe(!sameAnchor)
        const end = poseAt(start, steps, END)
        expect(end.anchor).toBe(target.id)
        expect(end.pos.x).toBeCloseTo(target.pos.x, 6)
        expect(end.pos.z).toBeCloseTo(target.pos.z, 6)
        if (to === 'leaving') {
          expect(k.slice(-2)).toEqual(['ElevatorIn', 'fade'])
          expect(end.visible).toBe(false)
          expect(end.props).toEqual([])
          return
        }
        expect(end.clip).toBe(look.clip)
        const last = steps.at(-1)!
        expect(last).toMatchObject({ kind: 'clip', loop: true })
        if (end.posture !== 'stand' && !(sameAnchor && start.posture !== 'stand'))
          expect(k).toContain('SitDown')
        if (look.prop) expect(end.props).toEqual([look.prop])
        else expect(end.props).toEqual([])
        if (!sameAnchor) expect(Math.cos(end.heading - target.heading)).toBeCloseTo(1, 6)
        // Fade-ins follow the crossfade table.
        let prev = start.clip
        for (const s of steps) {
          if (s.kind === 'move') prev = 'Walk'
          if (s.kind !== 'clip') continue
          if (!s.offset) expect(s.fadeIn).toBe(crossfade(prev, s.clip))
          prev = s.clip
        }
      })
})

describe('choreograph: interruption', () => {
  it('re-plans mid-walk with continuous position and velocity (no snaps)', () => {
    const start = settled('desk-work')
    const toBooth = choreograph(start, intent('booth'), ctx)
    const move = toBooth.findIndex((s) => s.kind === 'move')
    // Standing up facing the desk, the agent first turns in place towards the approach point.
    const turn = (toBooth[move] as Extract<Step, { kind: 'move' }>).path.turnDuration ?? 0
    const before = stepsDuration(toBooth.slice(0, move)) + turn
    for (const dt of [0.4, 1.3, 2.7]) {
      const t = before + dt
      const mid = poseAt(start, toBooth, t)
      expect(mid.speed).toBeGreaterThan(0)
      const re = choreograph(mid, intent('kitchen'), ctx)
      expect(re[0]!.kind).toBe('move')
      const now = poseAt(mid, re, 0)
      expect(Math.hypot(now.pos.x - mid.pos.x, now.pos.z - mid.pos.z)).toBeLessThan(1e-3)
      const [v0, v1] = [vel(mid), vel(now)]
      expect(Math.hypot(v0.x - v1.x, v0.z - v1.z)).toBeLessThan(1e-3)
      // A moment later the walker is still close (no jump).
      const soon = poseAt(mid, re, 0.02)
      expect(Math.hypot(soon.pos.x - mid.pos.x, soon.pos.z - mid.pos.z)).toBeLessThan(0.05)
      expect(poseAt(mid, re, END).anchor).toBe(TARGETS.kitchen)
    }
  })

  it('finishes an interrupted one-shot clip before the new sequence', () => {
    const start = settled('desk-work')
    const toBooth = choreograph(start, intent('booth'), ctx)
    const mid = poseAt(start, toBooth, 0.4) // halfway through StandUp
    expect(mid).toMatchObject({ clip: 'StandUp', posture: 'sit' })
    expect(mid.clipRemaining).toBeCloseTo(DEFAULT_CLIP_DURATIONS.StandUp! - 0.4)
    const re = choreograph(mid, intent('kitchen'), ctx)
    expect(re[0]).toMatchObject({ kind: 'clip', clip: 'StandUp', loop: false, fadeIn: 0 })
    expect((re[0] as { offset?: number }).offset).toBeCloseTo(0.4)
    expect(kinds(re)[1]).toBe('move')
    const p0 = poseAt(mid, re, 0)
    expect(p0.pos).toEqual(mid.pos)
    expect(p0.clipTime).toBeCloseTo(0.4)
  })

  it('cuts a sitting loop and stands up with the short crossfade', () => {
    const steps = choreograph(settled('meeting'), intent('booth'), ctx)
    expect(steps[0]).toMatchObject({ kind: 'clip', clip: 'StandUp', fadeIn: CROSSFADE.sitStand })
  })

  it('switches clips in place when the anchor stays the same', () => {
    expect(kinds(choreograph(settled('desk-work'), intent('desk-think'), ctx))).toEqual([
      'SitThink',
    ])
    expect(kinds(choreograph(settled('desk-work'), intent('desk-error'), ctx))).toEqual([
      'StandUp',
      'HeadScratch',
    ])
    expect(kinds(choreograph(settled('desk-error'), intent('desk-idle'), ctx))).toEqual([
      'SitDown',
      'SitIdle',
    ])
  })

  it('uses a laptop when hot-desking at the cafe, and stands idle without a target', () => {
    const steps = choreograph(
      settled('desk-work'),
      intent('desk-work', { target: 'atrium/seat:cafe:9' }),
      ctx,
    )
    const end = poseAt(settled('desk-work'), steps, END)
    expect(end).toMatchObject({ clip: 'SitLaptop', props: ['laptop'] })
    const lost = choreograph(settled('desk-work'), intent('desk-work', { target: '' }), ctx)
    expect(kinds(lost)).toEqual(['StandUp', 'Idle'])
    expect(kinds(choreograph(settled('booth'), intent('desk-work', { target: '' }), ctx))).toEqual([
      'prop',
      'Idle',
    ])
  })
})

describe('poseAt', () => {
  it('reports face turns, fades and props over time', () => {
    const from: AgentPose = { ...hiddenPose(), visible: true, heading: 0 }
    const steps: Step[] = [
      { kind: 'face', heading: Math.PI / 2, duration: 1 },
      { kind: 'prop', prop: 'cup', on: true },
      { kind: 'fade', to: 0, duration: 0.5 },
      { kind: 'clip', clip: 'DrinkCoffee', loop: true, fadeIn: 0.25 },
    ]
    expect(poseAt(from, steps, 0.5).heading).toBeCloseTo(Math.PI / 4)
    const end = poseAt(from, steps, 2)
    expect(end).toMatchObject({ props: ['cup'], visible: false, clip: 'DrinkCoffee' })
    expect(end.clipTime).toBeCloseTo(1)
    expect(poseAt(from, steps, 1.2).visible).toBe(true)
    expect(poseAt(from, [{ kind: 'prop', prop: 'cup', on: false }], 1).props).toEqual([])
    expect(stepsDuration([{ kind: 'clip', clip: 'Wave', loop: false, fadeIn: 0 }])).toBeCloseTo(
      DEFAULT_CLIP_DURATIONS.Wave!,
    )
  })
})
