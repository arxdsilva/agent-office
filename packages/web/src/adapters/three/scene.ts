// SceneView port → three.js HQ: assets, building, characters, labels, camera and post-processing.
// Rendering only: what to show comes from the controller (layout + plans from the director).
import { STATUS_COLORS, type GraphicsQuality } from '@agent-office/shared'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { nearestNode } from '../../app/navigation.ts'
import type { Manifest } from '../../app/manifest.ts'
import type { AgentPlan, BuildingLayout } from '../../app/office-types.ts'
import { createGovernor, PRESETS, resolvePreset, type Preset } from '../../app/quality.ts'
import type { SceneAssets, SceneView } from '../../ports.ts'
import { AssetStore, LoadingScreen, type LoadingElements } from './assets.ts'
import { BuildingView, type ScreenState } from './building-view.ts'
import { anchorBookmark, bookmarksFor, CameraDirector, type Bookmark } from './camera-director.ts'
import { CharacterSystem, loadCharacterAssets } from './characters.ts'
import { Labels } from './labels.ts'
import { RenderPipeline } from './render-pipeline.ts'

export interface SceneElements {
  stage: HTMLElement
  walkButton: HTMLElement
  fitButton: HTMLElement
  crosshair: HTMLElement
  walkHelp: HTMLElement
  loading: LoadingElements
  /** Camera bookmark buttons (Atrium, Main Street, wings, Overview). */
  views: HTMLElement
  /** Accessible list of wing sign texts (the signs themselves are canvas textures). */
  wingSigns: HTMLElement
  stats: HTMLElement
}

const ASSET_BASE = 'assets/'
const SHADOW_EXTENT = 22
const SUN_DIR = new THREE.Vector3(-0.45, 1, 0.3).normalize()
const ELEVATOR_OPEN_DIST = 3.2
const TV_ON: ScreenState = { color: '#7fb2ff', intensity: 1.3 }

/** `?debug`/`?stats` in dev, or the `ao-debug` flag in local storage (screenshot/perf scripts). */
const debugEnabled = () => {
  try {
    return /[?&](debug|stats)\b/.test(location.search) || localStorage.getItem('ao-debug') === '1'
  } catch {
    return false
  }
}

