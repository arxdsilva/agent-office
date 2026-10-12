// One AnimationMixer per character: clips by name, crossfades, Walk timeScale. Implements the
// mover's target. A clip the glb lacks falls back to SitIdle/Idle by posture (loops) or is skipped
// (one-shots; the previous pose holds). One-shots clamp on their last frame (`hold`).
import * as THREE from 'three'
import { fallbackLoop } from '../../../app/motion.ts'
import type { ClipName, PropName } from '../../../app/office-types.ts'
import type { MoverTarget } from '../mover.ts'

export class Animator implements MoverTarget {
  readonly mixer: THREE.AnimationMixer
  private readonly actions = new Map<string, THREE.AnimationAction>()
  private current: THREE.AnimationAction | undefined

  constructor(
    root: THREE.Object3D,
    private readonly clips: ReadonlyMap<string, THREE.AnimationClip>,
    private readonly props: ReadonlyMap<string, THREE.Object3D>,
  ) {
    this.mixer = new THREE.AnimationMixer(root)
  }

  private action(name: string): THREE.AnimationAction | undefined {
    let a = this.actions.get(name)
    if (!a) {
      const clip = this.clips.get(name)
      if (!clip) return undefined
      a = this.mixer.clipAction(clip)
      this.actions.set(name, a)
    }
    return a
  }

  play(clip: ClipName, loop: boolean, fadeIn: number, offset: number) {
    const a = this.action(clip) ?? (loop ? this.action(fallbackLoop(clip)) : undefined)
    if (!a) return
    const cur = this.current
    if (a === cur && loop && a.isRunning() && a.loop === THREE.LoopRepeat) return
    a.reset()
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
    a.clampWhenFinished = !loop
    a.setEffectiveTimeScale(1)
    a.setEffectiveWeight(1)
    a.time = Math.min(offset, a.getClip().duration)
    a.play()
    if (fadeIn > 0 && cur && cur !== a) cur.crossFadeTo(a, fadeIn, false)
    else if (fadeIn <= 0) for (const other of this.actions.values()) if (other !== a) other.stop()
    this.current = a
  }

  prop(prop: PropName, on: boolean) {
    const p = this.props.get(prop)
    if (p) p.visible = on
  }

  walkRate(timeScale: number) {
    const w = this.actions.get('Walk')
    if (w && w === this.current) w.setEffectiveTimeScale(timeScale)
  }

  update(dt: number) {
    this.mixer.update(dt)
  }

  dispose(root: THREE.Object3D) {
    this.mixer.stopAllAction()
    this.mixer.uncacheRoot(root)
    this.actions.clear()
    this.current = undefined
  }
}
