// SceneHost (2D RPG plan §2.1): one SceneView for the controller that forwards to the active scene
// (ThreeScene or PixelScene), caches the replayable state, and swaps scenes on a viewMode change:
// create + load the new one → dispose the old one → re-attach listeners → replay → resync plans.
// In 3D mode it only forwards, so the 3D office behaves exactly as before.
import type { GraphicsQuality, ViewMode, WallMode } from '@agent-office/shared'
import type { Effective, GraphicsStats, HardwareInfo } from '../app/graphics-types.ts'
import type { ViewEntry } from '../app/library-types.ts'
import type { AgentPlan, BuildingLayout, InteractionHit, Link } from '../app/office-types.ts'
import type { InteractTarget, TileRect } from '../app/pixel/types.ts'
import type { RosterInput } from '../app/hierarchy-types.ts'
import type { ProjectLibraryVM } from '../app/project-library.ts'
import type { CapabilityRef, SceneAssets, SceneSurfaces, SceneView } from '../ports.ts'

/** Adapter-level extras some scenes have (ThreeScene: hardware tier input, the FPS readout). */
interface SceneExtras {
  hardwareInfo?(): HardwareInfo | null
  onFrameStats?(fn: (fps: number, preset: string) => void): void
}
type AnyScene = SceneView & SceneExtras

export interface SceneHostDeps {
  /** Creates the scene for a mode (may throw, e.g. WebGL can't start). */
  factory: (mode: ViewMode) => SceneView
  /**
   * Every visible agent's plan with its remaining steps from now (`director.resync(now)`), so a
   * fresh scene continues agents where they are. Empty → the cached plans (without steps).
   */
  resync: () => Map<string, AgentPlan>
  /** The mode of the first scene (created at once). */
  mode: ViewMode
  /**
   * Optional (plan §5.4): creates a scene asynchronously (a lazy-loaded mode).
   * When given, `switchTo` and `initAsync` use it instead of `factory`.
   */
  factoryAsync?: (mode: ViewMode) => Promise<SceneView>
}

type Fn = (...args: never[]) => void

/** Listener registrations the host re-attaches to every new scene. */
const LISTENERS = [
  'onPick',
  'onPickCapability',
  'onContextLost',
  'onContextRestored',
  'onHoverSurface',
  'onViews',
  'onInteract',
  'onRoom',
  'onPlayerMove',
  'onCamera',
  'onMinimapBase',
  'onZoom',
  'onRun',
  'onPickFixture',
  'onPickInteraction',
  'onFrameStats',
] as const
type ListenerName = (typeof LISTENERS)[number]

export class SceneHost implements SceneView {
  private scene: AnyScene
  private current: ViewMode
  private manifestUrl: string | null = null
  private fns = new Map<ListenerName, Fn>()
  // ── Replayable state ──
  private layout: BuildingLayout | null = null
  private theme: 'light' | 'dark' | null = null
  private gfx: Effective | null = null
  private quality: GraphicsQuality | null = null
  private links: Link[] | null = null
  private surfaces: SceneSurfaces | null = null
  private highlighted: string | null = null
  private selected: string | null = null
  private suspended = false
  private focus: { ids: string[] | null; o: { dim: boolean; frame: boolean } } | null = null
  private projectLibrary: ProjectLibraryVM | null = null
  private roster: RosterInput | null = null
  /** Sims-style wall mode (3D only; graphics contract §13). */
  private wallMode: WallMode | null = null
  private plans = new Map<string, AgentPlan>()
  /** Switches run one after another; the last request wins. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private deps: SceneHostDeps) {
    this.current = deps.mode
    this.scene = deps.factory(deps.mode)
  }

  /**
   * Creates the host with its first scene made asynchronously (`factoryAsync`, else `factory`),
   * so a lazy-loaded mode can be the startup mode. Rejects when that scene can't be created.
   */
  static async initAsync(deps: SceneHostDeps): Promise<SceneHost> {
    const first = await (deps.factoryAsync
      ? deps.factoryAsync(deps.mode)
      : Promise.resolve().then(() => deps.factory(deps.mode)))
    let pending: SceneView | null = first
    return new SceneHost({
      ...deps,
      factory: (mode) => {
        if (pending && mode === deps.mode) {
          const s = pending
          pending = null
          return s
        }
        return deps.factory(mode)
      },
    })
  }

