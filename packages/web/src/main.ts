// Renderer composition root: real adapters → controller. Excluded from coverage (rendering only).
import { byProviderAndTopic, type ViewMode } from '@agent-office/shared'
import { DomBanner, DomHud } from './adapters/dom/hud.ts'
import { byId } from './adapters/dom/el.ts'
import { DomCapabilityPanel } from './adapters/dom/capability-panel.ts'
import { DomConnectPanel, SNIPPET_LANG_KEY } from './adapters/dom/connect-panel.ts'
import { DomEmptyState } from './adapters/dom/empty-state.ts'
import { DomToast } from './adapters/dom/toast.ts'
import { DomPanel } from './adapters/dom/panel.ts'
import { DomNewSession } from './adapters/dom/new-session-dialog.ts'
import { DomSettings } from './adapters/dom/settings-dialog.ts'
import { showGfxFailure } from './adapters/dom/gfx-failure.ts'
import { DomLibrary } from './adapters/dom/library-browser.ts'
import { DomTooltip } from './adapters/dom/tooltip.ts'
import { DomViewBar } from './adapters/dom/view-bar.ts'
import { DomDialogue } from './adapters/dom/dialogue.ts'
import { DomModeToggle } from './adapters/dom/mode-toggle.ts'
import { DomPixelHud } from './adapters/dom/pixel-hud.ts'
import { PixelScene } from './adapters/pixel/scene.ts'
import { SceneHost } from './adapters/scene-host.ts'
import { preloadGateway } from './adapters/preload-gateway.ts'
import { ThreeScene, type SceneElements } from './adapters/three/scene.ts'
import type { SnippetLang } from './app/connect-types.ts'
import type { Effective } from './app/graphics-types.ts'
import { PRESETS } from './app/quality.ts'
import { createSimClock, type SimClock } from './app/sim-clock.ts'
import { createController } from './controller.ts'
import type { AgentPlan } from './app/office-types.ts'
import type { OfficeGateway, SceneView } from './ports.ts'

type PowerPreference = Effective['powerPreference']
/** The scene's constructor with the startup options (RA: `powerPreference` is read once, at start). */
type SceneCtor = new (
  el: SceneElements,
  clock: SimClock,
  opts?: { powerPreference?: PowerPreference },
) => ThreeScene

/** The 2D scene's constructor (Canvas2D; draws into #stage, no WebGL). */
type PixelSceneCtor = new (el: PixelElements, clock: SimClock) => SceneView
interface PixelElements {
  stage: HTMLElement
  loading: { root: HTMLElement; fill: HTMLElement; label: HTMLElement; tip: HTMLElement }
  views: HTMLElement
}

/** Renderer `powerPreference` for the saved preset (Auto: the scene's default), and the view mode. */
async function startupSettings(
  gateway: OfficeGateway,
): Promise<{ powerPreference: PowerPreference | undefined; viewMode: ViewMode }> {
  try {
    const { graphicsQuality, viewMode } = await gateway.settings.get()
    const mode: ViewMode = viewMode === 'pixel' ? 'pixel' : '3d'
    if (graphicsQuality === 'auto') return { powerPreference: undefined, viewMode: mode }
    const spec = PRESETS[graphicsQuality] as { powerPreference?: PowerPreference } | undefined
    return { powerPreference: spec?.powerPreference, viewMode: mode }
  } catch {
    return { powerPreference: undefined, viewMode: '3d' }
  }
}

/** Builds the 2D RPG view (plan §2.1): a Canvas2D scene, so it never touches WebGL. */
function createPixelScene(clock: SimClock): SceneView {
  const elements: PixelElements = {
    stage: byId('stage'),
    loading: {
      root: byId('loading'),
      fill: byId('loading-fill'),
      label: byId('loading-label'),
      tip: byId('loading-tip'),
    },
    views: byId('views'),
  }
  return new (PixelScene as unknown as PixelSceneCtor)(elements, clock)
}

/** Builds the 3D view; throws when WebGL can't start (or `?forceWebglFail=1`, a test seam). */
function createScene(clock: SimClock, powerPreference: PowerPreference | undefined): ThreeScene {
  if (new URLSearchParams(location.search).get('forceWebglFail') === '1')
    throw new Error('WebGL start was forced to fail (AGENT_OFFICE_FORCE_WEBGL_FAIL)')
  // A variable, not a literal: the element list may shrink as the scene hands DOM to adapters.
  const elements = {
    stage: byId('stage'),
    walkButton: byId('walk'),
    fitButton: byId('fit'),
    crosshair: byId('crosshair'),
    walkHelp: byId('walk-help'),
    loading: {
      root: byId('loading'),
      fill: byId('loading-fill'),
      label: byId('loading-label'),
      tip: byId('loading-tip'),
    },
    views: byId('views'),
    wingSigns: byId('wing-signs'),
    stats: byId('stats'),
    capabilities: byId('capability-list'),
    links: byId('link-list'),
  }
  const Scene = ThreeScene as unknown as SceneCtor
  return new Scene(elements, clock, powerPreference ? { powerPreference } : {})
}

