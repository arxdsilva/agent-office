// Renderer composition root: real adapters → controller. Excluded from coverage (rendering only).
import { byProviderAndTopic } from '@agent-office/shared'
import { DomBanner, DomHud } from './adapters/dom/hud.ts'
import { byId } from './adapters/dom/el.ts'
import { DomCapabilityPanel } from './adapters/dom/capability-panel.ts'
import { DomConnectPanel, SNIPPET_LANG_KEY } from './adapters/dom/connect-panel.ts'
import { DomEmptyState } from './adapters/dom/empty-state.ts'
import { DomToast } from './adapters/dom/toast.ts'
import { DomPanel } from './adapters/dom/panel.ts'
import { DomSettings } from './adapters/dom/settings-dialog.ts'
import { preloadGateway } from './adapters/preload-gateway.ts'
import { ThreeScene } from './adapters/three/scene.ts'
import type { SnippetLang } from './app/connect-types.ts'
import { createSimClock } from './app/sim-clock.ts'
import { createController } from './controller.ts'

// One simulation clock for the director (controller) and the scene, so their timings agree.
const clock = createSimClock()

const scene = new ThreeScene(
  {
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
  },
  clock,
)
const settings = new DomSettings()
// Live FPS readout in Settings → Graphics (adapter to adapter, no decisions involved).
scene.onFrameStats((fps, preset) => settings.showFrameRate(fps, preset))

/** Last snippet language (per viewer); storage may be unavailable. */
function storedSnippetLang(): SnippetLang | undefined {
  try {
    const v = localStorage.getItem(SNIPPET_LANG_KEY)
    return v === 'curl' || v === 'python' || v === 'js' ? v : undefined
  } catch {
    return undefined
  }
}
const snippetLang = storedSnippetLang()

const controller = createController({
  gateway: preloadGateway(),
  scene,
  panel: new DomPanel(),
  hud: new DomHud(),
  settings,
  banner: new DomBanner(),
  capabilityPanel: new DomCapabilityPanel(),
  connect: new DomConnectPanel(),
  empty: new DomEmptyState(),
  toast: new DomToast(),
  isWindows: /Windows/i.test(navigator.userAgent),
  ...(snippetLang && { snippetLang }),
  grouping: byProviderAndTopic,
  clock,
  every: (ms, fn) => {
    const h = setInterval(fn, ms)
    return () => clearInterval(h)
  },
  after: (ms, fn) => {
    const h = setTimeout(fn, ms)
    return () => clearTimeout(h)
  },
})
void controller.start()
