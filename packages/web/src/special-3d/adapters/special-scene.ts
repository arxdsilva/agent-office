// SpecialScene: the Night City view (docs/special-3d/architecture.md). A third SceneView behind
// SceneHost, lazy-loaded. It draws the same director plans as the other modes: each classic
// intent is mapped onto Night City anchors (app/special/stage.ts) and choreographed on the
// special nav graph, then played by the shared CharacterSystem. Rendering only: no business
// logic, no agent activity of its own; ambient city motion never touches agent objects.
//
// Composed from the classic modules: CharacterSystem, Labels, CameraDirector, AssetStore,
// LoadingScreen, RenderPipeline (with Night City's PipelineConfig), the scene kit (paced loop,
// teardown, GPU memory, hardware info) and BuildingView's bakeMaterial (adapters/three).
import {
  SpecialSettingsSchema,
  STATUS_COLORS,
  type GraphicsQuality,
  type Settings,
  type SettingsPatch,
  type SpecialSettings,
} from '@agent-office/shared'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { AssetStore, LoadingScreen, type LoadingElements } from '../../adapters/three/assets.ts'
import { CameraDirector } from '../../adapters/three/camera-director.ts'
import { CharacterSystem } from '../../adapters/three/characters.ts'
import { Labels } from '../../adapters/three/labels.ts'
import { isEmptyBox, pointerToNdc } from '../../adapters/three/viewport.ts'
import { frameAgents } from '../../app/framing.ts'
import type { Effective, GraphicsStats, HardwareInfo } from '../../app/graphics-types.ts'
import type { ViewEntry } from '../../app/library-types.ts'
import type { Manifest } from '../../app/manifest.ts'
import type {
  AgentPlan,
  BuildingLayout,
  AABB,
  ClipName,
  InteractionHit,
  InteractionKind,
  Link,
  Vec2,
} from '../../app/office-types.ts'
import type { ProjectLibraryVM } from '../../app/project-library.ts'
import { resolvePreset, type Preset } from '../../app/quality.ts'
import { createSimClock, type SimClock } from '../../app/sim-clock.ts'
import { departmentOrder } from '../../app/special/departments.ts'
import { displayVM, type DisplayInput } from '../../app/special/display-vm.ts'
import { specialHudVM, type SpecialCamera } from '../../app/special/hud-vm.ts'
import { createPlayer, type PlayerState } from '../../app/special/player.ts'
import { specialFeatures, type SpecialFeatures } from '../../app/special/special-quality.ts'
import { createStage, type Stage } from '../../app/special/stage.ts'
import { cyberLook } from '../../app/special/outfit.ts'
import { SPECIAL_COPY } from '../../app/special/copy.ts'
import { roomAt, type SpecialKind } from '../../app/special/world.ts'
import { toWorld } from '../../app/building.ts'
import type { GlobalOverview, ProjectDashboard, WallMode } from '@agent-office/shared'
import type { CapabilityRef, SceneAssets, SceneSurfaces, SceneView } from '../../ports.ts'
import { showSpecialFailure } from '../failure.ts'
import { CameraRig, type Bookmark } from './camera/camera-rig.ts'
import { loadSpecialCharacters, type CharacterSet } from './characters/cyber-characters.ts'
import { PlayerAvatar } from './characters/player-avatar.ts'
import { AdScreens } from './environment/ad-screens.ts'
import { CitySkyline } from './environment/city-skyline.ts'
import { NeonSigns } from './environment/neon.ts'
import { createRainGlassMaterial, Rain } from './environment/rain.ts'
import { Traffic } from './environment/traffic.ts'
import { InteractionRegistry, type Workstation } from './interactions/registry-adapter.ts'
import { Atmosphere } from './rendering/atmosphere.ts'
import { Lighting } from './rendering/lighting.ts'
import { MaterialLibrary } from './rendering/material-library.ts'
import { RenderPipeline } from '../../adapters/three/render-pipeline.ts'
import {
  FrameLoop,
  hardwareInfo,
  presetGraphics,
  sceneMemory,
  Teardown,
} from '../../adapters/three/scene-kit.ts'
import { SPECIAL_BLOOM } from './rendering/bloom-selective.ts'
import { createColorGrade } from './rendering/color-grade.ts'
import { ReflectionProbes } from './rendering/reflection-probes.ts'
import { SpecialSettingsPanel, SpecialIntro } from './ui/dialogs.ts'
import { SpecialHud } from './ui/hud.ts'
import { HoloDisplays } from './world/holo-displays.ts'
import { SpecialWorldView, type ScreenState } from './world/special-world.ts'

export interface SpecialElements {
  stage: HTMLElement
  loading: LoadingElements
  crosshair: HTMLElement
  walkHelp: HTMLElement
}

/** What the scene may ask of the app: its own settings only (it never sees tokens or paths). */
export interface SpecialGateway {
  get(): Promise<Settings>
  set(patch: SettingsPatch): Promise<unknown>
}

export interface SpecialOptions {
  powerPreference?: Effective['powerPreference']
  settings: SpecialGateway
}

