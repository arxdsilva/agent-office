// Night City cameras (docs/special-3d/architecture.md): third person (the player avatar with a
// spring arm that never clips walls), first person (the classic walk controls, CameraDirector's
// walk mode) and overview (the classic orbit controls with bookmarks). F cycles them.
import * as THREE from 'three'
import type { CameraDirector } from '../../../adapters/three/camera-director.ts'
import type { SpecialCamera } from '../../../app/special/hud-vm.ts'
import {
  armLength,
  PLAYER,
  smoothArm,
  stepPlayer,
  type PlayerInput,
  type PlayerState,
} from '../../../app/special/player.ts'
import type { Collider } from '../../../app/special/world.ts'

export const CAMERA_ORDER: readonly SpecialCamera[] = ['third', 'first', 'overview']
const PIVOT_Y = 1.55
const MIN_PITCH = -0.25
const MAX_PITCH = 1.1
const MIN_ARM = 1.6
const MAX_ARM = 6

export interface Bookmark {
  id: string
  label: string
  position: THREE.Vector3
  target: THREE.Vector3
}

export class CameraRig {
  mode: SpecialCamera = 'third'
  onModeChange: (m: SpecialCamera) => void = () => {}
  /** Camera yaw (heading convention) and pitch (positive looks down) in third person. */
  yaw = Math.PI / 2
  pitch = 0.28
  private arm: number = PLAYER.arm
  private armNow: number = PLAYER.arm
  private keys = new Set<string>()
  private input: PlayerInput = { forward: 0, right: 0, sprint: false, yaw: 0 }
  private pivot = new THREE.Vector3()
  private fwd = new THREE.Vector3()
  private back = new THREE.Vector3()
  private look = new THREE.Vector3()
  private dragging: { x: number; y: number } | null = null
  private teardown: (() => void)[] = []
  suspended = false

  constructor(
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
    readonly director: CameraDirector,
    readonly player: PlayerState,
  ) {
    const on = <K extends keyof WindowEventMap>(
      t: Window | HTMLElement,
      type: K,
      fn: (e: WindowEventMap[K]) => void,
    ) => {
      const h = fn as EventListener
      t.addEventListener(type, h)
      this.teardown.push(() => t.removeEventListener(type, h))
    }
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
    }
    on(window, 'keydown', (e) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return
      this.keys.add(e.code)
    })
    on(window, 'keyup', (e) => this.keys.delete(e.code))
    on(window, 'blur', () => this.keys.clear())
    on(dom, 'pointerdown', (e) => {
      if (this.mode !== 'third' || e.button !== 0) return
      this.dragging = { x: e.clientX, y: e.clientY }
    })
    on(window, 'pointermove', (e) => {
      if (!this.dragging || this.mode !== 'third') return
      const dx = e.clientX - this.dragging.x
      const dy = e.clientY - this.dragging.y
      this.dragging = { x: e.clientX, y: e.clientY }
      this.yaw -= dx * 0.005
      this.pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, this.pitch + dy * 0.004))
      director.markInput()
    })
    on(window, 'pointerup', () => (this.dragging = null))
    on(dom, 'wheel', (e) => {
      if (this.mode !== 'third') return
      this.arm = Math.min(MAX_ARM, Math.max(MIN_ARM, this.arm + Math.sign(e.deltaY) * 0.4))
      director.markInput()
    })
    // Leaving pointer lock (Esc) drops the walk controls: continue in third person from there.
    director.onModeChange = (m) => {
      if (m === 'orbit' && this.mode === 'first') this.setMode('third')
    }
    director.orbit.enabled = false
  }

  /** True while the pointer drags the third-person camera (a click is not a pick then). */
  get dragged(): boolean {
    return this.dragging !== null
  }

  next(): SpecialCamera {
    return CAMERA_ORDER[(CAMERA_ORDER.indexOf(this.mode) + 1) % CAMERA_ORDER.length]!
  }

  setMode(m: SpecialCamera, overview?: Bookmark): void {
    if (m === this.mode && !overview) return
    const prev = this.mode
    this.mode = m
    const d = this.director
    if (prev === 'first' && m !== 'first') {
      // The player continues from where the first-person camera stood.
      this.player.x = this.camera.position.x
      this.player.z = this.camera.position.z
      this.camera.getWorldDirection(this.fwd)
      this.player.heading = Math.atan2(this.fwd.x, this.fwd.z)
      this.yaw = this.player.heading
      if (d.mode === 'walk') {
        this.mode = m
        d.exitWalk()
      }
    }
    d.orbit.enabled = m === 'overview'
    if (m === 'first')
      d.walkAt(new THREE.Vector3(this.player.x, 0, this.player.z), this.player.heading)
    if (m === 'overview') {
      const b = overview
      if (b) d.jumpTo(b)
      else
        d.jumpTo({
          position: this.camera.position.clone().setY(Math.max(this.camera.position.y, 12)),
          target: new THREE.Vector3(this.player.x, 0, this.player.z),
        })
    }
    this.keys.clear()
    this.onModeChange(m)
  }

  /** Locks the pointer for mouse look (first person; needs a user gesture). */
  lockPointer(): void {
    if (this.mode === 'first' && !this.director.walk.isLocked) this.director.walk.lock()
  }

  update(dt: number, colliders: readonly Collider[]): void {
    if (this.mode === 'first') {
      if (!this.suspended) this.director.update(dt, colliders as Collider[])
      this.player.x = this.camera.position.x
      this.player.z = this.camera.position.z
      return
    }
    if (this.mode === 'overview') {
      this.director.update(dt, colliders as Collider[])
      return
    }
    const k = this.keys
    const i = this.input
    const on = (...codes: string[]) => (!this.suspended && codes.some((c) => k.has(c)) ? 1 : 0)
    i.forward = on('KeyW', 'ArrowUp') - on('KeyS', 'ArrowDown')
    i.right = on('KeyD', 'ArrowRight') - on('KeyA', 'ArrowLeft')
    i.sprint = on('ShiftLeft', 'ShiftRight') === 1
    i.yaw = this.yaw
    if (i.forward || i.right) this.director.markInput()
    stepPlayer(this.player, i, dt, colliders)
    // Spring arm: behind and above the pivot, shortened in front of walls.
    const p = this.player
    this.pivot.set(p.x, p.y + PIVOT_Y, p.z)
    const cp = Math.cos(this.pitch)
    this.fwd.set(Math.sin(this.yaw) * cp, -Math.sin(this.pitch), Math.cos(this.yaw) * cp)
    this.back.copy(this.fwd).negate()
    const want = armLength(this.pivot, this.back, this.arm, colliders)
    this.armNow = smoothArm(this.armNow, want, dt)
    this.camera.position.copy(this.pivot).addScaledVector(this.back, this.armNow)
    this.look.copy(this.pivot).addScaledVector(this.fwd, 2)
    this.camera.lookAt(this.look)
  }

  dispose(): void {
    for (const off of this.teardown.splice(0)) off()
    this.director.onModeChange = () => {}
    this.keys.clear()
  }
}
