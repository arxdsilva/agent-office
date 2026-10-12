// Renderer composition root: real adapters → controller. Excluded from coverage (rendering only).
import { byProviderAndTopic } from '@agent-office/shared'
import { DomBanner, DomHud } from './adapters/dom/hud.ts'
import { byId } from './adapters/dom/el.ts'
import { DomPanel } from './adapters/dom/panel.ts'
import { DomSettings } from './adapters/dom/settings-dialog.ts'
import { preloadGateway } from './adapters/preload-gateway.ts'
import { ThreeScene } from './adapters/three/scene.ts'
import { createController } from './controller.ts'

const controller = createController({
  gateway: preloadGateway(),
  scene: new ThreeScene({
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
  }),
  panel: new DomPanel(),
  hud: new DomHud(),
  settings: new DomSettings(),
  banner: new DomBanner(),
  grouping: byProviderAndTopic,
  clock: { now: () => Date.now() },
  every: (ms, fn) => {
    const h = setInterval(fn, ms)
    return () => clearInterval(h)
  },
})
void controller.start()
