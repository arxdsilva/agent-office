// Choreography: an intent change becomes a sequence of steps the scene's mover plays
// (stand up → walk → face → sit → loop). Pure. Durations are seconds.
import type { AgentStatus } from '@agent-office/shared'
import { normalizeAngle } from './building.ts'
import { TURN_RATE, routeToPath, sampleAt } from './navigation.ts'
import type {
  Activity,
  AgentPose,
  BuildingLayout,
  ClipName,
  Intent,
  Posture,
  PropName,
  Step,
  WorldAnchor,
} from './office-types.ts'

/** One-shot clip lengths (frames / 30 fps, plan §3.3). Override with character.json via `clipDurations`. */
export const DEFAULT_CLIP_DURATIONS: Readonly<Partial<Record<ClipName, number>>> = {
  TurnL90: 20 / 30,
  TurnR90: 20 / 30,
  SitDown: 36 / 30,
  StandUp: 30 / 30,
  Wave: 40 / 30,
  ElevatorIn: 40 / 30,
}
/** Elevator fade in/out. */
export const FADE_S = 0.5
/** Crossfade table: sit ↔ stand poses already match; walk → standing loops settles slower. */
export const CROSSFADE = { default: 0.25, sitStand: 0.15, walkToIdle: 0.3 } as const
/** Shortest in-place face step. */
export const MIN_FACE_S = 0.15

const SIT_LOOPS = new Set<ClipName>([
  'SitIdle',
  'SitType',
  'SitThink',
  'SitTalk',
  'SitLaptop',
  'LoungeSit',
])
const STAND_LOOPS = new Set<ClipName>([
  'Idle',
  'StandTalk',
  'PhoneCall',
  'DrinkCoffee',
  'PingPong',
  'HeadScratch',
])
const ONE_SHOTS = new Set<ClipName>([
  'TurnL90',
  'TurnR90',
  'SitDown',
  'StandUp',
  'Wave',
  'ElevatorIn',
])

export function crossfade(from: ClipName | undefined, to: ClipName): number {
  if (!from) return 0
  if ((from === 'SitDown' && SIT_LOOPS.has(to)) || (SIT_LOOPS.has(from) && to === 'StandUp'))
    return CROSSFADE.sitStand
  if (from === 'Walk' && STAND_LOOPS.has(to)) return CROSSFADE.walkToIdle
  return CROSSFADE.default
}

/** Loop clip and prop for each activity once the agent is at its target. */
export const ACTIVITY_LOOKS: Readonly<Record<Activity, { clip: ClipName; prop?: PropName }>> = {
  arriving: { clip: 'SitIdle' },
  'desk-work': { clip: 'SitType' },
  'desk-think': { clip: 'SitThink' },
  'desk-idle': { clip: 'SitIdle' },
  'desk-error': { clip: 'HeadScratch' },
  meeting: { clip: 'SitTalk' },
  booth: { clip: 'PhoneCall', prop: 'phone' },
  kitchen: { clip: 'DrinkCoffee', prop: 'cup' },
  lounge: { clip: 'LoungeSit' },
  cafe: { clip: 'SitIdle', prop: 'cup' },
  pingpong: { clip: 'PingPong', prop: 'paddle' },
  leaving: { clip: 'ElevatorIn' },
}

const DESK_FOR_STATUS: Partial<Record<AgentStatus, Activity>> = {
  tool: 'desk-work',
  thinking: 'desk-think',
  error: 'desk-error',
}

/** The loop for an intent: arrivals end in the status' desk loop; hot desks at the cafe use a laptop. */
export function lookFor(intent: Intent, status?: AgentStatus): { clip: ClipName; prop?: PropName } {
  const activity =
    intent.activity === 'arriving'
      ? ((status && DESK_FOR_STATUS[status]) ?? 'desk-idle')
      : intent.activity
  if (activity === 'desk-work' && /\/seat:cafe:/.test(intent.target))
    return { clip: 'SitLaptop', prop: 'laptop' }
  return ACTIVITY_LOOKS[activity]
}

const postureOf = (clip: ClipName): Posture =>
  clip === 'LoungeSit' ? 'lounge' : SIT_LOOPS.has(clip) ? 'sit' : 'stand'

export interface ChoreoContext {
  layout: BuildingLayout
  /** Agent status, used for the loop an arrival ends in. */
  status?: AgentStatus
  /** One-shot clip lengths from character.json. */
  clipDurations?: Partial<Record<ClipName, number>>
}