  /** The mode of the active scene. */
  get mode(): ViewMode {
    return this.current
  }

  /** The active scene (debug and tests). */
  get active(): SceneView {
    return this.scene
  }

  /**
   * Swaps to the scene for `mode` (no-op when it's already active). Resolves with the new scene's
   * assets once it has loaded and been replayed into; null when nothing was switched. Rejects
   * (and keeps the old scene) when the new one can't be created or loaded.
   */
  switchTo(mode: ViewMode): Promise<SceneAssets | null> {
    const run = this.queue.then(() => this.swap(mode))
    this.queue = run.catch(() => null)
    return run
  }

  private async swap(mode: ViewMode): Promise<SceneAssets | null> {
    if (mode === this.current) return null
    // Create and load the new scene first: if that fails (no WebGL…), the old one keeps running.
    const next = (
      this.deps.factoryAsync ? await this.deps.factoryAsync(mode) : this.deps.factory(mode)
    ) as AnyScene
    let assets: SceneAssets | null = null
    try {
      if (this.manifestUrl !== null) assets = await next.load(this.manifestUrl)
    } catch (err) {
      next.dispose?.()
      throw err
    }
    this.scene.dispose?.()
    this.scene = next
    this.current = mode
    this.attach(next)
    if (this.manifestUrl !== null) this.replay(next)
    return assets
  }

  private attach(s: AnyScene): void {
    for (const name of LISTENERS) {
      const fn = this.fns.get(name)
      const on = s[name] as ((fn: Fn) => void) | undefined
      if (fn && on) on.call(s, fn)
    }
  }

  private replay(s: AnyScene): void {
    if (this.layout) s.setBuilding(this.layout)
    if (this.theme) s.setTheme(this.theme)
    if (this.gfx) s.setGraphics(this.gfx)
    else if (this.quality) s.setQuality(this.quality)
    if (this.links) s.setLinks(this.links)
    if (this.surfaces) s.setSurfaces(this.surfaces)
    if (this.highlighted !== null) s.highlightLinks(this.highlighted)
    if (this.suspended) s.setInputSuspended?.(true)
    if (this.projectLibrary) s.setProjectLibrary?.(this.projectLibrary)
    if (this.wallMode) s.setWallMode?.(this.wallMode)
    if (this.roster) s.setRoster?.(this.roster)
    const resynced = this.deps.resync()
    const plans = resynced.size ? resynced : this.cachedPlans()
    if (plans.size) s.direct(plans, [])
    if (this.selected !== null) s.select(this.selected)
    if (this.focus?.ids) s.focusAgents?.(this.focus.ids, this.focus.o)
  }

  private cachedPlans(): Map<string, AgentPlan> {
    const out = new Map<string, AgentPlan>()
    for (const [id, p] of this.plans) {
      const { steps: _steps, ...rest } = p
      out.set(id, rest)
    }
    return out
  }

  private listen(name: ListenerName, fn: Fn): void {
    this.fns.set(name, fn)
    const on = this.scene[name] as ((fn: Fn) => void) | undefined
    on?.call(this.scene, fn)
  }

  // ── SceneView ──
  async load(manifestUrl: string): Promise<SceneAssets> {
    this.manifestUrl = manifestUrl
    const s = this.scene
    const assets = await s.load(manifestUrl)
    if (this.scene === s) this.attach(s)
    return assets
  }

  setBuilding(layout: BuildingLayout): void {
    this.layout = layout
    this.scene.setBuilding(layout)
  }

  direct(plans: Map<string, AgentPlan>, departed: string[]): void {
    for (const id of departed) this.plans.delete(id)
    for (const id of this.plans.keys()) if (!plans.has(id)) this.plans.delete(id)
    for (const [id, p] of plans) this.plans.set(id, p)
    this.scene.direct(plans, departed)
  }

  setLinks(links: Link[]): void {
    this.links = links
    this.scene.setLinks(links)
  }

  setSurfaces(s: SceneSurfaces): void {
    this.surfaces = s
    this.scene.setSurfaces(s)
  }

  onPickCapability(fn: (ref: CapabilityRef) => void): void {
    this.listen('onPickCapability', fn)
  }

