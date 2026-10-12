// The 2D canvas: a 480×270 logical view inside #stage, integer-scaled to the window in device
// pixels (crisp: no smoothing) and letterboxed. Static floor/wall layers are pre-rendered into
// 512×512 chunks (32×32 tiles) and only the visible ones are drawn.
import { TILE_PX, VIEW_H, VIEW_W, type PixelMap } from '../../app/pixel/types.ts'
import type { PixelTiles } from './tiles.ts'

/** Tiles per chunk side (512 px). */
export const CHUNK_TILES = 32
const CHUNK_PX = CHUNK_TILES * TILE_PX

/** A view of the world: top-left in world px and world px → device px scale. */
export interface ViewRect {
  x: number
  y: number
  w: number
  h: number
  scale: number
}

export class PixelRenderer {
  readonly canvas = document.createElement('canvas')
  readonly ctx: CanvasRenderingContext2D
  /** Device px per logical px (integer ≥ 1). */
  scale = 1
  /** Letterbox offset of the logical view (device px). */
  offX = 0
  offY = 0
  width = 0
  height = 0

  constructor(private stage: HTMLElement) {
    this.canvas.id = 'pixel'
    this.canvas.setAttribute('aria-label', '2D office')
    Object.assign(this.canvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      imageRendering: 'pixelated',
      display: 'block',
    })
    stage.append(this.canvas)
    const ctx = this.canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Canvas 2D is unavailable')
    this.ctx = ctx
    this.resize()
  }

  /** Matches the backing store to the window in device pixels and picks the integer scale. */
  resize(): void {
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1
    const cssW = this.stage.clientWidth || innerWidth
    const cssH = this.stage.clientHeight || innerHeight
    this.width = Math.max(1, Math.round(cssW * dpr))
    this.height = Math.max(1, Math.round(cssH * dpr))
    if (this.canvas.width !== this.width) this.canvas.width = this.width
    if (this.canvas.height !== this.height) this.canvas.height = this.height
    this.scale = Math.max(1, Math.floor(Math.min(this.width / VIEW_W, this.height / VIEW_H)))
    this.offX = Math.floor((this.width - VIEW_W * this.scale) / 2)
    this.offY = Math.floor((this.height - VIEW_H * this.scale) / 2)
    this.ctx.imageSmoothingEnabled = false
  }

  /** Device px of the logical view (the letterboxed area). */
  get viewW(): number {
    return VIEW_W * this.scale
  }
  get viewH(): number {
    return VIEW_H * this.scale
  }

  /** Clears to the letterbox colour and clips to the logical view; call `end` after drawing. */
  begin(background: string): void {
    const c = this.ctx
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.fillStyle = '#000'
    c.fillRect(0, 0, this.width, this.height)
    c.save()
    c.beginPath()
    c.rect(this.offX, this.offY, this.viewW, this.viewH)
    c.clip()
    c.fillStyle = background
    c.fillRect(this.offX, this.offY, this.viewW, this.viewH)
  }

  /** World px → device px transform for a view (positions snapped to device pixels). */
  world(v: ViewRect, smooth = false): void {
    const s = v.scale
    this.ctx.setTransform(
      s,
      0,
      0,
      s,
      this.offX - Math.round(v.x * s),
      this.offY - Math.round(v.y * s),
    )
    this.ctx.imageSmoothingEnabled = smooth
  }

  /** Screen (logical-view) transform: 1 unit = 1 logical px. */
  screen(): void {
    this.ctx.setTransform(this.scale, 0, 0, this.scale, this.offX, this.offY)
    this.ctx.imageSmoothingEnabled = false
  }

  end(): void {
    this.ctx.restore()
    this.ctx.setTransform(1, 0, 0, 1, 0, 0)
  }

  /** CSS px (client) → world px for a view. */
  toWorldPx(clientX: number, clientY: number, v: ViewRect): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect()
    const dx = ((clientX - r.left) / Math.max(1, r.width)) * this.width
    const dy = ((clientY - r.top) / Math.max(1, r.height)) * this.height
    return {
      x: (dx - this.offX + Math.round(v.x * v.scale)) / v.scale,
      y: (dy - this.offY + Math.round(v.y * v.scale)) / v.scale,
    }
  }

  /** World px → CSS px (tooltips). */
  toClient(x: number, y: number, v: ViewRect): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect()
    const dx = this.offX + x * v.scale - Math.round(v.x * v.scale)
    const dy = this.offY + y * v.scale - Math.round(v.y * v.scale)
    return { x: r.left + (dx / this.width) * r.width, y: r.top + (dy / this.height) * r.height }
  }

  bytes(): number {
    return this.width * this.height * 4
  }

  dispose(): void {
    this.canvas.width = this.canvas.height = 0
    this.canvas.remove()
  }
}

type Layer = 'base' | 'overhead'

/** Pre-rendered map chunks, built lazily for visible chunks; invalidated per changed module. */
export class ChunkCache {
  private chunks = new Map<string, HTMLCanvasElement | null>()
  private pool: HTMLCanvasElement[] = []
  private map: PixelMap | null = null