export class ThreeScene implements SceneView {
  private renderer = new THREE.WebGLRenderer({
    antialias: false,
    powerPreference: 'high-performance',
  })
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500)
  private pipeline: RenderPipeline
  private labels: Labels
  private cam: CameraDirector
  private store = new AssetStore(ASSET_BASE)
  private loading: LoadingScreen
  private building: BuildingView | null = null
  private characters: CharacterSystem | null = null
  private manifest: Manifest | null = null
  private layout: BuildingLayout | null = null
  private bookmarks: Bookmark[] = []
  private plans = new Map<string, AgentPlan>()
  private desks = new Map<string, string>()
  private quality: GraphicsQuality = 'auto'
  private governor = createGovernor()
  private preset: Preset = 'high'
  private sun = new THREE.DirectionalLight(0xfff4e6, 1.6)
  private catcher = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShadowMaterial({ opacity: 0.3, depthWrite: false }),
  )
  private fill = new THREE.HemisphereLight(0xdfe8ff, 0x6b5a48, 0.35)
  private selected: string | null = null
  private pickFn: (id: string | null) => void = () => {}
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private framed = false
  private focus = new THREE.Vector3()
  private openBanks = new Set<string>()
  private debug = debugEnabled()

  constructor(private el: SceneElements) {
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    el.stage.append(this.renderer.domElement)
    this.pipeline = new RenderPipeline(this.renderer, this.scene, this.camera)
    this.labels = new Labels(el.stage, (id) => this.pickFn(id))
    this.cam = new CameraDirector(this.camera, this.renderer.domElement)
    this.loading = new LoadingScreen(el.loading)
    this.store.manager.onProgress = (_url, loaded, total) =>
      this.loading.progress(total ? loaded / total : 0)

    this.scene.background = new THREE.Color(0x1b2028)
    this.camera.position.set(30, 40, 50)
    this.sun.position.copy(SUN_DIR).multiplyScalar(40)
    const s = this.sun.shadow
    s.camera.left = s.camera.bottom = -SHADOW_EXTENT
    s.camera.right = s.camera.top = SHADOW_EXTENT
    s.camera.near = 1
    s.camera.far = 100
    s.bias = -0.0004
    s.normalBias = 0.03
    s.radius = 4
    this.catcher.rotation.x = -Math.PI / 2
    this.catcher.position.y = 0.004
    this.catcher.receiveShadow = true
    this.catcher.renderOrder = 1
    this.scene.add(this.sun, this.sun.target, this.fill, this.catcher)

    this.applyPreset(this.preset)
    addEventListener('resize', () => this.resize())
    this.resize()
    this.bindInput()
    if (this.debug) this.installDebug()

    const clock = new THREE.Clock()
    this.renderer.setAnimationLoop(() => this.frame(clock.getDelta()))
  }

  async load(manifestUrl: string): Promise<SceneAssets> {
    try {
      this.loading.progress(0.02, 'Loading the floor plan…')
      const manifest = await this.store.manifest(manifestUrl)
      this.manifest = manifest
      this.building = new BuildingView(this.store, manifest)
      this.building.onChange = () => this.updateSurfaces()
      this.scene.add(this.building.group)
      this.loading.progress(0.08, 'Loading the atrium…')
      const env = this.store.environment(manifest.hdri, this.renderer).catch(() => {
        const pmrem = new THREE.PMREMGenerator(this.renderer)
        const t = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
        pmrem.dispose()
        return t
      })
      const [character, envMap] = await Promise.all([
        // Without the character the building still renders (tags stay hidden); say why once.
        loadCharacterAssets(ASSET_BASE, this.store.gltf).catch((err: Error) => {
          console.warn(`agent-office: character assets unavailable (${err.message})`)
          return null
        }),
        env,
        // Atrium first: it's where the camera starts. Street/cap come along; wings stream in later.
        this.building.preload(['atrium', 'street', 'cap', 'garden']),
      ])
      this.scene.environment = envMap
      if (character)
        this.characters = new CharacterSystem(this.scene, character, {
          quality: this.preset,
          renderer: this.renderer,
        })
      this.loading.progress(1, 'Opening the doors…')
      this.loading.hide()
      // One-shot clip lengths so the director's pose predictions match the real clips.
      const clipDurations: SceneAssets['clipDurations'] = {}
      for (const [name, c] of Object.entries(character?.meta.clips ?? {}))
        if (c && !c.loop) clipDurations[name as keyof typeof clipDurations] = c.duration
      return { manifest, clipDurations }
    } catch (err) {
      this.loading.error(`Could not load the office: ${(err as Error).message}`)
      setTimeout(() => this.loading.hide(), 4000)
      throw err
    }
  }

  setBuilding(layout: BuildingLayout): void {
    if (!this.building || !this.manifest) return
    this.layout = layout
    this.building.setLayout(layout)
    const b = layout.bounds
    this.catcher.scale.set(b.maxX - b.minX + 4, b.maxZ - b.minZ + 4, 1)
    this.catcher.position.set((b.minX + b.maxX) / 2, 0.004, (b.minZ + b.maxZ) / 2)
    this.bookmarks = bookmarksFor(layout, this.manifest)
    this.renderViews()
    this.renderSigns(layout)
    if (!this.framed) {
      this.framed = true
      const start = this.bookmarks.find((x) => x.id === 'atrium') ?? this.bookmarks[0]
      if (start) this.cam.jumpTo(start)
    }
    this.updateSurfaces()
  }

  direct(plans: Map<string, AgentPlan>, departed: string[]): void {
    const now = Date.now()
    for (const id of departed) this.drop(id)
    for (const id of this.plans.keys()) if (!plans.has(id)) this.drop(id)
    this.plans = plans
    for (const [id, plan] of plans) {
      this.characters?.upsert(plan, now)
      this.labels.upsert(plan.agent, plan.intent.activity)
      const local = plan.intent.target.slice(plan.intent.target.lastIndexOf('/') + 1)
      if (local.startsWith('seat:desk:')) this.desks.set(id, plan.intent.target)
    }
    this.updateSurfaces()
  }

  private drop(id: string): void {
    this.characters?.remove(id)
    this.labels.remove(id)
    this.desks.delete(id)
  }

  /** Monitors (status colors), meeting TVs, booth LEDs and LED wall numbers from the current plans. */
  private updateSurfaces(): void {
    if (!this.building || !this.layout) return
    const anchors = this.layout.anchors
    const screens = new Map<string, ScreenState>()
    for (const [id, desk] of this.desks) {
      const plan = this.plans.get(id)
      const a = anchors.get(desk)
      if (!plan || !a?.screen) continue
      const status = plan.agent.status
      screens.set(`${a.placement}|${a.screen}`, {
        color: STATUS_COLORS[status],
        intensity: status === 'idle' || status === 'done' ? 0.35 : 1.5,
      })
    }
    const leds = new Set<string>()
    const rooms = new Set<string>()
    let working = 0
    let waiting = 0
    for (const plan of this.plans.values()) {
      const st = plan.agent.status
      if (st === 'tool' || st === 'thinking') working++
      if (st === 'waiting') waiting++
      const a = anchors.get(plan.intent.target)
      if (!a) continue
      if (plan.intent.activity === 'booth' && a.led) leds.add(`${a.placement}|${a.led}`)
      if (plan.intent.activity === 'meeting' && a.room?.startsWith('meeting-')) {
        const room = a.room.slice('meeting-'.length)
        rooms.add(`${a.placement}|${room}`)
        screens.set(`${a.placement}|meeting:${room}`, TV_ON)
      }
    }
    this.building.setScreens(screens)
    this.building.setLeds(leds)
    this.building.setStats({ agents: this.plans.size, working, waiting, meetings: rooms.size })
  }

  setQuality(q: GraphicsQuality): void {
    this.quality = q
    if (q === 'auto') this.governor.reset()
    this.applyPreset(resolvePreset(q, this.governor.preset))
  }

  private applyPreset(p: Preset): void {
    this.preset = p
    this.pipeline.setPreset(p)
    const size = PRESETS[p].shadowMap
    this.sun.castShadow = size > 0
    if (size && this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size)
      this.sun.shadow.map?.dispose()
      this.sun.shadow.map = null
    }
    this.characters?.setQuality(p)
  }

  onPick(fn: (id: string | null) => void): void {
    this.pickFn = fn
  }

  select(id: string | null): void {
    this.selected = id
    this.labels.select(id)
    const chars = this.characters
    if (!id || !chars) return this.cam.focusOn(null)
    this.cam.focusOn(() => chars.positionOf(id))
  }

  private frame(rawDt: number): void {
    const dt = Math.min(rawDt, 0.1)
    const now = Date.now()
    const colliders = this.building?.colliders() ?? []
    this.cam.update(dt, colliders)
    this.camera.updateMatrixWorld()
    if (this.characters) this.characters.update(dt, this.camera, now)
    if (this.building) {
      this.updateDoors()
      this.building.update(dt, this.camera, this.openBanks)
    }
    this.followShadow()
    const sample = this.pipeline.render(rawDt)
    this.labels.update(this.camera, (id) => this.characters?.headOf(id), colliders, now)
    if (sample) this.onSample(sample)
  }

  private onSample(s: { fps: number; dt: number }): void {
    if (this.quality === 'auto') {
      const next = this.governor.sample(s.fps, s.dt)
      if (next) this.applyPreset(next)
    }
    if (!this.el.stats.hidden) {
      const st = this.pipeline.stats
      this.el.stats.textContent = `${st.fps.toFixed(0)} fps · ${st.drawCalls} calls · ${(st.triangles / 1000).toFixed(0)}k tris · ${this.preset}`
    }
  }

  /** Elevator doors open while someone stands or walks near them. */
  private updateDoors(): void {
    this.openBanks.clear()
    const banks = this.building!.elevatorBanks()
    if (!banks.length || !this.characters) return
    for (const id of this.plans.keys()) {
      const p = this.characters.positionOf(id)
      if (!p) continue
      for (const b of banks)
        if (Math.hypot(p.x - b.pos.x, p.z - b.pos.z) < ELEVATOR_OPEN_DIST) this.openBanks.add(b.key)
    }
  }

  /** The shadow frustum follows the camera focus, snapped to texels to avoid shimmering. */
  private followShadow(): void {
    if (!this.sun.castShadow) return
    this.cam.focusPoint(this.focus)
    const texel = (SHADOW_EXTENT * 2) / this.sun.shadow.mapSize.x
    this.focus.set(
      Math.round(this.focus.x / texel) * texel,
      0,
      Math.round(this.focus.z / texel) * texel,
    )
    this.sun.target.position.copy(this.focus)
    this.sun.position.copy(this.focus).addScaledVector(SUN_DIR, 40)
    this.sun.target.updateMatrixWorld()
  }

  private renderViews(): void {
    const order = ['atrium', 'street']
    const views = [
      ...order.map((id) => this.bookmarks.find((b) => b.id === id)).filter((b) => !!b),
      ...this.bookmarks.filter((b) => b.id.startsWith('wing:')),
      ...this.bookmarks.filter((b) => b.id === 'overview'),
    ]
    const key = views.map((v) => `${v.id}=${v.label}`).join('|')
    if (this.el.views.dataset.key === key) return
    this.el.views.dataset.key = key
    this.el.views.replaceChildren(
      ...views.map((v) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'view-btn'
        b.dataset.view = v.id
        b.textContent = v.label
        b.addEventListener('click', () => this.flyTo(v.id))
        return b
      }),
    )
  }

  private renderSigns(layout: BuildingLayout): void {
    const labels = layout.placements
      .filter((p) => p.kind === 'wing' && p.label)
      .map((p) => p.label!)
      .sort()
    const key = labels.join('|')
    if (this.el.wingSigns.dataset.key === key) return
    this.el.wingSigns.dataset.key = key
    this.el.wingSigns.replaceChildren(
      ...labels.map((l) => {
        const li = document.createElement('li')
        li.className = 'zone-sign'
        li.textContent = l
        return li
      }),
    )
  }

  private flyTo(id: string): boolean {
    const b = this.bookmarks.find((x) => x.id === id)
    if (!b) return false
    if (this.selected) this.pickFn(null)
    this.cam.flyTo(b)
    return true
  }

  private resize(): void {
    this.pipeline.resize(innerWidth, innerHeight)
    this.labels.setSize(innerWidth, innerHeight)
    this.camera.aspect = innerWidth / innerHeight
    this.camera.updateProjectionMatrix()
  }

  private pick(ndcX: number, ndcY: number): string | null {
    if (!this.characters) return null
    this.pointer.set(ndcX, ndcY)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObjects(this.characters.pickTargets(), false)
    for (const h of hits)
      for (let o: THREE.Object3D | null = h.object; o; o = o.parent)
        if (o.userData.agentId) return o.userData.agentId as string
    return null
  }

  /** Walk mode starts on the walkable graph nearest to where the orbit camera looks. */
  private walkStart(): THREE.Vector3 | undefined {
    if (!this.layout) return undefined
    const t = this.cam.orbit.target
    const id = nearestNode(this.layout.nav, { x: t.x, z: t.z })
    const n = id ? this.layout.nav.nodes.get(id) : undefined
    return n ? new THREE.Vector3(n.pos.x, 0, n.pos.z) : undefined
  }

  private bindInput(): void {
    const canvas = this.renderer.domElement
    let downAt: [number, number] | null = null
    canvas.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]))
    canvas.addEventListener('pointerup', (e) => {
      if (!downAt || this.cam.mode !== 'orbit') return
      const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1])
      downAt = null
      if (moved > 5) return // it was a drag
      this.pickFn(this.pick((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1))
    })
    this.el.walkButton.addEventListener('click', () => this.cam.enterWalk(this.walkStart()))
    this.el.fitButton.addEventListener('click', () => this.flyTo('overview'))
    this.cam.onModeChange = (mode) => {
      this.el.crosshair.hidden = mode !== 'walk'
      this.el.walkHelp.hidden = mode !== 'walk'
      this.el.walkButton.textContent = mode === 'walk' ? '🎥 Orbit' : '🚶 Walk'
      this.building?.setCeilingsVisible(mode === 'walk')
    }
    addEventListener('keydown', (e) => {
      const t = e.target
      if (
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLInputElement ||
        t instanceof HTMLSelectElement
      )
        return
      if (e.code === 'KeyF' && this.cam.mode === 'orbit') this.cam.enterWalk(this.walkStart())
      if (e.code === 'KeyE' && this.cam.mode === 'walk') {
        const id = this.pick(0, 0) // crosshair at screen center
        if (id) this.pickFn(id)
      }
      if (e.code === 'Escape' && this.cam.mode === 'orbit') this.pickFn(null)
    })
  }

  /** Dev/screenshot hook: camera bookmarks and frame stats. Only installed behind the debug flag. */
  private installDebug(): void {
    this.el.stats.hidden = false
    const api = {
      ready: () => !!this.layout,
      views: () => this.bookmarks.map((b) => b.id),
      view: (id: string) => {
        const b = this.bookmarks.find((x) => x.id === id)
        if (b) this.cam.jumpTo(b)
        return !!b
      },
      anchor: (pattern: string, distance?: number) => {
        const b = this.layout && anchorBookmark(this.layout, new RegExp(pattern), distance)
        if (b) this.cam.jumpTo(b)
        return !!b
      },
      look: (pos: [number, number, number], target: [number, number, number]) =>
        this.cam.jumpTo({
          position: new THREE.Vector3(...pos),
          target: new THREE.Vector3(...target),
        }),
      stats: () => ({
        ...this.pipeline.stats,
        preset: this.preset,
        ...(this.characters?.count() ?? {}),
      }),
    }
    ;(window as unknown as { __aoDebug: typeof api }).__aoDebug = api
  }
}
