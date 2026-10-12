// Agent NPCs: one motion.ts instance per agent fed with the director's steps (the same step player
// the 3D characters use), so the 2D view draws exactly the decisions the director made. Identity
// comes from PL's `createNpcs` (created on the first plan, dropped after `departed` + the fade);
// what to draw (animation, frame rate, status icon) from `npcVisual`.
import {
  advanceMotion,
  createMotion,
  isWalking,
  separationPush,
  SEPARATION,
  setSteps,
  type ClipTable,
  type Motion,
  type MotionEvent,
} from '../../app/motion.ts'
import type { AgentPlan, PropName, Vec2 } from '../../app/office-types.ts'
import { npcVisual, WALK_FPS } from '../../app/pixel/anim.ts'
import { createNpcs, type NpcEntity } from '../../app/pixel/npc.ts'
import { dir4 } from '../../app/pixel/project.ts'
import type { Dir4, PixelAnim, StatusIcon } from '../../app/pixel/types.ts'
import { lookKey, type Look } from './sprites.ts'

export interface Npc {
  id: string
  entity: NpcEntity
  plan: AgentPlan
  motion: Motion
  look: Look
  key: string
  anim: PixelAnim
  /** The atlas animation to play (adds the sit-down / stand-up transitions). */
  name: string
  props: PropName[]
  dir: Dir4
  icon: StatusIcon
  /** Renderer-only facing (towards the player while talking); no step changes. */
  faceOverride: Dir4 | null
  animT: number
}

export class NpcSystem {
  readonly npcs = new Map<string, Npc>()
  private ids = createNpcs()
  private events: MotionEvent[] = []
  private xs = new Float64Array(64)
  private zs = new Float64Array(64)
  private push: Vec2 = { x: 0, z: 0 }

  /** One director update. Agents missing from `plans` leave like departed ones (fade, then gone). */
  direct(plans: Map<string, AgentPlan>, departed: string[], now: number): void {
    const gone = [...departed, ...[...this.npcs.keys()].filter((id) => !plans.has(id))]
    const { removed } = this.ids.sync(plans, gone, now)
    for (const id of removed) this.npcs.delete(id)
    for (const [id, plan] of plans) {
      let n = this.npcs.get(id)
      if (!n) {
        const entity = this.ids.get(id)!
        const look: Look = entity.appearance
        n = {
          id,
          entity,
          plan,
          motion: createMotion(),
          look,
          key: lookKey(look),
          anim: 'idle',
          name: 'idle',
          props: [],
          dir: 's',
          icon: null,
          faceOverride: null,
          animT: 0,
        }
        this.npcs.set(id, n)
      }
      n.plan = plan
      if (plan.steps) setSteps(n.motion, plan.steps)
    }
  }

  update(dt: number, clips: ClipTable, now: number): void {
    for (const id of this.ids.sync(new Map(), [], now).removed) this.npcs.delete(id)
    const list = [...this.npcs.values()]
    if (this.xs.length < list.length) {
      this.xs = new Float64Array(list.length * 2)
      this.zs = new Float64Array(list.length * 2)
    }
    list.forEach((n, i) => ((this.xs[i] = n.motion.pos.x), (this.zs[i] = n.motion.pos.z)))
    list.forEach((n, i) => {
      const m = n.motion
      const push = isWalking(m)
        ? separationPush(this.xs, this.zs, list.length, i, SEPARATION.radius, this.push)
        : undefined
      advanceMotion(m, dt, clips, push, this.events)
      const v = npcVisual({
        status: n.plan.agent.status,
        clip: m.clip,
        speed: m.speed,
        props: m.props,
        ...(n.entity.leaving && { leaving: true }),
      })
      const name = m.clip === 'SitDown' ? 'sit-down' : m.clip === 'StandUp' ? 'stand-up' : v.anim
      if (name !== n.name) ((n.anim = v.anim), (n.name = name), (n.animT = 0))
      // Walk cycles run at the ground speed (like the 3D Walk timeScale); the rest in real time.
      n.animT += dt * (v.fps ? v.fps / WALK_FPS : 1)
      n.icon = v.icon
      n.props = v.props
      n.dir = n.faceOverride ?? dir4(m.heading)
    })
  }

  clear(): void {
    this.npcs.clear()
  }
}