  constructor(private tiles: PixelTiles) {}

  /** A new map: keep chunks outside the changed modules when the grid didn't move. */
  setMap(map: PixelMap): void {
    const prev = this.map
    this.map = map
    const same =
      prev &&
      prev.widthTiles === map.widthTiles &&
      prev.heightTiles === map.heightTiles &&
      prev.originM.x === map.originM.x &&
      prev.originM.z === map.originM.z
    if (!same) return this.clear()
    for (const id of map.dirty) {
      const room =
        map.rooms.find((r) => r.placement === id) ?? prev.rooms.find((r) => r.placement === id)
      if (!room) return this.clear()
      const r = room.rect
      for (
        let cy = Math.floor((r.ty - 1) / CHUNK_TILES);
        cy <= Math.floor((r.ty + r.th) / CHUNK_TILES);
        cy++
      )
        for (
          let cx = Math.floor((r.tx - 1) / CHUNK_TILES);
          cx <= Math.floor((r.tx + r.tw) / CHUNK_TILES);
          cx++
        )
          for (const layer of ['base', 'overhead'] as const) this.drop(`${layer}:${cx}:${cy}`)
    }
  }

  /** Every tile drawing changed (atlas loaded). */
  clear(): void {
    for (const k of [...this.chunks.keys()]) this.drop(k)
  }

  private drop(key: string): void {
    const c = this.chunks.get(key)
    if (c) this.pool.push(c)
    this.chunks.delete(key)
  }

  /** Draws the visible chunks of a layer (the context is in world px). Returns the count drawn. */
  draw(ctx: CanvasRenderingContext2D, layer: Layer, v: ViewRect): number {
    const m = this.map
    if (!m) return 0
    let n = 0
    const cx0 = Math.max(0, Math.floor(v.x / CHUNK_PX))
    const cy0 = Math.max(0, Math.floor(v.y / CHUNK_PX))
    const cx1 = Math.min(
      Math.ceil(m.widthTiles / CHUNK_TILES) - 1,
      Math.floor((v.x + v.w) / CHUNK_PX),
    )
    const cy1 = Math.min(
      Math.ceil(m.heightTiles / CHUNK_TILES) - 1,
      Math.floor((v.y + v.h) / CHUNK_PX),
    )
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = this.chunk(layer, cx, cy)
        if (!c) continue
        ctx.drawImage(c, cx * CHUNK_PX, cy * CHUNK_PX)
        n++
      }
    return n
  }

  private chunk(layer: Layer, cx: number, cy: number): HTMLCanvasElement | null {
    const key = `${layer}:${cx}:${cy}`
    if (this.chunks.has(key)) return this.chunks.get(key)!
    const m = this.map!
    const canvas = this.pool.pop() ?? document.createElement('canvas')
    canvas.width = CHUNK_PX
    canvas.height = CHUNK_PX
    const c = canvas.getContext('2d')!
    c.clearRect(0, 0, CHUNK_PX, CHUNK_PX)
    c.imageSmoothingEnabled = false
    let any = false
    const layers = layer === 'base' ? [m.layers.floor, m.layers.walls] : [m.layers.overhead]
    for (let ty = 0; ty < CHUNK_TILES; ty++) {
      const y = cy * CHUNK_TILES + ty
      if (y >= m.heightTiles) break
      for (let tx = 0; tx < CHUNK_TILES; tx++) {
        const x = cx * CHUNK_TILES + tx
        if (x >= m.widthTiles) break
        for (let l = 0; l < layers.length; l++) {
          const id = layers[l]![y * m.widthTiles + x]!
          if (!id) continue
          const wl = layers[l]!
          const at = (xx: number, yy: number) =>
            xx >= 0 &&
            yy >= 0 &&
            xx < m.widthTiles &&
            yy < m.heightTiles &&
            wl[yy * m.widthTiles + xx]! > 0
          // Connected walls (N=1 E=2 S=4 W=8) for the atlas wall-top set.
          const mask =
            l === 0 && layer === 'base'
              ? 0
              : (at(x, y - 1) ? 1 : 0) |
                (at(x + 1, y) ? 2 : 0) |
                (at(x, y + 1) ? 4 : 0) |
                (at(x - 1, y) ? 8 : 0)
          this.tiles.draw(c, id, tx * TILE_PX, ty * TILE_PX, x, y, mask)
          any = true
        }
      }
    }
    if (!any && layer === 'overhead') {
      this.pool.push(canvas)
      this.chunks.set(key, null)
      return null
    }
    this.chunks.set(key, canvas)
    return canvas
  }

  /** Approximate bytes held by chunk canvases. */
  bytes(): number {
    let n = 0
    for (const c of this.chunks.values()) if (c) n += CHUNK_PX * CHUNK_PX * 4
    return n
  }

  dispose(): void {
    for (const c of this.chunks.values()) if (c) c.width = c.height = 0
    for (const c of this.pool) c.width = c.height = 0
    this.chunks.clear()
    this.pool = []
    this.map = null
  }
}
