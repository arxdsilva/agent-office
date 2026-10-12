// The 2D camera: follows a target with critically damped smoothing (k = 10), zooms 1–3× (integer),
// clamps to the map, and has an overview mode that fits the whole map (smoothed, non-integer).
import { VIEW_H, VIEW_W } from '../../app/pixel/types.ts'
import type { ViewRect } from './renderer.ts'

const K = 10

export class PixelCamera {
  /** Centre in world px. */
  x = 0
  y = 0
  zoom = 1
  overview = false
  private tx = 0
  private ty = 0
  private snapNext = true

  /** Sets where to look (world px); `snap` jumps there at once. */
  target(x: number, y: number, snap = false): void {
    this.tx = x
    this.ty = y
    if (snap) this.snapNext = true
  }

  setZoom(z: number): void {
    this.zoom = Math.max(1, Math.min(3, Math.round(z)))
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

  /** The visible world rect for a renderer of `scale` device px per logical px. */
  view(scale: number, mapW: number, mapH: number): ViewRect {
    if (this.overview) {
      const s = Math.min((VIEW_W * scale) / mapW, (VIEW_H * scale) / mapH)
      const w = (VIEW_W * scale) / s
      const h = (VIEW_H * scale) / s
      return { x: (mapW - w) / 2, y: (mapH - h) / 2, w, h, scale: s }
    }
    const w = VIEW_W / this.zoom
    const h = VIEW_H / this.zoom
    const clamp = (c: number, size: number, max: number) =>
      max <= size ? (max - size) / 2 : Math.max(0, Math.min(max - size, c - size / 2))
    return {
      x: clamp(this.x, w, mapW),
      y: clamp(this.y, h, mapH),
      w,
      h,
      scale: scale * this.zoom,
    }
  }
}