  focusCapability(ref: CapabilityRef | null): void {
    this.scene.focusCapability(ref)
  }

  highlightLinks(capabilityId: string | null): void {
    this.highlighted = capabilityId
    this.scene.highlightLinks(capabilityId)
  }

  select(id: string | null): void {
    this.selected = id
    this.scene.select(id)
  }

  setQuality(q: GraphicsQuality): void {
    this.quality = q
    this.scene.setQuality(q)
  }

  onPick(fn: (id: string | null) => void): void {
    this.listen('onPick', fn)
  }

  goTo(viewId: string): void {
    this.scene.goTo(viewId)
  }

  cameraIdleMs(): number {
    return this.scene.cameraIdleMs()
  }

  setTheme(theme: 'light' | 'dark'): void {
    this.theme = theme
    this.scene.setTheme(theme)
  }

  setGraphics(e: Effective): void {
    this.gfx = e
    this.scene.setGraphics(e)
  }

  stats(): GraphicsStats {
    return this.scene.stats()
  }

  onContextLost(fn: () => void): void {
    this.listen('onContextLost', fn)
  }

  onContextRestored(fn: () => void): void {
    this.listen('onContextRestored', fn)
  }

  onHoverSurface(fn: (ref: CapabilityRef | null, x: number, y: number) => void): void {
    this.listen('onHoverSurface', fn)
  }

  onViews(fn: (views: ViewEntry[]) => void): void {
    this.listen('onViews', fn)
  }

  dispose(): void {
    this.scene.dispose?.()
  }

  onInteract(fn: (t: InteractTarget) => void): void {
    this.listen('onInteract', fn)
  }

  setInputSuspended(on: boolean): void {
    this.suspended = on
    this.scene.setInputSuspended?.(on)
  }

  onPlayerMove(fn: (pos: { x: number; z: number }) => void): void {
    this.listen('onPlayerMove', fn)
  }

  onRoom(fn: (roomName: string) => void): void {
    this.listen('onRoom', fn)
  }

  follow(agentId: string | null): void {
    this.scene.follow?.(agentId)
  }

  travelTo(target: { agentId?: string; viewId?: string; pos?: { x: number; z: number } }): void {
    this.scene.travelTo?.(target)
  }

  panTo(pos: { x: number; z: number }): void {
    this.scene.panTo?.(pos)
  }

  onCamera(fn: (view: TileRect) => void): void {
    this.listen('onCamera', fn)
  }

  onMinimapBase(
    fn: (img: CanvasImageSource, widthTiles: number, heightTiles: number) => void,
  ): void {
    this.listen('onMinimapBase', fn)
  }

  zoomBy(delta: -1 | 0 | 1): void {
    this.scene.zoomBy?.(delta)
  }

  onZoom(fn: (z: { level: number; levels: number; atDefault: boolean }) => void): void {
    this.listen('onZoom', fn)
  }

  onRun(fn: (on: boolean) => void): void {
    this.listen('onRun', fn)
  }

  focusAgents(ids: string[] | null, o: { dim: boolean; frame: boolean }): void {
    this.focus = ids ? { ids, o } : null
    this.scene.focusAgents?.(ids, o)
  }

  onPickFixture(fn: (f: { kind: 'project-directory' }) => void): void {
    this.listen('onPickFixture', fn)
  }

  onPickInteraction(fn: (hit: InteractionHit) => void): void {
    this.listen('onPickInteraction', fn)
  }

  setProjectLibrary(vm: ProjectLibraryVM | null): void {
    this.projectLibrary = vm
    this.scene.setProjectLibrary?.(vm)
  }

  setWallMode(m: WallMode): void {
    this.wallMode = m
    this.scene.setWallMode?.(m)
  }

  setRoster(roster: RosterInput): void {
    this.roster = roster
    this.scene.setRoster?.(roster)
  }

  // ── Adapter-level extras (main.ts) ──
  /** The active scene's hardware info (3D only; null in 2D). */
  hardwareInfo(): HardwareInfo | null {
    return this.scene.hardwareInfo?.() ?? null
  }

  /** FPS samples for the Settings readout, from whichever scene reports them. */
  onFrameStats(fn: (fps: number, preset: string) => void): void {
    this.listen('onFrameStats', fn)
  }
}
