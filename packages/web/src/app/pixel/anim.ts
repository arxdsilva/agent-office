// 3D clip → 2D pixel animation (plan §5.4), plus the status icon, which comes from the agent's
// business status (not the clip), so "!" shows the moment an agent starts waiting, mid-walk too.
import type { AgentStatus } from '@agent-office/shared'
import { MIN_WALK_TIMESCALE } from '../motion.ts'
import { WALK_SPEED } from '../navigation.ts'
import type { ClipName, PropName } from '../office-types.ts'
import type { PixelAnim, StatusIcon } from './types.ts'

export const CLIP_ANIM: Readonly<Record<ClipName, PixelAnim>> = {
  Idle: 'idle',
  Walk: 'walk',
  // Turning in place: the sprite just changes facing.
  TurnL90: 'idle',
  TurnR90: 'idle',
  SitDown: 'sit',
  StandUp: 'sit',
  SitIdle: 'sit',
  SitType: 'sit-type',
  SitThink: 'sit-think',
  SitTalk: 'sit-talk',
  SitLaptop: 'sit-type',
  StandTalk: 'idle-talk',
  PhoneCall: 'phone',
  DrinkCoffee: 'coffee',
  LoungeSit: 'lounge',
  PingPong: 'pingpong',
  Wave: 'wave',
  HeadScratch: 'confused',
  ElevatorIn: 'elevator-in',
  StandInteract: 'stand-interact',
  SitRead: 'read',
  ShelfPick: 'stand-interact',
}

/** Walk cycle frame rate at WALK_SPEED; other animations play at their own atlas timing. */
export const WALK_FPS = 8

export const animFor = (clip: ClipName | undefined): PixelAnim => (clip ? CLIP_ANIM[clip] : 'idle')

/** Walk frame rate for a ground speed (scaled like the 3D Walk timeScale, with the same floor). */
export const walkFps = (speed: number) =>
  WALK_FPS * Math.max(MIN_WALK_TIMESCALE, speed / WALK_SPEED)

/** Frame index `t` seconds into a looping animation of `frames` frames at `fps`. */
export const frameAt = (t: number, frames: number, fps: number) =>
  frames <= 1 ? 0 : Math.floor(Math.max(0, t) * fps + 1e-9) % frames

const ICONS: Readonly<Record<AgentStatus, StatusIcon>> = {
  idle: null,
  thinking: 'thinking',
  tool: 'tool',
  waiting: 'waiting',
  error: 'error',
  done: null,
}
export const statusIcon = (s: AgentStatus): StatusIcon => ICONS[s]

export interface NpcVisual {
  anim: PixelAnim
  /** Frames per second for the walk cycle (undefined: the atlas timing). */
  fps?: number
  icon: StatusIcon
  props: PropName[]
}

/** What to draw for an NPC this frame, from its motion and its business status. */
export function npcVisual(i: {
  status: AgentStatus
  clip: ClipName | undefined
  speed: number
  props: readonly PropName[]
  /** Fading out at the elevator. */
  leaving?: boolean
}): NpcVisual {
  const anim = i.leaving && i.clip !== 'Walk' ? 'elevator-out' : animFor(i.clip)
  const v: NpcVisual = { anim, icon: statusIcon(i.status), props: [...i.props].sort() }
  if (anim === 'walk') v.fps = walkFps(i.speed)
  return v
}