/** Last snippet language (per viewer); storage may be unavailable. */
function storedSnippetLang(): SnippetLang | undefined {
  try {
    const v = localStorage.getItem(SNIPPET_LANG_KEY)
    return v === 'curl' || v === 'python' || v === 'js' ? v : undefined
  } catch {
    return undefined
  }
}

async function boot(): Promise<void> {
  const gateway = preloadGateway()
  // One simulation clock for the director (controller) and the scene, so their timings agree.
  const clock = createSimClock()
  const startup = await startupSettings(gateway)
  // The optional 2D RPG mode (plan §2.5): the host forwards to the active scene and swaps it on a
  // viewMode change. The saved mode's scene is created first, so a 2D user never starts WebGL.
  let resync: (() => Map<string, AgentPlan>) | null = null
  let scene: SceneHost
  try {
    scene = new SceneHost({
      mode: startup.viewMode,
      factory: (mode) =>
        mode === 'pixel' ? createPixelScene(clock) : createScene(clock, startup.powerPreference),
      resync: () => resync?.() ?? new Map(),
    })
  } catch (e) {
    showGfxFailure(gateway, e)
    return
  }
  document.body.dataset.mode = startup.viewMode
  const settings = new DomSettings()
  // Fallback FPS readout in Settings → Graphics until the controller pushes the full stats line.
  scene.onFrameStats((fps, preset) => settings.showFrameRate(fps, preset))
  const toast = new DomToast()

  const snippetLang = storedSnippetLang()
  // A variable, not a literal: the Library, tooltip and view-bar views are new ControllerDeps.
  const deps = {
    gateway,
    scene,
    panel: new DomPanel(),
    hud: new DomHud(),
    settings,
    banner: new DomBanner(),
    capabilityPanel: new DomCapabilityPanel(),
    connect: new DomConnectPanel(),
    empty: new DomEmptyState(),
    toast,
    newSession: new DomNewSession(),
    library: new DomLibrary(),
    tooltip: new DomTooltip(),
    viewBar: new DomViewBar(),
    // The scene follows the effective color scheme (Settings → Appearance drives it from main).
    matchMedia: (q: string) => window.matchMedia(q),
    isWindows: /Windows/i.test(navigator.userAgent),
    isMac: /Macintosh|Mac OS X/i.test(navigator.userAgent),
    // Power saver and Auto tiering inputs (low-spec plan §5.1, §5.7).
    doc: document,
    win: window,
    hardware: () => scene.hardwareInfo(),
    // The 2D RPG mode's views (plan §8.2, §9); inert while the 3D office is shown.
    dialogue: new DomDialogue(),
    pixelHud: new DomPixelHud(),
    modeToggle: new DomModeToggle(),
    onViewMode: (mode: ViewMode) => switchMode(mode),
    devicePixelRatio: () => window.devicePixelRatio,
    ...(snippetLang && { snippetLang }),
    grouping: byProviderAndTopic,
    clock,
    every: (ms: number, fn: () => void) => {
      const h = setInterval(fn, ms)
      return () => clearInterval(h)
    },
    after: (ms: number, fn: () => void) => {
      const h = setTimeout(fn, ms)
      return () => clearTimeout(h)
    },
  }
  /** Swaps the scene; when the new one can't start (e.g. no WebGL), goes back to the old mode. */
  const switchMode = async (mode: ViewMode): Promise<void> => {
    const previous = scene.mode
    if (mode === previous) return
    document.body.dataset.mode = mode
    try {
      await scene.switchTo(mode)
    } catch (e) {
      document.body.dataset.mode = scene.mode
      toast.show(e instanceof Error ? e.message : String(e))
      if (scene.mode !== mode) await gateway.settings.set({ viewMode: scene.mode }).catch(() => {})
    }
  }
  const controller = createController(deps)
  // The director's resync (plan §2.3) lets a freshly shown scene continue agents where they are.
  const r = (controller as { resync?: (now?: number) => Map<string, AgentPlan> }).resync
  if (r) resync = () => r.call(controller)
  await controller.start()
}
void boot()
