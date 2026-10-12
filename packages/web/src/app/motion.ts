// Character motion helpers for the three.js character adapter (pure; no three.js here):
// heading spring, walk timing, separation steering, animation LOD and impostor picking,
// per-agent appearance, and the step player that runs a choreography `Step[]` from the
// agent's ACTUAL pose (the director only predicts it). Allocation-free per frame.
import type { GraphicsQuality } from '@agent-office/shared'
import { hash32, normalizeAngle } from './building.ts'
import { DEFAULT_CLIP_DURATIONS, FADE_S, crossfade } from './choreography.ts'
import { sampleAt } from './navigation.ts'
import { PRESETS, type Preset } from './quality.ts'
import type { AnchorId, ClipName, PropName, Step, TimedPath, Vec2 } from './office-types.ts'

// ── Heading spring ──────────────────────────────────────────────────────────────────────────────
/** Natural frequency of the heading spring (rad/s), plan §4.2. */
export const HEADING_OMEGA = 12

/** Critically damped spring on an angle, exact for any `dt`; turns the short way. Mutates `s`. */
export function springAngle(
  s: { h: number; v: number },
  target: number,
  omega: number,
  dt: number,
) {
  const x = normalizeAngle(s.h - target)
  const e = Math.exp(-omega * dt)
  const c = s.v + omega * x
  s.h = normalizeAngle(target + (x + c * dt) * e)
  s.v = (s.v - omega * c * dt) * e
}

/** Exponential smoothing factor for a time constant `tau`. */
export const decay = (dt: number, tau: number) => Math.exp(-dt / tau)

// ── Walk timing ─────────────────────────────────────────────────────────────────────────────────
/** Slowest Walk playback: stepping in place when starting reads better than frozen legs. */
export const MIN_WALK_TIMESCALE = 0.35
const MAX_WALK_TIMESCALE = 2

/** Walk timeScale = ground speed / authored speed (contract §8), so the feet don't slide. */
export function walkTimeScale(speed: number, authored: number): number {
  if (!(authored > 0)) return 1
  return Math.min(MAX_WALK_TIMESCALE, Math.max(MIN_WALK_TIMESCALE, speed / authored))
}

/** Seconds into Walk where its first foot plant lands (walks start on a planted foot). */
export function walkStartOffset(walk?: { duration: number; footPlants?: number[] }): number {
  return walk ? (walk.footPlants?.[0] ?? 0) * walk.duration : 0
}

/** Loop time for a synced pair (ping-pong): both follow a shared clock; player B is `pairOffset` cycles later. */
export function pairedOffset(clockS: number, duration: number, pairOffset: number, isB: boolean) {
  if (!(duration > 0)) return 0
  return (clockS + (isB ? pairOffset * duration : 0)) % duration
}

// ── Separation steering ─────────────────────────────────────────────────────────────────────────
export const SEPARATION = {
  /** Personal radius (m): walkers closer than 2 × radius push apart. */
  radius: 0.4,
  /** Push → offset rate (m/s per unit push). */
  gain: 1.2,
  /** Soft limit on the sideways offset (m). */
  maxOffset: 0.3,
  /** Offset decay time constant (s) once the push stops. */
  tau: 0.6,
  /** Distance (m) from the start and end of a walk over which separation fades in/out. */
  fadeDist: 1,
} as const

/** Sum of soft pushes on walker `i` from the others (positions in `xs`/`zs`). Writes `out`. */
export function separationPush(
  xs: ArrayLike<number>,
  zs: ArrayLike<number>,
  n: number,
  i: number,
  radius: number,
  out: Vec2,
): Vec2 {
  out.x = 0
  out.z = 0
  const reach = 2 * radius
  const x = xs[i]!
  const z = zs[i]!
  for (let j = 0; j < n; j++) {
    if (j === i) continue
    const dx = x - xs[j]!
    const dz = z - zs[j]!
    if (Math.abs(dx) >= reach || Math.abs(dz) >= reach) continue
    const d = Math.hypot(dx, dz)
    if (d >= reach) continue
    const w = 1 - d / reach
    if (d < 1e-6) out.x += i < j ? w : -w
    else ((out.x += (dx / d) * w), (out.z += (dz / d) * w))
  }
  return out
}

