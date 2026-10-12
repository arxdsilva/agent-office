// 2D zoom as whole device px per art px (plan "2D at GBA scale" §4b), so pixels stay square and
// crisp at every level. The fit scale is the integer scale that fits the 480×270 logical view to
// the window; the levels run from twice that (zoomed in) down to 1 (the most zoomed out). Pure.

const fit = (fitScale: number) => Math.max(1, Math.floor(fitScale))

/** Device px per art px, descending: fitScale·2 … 1 (whole numbers, unique). */
export function zoomLevels(fitScale: number): number[] {
  const out: number[] = []
  for (let p = 2 * fit(fitScale); p >= 1; p--) out.push(p)
  return out
}

/** The level the view starts at (and `⌂` returns to): the fit scale. */
export const defaultZoom = (fitScale: number): number => fit(fitScale)

/**
 * The level after a zoom input: −1 zooms out (a smaller level), +1 zooms in, 0 returns to the
 * default (half the largest level). Clamped to the list; a `current` not in it snaps to the nearest.
 */
export function nextZoom(levels: readonly number[], current: number, delta: -1 | 0 | 1): number {
  if (!levels.length) return current
  const nearest = (v: number) =>
    levels.reduce((best, l, i) => (Math.abs(l - v) < Math.abs(levels[best]! - v) ? i : best), 0)
  if (delta === 0) return levels[nearest(levels[0]! / 2)]!
  // Levels descend: zooming out (−1) moves to a later index.
  const i = Math.min(levels.length - 1, Math.max(0, nearest(current) - delta))
  return levels[i]!
}

/** The view in art px for a device size at a level (rounded up to cover the screen). */
export const viewSize = (deviceW: number, deviceH: number, level: number) => ({
  w: Math.ceil(deviceW / level),
  h: Math.ceil(deviceH / level),
})
