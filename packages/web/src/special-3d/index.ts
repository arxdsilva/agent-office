// Night City (Special 3D), the optional third view mode: lazy-loaded by main.ts as its own chunk
// (`await import('./special-3d/index.ts')`). See docs/special-3d/architecture.md.
import { byId } from '../adapters/dom/el.ts'
import type { Effective } from '../app/graphics-types.ts'
import type { SimClock } from '../app/sim-clock.ts'
import { forcedSpecialFailure } from './failure.ts'
import { SPECIAL_COPY } from '../app/special/copy.ts'
import { SpecialScene, type SpecialGateway } from './adapters/special-scene.ts'

export { SpecialScene }

/** Builds the Night City scene into #stage; throws when it can't start (WebGL 2, test seam). */
export function createSpecialScene(
  clock: SimClock,
  o: { settings: SpecialGateway; powerPreference?: Effective['powerPreference'] },
): SpecialScene {
  if (forcedSpecialFailure()) throw new Error(SPECIAL_COPY.errors.forced)
  return new SpecialScene(
    {
      stage: byId('stage'),
      loading: {
        root: byId('loading'),
        fill: byId('loading-fill'),
        label: byId('loading-label'),
        tip: byId('loading-tip'),
      },
      crosshair: byId('crosshair'),
      walkHelp: byId('walk-help'),
    },
    clock,
    { settings: o.settings, ...(o.powerPreference && { powerPreference: o.powerPreference }) },
  )
}