/** Integrates the separation offset: grows with the push, decays, and is limited by `weight`. */
export function stepSeparation(off: Vec2, push: Vec2, dt: number, weight: number) {
  const limit = SEPARATION.maxOffset * Math.min(1, Math.max(0, weight))
  if (limit <= 0) {
    off.x = 0
    off.z = 0
    return
  }
  const k = decay(dt, SEPARATION.tau)
  off.x = (off.x + push.x * SEPARATION.gain * dt * weight) * k
  off.z = (off.z + push.z * SEPARATION.gain * dt * weight) * k
  const len = Math.hypot(off.x, off.z)
  if (len > limit) ((off.x *= limit / len), (off.z *= limit / len))
}

// ── Quality presets and animation LOD ───────────────────────────────────────────────────────────
export type CharacterPreset = Preset
export interface CharacterQuality {
  /** Under `near` m: animate every frame. */
  near: number
  /** `near`–`far`: every second frame; beyond: LOD1 mesh at 10 Hz. */
  far: number
  /** On-screen agents animated at most; the farthest beyond become impostors. */
  maxAnimated: number
  /** Real shadow casting (High and up; the contact blob is always on). */
  shadows: boolean
}
const fromPreset = (p: Preset): CharacterQuality => ({
  near: PRESETS[p].lod[0],
  far: PRESETS[p].lod[1],
  maxAnimated: PRESETS[p].maxAnimated,
  shadows: PRESETS[p].shadowMap >= 2048,
})
/** The character half of the quality presets (plan §4.2), derived from `PRESETS`. */
export const CHARACTER_QUALITY: Readonly<Record<CharacterPreset, CharacterQuality>> = {
  low: fromPreset('low'),
  medium: fromPreset('medium'),
  high: fromPreset('high'),
  ultra: fromPreset('ultra'),
}
/** Auto starts at High (the governor steps it later). */
export const presetOf = (q: GraphicsQuality): CharacterPreset => (q === 'auto' ? 'high' : q)

export type AnimTier = 'full' | 'half' | 'far' | 'frozen'
/** Far-tier animation rate (Hz). */
export const FAR_HZ = 10

export function animTier(dist: number, onScreen: boolean, q: CharacterQuality): AnimTier {
  if (!onScreen) return 'frozen'
  return dist < q.near ? 'full' : dist < q.far ? 'half' : 'far'
}

/** Whether to advance the mixer this frame (`slot` staggers half-rate agents; `pending` = un-ticked seconds). */
export function tickDue(tier: AnimTier, frame: number, slot: number, pending: number): boolean {
  if (tier === 'full') return true
  if (tier === 'half') return (frame + slot) % 2 === 0
  if (tier === 'far') return pending >= 1 / FAR_HZ - 1e-9
  return false
}

/** Impostors keep their status until they are this much nearer than an animated agent. */
const IMPOSTOR_HYSTERESIS = 1.05

/**
 * Marks (1) the farthest on-screen agents beyond `max` as impostors in `out` (read as the previous
 * mask for hysteresis). Returns the impostor count. `scratch` is reused between calls.
 */
export function impostorMask(
  dist: ArrayLike<number>,
  onScreen: ArrayLike<boolean>,
  n: number,
  max: number,
  out: Uint8Array,
  scratch: number[],
): number {
  scratch.length = 0
  for (let i = 0; i < n; i++) if (onScreen[i]) scratch.push(i)
  if (scratch.length <= max) {
    out.fill(0, 0, n)
    return 0
  }
  const key = (i: number) => dist[i]! * (out[i] ? IMPOSTOR_HYSTERESIS : 1)
  scratch.sort((a, b) => key(a) - key(b))
  out.fill(0, 0, n)
  for (let k = max; k < scratch.length; k++) out[scratch[k]!] = 1
  return scratch.length - max
}

