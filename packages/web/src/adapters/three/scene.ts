// SceneView port → three.js HQ: assets, building, characters, labels, camera and post-processing.
// Rendering only: what to show comes from the controller (layout + plans from the director).
// Graphics (low-spec plan §5): `setGraphics` applies every lever; a frame pacer caps or pauses
// the render loop; `stats()` reports GPU memory; WebGL context loss and restore are surfaced.
import { GraphicsAdvancedSchema, STATUS_COLORS, type GraphicsQuality } from '@agent-office/shared'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { directoryFixture, toWorld } from '../../app/building.ts'
import { createPacer } from '../../app/frame-pacer.ts'
import type { Effective, GraphicsStats, HardwareInfo } from '../../app/graphics-types.ts'
import type { ViewEntry } from '../../app/library-types.ts'
import { viewsFor } from '../../app/views.ts'
import { linksForMode, type RenderLink } from '../../app/links.ts'
import { nearestNode } from '../../app/navigation.ts'
import type { Manifest } from '../../app/manifest.ts'
import type { AgentPlan, BuildingLayout, Link, Vec2, Vec3 } from '../../app/office-types.ts'
import { createSimClock, type SimClock } from '../../app/sim-clock.ts'
import { frameAgents, frameSurfaces } from '../../app/framing.ts'
import { projectSurfaces, type ProjectLibraryVM } from '../../app/project-library.ts'
import { effectiveGraphics, resolvePreset, type Preset } from '../../app/quality.ts'
import type { ProviderSurfaces } from '../../app/capability-vm.ts'
import type { CapabilityRef, SceneAssets, SceneSurfaces, SceneView } from '../../ports.ts'
import { AssetStore, LoadingScreen, textureBytes, within, type LoadingElements } from './assets.ts'
import { BuildingView, type ScreenState } from './building-view.ts'
import { anchorBookmark, bookmarksFor, CameraDirector, type Bookmark } from './camera-director.ts'
import { CharacterSystem, loadCharacterAssets } from './characters.ts'
import { isEmptyBox, ndcToClient, pointerToNdc } from './viewport.ts'
import { Labels } from './labels.ts'
import { LinkSystem } from './links.ts'
import { RenderPipeline } from './render-pipeline.ts'

export interface SceneElements {
  stage: HTMLElement
  walkButton: HTMLElement
  fitButton: HTMLElement
  crosshair: HTMLElement
  walkHelp: HTMLElement
  loading: LoadingElements
  /** Unused: the view bar is a DOM adapter fed by `onViews` (kept so older wiring compiles). */
  views?: HTMLElement
  /** Accessible list of wing sign texts (the signs themselves are canvas textures). */
  wingSigns: HTMLElement
  stats: HTMLElement
  /** Accessible list of every capability surface (stations, spines, boards, notebooks): buttons. */
  capabilities: HTMLElement
  /** Accessible list of the links drawn now (`data-link`). */
  links: HTMLElement
}

const ASSET_BASE = 'assets/'
const SHADOW_EXTENT = 22
const SUN_DIR = new THREE.Vector3(-0.45, 1, 0.3).normalize()
const ELEVATOR_OPEN_DIST = 3.2
/** The reception's Project Directory: label text, label height, and the pick proxy (shared). */
const DIRECTORY_LABEL = 'Project Directory'
const DIRECTORY_GEOMETRY = new THREE.BoxGeometry(2.6, 1.8, 1.6)
const DIRECTORY_MATERIAL = new THREE.MeshBasicMaterial({ visible: false })
const TV_ON: ScreenState = { color: '#7fb2ff', intensity: 2 }

/** `?debug=1` is added by the main process only when AGENT_OFFICE_DEBUG=1 (capture scripts). */
const debugEnabled = () => new URLSearchParams(location.search).get('debug') === '1'

type Vec3T = [number, number, number]

export interface SceneOptions {
  /** Renderer `powerPreference`, read once at construction (changing it needs a reload). */
  powerPreference?: Effective['powerPreference']
}

/** Hemisphere fill multiplier when the environment map is off (Minimal): dynamic objects lose IBL. */
const NO_ENV_FILL = 2.4
/** Hover raycasts at most every 100 ms (10 Hz). */
const HOVER_MS = 100
/** GPU memory accounting is cached this long (ms). */
const MEMORY_MS = 2000

/** The effective graphics for a plain preset (the `setQuality` shim and the start-up default). */
const presetGraphics = (preset: Preset): Effective =>
  effectiveGraphics({
    preset,
    advanced: GraphicsAdvancedSchema.parse({}),
    dpr: typeof devicePixelRatio === 'number' ? devicePixelRatio : 1,
    power: { focused: true, hidden: false, onBattery: false },
    saver: { blur: false, hidden: false, battery: 'off' },
  })

const TEXTURE_KEYS = [
  'map',
  'lightMap',
  'aoMap',
  'emissiveMap',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'alphaMap',
  'bumpMap',
  'envMap',
] as const

const THEMES = {
  light: { background: 0xe9edf3, sky: 0xeef3ff, ground: 0x8a7a66, fill: 0.45, environment: 1.1 },
  dark: { background: 0x1b2028, sky: 0xdfe8ff, ground: 0x6b5a48, fill: 0.35, environment: 1.0 },
} as const

