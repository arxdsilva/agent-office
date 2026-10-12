// The 2D camera: follows a target with critically damped smoothing (k = 10), clamps to the map,
// and zooms in crisp whole-number steps: the zoom is the device px per art px (`app/pixel/zoom.ts`
// levels, from 1 = most zoomed out up to twice the fit scale), so pixels stay square. The overview
// fits the whole map (smoothed, non-integer) and is unchanged.
import { defaultZoom, nextZoom, viewSize, zoomLevels } from '../../app/pixel/zoom.ts'
import type { ViewRect } from './renderer.ts'

const K = 10

export interface ZoomInfo {
  /** Index in `levels`, 0 = most zoomed out. */
  level: number
  levels: number
  atDefault: boolean
}

export class PixelCamera {
  /** Centre in world px. */
  x = 0
  y = 0
  /** Device px per art px (an entry of `levels`). */
  zoom = 1
  overview = false
  /** Zoom levels as `zoomLevels` gives them: most zoomed in first. */
  private levels: number[] = [1]
  private fit = 0
  private tx = 0
  private ty = 0
  private snapNext = true

  /** Sets where to look (world px); `snap` jumps there at once. */
  target(x: number, y: number, snap = false): void {
    this.tx = x
    this.ty = y
    if (snap) this.snapNext = true
  }

  /**
   * The renderer's integer fit scale (device px per logical px) changed: rebuild the levels. The
   * first call starts at the default zoom; later ones keep the level when it still exists.
   */
  setFit(fitScale: number): boolean {
    if (fitScale === this.fit) return false
    const first = this.fit === 0
    this.fit = fitScale
    this.levels = zoomLevels(fitScale)
    if (!this.levels.length) this.levels = [1]
    const before = this.zoom
    if (first || !this.levels.includes(this.zoom)) this.zoom = this.defaultLevel()
    return first || before !== this.zoom
  }

  private defaultLevel(): number {
    const d = defaultZoom(this.fit)
    return this.levels.includes(d) ? d : this.levels[0]!
  }

  /** Steps out (−1), in (+1) or back to the default (0). True when the zoom changed. */
  zoomBy(delta: -1 | 0 | 1): boolean {
    const before = this.zoom
    const next = delta === 0 ? this.defaultLevel() : nextZoom(this.levels, this.zoom, delta)
    this.zoom = this.levels.includes(next) ? next : before
    return this.zoom !== before
  }

  info(): ZoomInfo {
    return {
      level: Math.max(0, this.levels.length - 1 - this.levels.indexOf(this.zoom)),
      levels: this.levels.length,
      atDefault: this.zoom === this.defaultLevel(),
    }
  }

  update(dt: number): void {
    if (this.snapNext) {
      this.x = this.tx
      this.y = this.ty
      this.snapNext = false
      return
    }
    const a = 1 - Math.exp(-K * dt)
    this.x += (this.tx - this.x) * a
    this.y += (this.ty - this.y) * a
  }

  /** The visible world rect for a logical view of `viewW`×`viewH` device px and a map in px. */
  view(viewW: number, viewH: number, mapW: number, mapH: number): ViewRect {
    if (this.overview) {
      const s = Math.min(viewW / mapW, viewH / mapH)
      const w = viewW / s
      const h = viewH / s
      return { x: (mapW - w) / 2, y: (mapH - h) / 2, w, h, scale: s }
    }
    const { w, h } = viewSize(viewW, viewH, this.zoom)
    const clamp = (c: number, size: number, max: number) =>
      max <= size ? (max - size) / 2 : Math.max(0, Math.min(max - size, c - size / 2))
    return {
      x: clamp(this.x, w, mapW),
      y: clamp(this.y, h, mapH),
      w,
      h,
      scale: this.zoom,
    }
  }
}
