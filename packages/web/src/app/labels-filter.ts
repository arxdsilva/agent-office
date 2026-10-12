// Which name tags show (low-spec plan §5.3, Name tags lever). Pure and allocation-free: the labels
// adapter asks per tag per frame. The selected agent's tag always shows, at full strength.
import type { LabelMode } from './graphics-types.ts'

export interface LabelFilter {
  mode: LabelMode
  /** Radius for 'nearby' (m). */
  nearbyM: number
  selected: string | null
}

export function labelVisible(f: LabelFilter, id: string, distance: number): boolean {
  if (id === f.selected) return true
  if (f.mode === 'selected') return false
  return f.mode === 'all' || distance < f.nearbyM
}

/** Hidden tags cost nothing: no occlusion ray. The selected tag never dims, so it needs none. */
export const needsOcclusion = (f: LabelFilter, id: string, distance: number): boolean =>
  id !== f.selected && labelVisible(f, id, distance)
