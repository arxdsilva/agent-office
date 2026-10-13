// Horizon (docs/horizon): the Classic office with a light flavor. Pure helpers the controller and
// the scene share: where the flavor's assets live and its calm name-tag default.
import type { ViewMode } from '@agent-office/shared'
import type { LabelMode } from '../graphics-types.ts'

/** Horizon's asset set (graphics contract §14): the Classic modules in the Horizon palettes. */
export const HORIZON_ASSET_BASE = 'horizon/'
/** Calm by default: name tags only near the camera (Settings → Graphics → Advanced overrides it). */
export const HORIZON_LABELS: LabelMode = 'nearby'

/** The flavor's manifest: `${assetBase}manifest.json` (the controller always asks for Classic's). */
export function manifestUrlFor(url: string, assetBase: string): string {
  return `${assetBase}${url.replace(/[?#].*$/, '').replace(/^.*\//, '')}`
}

/** The label default a view mode applies while the user's Advanced labels is Auto. */
export function labelsDefaultFor(mode: ViewMode | undefined): LabelMode | undefined {
  return mode === 'special' ? HORIZON_LABELS : undefined
}
