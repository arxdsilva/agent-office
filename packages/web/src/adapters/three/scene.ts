import type { Agent } from '@agent-office/shared'
import * as THREE from 'three'
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js'
import type { OfficeLayout, SceneView } from '../../ports.ts'
import { Avatar } from './avatar.ts'
import { Controls } from './controls.ts'
import { Office, type Collider } from './office.ts'

export interface SceneElements {
  stage: HTMLElement
  walkButton: HTMLElement
  fitButton: HTMLElement
  crosshair: HTMLElement
  walkHelp: HTMLElement
}

/** SceneView port → three.js office. Rendering only: what to show comes from the controller. */
export class ThreeScene implements SceneView {
  private renderer = new THREE.WebGLRenderer({ antialias: true })
  private labels = new CSS2DRenderer()
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400)
  private office: Office
  private controls: Controls
  private avatars = new Map<string, Avatar>()
  private leaving = new Set<Avatar>()
  private colliders: Collider[] = []
  private selected: string | null = null
  private framedZones = -1
  private pickFn: (id: string | null) => void = () => {}
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()

  constructor(private el: SceneElements) {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    el.stage.append(this.renderer.domElement)
    Object.assign(this.labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' })
    el.stage.append(this.labels.domElement)

    const bg = new THREE.Color(dark ? 0x12151b : 0xeef0f3)
    this.scene.background = bg
    this.scene.fog = new THREE.Fog(bg, 60, 160)
    this.camera.position.set(0, 18, 26)
    this.office = new Office(dark)
    this.scene.add(this.office.group)
    this.controls = new Controls(this.camera, this.renderer.domElement)

    addEventListener('resize', () => this.resize())
    this.resize()
    this.bindInput()

    const clock = new THREE.Clock()
    this.renderer.setAnimationLoop(() => {
      const dt = Math.min(clock.getDelta(), 0.1)
      const t = clock.elapsedTime
      for (const av of this.avatars.values()) av.update(dt, t)
      for (const av of this.leaving) {
        if (!av.update(dt, t)) {
          av.dispose()
          this.leaving.delete(av)
        }
      }
      this.controls.update(dt, this.colliders)
      this.renderer.render(this.scene, this.camera)
      this.labels.render(this.scene, this.camera)
    })
  }

  onPick(fn: (id: string | null) => void): void {
    this.pickFn = fn
  }

  sync(agents: Agent[], layout: OfficeLayout): void {
    this.office.setZones(layout.zones)
    // Re-frame when zones appear or disappear (not on every update, so we don't fight the user).
    if (layout.zones.length !== this.framedZones) {
      this.framedZones = layout.zones.length
      this.controls.frame(this.office.bounds)
    }
    const present = new Set<string>()
    for (const a of agents) {
      present.add(a.id)
      let av = this.avatars.get(a.id)
      if (!av) {
        av = new Avatar(a, (id) => this.pickFn(id))
        this.avatars.set(a.id, av)
        this.scene.add(av.group)
      }
      av.setAgent(a)
      const seat = layout.slots.get(a.id)
      if (seat) av.setSeat(seat.x, seat.z)
    }
    for (const [id, av] of this.avatars) {
      if (present.has(id)) continue
      av.leaving = true
      this.leaving.add(av)
      this.avatars.delete(id)
    }
    this.colliders = [...this.office.wallColliders, ...[...this.avatars.values()].map((a) => a.collider())]
  }

  select(id: string | null): void {
    if (this.selected) this.avatars.get(this.selected)?.setSelected(false)
    this.selected = id
    const av = id ? this.avatars.get(id) : undefined
    if (!av) return
    av.setSelected(true)
    if (this.controls.mode === 'walk') this.controls.exitWalk()
    this.controls.focus(av.group.position.x, av.group.position.z)
  }

  private resize(): void {
    this.renderer.setSize(innerWidth, innerHeight)
    this.labels.setSize(innerWidth, innerHeight)
    this.camera.aspect = innerWidth / innerHeight
    this.camera.updateProjectionMatrix()
  }

  private pick(ndcX: number, ndcY: number): string | null {
    this.pointer.set(ndcX, ndcY)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObjects([...this.avatars.values()].map((a) => a.hit), false)
    return (hits[0]?.object.userData.agentId as string | undefined) ?? null
  }

  private bindInput(): void {
    const canvas = this.renderer.domElement
    let downAt: [number, number] | null = null
    canvas.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]))
    canvas.addEventListener('pointerup', (e) => {
      if (!downAt || this.controls.mode !== 'orbit') return
      const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1])
      downAt = null
      if (moved > 5) return // it was a drag
      this.pickFn(this.pick((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1))
    })
    this.el.walkButton.addEventListener('click', () => this.controls.enterWalk())
    this.el.fitButton.addEventListener('click', () => this.controls.frame(this.office.bounds))
    this.controls.onModeChange = (mode) => {
      this.el.crosshair.hidden = mode !== 'walk'
      this.el.walkHelp.hidden = mode !== 'walk'
      this.el.walkButton.textContent = mode === 'walk' ? '🎥 Orbit' : '🚶 Walk'
    }
    addEventListener('keydown', (e) => {
      const t = e.target
      if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement || t instanceof HTMLSelectElement) return
      if (e.code === 'KeyF' && this.controls.mode === 'orbit') this.controls.enterWalk()
      if (e.code === 'KeyE' && this.controls.mode === 'walk') {
        const id = this.pick(0, 0) // crosshair at screen center
        if (id) this.pickFn(id)
      }
      if (e.code === 'Escape' && this.controls.mode === 'orbit') this.pickFn(null)
    })
  }
}