/** Impostor view cell: 0 = seen from the front, increasing with the camera's angle around the agent. */
export function impostorCell(cam: Vec2, pos: Vec2, heading: number, cells: number): number {
  const a = Math.atan2(cam.x - pos.x, cam.z - pos.z)
  const step = (2 * Math.PI) / cells
  const k = Math.round(normalizeAngle(a - heading) / step)
  return ((k % cells) + cells) % cells
}

const SIT_CLIPS = new Set<ClipName>(['SitIdle', 'SitType', 'SitThink', 'SitTalk', 'SitLaptop'])
/** Impostor pose row: 0 standing, 1 seated, 2 lounging. */
export function poseRowOf(clip: ClipName | undefined): 0 | 1 | 2 {
  if (clip === 'LoungeSit') return 2
  return clip && SIT_CLIPS.has(clip) ? 1 : 0
}

// ── Appearance ──────────────────────────────────────────────────────────────────────────────────
export type HairStyle = 'hairA' | 'hairB' | 'hairC' | 'hairD'
export interface Appearance {
  skin: number
  shirt: number
  pants: number
  hair: number
  hairStyle: HairStyle
  glasses: boolean
  headset: boolean
  /** Lanyard badge color (the parent's shirt) — subagents only. */
  badge?: number
}
const SKINS = [0xf6d5c3, 0xeac0a0, 0xd8a47f, 0xb57d5a, 0x8d5a3b, 0x5f3a24]
const SHIRTS = [
  0x3b6ea5, 0xc8553d, 0x5b8c5a, 0xe0a339, 0x7a5ca8, 0x2f9e9a, 0xd96c8a, 0x404a59, 0xf2efe9,
  0x8b3a3a, 0x4f7cc9, 0x9aa64b,
]
const PANTS = [0x2c3440, 0x3a3a3a, 0x5c4a3a, 0x6b7a8f, 0xbfae8e, 0x22252b]
const HAIRS = [0x1f1a17, 0x3b2a1e, 0x6b4a2b, 0xa8763e, 0xd9c08c, 0x8a8a8a, 0x9c3b2a]
const STYLES: HairStyle[] = ['hairA', 'hairB', 'hairC', 'hairD']

const pick = <T>(xs: readonly T[], h: number): T => xs[h % xs.length]!

/** Seeded look for an agent id (and its parent's id, for the team badge). */
export function appearanceOf(id: string, teamOf?: string): Appearance {
  const a = hash32(id)
  const b = hash32(`${id}#look`)
  const look: Appearance = {
    skin: pick(SKINS, a),
    shirt: pick(SHIRTS, a >>> 8),
    pants: pick(PANTS, a >>> 16),
    hair: pick(HAIRS, a >>> 24),
    hairStyle: pick(STYLES, b),
    glasses: (b >>> 8) % 100 < 30,
    headset: (b >>> 16) % 100 < 15,
  }
  if (teamOf) look.badge = appearanceOf(teamOf).shirt
  return look
}

/** Key of the tinted materials an appearance needs (identical palettes share materials). */
export const paletteKey = (a: Appearance) =>
  [a.skin, a.shirt, a.pants, a.hair, a.badge ?? -1].map((c) => c.toString(16)).join('-')

// ── Step player ─────────────────────────────────────────────────────────────────────────────────
export interface ClipMeta {
  duration: number
  loop: boolean
  speed?: number
  footPlants?: number[]
  /** Synced pair loops (PingPong): player B runs this many cycles later. */
  pairOffset?: number
  /** Root yaw the clip itself performs (rad), e.g. TurnL90 = π/2. */
  turn?: number
}
export type ClipTable = Readonly<Record<string, ClipMeta | undefined>>

