// Renderer composition root: real adapters → controller. Excluded from coverage (rendering only).
import { byProviderAndTopic } from '@agent-office/shared'
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
import { preloadGateway } from './adapters/preload-gateway.ts'
import { ThreeScene, type SceneElements } from './adapters/three/scene.ts'
import type { SnippetLang } from './app/connect-types.ts'
import type { Effective } from './app/graphics-types.ts'
import { PRESETS } from './app/quality.ts'
import { createSimClock, type SimClock } from './app/sim-clock.ts'
import { createController } from './controller.ts'
import type { OfficeGateway } from './ports.ts'

type PowerPreference = Effective['powerPreference']
/** The scene's constructor with the startup options (RA: `powerPreference` is read once, at start). */
type SceneCtor = new (
  el: SceneElements,
  clock: SimClock,
  opts?: { powerPreference?: PowerPreference },
) => ThreeScene

/** Renderer `powerPreference` for the saved preset (Auto: the scene's default). */
async function startupPowerPreference(
  gateway: OfficeGateway,
): Promise<PowerPreference | undefined> {
  try {
    const { graphicsQuality } = await gateway.settings.get()
    if (graphicsQuality === 'auto') return undefined
    const spec = PRESETS[graphicsQuality] as { powerPreference?: PowerPreference } | undefined
    return spec?.powerPreference
  } catch {
    return undefined
  }
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
  let scene: ThreeScene
  try {
    scene = createScene(clock, await startupPowerPreference(gateway))
  } catch (e) {
    showGfxFailure(gateway, e)
    return
  }
  const settings = new DomSettings()
  // Fallback FPS readout in Settings → Graphics until the controller pushes the full stats line.
  const frameStats = (scene as { onFrameStats?: (fn: (fps: number, p: string) => void) => void })
    .onFrameStats
  frameStats?.call(scene, (fps, preset) => settings.showFrameRate(fps, preset))

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
    toast: new DomToast(),
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
  await createController(deps).start()
}
void boot()
