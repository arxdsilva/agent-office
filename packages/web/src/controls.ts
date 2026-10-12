import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js'
import type { Collider } from './office.ts'

const EYE_HEIGHT = 1.7
const WALK_SPEED = 4
const SPRINT = 2
const RADIUS = 0.35

export type Mode = 'orbit' | 'walk'

/** Orbit (default) and first-person walk with simple AABB collision. */
export class Controls {
  readonly orbit: OrbitControls
  readonly walk: PointerLockControls
  mode: Mode = 'orbit'
  onModeChange: (mode: Mode) => void = () => {}
  private keys = new Set<string>()
  private savedOrbit = { position: new THREE.Vector3(), target: new THREE.Vector3() }
  private focusAnim: {
    from: THREE.Vector3
    to: THREE.Vector3
    camFrom: THREE.Vector3
    camTo: THREE.Vector3
    t: number
  } | null = null
  private move = new THREE.Vector3()
  private forward = new THREE.Vector3()
  private right = new THREE.Vector3()

  constructor(
    private camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
  ) {
    this.orbit = new OrbitControls(camera, dom)
    this.orbit.enableDamping = true
    this.orbit.maxPolarAngle = Math.PI / 2.15
    this.orbit.minDistance = 4
    this.orbit.maxDistance = 120
    this.walk = new PointerLockControls(camera, document.body)
    this.walk.addEventListener('unlock', () => this.setMode('orbit'))
    window.addEventListener('keydown', (e) => this.keys.add(e.code))
    window.addEventListener('keyup', (e) => this.keys.delete(e.code))
    window.addEventListener('blur', () => this.keys.clear())
  }

  enterWalk(): void {
    if (this.mode === 'walk') return
    this.savedOrbit.position.copy(this.camera.position)
    this.savedOrbit.target.copy(this.orbit.target)
    this.orbit.enabled = false
    // Stand where the orbit camera looks from, at eye height, facing the orbit target.
    this.camera.position.y = EYE_HEIGHT
    this.camera.lookAt(this.orbit.target.x, EYE_HEIGHT, this.orbit.target.z)
    this.setMode('walk')
    this.walk.lock()
  }

  exitWalk(): void {
    if (this.walk.isLocked) this.walk.unlock()
    else this.setMode('orbit')
  }

  /** Eases the orbit camera toward a point (selected agent). */
  focus(x: number, z: number): void {
    if (this.mode !== 'orbit') return
    const to = new THREE.Vector3(x, 1, z + 0.8)
    const offset = this.camera.position.clone().sub(this.orbit.target).setLength(9)
    offset.y = Math.max(offset.y, 4)
    this.focusAnim = {
      from: this.orbit.target.clone(),
      to,
      camFrom: this.camera.position.clone(),
      camTo: to.clone().add(offset),
      t: 0,
    }
  }

  /** Orbit camera framing the given floor area. */
  frame(b: { minX: number; maxX: number; minZ: number; maxZ: number }): void {
    if (this.mode !== 'orbit') return
    const cx = (b.minX + b.maxX) / 2
    const cz = (b.minZ + b.maxZ) / 2
    const halfW = (b.maxX - b.minX) / 2 + 2
    const halfD = (b.maxZ - b.minZ) / 2 + 2
    const vFov = (this.camera.fov * Math.PI) / 180
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect)
    // The near edge is closer to the camera than the center, so pad the width for perspective.
    const dist = Math.max(
      (halfW * 1.35) / Math.tan(hFov / 2),
      (halfD * 1.6) / Math.tan(vFov / 2),
      12,
    )
    const to = new THREE.Vector3(cx, 0, cz)
    const dir = new THREE.Vector3(0, 0.75, 0.66).normalize()
    this.focusAnim = {
      from: this.orbit.target.clone(),
      to,
      camFrom: this.camera.position.clone(),
      camTo: to.clone().addScaledVector(dir, Math.min(dist, this.orbit.maxDistance)),
      t: 0,
    }
  }

  update(dt: number, colliders: Collider[]): void {
    if (this.mode === 'orbit') {
      if (this.focusAnim) {
        const a = this.focusAnim
        a.t = Math.min(1, a.t + dt / 0.6)
        const k = 1 - (1 - a.t) ** 3
        this.orbit.target.lerpVectors(a.from, a.to, k)
        this.camera.position.lerpVectors(a.camFrom, a.camTo, k)
        if (a.t >= 1) this.focusAnim = null
      }
      this.orbit.update()
      return
    }
    const speed =
      WALK_SPEED * (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? SPRINT : 1) * dt
    this.camera.getWorldDirection(this.forward)
    this.forward.y = 0
    this.forward.normalize()
    this.right.crossVectors(this.forward, this.camera.up).normalize()
    this.move.set(0, 0, 0)
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) this.move.add(this.forward)
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) this.move.sub(this.forward)
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) this.move.add(this.right)
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) this.move.sub(this.right)
    if (this.move.lengthSq() === 0) return
    this.move.setLength(speed)
    const p = this.camera.position
    // Resolve per axis so you slide along walls and desks instead of sticking.
    if (!blocked(p.x + this.move.x, p.z, colliders)) p.x += this.move.x
    if (!blocked(p.x, p.z + this.move.z, colliders)) p.z += this.move.z
    p.y = EYE_HEIGHT
  }

  private setMode(mode: Mode): void {
    if (mode === this.mode) return
    this.mode = mode
    if (mode === 'orbit') {
      this.camera.position.copy(this.savedOrbit.position)
      this.orbit.target.copy(this.savedOrbit.target)
      this.orbit.enabled = true
    }
    this.keys.clear()
    this.onModeChange(mode)
  }
}

function blocked(x: number, z: number, colliders: Collider[]): boolean {
  return colliders.some(
    (c) => x + RADIUS > c.minX && x - RADIUS < c.maxX && z + RADIUS > c.minZ && z - RADIUS < c.maxZ,
  )
}