/** What the adapter must do to the model this frame, in order. */
export type MotionEvent =
  | { kind: 'clip'; clip: ClipName; loop: boolean; fadeIn: number; offset: number }
  | { kind: 'prop'; prop: PropName; on: boolean }
  | { kind: 'teleport' }

/** Blend time constant (s) for the gap between the actual and the planned position. */
export const BLEND_TAU = 0.25
/** Opacity dip-and-return for a fallback teleport of a visible agent. */
export const TELEPORT_FADE_S = 0.35
/** Look-ahead (s) along the path for the heading target, compensating the spring's lag. */
export const HEADING_LOOKAHEAD = 2 / HEADING_OMEGA
/** Face steps turning more than this play a turn clip instead of standing idle. */
const TURN_CLIP_MIN = Math.PI / 3

export interface Motion {
  /** Actual world position (floor) and heading. */
  pos: Vec2
  heading: number
  /** Ground speed of the planned motion (m/s), drives the Walk timeScale. */
  speed: number
  anchor?: AnchorId
  visible: boolean
  opacity: number
  props: PropName[]
  /** Clip the model should be playing, and seconds into it (one-shots). */
  clip?: ClipName
  clipTime: number
  /** Weight for separation steering (0 outside a walk). */
  sepWeight: number
  // ── internals ──
  queue: Step[]
  started: boolean
  stepT: number
  stepLen: number
  base: Vec2
  blend: Vec2
  sep: Vec2
  spring: { h: number; v: number }
  hTarget: number
  faceFrom: number
  turnClip: ClipName
  fade: { from: number; to: number; t: number; duration: number } | undefined
}

export const createMotion = (): Motion => ({
  pos: { x: 0, z: 0 },
  heading: 0,
  speed: 0,
  visible: false,
  opacity: 0,
  props: [],
  clipTime: 0,
  sepWeight: 0,
  queue: [],
  started: false,
  stepT: 0,
  stepLen: 0,
  base: { x: 0, z: 0 },
  blend: { x: 0, z: 0 },
  sep: { x: 0, z: 0 },
  spring: { h: 0, v: 0 },
  hTarget: 0,
  faceFrom: 0,
  turnClip: 'TurnL90',
  fade: undefined,
})

/** True while walking along a path (not turning in place): separation applies. */
export const isWalking = (m: Motion) => m.sepWeight > 0 || (m.speed > 0 && m.clip === 'Walk')

function lengthOf(s: Step, clips: ClipTable): number {
  switch (s.kind) {
    case 'clip':
      return s.loop
        ? Infinity
        : (s.duration ?? clips[s.clip]?.duration ?? DEFAULT_CLIP_DURATIONS[s.clip] ?? 1)
    case 'move':
      return s.path.duration
    case 'face':
      return s.duration
    default:
      return 0
  }
}

/**
 * Hands the motion a new sequence (planned from the director's predicted pose). A one-shot clip,
 * walk or turn in progress is finished first — seamlessly, when the sequence resumes the same
 * one-shot — unless the sequence starts by re-planning a walk or teleporting. Loops are cut.
 */
export function setSteps(m: Motion, steps: Step[]) {
  const cur = m.started ? m.queue[0] : undefined
  const first = steps[0]
  const cutsIn = !first || first.kind === 'move' || first.kind === 'teleport'
  const unfinished =
    cur &&
    ((cur.kind === 'clip' && !cur.loop) || cur.kind === 'move' || cur.kind === 'face') &&
    m.stepLen - m.stepT > 1e-6
  if (cur && !cutsIn && unfinished) {
    const resumes =
      cur.kind === 'clip' && first.kind === 'clip' && !first.loop && first.clip === cur.clip
    m.queue = [cur, ...(resumes ? steps.slice(1) : steps)]
    return
  }
  m.queue = [...steps]
  m.started = false
  m.stepT = 0
}