/** Pose of an agent not yet in the world. */
export const hiddenPose = (): AgentPose => ({
  pos: { x: 0, z: 0 },
  heading: 0,
  speed: 0,
  posture: 'stand',
  visible: false,
  props: [],
})

/**
 * Steps from `from` to the intent's target. Interruptions: a one-shot in progress is finished
 * first (resumed at its offset); a walk re-plans from the current position, heading and speed.
 */
export function choreograph(from: AgentPose, intent: Intent, ctx: ChoreoContext): Step[] {
  const { layout } = ctx
  const dur = (c: ClipName) => ctx.clipDurations?.[c] ?? DEFAULT_CLIP_DURATIONS[c] ?? 1
  const steps: Step[] = []
  let last = from.clip
  let posture = from.posture
  let props = [...from.props]
  let at = from.anchor
  let pos = from.pos
  let heading = from.heading
  let speed = from.speed
  const target = layout.anchors.get(intent.target)
  const look = lookFor(intent, ctx.status)

  const clip = (c: ClipName, loop: boolean) => {
    const s: Step = { kind: 'clip', clip: c, loop, fadeIn: crossfade(last, c) }
    if (!loop) s.duration = dur(c)
    if (at) s.anchor = at
    steps.push(s)
    last = c
    if (c === 'SitDown') posture = 'sit'
    else if (c === 'StandUp' || !loop) posture = 'stand'
    else posture = postureOf(c)
  }
  const propsTo = (want: PropName[]) => {
    for (const p of props) if (!want.includes(p)) steps.push({ kind: 'prop', prop: p, on: false })
    for (const p of want) if (!props.includes(p)) steps.push({ kind: 'prop', prop: p, on: true })
    props = [...want]
  }
  const teleport = (a: WorldAnchor) => {
    steps.push({ kind: 'teleport', pos: a.pos, heading: a.heading, anchor: a.id })
    ;((last = 'Idle'),
      (posture = 'stand'),
      (pos = a.pos),
      (heading = a.heading),
      (at = a.id),
      (speed = 0))
  }
  const walkTo = (a: WorldAnchor) => {
    const opts: { fromNode?: string; startHeading: number; startSpeed: number } = {
      startHeading: heading,
      startSpeed: speed,
    }
    const fromNode = at && speed === 0 ? layout.anchors.get(at)?.navNode : undefined
    if (fromNode) opts.fromNode = fromNode
    const path = routeToPath(layout.nav, pos, a, opts)
    if (!path) return teleport(a)
    steps.push({ kind: 'move', path })
    last = 'Walk'
    const arrived = sampleAt(path, path.duration).heading
    const delta = Math.abs(normalizeAngle(a.heading - arrived))
    if (delta > 1e-3)
      steps.push({
        kind: 'face',
        heading: a.heading,
        duration: Math.max(MIN_FACE_S, delta / TURN_RATE),
      })
    ;((pos = a.pos), (heading = a.heading), (at = a.id), (speed = 0))
  }
  const settle = () => {
    if (intent.activity === 'leaving') {
      propsTo([])
      clip('ElevatorIn', false)
      steps.push({ kind: 'fade', to: 0, duration: FADE_S })
      return steps
    }
    const want = postureOf(look.clip)
    if (want === 'stand' && posture !== 'stand') clip('StandUp', false)
    if (want !== 'stand' && posture === 'stand') clip('SitDown', false)
    propsTo(look.prop ? [look.prop] : [])
    clip(look.clip, true)
    return steps
  }

  if (!from.visible) {
    // Spawn: arrivals appear at the elevator; agents present at startup appear at their target.
    const via =
      intent.activity === 'arriving' && !intent.spawn
        ? (intent.via ?? []).map((id) => layout.anchors.get(id)).filter((a) => !!a)
        : []
    const first = via[0] ?? target
    if (!first)
      return [
        { kind: 'teleport', pos: from.pos, heading: from.heading },
        { kind: 'fade', to: 1, duration: FADE_S },
        { kind: 'clip', clip: 'Idle', loop: true, fadeIn: 0 },
      ]
    teleport(first)
    steps.push({ kind: 'fade', to: 1, duration: FADE_S })
    if (!via.length) {
      // Already in place: no stand-up/sit-down, straight into the loop.
      propsTo(look.prop ? [look.prop] : [])
      steps.push({ kind: 'clip', clip: look.clip, loop: true, fadeIn: 0, anchor: first.id })
      return steps
    }
    for (const w of via.slice(1)) {
      walkTo(w)
      if (/^spot:reception:/.test(w.local)) clip('Wave', false)
    }
  } else if (
    from.clip &&
    ONE_SHOTS.has(from.clip) &&
    (from.clipRemaining ?? 0) > 0 &&
    from.speed === 0
  ) {
    // Finish the one-shot in progress (a sit-down, stand-up, wave or turn) before anything else.
    const s: Step = {
      kind: 'clip',
      clip: from.clip,
      loop: false,
      fadeIn: 0,
      offset: from.clipTime ?? 0,
      duration: from.clipRemaining!,
    }
    if (at) s.anchor = at
    steps.push(s)
    posture = from.clip === 'SitDown' ? 'sit' : 'stand'
  }

  if (!target) {
    propsTo([])
    if (posture !== 'stand') clip('StandUp', false)
    at = undefined
    clip('Idle', true)
    return steps
  }
  if (at === target.id && speed === 0) return settle()
  propsTo([])
  if (posture !== 'stand') clip('StandUp', false)
  walkTo(target)
  return settle()
}

