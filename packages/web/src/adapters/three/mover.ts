// Plays a choreography `Step[]` for one agent from its ACTUAL pose (the director only predicts it):
// the step logic lives in the pure `app/motion.ts`; this file turns its events into model calls
// (clip crossfades, Walk timeScale, props) and writes the transform. Allocation-free per frame.
import type * as THREE from 'three'
import {
  advanceMotion,
  createMotion,
  isWalking,
  pairedOffset,
  setSteps,
  walkTimeScale,
  type ClipTable,
  type Motion,
  type MotionEvent,
} from '../../app/motion.ts'
import { WALK_SPEED } from '../../app/navigation.ts'
import type { ClipName, PropName, Step, Vec2 } from '../../app/office-types.ts'

/** What a mover drives: the character's animation and props. */
export interface MoverTarget {
  /** Start `clip` (crossfading over `fadeIn` s) at `offset` s; a loop already playing keeps going. */
  play(clip: ClipName, loop: boolean, fadeIn: number, offset: number): void
  /** Show or hide a prop on the `prop.R` socket. */
  prop(prop: PropName, on: boolean): void
  /** Walk playback rate (ground speed / authored speed). */
  walkRate(timeScale: number): void
}

export class Mover {
  readonly motion: Motion = createMotion()
  private readonly events: MotionEvent[] = []
  private readonly walkSpeed: number

  constructor(
    private readonly clips: ClipTable,
    private readonly target: MoverTarget,
    /** Object whose position/rotation.y follow the motion (the character's root). */
    private readonly object?: THREE.Object3D,
    /** Shared clock (s) that phase-locks paired loops such as PingPong. */
    private readonly clock: () => number = () => 0,
  ) {
    this.walkSpeed = clips.Walk?.speed ?? WALK_SPEED
  }

  /** New steps (from `AgentPlan.steps`): finishes/cuts what's playing per choreography semantics. */
  run(steps: Step[]) {
    setSteps(this.motion, steps)
  }

  /** Walking along a path right now (takes part in separation steering). */
  get walking() {
    return isWalking(this.motion)
  }

  get pos(): Vec2 {
    return this.motion.pos
  }

  update(dt: number, push?: Vec2) {
    const m = this.motion
    advanceMotion(m, dt, this.clips, push, this.events)
    for (const e of this.events) {
      if (e.kind === 'clip') {
        const meta = this.clips[e.clip]
        const offset =
          e.loop && meta?.pairOffset !== undefined
            ? pairedOffset(this.clock(), meta.duration, meta.pairOffset, /:B$/.test(m.anchor ?? ''))
            : e.offset
        this.target.play(e.clip, e.loop, e.fadeIn, offset)
      } else if (e.kind === 'prop') this.target.prop(e.prop, e.on)
    }
    if (m.clip === 'Walk') this.target.walkRate(walkTimeScale(m.speed, this.walkSpeed))
    const o = this.object
    if (o) {
      o.position.set(m.pos.x, 0, m.pos.z)
      o.rotation.y = m.heading
    }
  }
}