const debugEnabled = () => new URLSearchParams(location.search).get('debug') === '1'
const HOVER_PROMPT_MS = 120
const HUD_MS = 250
const MEMORY_MS = 2000
export class SpecialScene implements SceneView {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1600)
  private pipeline: RenderPipeline
  private labels: Labels
  private director: CameraDirector
  private rig: CameraRig
  private store = new AssetStore('assets/')
  private specialStore = new AssetStore('special3d/')
  private loading: LoadingScreen
  private mats = new MaterialLibrary()
  private rainGlassMat = createRainGlassMaterial()
  private holo = new HoloDisplays()
  private lighting: Lighting
  private atmosphere: Atmosphere
  private probes: ReflectionProbes
  private world: SpecialWorldView | null = null
  private stageMap: Stage | null = null
  private characters: CharacterSystem | null = null
  private characterSet: CharacterSet | null = null
  private avatar: PlayerAvatar | null = null
  private interactions: InteractionRegistry | null = null
  private skyline: CitySkyline | null = null
  private ads: AdScreens | null = null
  private rain: Rain | null = null
  private traffic: Traffic | null = null
  private neon: NeonSigns | null = null
  private hud: SpecialHud
  private panel: SpecialSettingsPanel
  private intro: SpecialIntro
  private envMap: THREE.Texture | null = null
  private player: PlayerState = createPlayer({ x: 0, z: 0 }, 0)
  private gfx: Effective = presetGraphics('high')
  private features: SpecialFeatures
  private special: SpecialSettings = SpecialSettingsSchema.parse({})
  private loop: FrameLoop
  private plans = new Map<string, AgentPlan>()
  private order: string[] = []
  private bubbles = new Map<string, string>()
  private selected: string | null = null
  private focusSet: ReadonlySet<string> | null = null
  private prompt: InteractionHit | null = null
  private room: string | null = null
  private projectName: string | null = null
  private displayData: Pick<DisplayInput, 'dashboard' | 'overview'> = {
    dashboard: null,
    overview: null,
  }
  private lastPrompt = -Infinity
  private lastHud = -Infinity
  private lastDisplay = -Infinity
  private lastMove = -Infinity
  private memory = { at: -Infinity, textureMB: 0, geometryMB: 0 }
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private bookmarks: Bookmark[] = []
  private current: string | null = null
  private ready = false
  /** Capture override of the first-person eye height (debug `look`). */
  private lookY: number | null = null
  private disposed = false
  private debug = debugEnabled()
  private debugApi: object | null = null
  private teardown = new Teardown()
  // ── Listeners ──
  private pickFn: (id: string | null) => void = () => {}
  private interactFn: ((hit: InteractionHit) => void) | null = null
  private fixtureFn: (f: { kind: 'project-directory' }) => void = () => {}
  private viewsFn: ((v: ViewEntry[]) => void) | null = null
  private lostFn: () => void = () => {}
  private restoredFn: () => void = () => {}
  private statsFn: (fps: number, preset: Preset) => void = () => {}
  private roomFn: (name: string) => void = () => {}
  private moveFn: (p: { x: number; z: number }) => void = () => {}

  constructor(
    private el: SpecialElements,
    private clock: SimClock = createSimClock(),
    private opts: SpecialOptions,
  ) {
    // Throws when WebGL can't start; main.ts shows the Night City failure card.
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: opts.powerPreference ?? 'high-performance',
    })
    if (!this.renderer.capabilities.isWebGL2) throw new Error(SPECIAL_COPY.errors.webgl2)
    this.renderer.domElement.dataset.scene = 'special'
    el.stage.append(this.renderer.domElement)
    this.pipeline = new RenderPipeline(this.renderer, this.scene, this.camera, {
      bloom: SPECIAL_BLOOM,
      grade: [createColorGrade()],
      exposure: 0.95,
    })
    this.loop = new FrameLoop(this.renderer, {
      limit: () => this.features.gfx.fpsLimit,
      visible: () => !isEmptyBox(this.el.stage.getBoundingClientRect()),
      frame: (dt, t) => this.frame(dt, t),
    })
    this.labels = new Labels(el.stage, (id) => this.pickFn(id))
    this.director = new CameraDirector(this.camera, this.renderer.domElement)
    this.rig = new CameraRig(this.camera, this.renderer.domElement, this.director, this.player)
    this.rig.onModeChange = (m) => this.onCameraMode(m)
    this.loading = new LoadingScreen(el.loading)
    this.lighting = new Lighting(this.scene)
    this.atmosphere = new Atmosphere(this.scene)
    this.probes = new ReflectionProbes(this.renderer, this.scene)
    this.scene.background = this.lighting.background
    this.camera.position.set(-15, 3, 0)
    this.features = specialFeatures(this.gfx, this.special)
    const host = el.stage.parentElement ?? document.body
    this.hud = new SpecialHud(host)
    this.hud.onCamera = () => this.cycleCamera()
    this.hud.onSettings = () => this.openSettings()
    this.hud.onPickAgent = (id) => this.pickFn(id)
    this.panel = new SpecialSettingsPanel(host)
    this.panel.onChange = (patch) => void this.writeSpecial(patch)
    this.intro = new SpecialIntro(host)
    this.intro.onContinue = () => void this.writeSpecial({ introSeen: true })
    this.intro.onBack = () => void this.opts.settings.set({ viewMode: '3d' }).catch(() => {})
    document.body.dataset.mode = 'special'
    this.listen(window, 'resize', () => this.resize())
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.resize())
      ro.observe(el.stage)
      this.teardown.add(() => ro.disconnect())
    }
    this.resize()
    this.bindInput()
    this.bindContext()
    this.listen(document, 'visibilitychange', () => this.arm())
    this.applyGraphics(this.gfx)
    this.arm()
  }

  private listen<K extends keyof (WindowEventMap & DocumentEventMap)>(
    target: Window | Document | HTMLElement,
    type: K,
    fn: (e: (WindowEventMap & DocumentEventMap)[K]) => void,
  ): void {
    this.teardown.on(target, type, fn)
  }

  // ── Loading ──────────────────────────────────────────────────────────────────────────────────
  async load(manifestUrl: string): Promise<SceneAssets> {
    try {
      // A mode switch re-shows the loading screen the previous scene hid.
      this.el.loading.root.hidden = false
      this.el.loading.root.classList.remove('done', 'failed')
      this.loading.progress(0.02, SPECIAL_COPY.loading)
      // The director keeps planning on the classic building; this scene maps its intents.
      const [manifest, settings] = await Promise.all([
        this.store.manifest(manifestUrl),
        this.opts.settings.get().catch(() => null),
      ])
      if (settings) this.special = settings.special
      this.loading.progress(0.1, 'Loading the headquarters…')
      const world = await SpecialWorldView.load(
        this.specialStore,
        this.mats,
        this.rainGlassMat,
        (f) => this.loading.progress(0.1 + f * 0.5),
        this.specialFeaturesNow().gfx.lightmapTier,
      )
      if (this.disposed) return { manifest }
      this.world = world
      this.scene.add(world.group)
      this.stageMap = createStage(world.world)
      this.buildEnvironment(world)
      const hdri = world.world.manifest.hdri
      if (hdri)
        void this.specialStore
          .environment(hdri, this.renderer)
          .then((env) => {
            if (this.disposed) return env.dispose()
            this.envMap?.dispose()
            this.envMap = env
            this.scene.environment = env
          })
          .catch(() => {})
      this.loading.progress(0.7, 'Waking up the city…')
      const chars = await loadSpecialCharacters(
        this.store.gltf,
        world.world.manifest.character ?? null,
      )
      if (this.disposed) return { manifest }
      const clipDurations: SceneAssets['clipDurations'] = {}
      if (chars) {
        this.characterSet = chars.set
        const cyber = chars.set === 'cyber'
        this.characters = new CharacterSystem(this.scene, chars.assets, {
          ...(cyber && { look: (id: string) => cyberLook(id) }),
          quality: this.gfx.preset,
          renderer: this.renderer,
        })
        this.avatar = new PlayerAvatar(
          this.scene,
          chars.assets,
          cyber ? cyberLook('player', { player: true }) : null,
        )
        for (const [name, c] of Object.entries(chars.assets.meta.clips))
          if (c && !c.loop) clipDurations[name as ClipName] = c.duration
        this.stageMap.setClipDurations(clipDurations)
      }
      const spawn = world.world.spawn
      Object.assign(this.player, createPlayer(spawn.pos, spawn.heading))
      this.rig.yaw = spawn.heading
      this.interactions = new InteractionRegistry(
        this.scene,
        this.labels,
        world.world.interactables,
        (hit) => this.fireInteraction(hit),
      )
      this.bookmarks = this.makeBookmarks()
      this.director.setBounds(world.world.layout.bounds)
      this.applySpecial(this.special)
      this.applyGraphics(this.gfx)
      this.rig.setMode(
        this.special.camera,
        this.bookmarks.find((b) => b.id === 'overview'),
      )
      this.onCameraMode(this.rig.mode)
      this.emitViews()
      this.renderDisplay(true)
      this.loading.progress(1, 'Doors open')
      this.loading.hide()
      this.ready = true
      if (!this.special.introSeen) this.intro.open()
      if (this.debug) this.installDebug()
      return { manifest, clipDurations }
    } catch (err) {
      this.loading.error(SPECIAL_COPY.errors.start((err as Error).message))
      setTimeout(() => this.loading.hide(), 4000)
      showSpecialFailure(
        err,
        (mode) => void this.opts.settings.set({ viewMode: mode }).catch(() => {}),
      )
      throw err
    }
  }

  private buildEnvironment(world: SpecialWorldView): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()
    this.scene.environment = this.envMap
    this.scene.environmentIntensity = 0.35
    for (const m of world.modules)
      for (const l of m.lights) this.lighting.add(m.kind, l.light, l.priority)
    this.atmosphere.addShafts(world.shafts)
    const b = world.world.layout.bounds
    const center = new THREE.Vector3((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2)
    // The published set brings its own skyline; the procedural one stands in until then.
    const ownSkyline = !!world.world.manifest.modules.skyline?.file
    if (!ownSkyline) this.skyline = new CitySkyline(this.scene, b)
    this.ads = new AdScreens(this.scene)
    const viewer = new THREE.Vector3(center.x, 3, center.z)
    if (world.ads.length) for (const m of world.ads) this.ads.adopt(m, viewer)
    else if (this.skyline) {
      // Eight screens on the nearest towers, spread around (the most visible first).
      const faces = [...this.skyline.nearFaces].sort(
        (p, q) => p.pos.distanceTo(center) - q.pos.distanceTo(center),
      )
      for (const f of faces.slice(0, 8))
        this.ads.add(f.pos, f.normal, Math.min(24, f.width * 0.8), Math.min(12, f.width * 0.4))
    }
    this.traffic = new Traffic(
      this.scene,
      center,
      80,
      9,
      world.traffic.length ? world.traffic : undefined,
    )
    // Rain outside the rain glass (the side it faces away from the building), else east.
    this.rain = new Rain(this.scene, {
      ...rainVolume(b, world.rainGlass, center),
      minY: -30,
      maxY: 45,
    })
    // Accent lights in front of the set's holo displays (the fixture places its own).
    if (!world.fixture)
      world.holo.slice(0, 6).forEach((m, i) => {
        const box = new THREE.Box3().setFromObject(m)
        const at = box.getCenter(new THREE.Vector3())
        const toCenter = new THREE.Vector3(center.x - at.x, 0, center.z - at.z).setLength(2.5)
        const l = new THREE.PointLight(i % 2 ? 0xffb02e : 0x29e3ff, 8, 14, 1.8)
        l.position.copy(at).add(toCenter)
        const inside = world.modules.find((mv) => {
          const r = this.moduleBox(mv.kind)
          return (
            r &&
            at.x >= r.minX - 1 &&
            at.x <= r.maxX + 1 &&
            at.z >= r.minZ - 1 &&
            at.z <= r.maxZ + 1
          )
        })
        this.lighting.add(inside?.kind ?? 'hq-atrium', l, i + 1)
      })
    this.neon = new NeonSigns(this.scene)
    for (const n of world.neon) this.neon.addText(n.text, n.color, n.pos, n.yaw)
    for (const m of world.neonMeshes) this.neon.adopt(m)
    for (const m of world.holo) this.holo.attach(m, viewer)
    for (const m of world.rainGlass) m.material = this.rainGlassMat
    for (const m of world.modules) this.probes.add(m.kind, m.probe, m.floors)
  }

  // ── SceneView ────────────────────────────────────────────────────────────────────────────────
  setBuilding(layout: BuildingLayout): void {
    // The classic layout only gives the department order (classic wing order).
    this.order = departmentOrder(
      layout,
      [...this.plans.values()].map((p) => p.agent.provider),
    )
  }

  direct(plans: Map<string, AgentPlan>, departed: string[]): void {
    if (!this.stageMap) return
    const now = this.clock.now()
    if (!this.order.length)
      this.order = departmentOrder(
        null,
        [...plans.values()].map((p) => p.agent.provider),
      )
    const out = this.stageMap.direct(plans, departed, now, this.order)
    for (const id of out.dropped) {
      this.characters?.remove(id)
      this.labels.remove(id)
    }
    this.plans = out.plans
    for (const [id, plan] of out.plans) {
      this.characters?.upsert(plan, now)
      this.labels.upsert(plan.agent, plan.intent.activity, this.bubbles.get(id))
    }
    if (this.focusSet) this.characters?.setFocus(this.focusSet)
    this.updateSurfaces()
  }

  /** Monitors (status colours) and booth LEDs from the current plans (real state only). */
  private updateSurfaces(): void {
    if (!this.world || !this.stageMap) return
    const anchors = this.world.world.layout.anchors
    const screens = new Map<string, ScreenState>()
    const leds = new Set<string>()
    for (const [id, plan] of this.plans) {
      const desk = this.stageMap.deskOf(id)
      const a = desk ? anchors.get(desk) : undefined
      const st = plan.agent.status
      if (a?.screen)
        screens.set(`${a.placement}|${a.screen}`, {
          color: STATUS_COLORS[st],
          intensity: st === 'idle' || st === 'done' ? 0.6 : 2.6,
        })
      const t = anchors.get(plan.intent.target)
      if (plan.intent.activity === 'booth' && t?.led) leds.add(`${t.placement}|${t.led}`)
    }
    this.world.setScreens(screens)
    this.world.setLeds(leds)
  }

  setLinks(_links: Link[]): void {
    // R1: capability links are drawn in Classic 3D only (no capability surfaces in Night City yet).
  }

  setSurfaces(s: SceneSurfaces): void {
    this.bubbles = s.bubbles
    for (const [id, plan] of this.plans)
      this.labels.upsert(plan.agent, plan.intent.activity, s.bubbles.get(id))
  }

  onPickCapability(_fn: (ref: CapabilityRef) => void): void {}
  focusCapability(_ref: CapabilityRef | null): void {}
  highlightLinks(_id: string | null): void {}

  select(id: string | null): void {
    this.selected = id
    this.labels.select(id)
    const chars = this.characters
    if (this.rig.mode !== 'overview' || !chars || !id) return this.director.focusOn(null)
    this.director.focusOn(() => chars.positionOf(id))
  }

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
    this.rig.setMode('overview')
    this.director.flyTo({
      target: new THREE.Vector3(pose.target.x, pose.target.y, pose.target.z),
      position: new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z),
    })
  }

  setQuality(q: GraphicsQuality): void {
    this.applyGraphics(presetGraphics(resolvePreset(q, 'high')))
  }

  setGraphics(e: Effective): void {
    this.applyGraphics(e)
  }

  private applyGraphics(e: Effective): void {
    this.gfx = e
    const f = (this.features = specialFeatures(e, this.special))
    this.pipeline.setGraphics({ ...f.gfx, bloom: f.bloom })
    this.lighting.apply({ perRoom: f.dynamicLights, shadowMap: f.gfx.shadowMap })
    this.atmosphere.apply({ fog: f.fog, density: f.fogDensity, shafts: f.shafts })
    this.rain?.setDrops(f.rainDrops)
    this.rainGlassMat.uniforms.uRain!.value = f.rainGlass ? 1 : 0
    this.traffic?.setCount(f.trafficCars)
    this.skyline?.setAnimated(f.animatedBands, f.windowFlicker)
    if (f.probes && !this.probes.captured && this.world) this.captureProbes()
    this.probes.setEnabled(f.probes)
    this.characters?.setDetail({
      lod: e.lod,
      maxAnimated: e.maxAnimated,
      shadows: f.gfx.shadows,
      impostorAtFar: false,
    })
    this.labels.setMode(e.labels.mode, e.labels.nearbyM)
    this.memory.at = -Infinity
    this.arm()
  }

  private specialFeaturesNow(): SpecialFeatures {
    return this.features
  }

  private captureProbes(): void {
    const hide: THREE.Object3D[] = [this.atmosphere.group]
    if (this.avatar) hide.push(this.avatar.root)
    if (this.rain) hide.push(this.rain.mesh)
    this.probes.capture(hide)
  }

  onPick(fn: (id: string | null) => void): void {
    this.pickFn = fn
  }

  goTo(viewId: string): void {
    const b = this.bookmarks.find((x) => x.id === viewId)
    if (!b) return
    this.current = b.id
    if (this.rig.mode !== 'overview') this.rig.setMode('overview', b)
    else this.director.flyTo(b)
    this.emitViews()
  }

  cameraIdleMs(): number {
    return this.director.idleMs()
  }

  setTheme(theme: 'light' | 'dark'): void {
    this.lighting.setTheme(theme)
  }

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

  /** GPU memory (scene-kit) plus Night City's targets: shadow map, post targets, probes. */
  private countMemory(now: number): void {
    const extra = this.lighting.shadowBytes() + this.pipeline.targetBytes() + this.probes.bytes()
    this.memory = { at: now, ...sceneMemory(this.scene, [], extra) }
  }

  hardwareInfo(): HardwareInfo | null {
    return hardwareInfo(this.renderer)
  }

  onContextLost(fn: () => void): void {
    this.lostFn = fn
  }
  onContextRestored(fn: () => void): void {
    this.restoredFn = fn
  }
  onHoverSurface(_fn: (ref: CapabilityRef | null, x: number, y: number) => void): void {}
  onViews(fn: (views: ViewEntry[]) => void): void {
    this.viewsFn = fn
    this.emitViews()
  }
  onFrameStats(fn: (fps: number, preset: Preset) => void): void {
    this.statsFn = fn
  }
  onRoom(fn: (name: string) => void): void {
    this.roomFn = fn
  }
  onPlayerMove(fn: (p: { x: number; z: number }) => void): void {
    this.moveFn = fn
  }
  onPickFixture(fn: (f: { kind: 'project-directory' }) => void): void {
    this.fixtureFn = fn
  }
  onPickInteraction(fn: (hit: InteractionHit) => void): void {
    this.interactFn = fn
  }
  setInputSuspended(on: boolean): void {
    this.rig.suspended = on
  }
  setWallMode(_m: WallMode): void {
    // R2: the cutaway in Night City (plan §3). Walls stay up in R1.
  }
  setProjectLibrary(_vm: ProjectLibraryVM | null): void {}

  /** Moves the player next to an agent (or to a point); third person. */
  travelTo(target: { agentId?: string; viewId?: string; pos?: { x: number; z: number } }): void {
    if (target.viewId) return this.goTo(target.viewId)
    const p = target.agentId ? this.characters?.positionOf(target.agentId) : undefined
    const at = p ? { x: p.x, z: p.z } : target.pos
    if (!at || !this.world) return
    const a =
      this.stageMap && target.agentId
        ? this.world.world.layout.anchors.get(this.plans.get(target.agentId)?.intent.target ?? '')
        : undefined
    const spot = a?.approach ?? at
    if (this.rig.mode === 'overview') this.rig.setMode('third')
    Object.assign(this.player, { x: spot.x, z: spot.z, vx: 0, vz: 0, speed: 0 })
    this.player.heading = Math.atan2(at.x - spot.x, at.z - spot.z)
    this.rig.yaw = this.player.heading
    if (this.rig.mode === 'first')
      this.director.walkAt(new THREE.Vector3(spot.x, 0, spot.z), this.player.heading)
  }

  // ── Night City extras (main.ts / controller hookup) ──────────────────────────────────────────
  /** New `settings.special` (the controller forwards settings changes). */
  setSpecialSettings(s: SpecialSettings): void {
    const camera = s.camera !== this.special.camera
    this.applySpecial(s)
    if (camera && this.ready)
      this.rig.setMode(
        s.camera,
        this.bookmarks.find((b) => b.id === 'overview'),
      )
  }

  /** The selected project's dashboard and the overview (counts and names only reach the screens). */
  setDisplayData(d: {
    dashboard?: ProjectDashboard | null
    overview?: GlobalOverview | null
    projectName?: string | null
  }): void {
    if (d.dashboard !== undefined) this.displayData.dashboard = d.dashboard
    if (d.overview !== undefined) this.displayData.overview = d.overview
    if (d.projectName !== undefined) this.projectName = d.projectName
    this.renderDisplay(true)
  }

  private applySpecial(s: SpecialSettings): void {
    this.special = s
    this.panel.render(s)
    this.applyGraphics(this.gfx)
  }

  private async writeSpecial(patch: Partial<SpecialSettings>): Promise<void> {
    const next: SpecialSettings = {
      ...this.special,
      ...patch,
      audio: { ...this.special.audio, ...patch.audio },
    }
    this.setSpecialSettings(next)
    try {
      await this.opts.settings.set({ special: next })
    } catch {
      // Settings unavailable: the change still applies for this session.
    }
  }

  private openSettings(): void {
    this.panel.render(this.special)
    if (this.panel.isOpen) this.panel.close()
    else this.panel.open()
  }

  private cycleCamera(): void {
    const next = this.rig.next()
    this.rig.setMode(
      next,
      next === 'overview' ? this.bookmarks.find((b) => b.id === 'overview') : undefined,
    )
  }

  private onCameraMode(m: SpecialCamera): void {
    this.avatar?.setVisible(m !== 'first')
    this.el.crosshair.hidden = m !== 'first'
    this.el.stage.dataset.specialCamera = m
    this.lastHud = -Infinity
  }

  private fireInteraction(hit: InteractionHit): void {
    if (this.interactFn) return this.interactFn(hit)
    // Until the controller routes semantic interactions, the directory falls back to the fixture path.
    if (hit.kind === 'project-directory') this.fixtureFn({ kind: 'project-directory' })
    if (hit.kind === 'agent-workstation' && hit.agentId) this.pickFn(hit.agentId)
  }

  private renderDisplay(force = false): void {
    const now = performance.now()
    if (!force && now - this.lastDisplay < 1000) return
    this.lastDisplay = now
    let active = 0
    let waiting = 0
    for (const p of this.plans.values()) {
      if (p.agent.status === 'thinking' || p.agent.status === 'tool') active++
      if (p.agent.status === 'waiting') waiting++
    }
    this.holo.render(displayVM({ ...this.displayData, live: { active, waiting }, now: Date.now() }))
  }

  private arm(): void {
    this.loop.arm()
  }

  private workstations(): Workstation[] {
    const out: Workstation[] = []
    if (!this.world || !this.stageMap) return out
    for (const id of this.plans.keys()) {
      const desk = this.stageMap.deskOf(id)
      const a = desk ? this.world.world.layout.anchors.get(desk) : undefined
      if (a) out.push({ agentId: id, pos: a.pos })
    }
    return out
  }

  private frame(rawDt: number, t: number): void {
    const dt = Math.min(rawDt, 0.1)
    const simDt = Math.min(rawDt * this.clock.scale, 0.5)
    const now = this.clock.now()
    const colliders = this.world?.world.colliders ?? []
    this.rig.update(dt, colliders)
    if (this.lookY !== null && this.rig.mode === 'first') this.camera.position.y = this.lookY
    else this.lookY = null
    this.camera.updateMatrixWorld()
    this.avatar?.update(dt, this.player)
    this.characters?.update(simDt, this.camera, now)
    const s = t / 1000
    const f = this.features
    this.skyline?.update(s)
    this.rain?.update(s)
    this.traffic?.update(dt)
    this.neon?.update(s, f.neonFlicker)
    this.ads?.update(Date.now(), f.adRotation)
    this.atmosphere.update(s)
    this.rainGlassMat.uniforms.uTime!.value = f.rainGlass ? s : 0
    if (t - this.lastPrompt > HOVER_PROMPT_MS) {
      this.lastPrompt = t
      this.prompt =
        this.rig.mode === 'overview'
          ? null
          : (this.interactions?.nearest(this.player, this.workstations()) ?? null)
    }
    if (t - this.lastHud > HUD_MS) {
      this.lastHud = t
      this.updateHud()
    }
    this.renderDisplay()
    const sample = this.pipeline.render(rawDt)
    this.labels.update(this.camera, (id) => this.characters?.headOf(id), colliders, now)
    if (sample) this.statsFn(sample.fps, this.gfx.preset)
  }

  private updateHud(): void {
    const room = this.world ? (roomAt(this.world.world, this.player)?.name ?? null) : null
    if (room !== this.room) {
      this.room = room
      if (room) this.roomFn(room)
    }
    const now = performance.now()
    if (now - this.lastMove > 250) {
      this.lastMove = now
      this.moveFn({ x: this.player.x, z: this.player.z })
    }
    const agents = [...this.plans.values()].map((p) => ({
      id: p.agent.id,
      name: p.agent.name,
      status: p.agent.status,
    }))
    this.hud.render(
      specialHudVM({
        agents,
        selectedId: this.selected,
        room,
        prompt: this.prompt?.kind ?? null,
        camera: this.rig.mode,
        projectName: this.projectName,
      }),
    )
    if (this.world && this.hud.mapOpen) {
      const dots = []
      for (const id of this.plans.keys()) {
        const p = this.characters?.positionOf(id)
        const st = this.plans.get(id)!.agent.status
        if (p) dots.push({ id, pos: { x: p.x, z: p.z }, status: st })
      }
      this.hud.drawMap({
        bounds: this.world.world.layout.bounds,
        rooms: this.world.world.rooms,
        agents: dots,
        player: { pos: { x: this.player.x, z: this.player.z }, heading: this.player.heading },
      })
    }
    this.hud.renderDirectory(agents.sort((a, b) => a.name.localeCompare(b.name)))
  }

  // ── Views and bookmarks ──────────────────────────────────────────────────────────────────────
  /** A module's world box (placement + bounds), or null when the set has no such module. */
  private moduleBox(kind: SpecialKind): AABB | null {
    const w = this.world!.world
    const def = w.manifest.modules[kind]
    const pl = w.layout.placements.find((p) => p.id === kind)
    if (!def || !pl) return null
    const pts = [
      toWorld({ x: def.bounds.minX, z: def.bounds.minZ }, pl),
      toWorld({ x: def.bounds.maxX, z: def.bounds.maxZ }, pl),
    ]
    return {
      minX: Math.min(pts[0]!.x, pts[1]!.x),
      maxX: Math.max(pts[0]!.x, pts[1]!.x),
      minZ: Math.min(pts[0]!.z, pts[1]!.z),
      maxZ: Math.max(pts[0]!.z, pts[1]!.z),
    }
  }

  /** Camera bookmarks derived from the set's modules (works for the fixture and the real set). */
  private makeBookmarks(): Bookmark[] {
    const w = this.world!.world
    const b = w.layout.bounds
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
    const mid = (r: AABB) => ({ x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2 })
    const c = mid(b)
    const sky = this.moduleBox('skyline')
    // The city side: the skyline module, else the side the rain glass faces, else east.
    const glass = this.world!.rainGlass[0]
    const gp = glass ? new THREE.Box3().setFromObject(glass).getCenter(new THREE.Vector3()) : null
    const cityAt = sky
      ? mid(sky)
      : gp
        ? { x: c.x + (gp.x - c.x) * 6, z: c.z + (gp.z - c.z) * 6 }
        : { x: c.x + 200, z: c.z }
    const dir = new THREE.Vector2(cityAt.x - c.x, cityAt.z - c.z).normalize()
    const out: Bookmark[] = [
      {
        id: 'overview',
        label: 'Overview',
        position: v(c.x - dir.x * 45 - dir.y * 25, 50, c.z - dir.y * 45 + dir.x * 25),
        target: v(c.x, 0, c.z),
      },
    ]
    /** Looks at the room's focal object (its holo/display) from across the room, near the ceiling. */
    const room = (kind: SpecialKind, id: string, label: string, h: number, focus: Vec2 | null) => {
      const r = this.moduleBox(kind)
      if (!r) return
      const m = mid(r)
      const f = focus ?? m
      const away = new THREE.Vector2(m.x - f.x, m.z - f.z)
      if (away.lengthSq() < 1) away.set(-dir.x, -dir.y)
      away.normalize()
      const reach = Math.min((r.maxX - r.minX) / 2, (r.maxZ - r.minZ) / 2) * 0.9
      // Clamp the eye inside the room (1 m from its walls).
      const ex = Math.min(r.maxX - 1, Math.max(r.minX + 1, m.x + away.x * reach))
      const ez = Math.min(r.maxZ - 1, Math.max(r.minZ + 1, m.z + away.y * reach))
      out.push({ id, label, position: v(ex, h * 0.8, ez), target: v(f.x, h * 0.35, f.z) })
    }
    const focusIn = (kind: SpecialKind): Vec2 | null => {
      const r = this.moduleBox(kind)
      if (!r) return null
      const inR = (p: { x: number; z: number }) =>
        p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ
      const display = w.interactables.find((i) => i.kind === 'command-display' && inR(i.pos))
      if (display) return display.pos
      for (const h of this.world!.holo) {
        const c = new THREE.Box3().setFromObject(h).getCenter(new THREE.Vector3())
        if (inR(c)) return { x: c.x, z: c.z }
      }
      return null
    }
    room(
      'hq-atrium',
      'atrium',
      'Atrium',
      w.manifest.modules['hq-atrium']?.height ?? 14,
      focusIn('hq-atrium'),
    )
    room(
      'command',
      'command',
      'Command Center',
      w.manifest.modules.command?.height ?? 6,
      focusIn('command'),
    )
    const a = this.moduleBox('hq-atrium')
    if (a) {
      const m = mid(a)
      const reach = Math.min((a.maxX - a.minX) / 2, (a.maxZ - a.minZ) / 2) * 0.75
      out.push({
        id: 'skyline',
        label: 'Skyline',
        position: v(m.x + dir.x * reach, 4, m.z + dir.y * reach),
        target: v(m.x + dir.x * 120, 25, m.z + dir.y * 120),
      })
    }
    return out
  }

  private emitViews(): void {
    if (!this.viewsFn || !this.bookmarks.length) return
    this.viewsFn(
      this.bookmarks.map((b) => ({
        id: b.id,
        label: b.label,
        ...(b.id === this.current && { active: true }),
      })),
    )
  }

  // ── Input ────────────────────────────────────────────────────────────────────────────────────
  private bindInput(): void {
    const canvas = this.renderer.domElement
    let downAt: [number, number] | null = null
    canvas.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]))
    canvas.addEventListener('pointerup', (e) => {
      if (!downAt) return
      const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1])
      downAt = null
      if (moved > 5) return
      if (this.rig.mode === 'first') return this.rig.lockPointer()
      const n = pointerToNdc(this.el.stage.getBoundingClientRect(), e.clientX, e.clientY)
      this.pickAt(n.x, n.y)
    })
    this.listen(window, 'keydown', (e) => {
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      if (e.metaKey || e.ctrlKey || e.altKey || this.rig.suspended) return
      if (document.querySelector('dialog[open]:not(#special-settings)')) return
      switch (e.code) {
        case 'KeyF':
          this.cycleCamera()
          break
        case 'KeyE':
          if (this.rig.mode === 'first') {
            // Crosshair at the centre: an agent or an object, else what is within reach.
            const id = this.pickAgent(0, 0)
            if (id) return this.pickFn(id)
            const hit = this.interactions?.pick(this.raycaster)
            if (hit) return this.fireInteraction(hit)
          }
          if (this.prompt) this.fireInteraction(this.prompt)
          break
        case 'KeyM':
          this.hud.toggleMap()
          this.lastHud = -Infinity
          break
        case 'KeyJ':
          this.hud.toggleDirectory()
          this.lastHud = -Infinity
          break
        case 'Escape':
          if (this.rig.mode !== 'first') this.pickFn(null)
          break
      }
    })
  }

  private pickAgent(x: number, y: number): string | null {
    this.pointer.set(x, y)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    if (!this.characters) return null
    for (const h of this.raycaster.intersectObjects(this.characters.pickTargets(), false))
      for (let o: THREE.Object3D | null = h.object; o; o = o.parent)
        if (o.userData.agentId) return o.userData.agentId as string
    return null
  }

  /** Click: an agent first, then a semantic object, else empty space (deselect). */
  private pickAt(x: number, y: number): void {
    const id = this.pickAgent(x, y)
    if (id) return this.pickFn(id)
    const hit = this.interactions?.pick(this.raycaster)
    if (hit) return this.fireInteraction(hit)
    this.pickFn(null)
  }

  private bindContext(): void {
    const canvas = this.renderer.domElement
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.lostFn()
    })
    canvas.addEventListener('webglcontextrestored', () => {
      if (this.features.probes && this.world) this.captureProbes()
      this.resize()
      this.memory.at = -Infinity
      this.restoredFn()
    })
  }

  private resize(): void {
    const r = this.el.stage.getBoundingClientRect()
    if (isEmptyBox(r)) return
    this.pipeline.resize(r.width, r.height)
    this.labels.setSize(r.width, r.height)
    this.camera.aspect = r.width / r.height
    this.camera.updateProjectionMatrix()
  }

  // ── Dispose ──────────────────────────────────────────────────────────────────────────────────
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.loop.stop()
    this.teardown.run()
    if (this.director.mode === 'walk') this.director.exitWalk()
    this.rig.dispose()
    this.director.dispose()
    this.el.crosshair.hidden = true
    this.el.walkHelp.hidden = true
    this.el.stage.dataset.specialCamera = ''
    this.el.stage.dataset.projectFocus = ''
    this.characters?.dispose()
    this.characters = null
    this.avatar?.dispose()
    this.interactions?.dispose()
    for (const sys of [this.skyline, this.ads, this.rain, this.traffic, this.neon]) sys?.dispose()
    this.world?.dispose()
    this.atmosphere.dispose()
    this.lighting.dispose()
    this.probes.dispose()
    this.holo.dispose()
    this.rainGlassMat.dispose()
    this.mats.dispose()
    this.envMap?.dispose()
    this.scene.environment = null
    // Anything still in the scene graph (placeholder merges, proxies) goes too.
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh
      m.geometry?.dispose?.()
    })
    this.pipeline.dispose()
    this.labels.renderer.domElement.remove()
    this.hud.dispose()
    this.panel.dispose()
    this.intro.dispose()
    this.lostFn = this.restoredFn = () => {}
    this.statsFn = () => {}
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
    const w = window as unknown as { __aoDebug?: unknown }
    if (this.debugApi && w.__aoDebug === this.debugApi) delete w.__aoDebug
  }

  // ── Debug (`?debug=1` only) ──────────────────────────────────────────────────────────────────
  private installDebug(): void {
    const scene = this
    const special = {
      ready: () => scene.ready,
      /** Every agent: its Night City anchor, activity, workstation and floor position. */
      agents: () => scene.stageMap?.entries(scene.clock.now()) ?? [],
      room: () => scene.room,
      /** Fires the semantic interaction of the first object of a kind (as E would). */
      interact: (kind: InteractionKind, agentId?: string) => {
        const hit =
          kind === 'agent-workstation'
            ? { kind, anchor: 'ws', ...(agentId && { agentId }) }
            : scene.interactions?.first(kind)
        if (hit) scene.fireInteraction(hit)
        return !!hit
      },
      gpu: () => scene.stats(),
      camera: (m?: SpecialCamera) => {
        if (m)
          scene.rig.setMode(
            m,
            m === 'overview' ? scene.bookmarks.find((b) => b.id === 'overview') : undefined,
          )
        return scene.rig.mode
      },
      player: () => ({
        x: scene.player.x,
        y: scene.player.y,
        z: scene.player.z,
        heading: scene.player.heading,
      }),
      teleport: (x: number, z: number, heading = scene.player.heading) => {
        Object.assign(scene.player, { x, z, heading, vx: 0, vz: 0, speed: 0 })
        scene.rig.yaw = heading
      },
      prompt: () => scene.prompt,
      /** The mesh under a screen point (NDC) and its material (look-dev). */
      meshAt: (x: number, y: number) => {
        scene.pointer.set(x, y)
        scene.raycaster.setFromCamera(scene.pointer, scene.camera)
        const h = scene.raycaster.intersectObject(scene.scene, true).find((i) => i.object.visible)
        const m = h?.object as THREE.Mesh | undefined
        const mat = m && (Array.isArray(m.material) ? m.material[0] : m.material)
        return m
          ? {
              name: m.name,
              parent: m.parent?.name,
              material: mat?.name,
              type: mat?.type,
              role: m.userData.role ?? m.parent?.userData.role,
              d: h!.distance,
            }
          : null
      },
      features: () => scene.features,
      lights: () => scene.lighting.counts(),
      fixture: () => scene.world?.fixture ?? null,
      characterSet: () => scene.characterSet,
      display: () => scene.holo.shown,
      /** Role meshes from the asset set: kind → world-space box centres and sizes (debug). */
      roles: () => {
        const w = scene.world
        if (!w) return null
        const box = new THREE.Box3()
        const info = (m: THREE.Object3D) => {
          box.setFromObject(m)
          const c = box.getCenter(new THREE.Vector3())
          const s = box.getSize(new THREE.Vector3())
          return {
            name: m.name,
            c: [c.x, c.y, c.z].map((v) => +v.toFixed(1)),
            s: [s.x, s.y, s.z].map((v) => +v.toFixed(1)),
          }
        }
        return {
          holo: w.holo.map(info),
          ads: w.ads.map(info),
          neon: w.neonMeshes.map(info),
          rainGlass: w.rainGlass.map(info),
          traffic: w.traffic.length,
          spawn: w.world.spawn,
          rooms: w.world.rooms,
        }
      },
    }
    const api = {
      special,
      ready: () => scene.ready,
      views: () => scene.bookmarks.map((b) => b.id),
      view: (id: string) => {
        const b = scene.bookmarks.find((x) => x.id === id)
        if (b) scene.rig.setMode('overview', b)
        return !!b
      },
      bookmark: (id?: string) => (id === undefined ? scene.current : api.view(id)),
      /** Eye-level camera at a pose (capture scripts): first person, looking at `target`. */
      look: (pos: [number, number, number], target: [number, number, number]) => {
        scene.rig.setMode('first')
        scene.director.walkAt(
          new THREE.Vector3(pos[0], 0, pos[2]),
          Math.atan2(target[0] - pos[0], target[2] - pos[2]),
        )
        scene.camera.position.y = pos[1]
        scene.camera.lookAt(new THREE.Vector3(...target))
        scene.lookY = pos[1]
      },
      graphics: () => scene.gfx,
      frames: () => scene.loop.frames,
      gpu: () => scene.stats(),
      hardware: () => scene.hardwareInfo(),
      timeScale: (n: number) => scene.clock.setScale(n),
      setQuality: (q: GraphicsQuality) => scene.setQuality(q),
      pass: (name: 'gtao' | 'bloom' | 'smaa', on: boolean) => scene.pipeline.setPass(name, on),
      hideHud: (hide: boolean) => document.body.classList.toggle('capture', hide),
      stats: () => ({
        ...scene.pipeline.stats,
        ...(({ textureMB, geometryMB, width, height }) => ({
          textureMB,
          geometryMB,
          width,
          height,
        }))(scene.stats()),
        preset: scene.gfx.preset,
        ...(scene.characters?.count() ?? {}),
      }),
    }
    this.debugApi = api
    ;(window as unknown as { __aoDebug: typeof api }).__aoDebug = api
  }
}