export class ThreeScene implements SceneView {
  private renderer: THREE.WebGLRenderer
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
  private gfx: Effective = presetGraphics('high')
  private pacer = createPacer()
  private looping = false
  private lastFrame = -1
  private frameCount = 0
  private envMap: THREE.Texture | null = null
  private fillBase = 0.35
  private lastLinks: Link[] = []
  /** The bookmark the camera flew to last (view-bar highlight, debug `bookmark()`). */
  private current: string | null = null
  private viewsFn: ((views: ViewEntry[]) => void) | null = null
  private hoverFn: (ref: CapabilityRef | null, x: number, y: number) => void = () => {}
  private hovered: string | null = null
  private lostFn: () => void = () => {}
  private restoredFn: () => void = () => {}
  private memory = { at: -Infinity, textureMB: 0, geometryMB: 0 }
  private sun = new THREE.DirectionalLight(0xfff4e6, 1.6)
  private catcher = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShadowMaterial({ opacity: 0.3, depthWrite: false }),
  )
  private fill = new THREE.HemisphereLight(0xdfe8ff, 0x6b5a48, 0.35)
  private background = new THREE.Color(0x1b2028)
  private selected: string | null = null
  private pickFn: (id: string | null) => void = () => {}
  private pickCapFn: (ref: CapabilityRef) => void = () => {}
  private pickFixtureFn: (f: { kind: 'project-directory' }) => void = () => {}
  /** Project focus (agents shown at full strength) and the selected project's Library. */
  private focusSet: ReadonlySet<string> | null = null
  private baseSurfaces: Map<string, ProviderSurfaces> | null = null
  private projectLibrary: ProjectLibraryVM | null = null
  /** Invisible pick proxy at the reception desk (the Project Directory). */
  private directoryProxy: THREE.Mesh | null = null
  private bubbles = new Map<string, string>()
  private focusRef: CapabilityRef | null = null
  private highlighted: string | null = null
  private links = new LinkSystem()
  private statsFn: (fps: number, preset: Preset) => void = () => {}
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private framed = false
  private lastWing: string | null = null
  private focus = new THREE.Vector3()
  private openBanks = new Set<string>()
  private debug = debugEnabled()
  /** Removes the window, document and persistent-DOM listeners (`dispose`). */
  private teardown: (() => void)[] = []
  private disposed = false
  private debugApi: object | null = null

  constructor(
    private el: SceneElements,
    /** Simulation time shared with the controller's director (debug `timeScale` speeds both up). */
    private clock: SimClock = createSimClock(),
    opts: SceneOptions = {},
  ) {
    // Throws when WebGL can't start; the composition root shows the failure card (§2.4).
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: opts.powerPreference ?? 'high-performance',
    })
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    el.stage.append(this.renderer.domElement)
    this.pipeline = new RenderPipeline(this.renderer, this.scene, this.camera)
    this.labels = new Labels(el.stage, (id) => this.pickFn(id))
    this.cam = new CameraDirector(this.camera, this.renderer.domElement)
    this.loading = new LoadingScreen(el.loading)
    this.store.manager.onProgress = (_url, loaded, total) =>
      this.loading.progress(total ? loaded / total : 0)

    this.scene.background = this.background
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
    this.scene.add(this.sun, this.sun.target, this.fill, this.catcher, this.links.group)
    this.links.onChange = (links) => this.renderLinkList(links)

    this.applyGraphics(this.gfx)
    this.listen(window, 'resize', () => this.resize())
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.resize())
      ro.observe(el.stage)
      this.teardown.push(() => ro.disconnect())
    }
    this.resize()
    this.bindInput()
    this.bindContext()
    // Hidden window: the loop may be paused (fpsLimit 0); coming back re-arms it at once.
    this.listen(document, 'visibilitychange', () => this.arm())
    if (this.debug) this.installDebug()
    this.arm()
  }

  /** Adds a listener that `dispose` removes (targets that outlive the scene). */
  private listen<K extends keyof (WindowEventMap & DocumentEventMap)>(
    target: Window | Document | HTMLElement,
    type: K,
    fn: (e: (WindowEventMap & DocumentEventMap)[K]) => void,
  ): void {
    const h = fn as EventListener
    target.addEventListener(type, h)
    this.teardown.push(() => target.removeEventListener(type, h))
  }

  /**
   * Releases everything (2D RPG plan §11): stops the loop, removes listeners, disposes the
   * building, characters, links and pipeline, the labels' DOM, the WebGL context and the canvas.
   * Only called when the scene host switches view modes; the scene is unusable afterwards.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.renderer.setAnimationLoop(null)
    this.looping = false
    for (const off of this.teardown.splice(0)) off()
    if (this.cam.mode === 'walk') this.cam.exitWalk()
    this.cam.onModeChange = () => {}
    this.cam.dispose()
    this.el.crosshair.hidden = true
    this.el.walkHelp.hidden = true
    this.el.walkButton.textContent = '🚶 Walk'
    this.links.setMode('off')
    this.scene.remove(this.links.group)
    this.characters?.dispose()
    this.characters = null
    if (this.building) {
      this.scene.remove(this.building.group)
      this.building.dispose()
      this.building = null
    }
    this.pipeline.dispose()
    this.envMap?.dispose()
    this.envMap = null
    this.setDirectoryProxy(null)
    this.labels.renderer.domElement.remove()
    // Accessible lists hold buttons bound to this scene: clear them (and their render keys).
    for (const list of [this.el.capabilities, this.el.links]) {
      list.replaceChildren()
      list.dataset.key = ''
    }
    this.el.stage.dataset.focus = ''
    // Our own context loss must not reach the controller ("Recovering graphics…").
    this.lostFn = () => {}
    this.restoredFn = () => {}
    this.statsFn = () => {}
    if (this.debug) {
      this.el.stats.hidden = true
      this.el.stats.textContent = ''
    }
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
    const w = window as unknown as { __aoDebug?: unknown }
    if (this.debugApi && w.__aoDebug === this.debugApi) delete w.__aoDebug
  }

  /** The frame limit in force. The controller already combines page and window visibility. */
  private limit(): number | null {
    return this.gfx.fpsLimit
  }

  /** Starts or stops `setAnimationLoop` to match the limit (0 = paused: no rAF at all). */
  private arm(): void {
    const run = this.limit() !== 0
    if (run === this.looping) return
    this.looping = run
    if (!run) return this.renderer.setAnimationLoop(null)
    this.pacer.reset()
    this.renderer.setAnimationLoop((t) => this.tick(t))
  }

  /**
   * One animation frame: the pacer decides whether to render; skipped frames do nothing, so the
   * next rendered frame advances mixers by the accumulated time (capped at 0.5 s).
   */
  private tick(t: number): void {
    if (this.disposed) return
    if (isEmptyBox(this.box())) return // stage hidden (user left the Office)
    if (!this.pacer.shouldRender(t, this.limit())) return
    const dt = this.lastFrame < 0 ? 0 : Math.min(0.5, (t - this.lastFrame) / 1000)
    this.lastFrame = t
    this.frameCount++
    this.frame(dt)
  }

  /** GPU driver reset: three re-uploads buffers and textures; render-target content is rebuilt. */
  private bindContext(): void {
    const canvas = this.renderer.domElement
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault() // allow a restore
      this.lostFn()
    })
    canvas.addEventListener('webglcontextrestored', () => {
      // The PMREM environment lives in a render target: regenerate it.
      if (this.manifest)
        void this.loadEnvironment(this.manifest).then((env) => {
          this.envMap = env
          this.applyEnv()
        })
      this.sun.shadow.map?.dispose()
      this.sun.shadow.map = null
      this.resize()
      this.memory.at = -Infinity
      this.restoredFn()
    })
  }

  private loadEnvironment(manifest: Manifest): Promise<THREE.Texture> {
    return this.store.environment(manifest.hdri, this.renderer).catch(() => {
      const pmrem = new THREE.PMREMGenerator(this.renderer)
      const t = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
      pmrem.dispose()
      return t
    })
  }

  async load(manifestUrl: string): Promise<SceneAssets> {
    try {
      this.loading.progress(0.02, 'Loading the floor plan…')
      const manifest = await this.store.manifest(manifestUrl)
      this.manifest = manifest
      this.building = new BuildingView(this.store, manifest)
      this.building.onChange = () => {
        this.updateSurfaces()
        this.updateBookmarks()
      }
      this.applyBuildingDetail()
      this.scene.add(this.building.group)
      this.loading.progress(0.08, 'Loading the atrium…')
      const env = this.loadEnvironment(manifest)
      const [character, envMap] = await Promise.all([
        // Without the character the building still renders (tags stay hidden); say why once.
        within(loadCharacterAssets(ASSET_BASE, this.store.gltf), 30_000, 'character.glb').catch(
          (err: Error) => {
            console.warn(`agent-office: character assets unavailable (${err.message})`)
            return null
          },
        ),
        env,
        // Atrium first: it's where the camera starts. Street/cap come along; wings stream in later.
        this.building.preload(['atrium', 'street', 'cap', 'garden']),
      ])
      this.envMap = envMap
      this.applyEnv()
      if (character) {
        this.characters = new CharacterSystem(this.scene, character, {
          quality: this.gfx.preset,
          renderer: this.renderer,
        })
        this.applyCharacterDetail()
      }
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
    this.cam.setBounds(b)
    this.catcher.scale.set(b.maxX - b.minX + 4, b.maxZ - b.minZ + 4, 1)
    this.catcher.position.set((b.minX + b.maxX) / 2, 0.004, (b.minZ + b.maxZ) / 2)
    this.updateBookmarks()
    this.renderSigns(layout)
    this.updateSurfaces()
    this.placeDirectory(layout)
  }

  /** The Project Directory: a pick proxy and a "Project Directory" label at the kiosk (else reception). */
  private placeDirectory(layout: BuildingLayout): void {
    const f = directoryFixture(layout.anchors.values())
    if (!f) {
      this.setDirectoryProxy(null)
      this.labels.setFixture('project-directory', DIRECTORY_LABEL, null, () => {})
      return
    }
    this.setDirectoryProxy(new THREE.Vector3(f.x, f.proxyY, f.z))
    this.labels.setFixture(
      'project-directory',
      DIRECTORY_LABEL,
      new THREE.Vector3(f.x, f.labelY, f.z),
      () => this.pickFixtureFn({ kind: 'project-directory' }),
    )
  }

  private setDirectoryProxy(at: THREE.Vector3 | null): void {
    if (!at) {
      if (this.directoryProxy) this.scene.remove(this.directoryProxy)
      this.directoryProxy = null
      return
    }
    if (!this.directoryProxy) {
      // Shared invisible material (raycasts ignore `visible`, like the agent hit boxes).
      this.directoryProxy = new THREE.Mesh(DIRECTORY_GEOMETRY, DIRECTORY_MATERIAL)
      this.directoryProxy.name = 'project-directory'
      this.directoryProxy.userData.fixture = 'project-directory'
      this.scene.add(this.directoryProxy)
    }
    this.directoryProxy.position.copy(at)
    this.directoryProxy.updateMatrixWorld()
  }

  onPickFixture(fn: (f: { kind: 'project-directory' }) => void): void {
    this.pickFixtureFn = fn
  }

  /** Dim everyone outside the project (tags too) and bring the group into view. */
  focusAgents(ids: string[] | null, o: { dim: boolean; frame: boolean }): void {
    this.focusSet = ids && o.dim ? new Set(ids) : null
    this.characters?.setFocus(this.focusSet)
    this.labels.setFocus(this.focusSet)
    this.el.stage.dataset.projectFocus = ids ? String(ids.length) : ''
    if (!ids || !o.frame || !this.characters) return
    const positions: Vec2[] = []
    for (const id of ids) {
      const p = this.characters.positionOf(id)
      if (p) positions.push({ x: p.x, z: p.z })
    }
    const pose = frameAgents({ positions, fovDeg: this.camera.fov, aspect: this.camera.aspect })
    if (!pose) return
    if (this.selected) this.pickFn(null)
    this.focusRef = null
    this.el.stage.dataset.focus = ''
    this.current = null
    this.cam.flyTo({
      target: new THREE.Vector3(pose.target.x, pose.target.y, pose.target.z),
      position: new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z),
    })
    this.emitViews()
  }

  /** The selected project's collections replace the provider's notebooks, shelves and boards. */
  setProjectLibrary(vm: ProjectLibraryVM | null): void {
    this.projectLibrary = vm
    if (this.baseSurfaces) this.applySurfaces()
  }

  private applySurfaces(): void {
    const base = this.baseSurfaces!
    const byProvider = this.projectLibrary ? projectSurfaces(base, this.projectLibrary) : base
    this.building?.setSurfaces(byProvider)
    this.renderCapabilityList(byProvider)
  }

  direct(plans: Map<string, AgentPlan>, departed: string[]): void {
    const now = this.clock.now()
    for (const id of departed) this.drop(id)
    for (const id of this.plans.keys()) if (!plans.has(id)) this.drop(id)
    this.plans = plans
    if (!this.framed) this.frameStart(plans)
    for (const [id, plan] of plans) {
      this.characters?.upsert(plan, now)
      this.labels.upsert(plan.agent, plan.intent.activity, this.bubbles.get(id))
      if (this.focusSet) this.characters?.setFocus(this.focusSet)
      const local = plan.intent.target.slice(plan.intent.target.lastIndexOf('/') + 1)
      if (local.startsWith('seat:desk:')) this.desks.set(id, plan.intent.target)
    }
    this.updateSurfaces()
  }

  setLinks(links: Link[]): void {
    this.lastLinks = links
    this.links.set(linksForMode(links, this.gfx.links), this.camera, this.selected)
  }

  setSurfaces(s: SceneSurfaces): void {
    this.bubbles = s.bubbles
    for (const [id, plan] of this.plans)
      this.labels.upsert(plan.agent, plan.intent.activity, s.bubbles.get(id))
    this.baseSurfaces = s.byProvider
    this.applySurfaces()
  }

  onPickCapability(fn: (ref: CapabilityRef) => void): void {
    this.pickCapFn = fn
  }

  /**
   * Close-up of the capability's surface (the one nearest the current view): head-on from inside
   * its room, 0.9–2.2 m away so its text is readable (low-spec plan §B3).
   */
  focusCapability(ref: CapabilityRef | null): void {
    this.el.stage.dataset.focus = ref ? `${ref.provider} ${ref.id}` : ''
    if (!ref) {
      if (this.focusRef) this.cam.focusOn(null)
      this.focusRef = null
      return
    }
    const pose = this.closeUp(ref)
    if (!pose) return
    this.focusRef = ref
    if (this.selected) this.pickFn(null)
    this.current = null
    this.cam.flyTo({ ...pose, closeUp: true })
    this.emitViews()
  }

  /** Camera pose facing one surface of `ref` (nearest the current view), or null. */
  private closeUp(ref: CapabilityRef): { position: THREE.Vector3; target: THREE.Vector3 } | null {
    if (!this.building || !this.layout) return null
    const here = this.cam.orbit.target
    const spot = this.building
      .surfaceSpots(ref)
      .sort((a, b) => a.pos.distanceTo(here) - b.pos.distanceTo(here))[0]
    const placement = spot && this.layout.placements.find((p) => p.id === spot.placement)
    if (!spot || !placement) return null
    // Inside the room: reading seats and shelf spots (Library), station spots (Adapters).
    const re = spot.role === 'station' ? /^spot:station:/ : /^(seat:reading|spot:shelf):/
    const spots = [...this.layout.anchors.values()].filter(
      (a) => a.placement === placement.id && re.test(a.local),
    )
    const inside = spots.length
      ? spots.reduce(
          (s, a) => ({ x: s.x + a.pos.x / spots.length, z: s.z + a.pos.z / spots.length }),
          {
            x: 0,
            z: 0,
          },
        )
      : toWorld({ x: 0, z: 0 }, placement)
    // Face the surface square-on: snap the direction into the room to the module's nearest axis.
    const c = Math.cos(placement.yaw)
    const sn = Math.sin(placement.yaw)
    const dx = inside.x - spot.pos.x
    const dz = inside.z - spot.pos.z
    const lx = dx * c - dz * sn // world → module axes (inverse of toWorld's rotation)
    const lz = dx * sn + dz * c
    const [ax, az] =
      Math.abs(lx) >= Math.abs(lz) ? [Math.sign(lx) || 1, 0] : [0, Math.sign(lz) || 1]
    const fx = ax * c + az * sn
    const fz = -ax * sn + az * c
    // The surface's extent (extras width × height) across the view, so a whole board fits.
    const hw = spot.width / 2
    const hh = spot.height / 2
    const p = spot.pos
    const corners: Vec3[] = [
      { x: p.x - fz * hw, y: p.y - hh, z: p.z + fx * hw },
      { x: p.x + fz * hw, y: p.y + hh, z: p.z - fx * hw },
    ]
    const at: Vec2 = { x: p.x + fx, z: p.z + fz }
    const f = frameSurfaces({
      surfaces: corners,
      inside: at,
      fovDeg: this.camera.fov,
      aspect: this.camera.aspect,
      minDist: 0.9,
      maxDist: 2.2,
      eyeHeight: p.y + 0.12,
    })
    return {
      position: new THREE.Vector3(f.position.x, f.position.y, f.position.z),
      target: new THREE.Vector3(f.target.x, f.target.y, f.target.z),
    }
  }

  highlightLinks(capabilityId: string | null): void {
    this.highlighted = capabilityId
    this.links.highlight(capabilityId)
    this.el.links.dataset.key = '' // re-render the list's highlight flags
  }

  /** Buttons for every filled surface: keyboard/screen-reader access and stable E2E hooks. */
  private renderCapabilityList(byProvider: Map<string, ProviderSurfaces>): void {
    const items: { provider: string; id: string; kind: string; label: string }[] = []
    for (const [provider, p] of byProvider) {
      const add = (kind: string, slots: ({ id: string; vm: { title: string } } | undefined)[]) => {
        for (const slot of slots)
          if (slot && slot.id !== '+more')
            items.push({ provider, id: slot.id, kind, label: slot.vm.title })
      }
      add('station', p.stations)
      add('book', p.books)
      add('board', p.boards)
      add('notebook', p.notebooks)
    }
    const key = items.map((i) => `${i.provider}|${i.kind}|${i.id}|${i.label}`).join('\n')
    if (this.el.capabilities.dataset.key === key) return
    this.el.capabilities.dataset.key = key
    this.el.capabilities.replaceChildren(
      ...items.map((i) => {
        const li = document.createElement('li')
        const b = document.createElement('button')
        b.type = 'button'
        b.textContent = i.label
        b.dataset.provider = i.provider
        b.dataset.capabilityId = i.id
        b.dataset.surface = i.kind
        b.addEventListener('click', () => this.pickCapFn({ provider: i.provider, id: i.id }))
        li.append(b)
        return li
      }),
    )
  }

  private renderLinkList(links: RenderLink[]): void {
    const key = `${this.highlighted}|${links.map((l) => l.id).join('|')}`
    if (this.el.links.dataset.key === key) return
    this.el.links.dataset.key = key
    const spans = new Map(this.links.debug().map((d) => [d.id, d.visible ? d.radius : 0]))
    this.el.links.replaceChildren(
      ...links.map((l) => {
        const li = document.createElement('li')
        li.dataset.link = l.id
        li.dataset.agentId = l.agentId
        li.dataset.capabilityId = l.capabilityId
        li.dataset.style = l.style
        // Drawn extent (m) of the link's geometry: E2E guards against collapsed/invisible links.
        li.dataset.span = (2 * (spans.get(l.id) ?? 0)).toFixed(1)
        if (this.highlighted) li.dataset.highlighted = String(l.capabilityId === this.highlighted)
        li.textContent = `${l.label} (${l.state})`
        return li
      }),
    )
  }

  /** First view: the wing where most agents work (their tags readable), else the atrium. */
  private frameStart(plans: Map<string, AgentPlan>): void {
    if (!this.layout) return
    this.framed = true
    const count = new Map<string, number>()
    for (const p of plans.values()) {
      const placement = this.layout.anchors.get(p.intent.target)?.placement
      if (placement?.startsWith('wing:')) count.set(placement, (count.get(placement) ?? 0) + 1)
    }
    const busiest = [...count].sort((a, b) => b[1] - a[1])[0]?.[0]
    const start =
      this.bookmarks.find((b) => b.id === busiest) ??
      this.bookmarks.find((b) => b.id === 'atrium') ??
      this.bookmarks[0]
    if (!start) return
    if (start.id.startsWith('wing:')) this.lastWing = start.id
    this.cam.jumpTo(start)
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
        intensity: status === 'idle' || status === 'done' ? 0.5 : 2.4,
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

  /** Plan §2.6: background, hemisphere fill and environment strength per theme (in-place, live). */
  setTheme(theme: 'light' | 'dark'): void {
    const t = THEMES[theme] ?? THEMES.dark
    this.background.setHex(t.background)
    this.fill.color.setHex(t.sky)
    this.fill.groundColor.setHex(t.ground)
    this.fillBase = t.fill
    this.scene.environmentIntensity = t.environment
    this.applyEnv()
  }

  /**
   * Legacy shim (one release): a preset with no overrides (Auto → High). The controller now owns
   * Auto (its governor samples `stats().fps`) and calls `setGraphics`.
   */
  setQuality(q: GraphicsQuality): void {
    this.applyGraphics(presetGraphics(resolvePreset(q, 'high')))
  }

  /** Applies every graphics lever live (low-spec plan §5.3); `e.preset` is already resolved. */
  setGraphics(e: Effective): void {
    this.applyGraphics(e)
  }

  private applyGraphics(e: Effective): void {
    this.gfx = e
    this.pipeline.setGraphics(e)
    // Sun shadows only on Full; the catcher plane only exists to receive them.
    const size = e.shadows === 'full' ? e.shadowMap : 0
    this.sun.castShadow = size > 0
    this.catcher.visible = size > 0
    if (size && this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size)
      this.sun.shadow.map?.dispose()
      this.sun.shadow.map = null
    }
    this.applyCharacterDetail()
    this.labels.setMode(e.labels.mode, e.labels.nearbyM)
    this.links.setMode(e.links)
    this.setLinks(this.lastLinks)
    this.applyBuildingDetail()
    this.applyEnv()
    if (!e.hover) this.hover(null, 0, 0)
    this.memory.at = -Infinity
    this.arm()
  }

  private applyCharacterDetail(): void {
    const e = this.gfx
    this.characters?.setDetail({
      lod: e.lod,
      maxAnimated: e.maxAnimated,
      shadows: e.shadows,
      impostorAtFar: e.preset === 'minimal',
    })
  }

  private applyBuildingDetail(): void {
    const e = this.gfx
    this.building?.setDetail({
      detailCullM: e.detailCullM,
      lightmapTier: e.lightmapTier,
      lowCanvas: e.preset === 'low' || e.preset === 'minimal',
    })
  }

  /** Environment map on/off; without it the hemisphere fill is raised to keep characters lit. */
  private applyEnv(): void {
    this.scene.environment = this.gfx.envMap ? this.envMap : null
    this.fill.intensity = this.fillBase * (this.gfx.envMap ? 1 : NO_ENV_FILL)
  }

  /** Live numbers for Settings → Graphics; GPU memory is re-counted at most every 2 s. */
  stats(): GraphicsStats {
    const now = performance.now()
    if (now - this.memory.at > MEMORY_MS) this.countMemory(now)
    const st = this.pipeline.stats
    const size = this.pipeline.bufferSize()
    return {
      fps: Math.round(st.fps),
      drawCalls: st.drawCalls,
      triangles: st.triangles,
      textureMB: Math.round(this.memory.textureMB),
      geometryMB: Math.round(this.memory.geometryMB * 10) / 10,
      width: size.width,
      height: size.height,
    }
  }

  /**
   * GPU memory estimate (low-spec plan §5.5): unique textures in the scene (shared sources once),
   * canvas surfaces, the environment, the shadow map and post-processing targets; geometry
   * buffers by byte length.
   */
  private countMemory(now: number): void {
    const sources = new Map<unknown, number>()
    const addTex = (t: THREE.Texture | null | undefined) => {
      if (t && !sources.has(t.source)) sources.set(t.source, textureBytes(t))
    }
    const geos = new Set<THREE.BufferGeometry>()
    let geoBytes = 0
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry && !geos.has(m.geometry)) {
        geos.add(m.geometry)
        for (const a of Object.values(m.geometry.attributes))
          geoBytes += (a as THREE.BufferAttribute).array?.byteLength ?? 0
        geoBytes += m.geometry.index?.array.byteLength ?? 0
      }
      const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : []
      for (const mat of mats) {
        const rec = mat as unknown as Record<string, unknown>
        for (const k of TEXTURE_KEYS) addTex(rec[k] as THREE.Texture | undefined)
        const uniforms = (mat as THREE.ShaderMaterial).uniforms
        if (uniforms)
          for (const u of Object.values(uniforms))
            if ((u?.value as THREE.Texture)?.isTexture) addTex(u.value as THREE.Texture)
      }
    })
    for (const t of this.building?.canvasTextures() ?? []) addTex(t)
    let bytes = [...sources.values()].reduce((a, b) => a + b, 0)
    const env = this.scene.environment as THREE.Texture | null
    // PMREM: a half-float CubeUV atlas (~3 × size² texels for a 256 face).
    if (env) bytes += 768 * 1024 * 8
    if (this.sun.castShadow) bytes += this.sun.shadow.mapSize.x ** 2 * 4
    bytes += this.pipeline.targetBytes()
    this.memory = { at: now, textureMB: bytes / 2 ** 20, geometryMB: geoBytes / 2 ** 20 }
  }

  /** What the controller needs to pick the hardware tier (low-spec plan §5.1); null if unreadable. */
  hardwareInfo(): HardwareInfo | null {
    try {
      return this.readHardware()
    } catch {
      return null
    }
  }

  private readHardware(): HardwareInfo {
    const gl = this.renderer.getContext()
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    const nav = navigator as Navigator & { deviceMemory?: number }
    return {
      renderer: str(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
      vendor: str(gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
      maxTextureSize: this.renderer.capabilities.maxTextureSize,
      dpr: devicePixelRatio,
      cores: nav.hardwareConcurrency ?? 4,
      ...(typeof nav.deviceMemory === 'number' ? { memoryGB: nav.deviceMemory } : {}),
      webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
    }
  }

  onContextLost(fn: () => void): void {
    this.lostFn = fn
  }

  onContextRestored(fn: () => void): void {
    this.restoredFn = fn
  }

  onHoverSurface(fn: (ref: CapabilityRef | null, x: number, y: number) => void): void {
    this.hoverFn = fn
  }

  onViews(fn: (views: ViewEntry[]) => void): void {
    this.viewsFn = fn
    this.emitViews()
  }

  /** Frame-rate samples (~2 Hz) for the Settings readout. Adapter-level, wired in main.ts. */
  onFrameStats(fn: (fps: number, preset: Preset) => void): void {
    this.statsFn = fn
  }

  onPick(fn: (id: string | null) => void): void {
    this.pickFn = fn
  }

  /** Same path as the view buttons, but not a user input (the controller flies to new wings). */
  goTo(viewId: string): void {
    this.flyTo(viewId)
  }

  cameraIdleMs(): number {
    return this.cam.idleMs()
  }

  select(id: string | null): void {
    this.selected = id
    if (id) {
      // Following an agent replaces following a capability.
      this.focusRef = null
      this.el.stage.dataset.focus = ''
    }
    this.labels.select(id)
    const chars = this.characters
    if (!id || !chars) return this.cam.focusOn(null)
    this.cam.focusOn(() => chars.positionOf(id))
  }

  /** `rawDt`: real seconds since the last rendered frame (accumulated over skipped ones, ≤ 0.5). */
  private frame(rawDt: number): void {
    const dt = Math.min(rawDt, 0.1)
    // Characters and doors run on simulation time; the camera stays on real time.
    const simDt = Math.min(rawDt * this.clock.scale, 0.5)
    const now = this.clock.now()
    const colliders = this.building?.colliders() ?? []
    this.cam.update(dt, colliders)
    this.camera.updateMatrixWorld()
    if (this.characters) this.characters.update(simDt, this.camera, now)
    if (this.building) {
      this.updateDoors()
      this.building.update(simDt, this.camera, this.openBanks)
    }
    this.links.update(simDt)
    this.followShadow()
    const sample = this.pipeline.render(rawDt)
    this.labels.update(this.camera, (id) => this.characters?.headOf(id), colliders, now)
    if (sample) this.onSample(sample)
  }

  private onSample(s: { fps: number }): void {
    this.statsFn(s.fps, this.gfx.preset)
    if (!this.el.stats.hidden) {
      const st = this.pipeline.stats
      this.el.stats.textContent = `${st.fps.toFixed(0)} fps · ${st.drawCalls} calls · ${(st.triangles / 1000).toFixed(0)}k tris · ${this.gfx.preset}`
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

  /** Recomputes the bookmarks (layout, loaded wing surfaces, aspect) and re-emits the views. */
  private updateBookmarks(): void {
    if (!this.layout || !this.manifest) return
    this.bookmarks = bookmarksFor(this.layout, this.manifest, this.building?.wingSurfaces(), {
      fovDeg: this.camera.fov,
      aspect: this.camera.aspect,
    })
    this.emitViews()
  }

  /**
   * The view bar's entries (the DOM adapter renders them): atrium, Main Street, wings, then
   * Adapters and Library per provider (first wing; grouped into menus), then the overview.
   */
  private emitViews(): void {
    if (!this.viewsFn || !this.layout) return
    // Shared with the 2D scene (app/views.ts); the 3D framing stays per id in the bookmarks.
    this.viewsFn(
      viewsFor(this.layout, {
        available: new Set(this.bookmarks.map((b) => b.id)),
        current: this.current,
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
    // Plain 'adapters'/'library': the rooms of the wing you looked at last (the first until then).
    if (id === 'adapters' || id === 'library') {
      const wing = this.lastWing ?? this.bookmarks.find((x) => x.id.startsWith('wing:'))?.id
      id = `${id}:${wing?.slice('wing:'.length) ?? ''}`
    }
    if (id.startsWith('wing:')) this.lastWing = id
    const b = this.bookmarks.find((x) => x.id === id)
    if (!b) return false
    if (this.selected) this.pickFn(null)
    this.focusRef = null
    this.el.stage.dataset.focus = ''
    this.current = b.id
    this.cam.flyTo(b)
    this.emitViews()
    return true
  }

  /** The stage's box (the canvas fills it). Empty while the stage is hidden. */
  private box(): DOMRect {
    return this.el.stage.getBoundingClientRect()
  }

  private resize(): void {
    const r = this.box()
    // Hidden or collapsed stage: keep the last size; the observer re-measures when it shows again.
    if (isEmptyBox(r)) return
    this.pipeline.resize(r.width, r.height)
    this.labels.setSize(r.width, r.height)
    this.camera.aspect = r.width / r.height
    this.camera.updateProjectionMatrix()
    // Framed bookmarks depend on the aspect ratio.
    this.updateBookmarks()
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

  /** Click: an agent first, then a capability surface, else empty space (deselect). */
  private pickAt(x: number, y: number): void {
    const id = this.pick(x, y)
    if (id) return this.pickFn(id)
    if (this.directoryProxy && this.raycaster.intersectObject(this.directoryProxy, false).length)
      return this.pickFixtureFn({ kind: 'project-directory' })
    const ref = this.pickSurface()
    if (ref) this.pickCapFn(ref)
    else this.pickFn(null)
  }

  /** Raycast (after `pick` set the ray) against filled capability surfaces. */
  private pickSurface(): CapabilityRef | null {
    if (!this.building) return null
    const hits = this.raycaster.intersectObjects(this.building.pickables(), true)
    for (const h of hits)
      for (let o: THREE.Object3D | null = h.object; o; o = o.parent)
        if (o.userData.capability) return o.userData.capability as CapabilityRef
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

  /** Reports the hovered surface (or null) and sets the pointer cursor over one. */
  private hover(ref: CapabilityRef | null, x: number, y: number): void {
    const key = ref ? `${ref.provider}|${ref.id}` : null
    if (!key && !this.hovered) return
    this.hovered = key
    this.renderer.domElement.style.cursor = ref ? 'pointer' : ''
    this.hoverFn(ref, x, y)
  }

  /** Surface under the pointer (orbit mode only, surfaces only), for the hover tooltip. */
  private hoverAt(x: number, y: number): void {
    if (!this.gfx.hover || this.cam.mode !== 'orbit' || !this.building)
      return this.hover(null, x, y)
    const n = pointerToNdc(this.box(), x, y)
    this.pointer.set(n.x, n.y)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    this.hover(this.pickSurface(), x, y)
  }

  private bindInput(): void {
    const canvas = this.renderer.domElement
    let downAt: [number, number] | null = null
    // Hover: at most 10 Hz, never while dragging; the last position is sampled on the next slot.
    let lastHover = -Infinity
    let pending: [number, number] | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const sample = () => {
      timer = undefined
      if (!pending) return
      lastHover = performance.now()
      const [x, y] = pending
      pending = null
      this.hoverAt(x, y)
    }
    canvas.addEventListener('pointermove', (e) => {
      if (e.buttons !== 0 || !this.gfx.hover) return this.hover(null, e.clientX, e.clientY)
      pending = [e.clientX, e.clientY]
      const wait = HOVER_MS - (performance.now() - lastHover)
      if (wait <= 0) sample()
      else timer ??= setTimeout(sample, wait)
    })
    canvas.addEventListener('pointerleave', () => {
      pending = null
      this.hover(null, 0, 0)
    })
    canvas.addEventListener('pointerdown', (e) => {
      downAt = [e.clientX, e.clientY]
      this.hover(null, e.clientX, e.clientY)
    })
    canvas.addEventListener('pointerup', (e) => {
      if (!downAt || this.cam.mode !== 'orbit') return
      const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1])
      downAt = null
      if (moved > 5) return // it was a drag
      const n = pointerToNdc(this.box(), e.clientX, e.clientY)
      this.pickAt(n.x, n.y)
    })
    this.listen(this.el.walkButton, 'click', () => {
      this.cam.markInput()
      this.current = null
      this.cam.enterWalk(this.walkStart())
    })
    this.listen(this.el.fitButton, 'click', () => {
      this.cam.markInput()
      this.flyTo('overview')
    })
    this.cam.onModeChange = (mode) => {
      if (mode === 'walk') this.hover(null, 0, 0)
      this.el.crosshair.hidden = mode !== 'walk'
      this.el.walkHelp.hidden = mode !== 'walk'
      this.el.walkButton.textContent = mode === 'walk' ? '🎥 Orbit' : '🚶 Walk'
      this.building?.setCeilingsVisible(mode === 'walk')
    }
    this.listen(window, 'keydown', (e) => {
      const t = e.target
      if (
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLInputElement ||
        t instanceof HTMLSelectElement
      )
        return
      if (e.code === 'KeyF' && this.cam.mode === 'orbit') this.cam.enterWalk(this.walkStart())
      if (e.code === 'KeyE' && this.cam.mode === 'walk') {
        // Crosshair at screen center: an agent, else a station/spine/board/notebook.
        const id = this.pick(0, 0)
        if (id) this.pickFn(id)
        else {
          const ref = this.pickSurface()
          if (ref) this.pickCapFn(ref)
        }
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
      look: (pos: Vec3T, target: Vec3T) =>
        this.cam.jumpTo({
          position: new THREE.Vector3(...pos),
          target: new THREE.Vector3(...target),
        }),
      /**
       * With an id, jumps there (overview, atrium, street, wing:<provider>:<annex>, adapters:…,
       * adapters-door:…, library:…, library-rules:…). Without, the bookmark flown to last.
       */
      bookmark: (id?: string) => (id === undefined ? this.current : api.view(id)),
      /** Capability close-up without the panel (capture scripts). */
      closeUp: (ref: CapabilityRef) => this.focusCapability(ref),
      /** The effective graphics applied now. */
      graphics: () => this.gfx,
      /** Frames rendered since start (the frame pacer's output; graphics.spec G3). */
      frames: () => this.frameCount,
      /** Camera distance (m) to the nearest surface of a capability, or null. */
      cameraDistanceTo: (ref: CapabilityRef) => {
        const d = (this.building?.surfacesOf(ref) ?? []).map((p) =>
          p.distanceTo(this.camera.position),
        )
        return d.length ? Math.min(...d) : null
      },
      /** A capability surface's centre in CSS px (for hover specs), or null when off screen. */
      surfaceScreenPos: (ref: CapabilityRef) => {
        const p = (this.building?.surfacesOf(ref) ?? []).sort(
          (a, b) => a.distanceTo(this.camera.position) - b.distanceTo(this.camera.position),
        )[0]
        if (!p) return null
        const v = p.clone().project(this.camera)
        if (v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null
        return ndcToClient(this.box(), v.x, v.y)
      },
      hardware: () => this.hardwareInfo(),
      gpu: () => this.stats(),
      /** Debug: where the texture estimate goes (mesh textures by kind, canvases, targets). */
      gpuBreakdown: () => {
        const seen = new Map<
          unknown,
          { name: string; w: number; h: number; mb: number; hash?: string }
        >()
        this.scene.traverse((o) => {
          const m = o as THREE.Mesh
          const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : []
          for (const mat of mats) {
            const rec = mat as unknown as Record<string, unknown>
            for (const k of TEXTURE_KEYS) {
              const t = rec[k] as THREE.Texture | undefined
              if (!t || seen.has(t.source)) continue
              const img = t.source.data as { width?: number; height?: number } | null
              seen.set(t.source, {
                name: `${k}:${t.name || '?'}`,
                w: img?.width ?? 0,
                h: img?.height ?? 0,
                mb: textureBytes(t) / 2 ** 20,
                ...(t.userData?.hash ? { hash: String(t.userData.hash) } : {}),
              })
            }
          }
        })
        const list = [...seen.values()]
        const canvas = (this.building?.canvasTextures() ?? []).reduce(
          (a, t) => a + textureBytes(t),
          0,
        )
        return {
          meshTextures: list.length,
          withHash: list.filter((t) => t.hash).length,
          meshMB: list.reduce((a, t) => a + t.mb, 0),
          byKind: Object.entries(
            list.reduce<Record<string, number>>((acc, t) => {
              const k = t.name.split(':')[0]!
              acc[k] = (acc[k] ?? 0) + t.mb
              return acc
            }, {}),
          ),
          canvasMB: canvas / 2 ** 20,
          targetsMB: this.pipeline.targetBytes() / 2 ** 20,
          top: list.sort((a, b) => b.mb - a.mb).slice(0, 12),
        }
      },
      orbitTo: (pos: Vec3T, target: Vec3T, ms = 800) =>
        this.cam.flyTo(
          { position: new THREE.Vector3(...pos), target: new THREE.Vector3(...target) },
          ms / 1000,
        ),
      focus: (agentId: string) => this.pickFn(agentId),
      /** Orbit target and the agent the camera follows (orbit-keys.spec). */
      orbit: () => {
        const t = this.cam.orbit.target
        return {
          target: { x: t.x, y: t.y, z: t.z },
          following: this.cam.following ? this.selected : null,
          flying: this.cam.flying,
        }
      },
      walkTo: (pos: Vec3T, heading: number) => this.cam.walkAt(new THREE.Vector3(...pos), heading),
      setQuality: (q: GraphicsQuality) => this.setQuality(q),
      timeScale: (n: number) => this.clock.setScale(n),
      pass: (name: 'gtao' | 'bloom' | 'smaa', on: boolean) => this.pipeline.setPass(name, on),
      hideHud: (hide: boolean) => document.body.classList.toggle('capture', hide),
      bounds: () => this.building?.contentBounds(),
      modules: () => this.building?.moduleVisibility(),
      links: () => this.links.debug(),
      /** Visible meshes grouped by role/kind (draw-call budget work). */
      breakdown: () => {
        const out: Record<string, { meshes: number; tris: number }> = {}
        this.scene.traverseVisible((o) => {
          const m = o as THREE.Mesh
          if (!m.isMesh) return
          let role = ''
          for (let p: THREE.Object3D | null = m; p && !role; p = p.parent)
            role = (p.userData.role as string) ?? ''
          const key = `${role || m.type}:${(Array.isArray(m.material) ? m.material[0] : m.material)?.type ?? ''}`
          const idx = m.geometry.index
          const n = (idx ? idx.count : m.geometry.attributes.position!.count) / 3
          const inst = (m as THREE.InstancedMesh).isInstancedMesh
            ? (m as THREE.InstancedMesh).count
            : 1
          const e = (out[key] ??= { meshes: 0, tris: 0 })
          e.meshes++
          e.tris += Math.round(n * inst)
        })
        return out
      },
      /** The current scene background as a hex number (theme.spec). */
      sceneBackground: () => this.background.getHex(),
      stats: () => ({
        ...this.pipeline.stats,
        // GPU memory estimate and drawing-buffer size (Settings → Graphics, make perf).
        ...(({ textureMB, geometryMB, width, height }) => ({
          textureMB,
          geometryMB,
          width,
          height,
        }))(this.stats()),
        preset: this.gfx.preset,
        ...(this.characters?.count() ?? {}),
      }),
    }
    this.debugApi = api
    ;(window as unknown as { __aoDebug: typeof api }).__aoDebug = api
  }
}