const headingOf = (a: Vec2, b: Vec2) => Math.atan2(b.x - a.x, b.z - a.z)

function playClip(
  m: Motion,
  out: MotionEvent[],
  clip: ClipName,
  loop: boolean,
  fadeIn: number,
  offset = 0,
) {
  out.push({ kind: 'clip', clip, loop, fadeIn, offset })
  m.clip = clip
  m.clipTime = offset
}

function startFade(m: Motion, to: number, duration: number) {
  if (to > 0) m.visible = true
  m.fade = { from: m.opacity, to, t: 0, duration }
}

function start(m: Motion, s: Step, clips: ClipTable, out: MotionEvent[]) {
  switch (s.kind) {
    case 'clip':
      playClip(m, out, s.clip, s.loop, s.fadeIn, s.offset ?? 0)
      if (s.anchor) m.anchor = s.anchor
      m.speed = 0
      break
    case 'move': {
      const p0 = s.path.points[0] ?? m.base
      m.blend.x = m.pos.x - m.sep.x - p0.x
      m.blend.z = m.pos.z - m.sep.z - p0.z
      m.base.x = p0.x
      m.base.z = p0.z
      delete m.anchor
      const p1 = s.path.points[1]
      const h0 = p1 ? headingOf(p0, p1) : s.path.endHeading
      m.turnClip = normalizeAngle(h0 - (s.path.startHeading ?? h0)) >= 0 ? 'TurnL90' : 'TurnR90'
      break
    }
    case 'face': {
      m.faceFrom = m.heading
      m.speed = 0
      const big = Math.abs(normalizeAngle(s.heading - m.heading)) >= TURN_CLIP_MIN
      const want: ClipName | undefined = big
        ? normalizeAngle(s.heading - m.heading) >= 0
          ? 'TurnL90'
          : 'TurnR90'
        : m.clip === 'Walk' || m.clip === 'TurnL90' || m.clip === 'TurnR90'
          ? 'Idle'
          : undefined
      if (want && want !== m.clip) playClip(m, out, want, true, crossfade(m.clip, want))
      break
    }
    case 'teleport':
      out.push({ kind: 'teleport' })
      m.base.x = m.pos.x = s.pos.x
      m.base.z = m.pos.z = s.pos.z
      m.blend.x = m.blend.z = m.sep.x = m.sep.z = 0
      m.spring.h = m.heading = m.hTarget = s.heading
      m.spring.v = 0
      m.speed = 0
      if (s.anchor) m.anchor = s.anchor
      else delete m.anchor
      // Spawn (invisible) or fallback (visible): either way it appears by fading in.
      m.opacity = 0
      startFade(m, 1, m.visible ? TELEPORT_FADE_S : FADE_S)
      playClip(m, out, 'Idle', true, 0)
      break
    case 'prop':
      m.props = m.props.filter((p) => p !== s.prop)
      if (s.on) m.props.push(s.prop)
      out.push({ kind: 'prop', prop: s.prop, on: s.on })
      break
    case 'fade':
      startFade(m, s.to, s.duration)
      break
  }
  void clips
}

