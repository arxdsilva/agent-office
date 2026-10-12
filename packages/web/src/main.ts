// Renderer composition root: real adapters → controller. Excluded from coverage (rendering only).
import { byProviderAndTopic } from '@agent-office/shared'
import { DomBanner, DomHud } from './adapters/dom/hud.ts'
import { byId } from './adapters/dom/el.ts'
import { DomCapabilityPanel } from './adapters/dom/capability-panel.ts'
import { DomPanel } from './adapters/dom/panel.ts'
import { DomSettings } from './adapters/dom/settings-dialog.ts'
import { preloadGateway } from './adapters/preload-gateway.ts'
import { ThreeScene } from './adapters/three/scene.ts'
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

const controller = createController({
  gateway: preloadGateway(),
  scene,
  panel: new DomPanel(),
  hud: new DomHud(),
  settings,
  banner: new DomBanner(),
  capabilityPanel: new DomCapabilityPanel(),
  grouping: byProviderAndTopic,
  clock,
  every: (ms, fn) => {
    const h = setInterval(fn, ms)
    return () => clearInterval(h)
  },
})
void controller.start()