/** Where an agent is `t` seconds after starting `steps` from `from`. */
export function poseAt(from: AgentPose, steps: Step[], t: number): AgentPose {
  const p: AgentPose = { ...from, pos: { ...from.pos }, props: [...from.props] }
  let clock = 0
  let hideAt: number | undefined
  const done = () => {
    if (hideAt !== undefined && t >= hideAt) p.visible = false
    return p
  }
  for (const s of steps) {
    switch (s.kind) {
      case 'teleport':
        p.pos = { ...s.pos }
        p.heading = s.heading
        p.visible = true
        p.posture = 'stand'
        p.speed = 0
        p.clip = 'Idle'
        p.clipTime = Math.max(0, t - clock)
        delete p.clipRemaining
        if (s.anchor) p.anchor = s.anchor
        else delete p.anchor
        break
      case 'fade':
        if (s.to === 1) p.visible = true
        else hideAt = clock + s.duration
        break
      case 'prop':
        p.props = s.on
          ? [...p.props.filter((x) => x !== s.prop), s.prop]
          : p.props.filter((x) => x !== s.prop)
        break
      case 'face': {
        if (t < clock + s.duration) {
          const k = (t - clock) / s.duration
          p.heading = normalizeAngle(p.heading + normalizeAngle(s.heading - p.heading) * k)
          p.speed = 0
          return done()
        }
        p.heading = s.heading
        clock += s.duration
        break
      }
      case 'move': {
        delete p.anchor
        delete p.clipRemaining
        p.posture = 'stand'
        const d = s.path.duration
        const smp = sampleAt(s.path, Math.min(t - clock, d))
        p.pos = smp.pos
        p.heading = smp.heading
        p.speed = smp.speed
        if (t < clock + d) {
          const turnLeft = normalizeAngle(smp.heading - (s.path.startHeading ?? smp.heading)) >= 0
          p.clip = smp.phase === 'turn' ? (turnLeft ? 'TurnL90' : 'TurnR90') : 'Walk'
          p.clipTime = t - clock
          return done()
        }
        p.clip = 'Walk'
        clock += d
        break
      }
      case 'clip': {
        if (s.anchor) p.anchor = s.anchor
        p.speed = 0
        p.clip = s.clip
        if (s.loop) {
          p.clipTime = Math.max(0, t - clock)
          delete p.clipRemaining
          p.posture = postureOf(s.clip)
          return done()
        }
        const d = s.duration ?? DEFAULT_CLIP_DURATIONS[s.clip] ?? 1
        if (t < clock + d) {
          p.clipTime = (s.offset ?? 0) + Math.max(0, t - clock)
          p.clipRemaining = clock + d - t
          p.posture = s.clip === 'StandUp' ? 'sit' : 'stand'
          return done()
        }
        p.clipTime = (s.offset ?? 0) + d
        p.clipRemaining = 0
        p.posture = s.clip === 'SitDown' ? 'sit' : 'stand'
        clock += d
        break
      }
    }
  }
  return done()
}

/** Time until every step has finished (Infinity when the sequence ends in a loop). */
export function stepsDuration(steps: Step[]): number {
  let clock = 0
  let end = 0
  for (const s of steps) {
    if (s.kind === 'face') clock += s.duration
    else if (s.kind === 'move') clock += s.path.duration
    else if (s.kind === 'fade') end = Math.max(end, clock + s.duration)
    else if (s.kind === 'clip') {
      if (s.loop) return Infinity
      clock += s.duration ?? DEFAULT_CLIP_DURATIONS[s.clip] ?? 1
    }
  }
  return Math.max(clock, end)
}