function apply(m: Motion, s: Step, clips: ClipTable, out: MotionEvent[]) {
  if (s.kind === 'clip') {
    m.clipTime = (s.offset ?? 0) + m.stepT
    return
  }
  if (s.kind === 'face') {
    // Lead the ramp by the spring's lag so the turn ends on time.
    const k = s.duration > 0 ? Math.min(1, (m.stepT + HEADING_LOOKAHEAD) / s.duration) : 1
    m.hTarget = normalizeAngle(m.faceFrom + normalizeAngle(s.heading - m.faceFrom) * k)
    return
  }
  if (s.kind !== 'move') return
  const path: TimedPath = s.path
  const smp = sampleAt(path, m.stepT)
  m.base.x = smp.pos.x
  m.base.z = smp.pos.z
  m.speed = smp.speed
  m.hTarget = smp.heading
  if (smp.phase === 'turn') {
    const turnEnd = path.turnDuration ?? 0
    m.hTarget = sampleAt(path, Math.min(turnEnd, m.stepT + HEADING_LOOKAHEAD)).heading
  } else if (smp.phase === 'walk' || smp.phase === 'approach') {
    // Aim at a point slightly ahead so the spring's lag doesn't cut corners late.
    const ahead = sampleAt(path, Math.min(path.duration, m.stepT + HEADING_LOOKAHEAD)).pos
    if (Math.hypot(ahead.x - smp.pos.x, ahead.z - smp.pos.z) > 0.05)
      m.hTarget = headingOf(smp.pos, ahead)
  }
  const want: ClipName = smp.phase === 'turn' ? m.turnClip : 'Walk'
  if (want !== m.clip && smp.phase !== 'arrived')
    playClip(
      m,
      out,
      want,
      true,
      crossfade(m.clip, want),
      want === 'Walk' ? walkStartOffset(clips.Walk) : 0,
    )
  if (smp.phase === 'turn' || smp.phase === 'arrived') m.sepWeight = 0
  else {
    const pts = path.points
    const end = pts[pts.length - 1]!
    const fromStart = Math.hypot(smp.pos.x - pts[0]!.x, smp.pos.z - pts[0]!.z)
    const toEnd = Math.hypot(end.x - smp.pos.x, end.z - smp.pos.z)
    m.sepWeight = Math.min(1, fromStart / SEPARATION.fadeDist, toEnd / SEPARATION.fadeDist)
  }
}

function finish(m: Motion, s: Step) {
  if (s.kind === 'move') {
    m.speed = 0
    m.sepWeight = 0
  } else if (s.kind === 'face') m.hTarget = s.heading
}

const NO_PUSH: Vec2 = { x: 0, z: 0 }

/**
 * Advances the motion by `dt` seconds, appending what the model must do to `out` (cleared first).
 * `push` is the separation push from nearby walkers (see `separationPush`).
 */
export function advanceMotion(
  m: Motion,
  dt: number,
  clips: ClipTable,
  push: Vec2 | undefined,
  out: MotionEvent[],
) {
  out.length = 0
  const f = m.fade
  if (f) {
    f.t += dt
    const k = f.duration > 0 ? Math.min(1, f.t / f.duration) : 1
    m.opacity = f.from + (f.to - f.from) * k
    if (k >= 1) {
      m.opacity = f.to
      m.fade = undefined
      if (f.to <= 0) m.visible = false
    }
  }
  let budget = dt
  for (;;) {
    const s = m.queue[0]
    if (!s) break
    if (!m.started) {
      m.started = true
      m.stepT = 0
      m.stepLen = lengthOf(s, clips)
      start(m, s, clips, out)
    }
    const rem = m.stepLen - m.stepT
    if (budget < rem) {
      m.stepT += budget
      budget = 0
      apply(m, s, clips, out)
      break
    }
    m.stepT = m.stepLen
    budget -= rem
    apply(m, s, clips, out)
    finish(m, s)
    m.queue.shift()
    m.started = false
  }
  if (!m.queue.length && m.clip) m.clipTime += budget

  springAngle(m.spring, m.hTarget, HEADING_OMEGA, dt)
  m.heading = m.spring.h
  const k = decay(dt, BLEND_TAU)
  m.blend.x *= k
  m.blend.z *= k
  if (m.sepWeight > 0) stepSeparation(m.sep, push ?? NO_PUSH, dt, m.sepWeight)
  else {
    const ks = decay(dt, BLEND_TAU)
    m.sep.x *= ks
    m.sep.z *= ks
  }
  m.pos.x = m.base.x + m.blend.x + m.sep.x
  m.pos.z = m.base.z + m.blend.z + m.sep.z
}