/** Rain outside the glass panes: the side they face away from the building centre (else east). */
function rainVolume(b: AABB, glass: THREE.Mesh[], center: THREE.Vector3): AABB {
  if (!glass.length)
    return { minX: b.maxX + 1.5, maxX: b.maxX + 70, minZ: b.minZ - 25, maxZ: b.maxZ + 25 }
  const box = new THREE.Box3()
  for (const g of glass) box.expandByObject(g)
  const c = box.getCenter(new THREE.Vector3())
  const dx = c.x - center.x
  const dz = c.z - center.z
  if (Math.abs(dx) > Math.abs(dz))
    return dx > 0
      ? { minX: box.max.x + 1.5, maxX: box.max.x + 70, minZ: b.minZ - 25, maxZ: b.maxZ + 25 }
      : { minX: box.min.x - 70, maxX: box.min.x - 1.5, minZ: b.minZ - 25, maxZ: b.maxZ + 25 }
  return dz > 0
    ? { minX: b.minX - 25, maxX: b.maxX + 25, minZ: box.max.z + 1.5, maxZ: box.max.z + 70 }
    : { minX: b.minX - 25, maxX: b.maxX + 25, minZ: box.min.z - 70, maxZ: box.min.z - 1.5 }
}

/** Manifest type re-export for the factory's return (the classic manifest drives the director). */
export type { Manifest }
