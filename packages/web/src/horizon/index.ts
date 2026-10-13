// Horizon, the optional third view mode (internal id 'special'): the Classic office with a light,
// calm flavor. Lazy-loaded by main.ts as its own chunk (`await import('./horizon/index.ts')`), so
// the other modes never download it. See docs/horizon/rendering.md.
import { byId } from '../adapters/dom/el.ts'
import type { Effective } from '../app/graphics-types.ts'
import type { SimClock } from '../app/sim-clock.ts'
import { HORIZON_COPY } from '../app/horizon/copy.ts'
import { forcedHorizonFailure } from './failure.ts'
import { HorizonScene, type HorizonSettings } from './adapters/horizon-scene.ts'

export { HorizonScene }

/** Builds Horizon into #stage; throws when it can't start (WebGL, the `forceSpecialFail` seam). */
export function createHorizonScene(
  clock: SimClock,
  o: { settings: HorizonSettings; powerPreference?: Effective['powerPreference'] },
): HorizonScene {
  if (forcedHorizonFailure()) throw new Error(HORIZON_COPY.errors.forced)
  // A variable, not a literal: the same elements as the Classic scene (main.ts createScene).
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
  return new HorizonScene(elements, clock, o.settings, {
    ...(o.powerPreference && { powerPreference: o.powerPreference }),
  })
}
