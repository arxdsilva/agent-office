// The 2D canvas: a 480×270 logical view inside #stage, integer-scaled to the window in device
// pixels (crisp: no smoothing) and letterboxed; the camera's zoom level sets how many device px an
// art px covers inside it. Floors and flat walls are pre-rendered into 512×512 chunks (32×32 one-
// metre tiles) and only the visible ones are drawn.
import { TILE_PX, VIEW_H, VIEW_W, type MapWall, type PixelMap } from '../../app/pixel/types.ts'
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

/** Walls baked into the chunks (flat: vertical runs and runs without a face); the rest y-sort. */
export const flatWall = (w: MapWall) => w.face !== 's'

/** Each room's floor tile: the id of the 1 m cell at its centre (0: none). */
function roomFloors(m: PixelMap): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of m.rooms) {
    const tx = Math.floor((r.box.x + r.box.w / 2) / TILE_PX)
    const ty = Math.floor((r.box.y + r.box.h / 2) / TILE_PX)
    const ok = tx >= 0 && ty >= 0 && tx < m.widthTiles && ty < m.heightTiles
    out.set(r.id, ok ? m.layers.floor[ty * m.widthTiles + tx]! : 0)
  }
  return out
}

/**
 * Pre-rendered map chunks (512 px = 32 m), built lazily for visible chunks and invalidated per
 * changed module: floors per 1 m cell, re-drawn per room clipped to its exact box (so floor seams
 * follow the real walls, not the grid), then the flat walls.
 */
export class ChunkCache {
  private chunks = new Map<string, HTMLCanvasElement | null>()
  private pool: HTMLCanvasElement[] = []
  private map: PixelMap | null = null
  private floors = new Map<string, number>()

  constructor(
    private tiles: PixelTiles,
    private paintWall: (c: CanvasRenderingContext2D, w: MapWall) => void = () => {},
  ) {}

  /** A new map: keep chunks outside the changed modules when the grid didn't move. */
  setMap(map: PixelMap): void {
    const prev = this.map
    this.map = map
    this.floors = roomFloors(map)
    const same =
      prev &&
      prev.widthPx === map.widthPx &&
      prev.heightPx === map.heightPx &&
      prev.originM.x === map.originM.x &&
      prev.originM.z === map.originM.z
    if (!same) return this.clear()
    for (const id of map.dirty) {
      const boxes = [...map.rooms, ...prev.rooms].filter((r) => r.placement === id)
      if (!boxes.length) return this.clear()
      for (const { box: b } of boxes) {
        const pad = TILE_PX
        for (
          let cy = Math.floor((b.y - pad) / CHUNK_PX);
          cy <= Math.floor((b.y + b.h + pad) / CHUNK_PX);
          cy++
        )
          for (
            let cx = Math.floor((b.x - pad) / CHUNK_PX);
            cx <= Math.floor((b.x + b.w + pad) / CHUNK_PX);
            cx++
          )
            this.drop(`${cx}:${cy}`)
      }
    }
  }

  /** Every drawing changed (atlas loaded). */
  clear(): void {
    for (const k of [...this.chunks.keys()]) this.drop(k)
  }

  private drop(key: string): void {
    const c = this.chunks.get(key)
    if (c) this.pool.push(c)
    this.chunks.delete(key)
  }

  /** Draws the visible chunks (the context is in world px). Returns the count drawn. */
  draw(ctx: CanvasRenderingContext2D, v: ViewRect): number {
    const m = this.map
    if (!m) return 0
    let n = 0
    const cx0 = Math.max(0, Math.floor(v.x / CHUNK_PX))
    const cy0 = Math.max(0, Math.floor(v.y / CHUNK_PX))
    const cx1 = Math.min(Math.ceil(m.widthPx / CHUNK_PX) - 1, Math.floor((v.x + v.w) / CHUNK_PX))
    const cy1 = Math.min(Math.ceil(m.heightPx / CHUNK_PX) - 1, Math.floor((v.y + v.h) / CHUNK_PX))
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = this.chunk(cx, cy)
        if (!c) continue
        ctx.drawImage(c, cx * CHUNK_PX, cy * CHUNK_PX)
        n++
      }
    return n
  }

  private chunk(cx: number, cy: number): HTMLCanvasElement | null {
    const key = `${cx}:${cy}`
    if (this.chunks.has(key)) return this.chunks.get(key)!
    const m = this.map!
    const canvas = this.pool.pop() ?? document.createElement('canvas')
    canvas.width = CHUNK_PX
    canvas.height = CHUNK_PX
    const c = canvas.getContext('2d')!
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.clearRect(0, 0, CHUNK_PX, CHUNK_PX)
    c.imageSmoothingEnabled = false
    const ox = cx * CHUNK_PX
    const oy = cy * CHUNK_PX
    const tx0 = cx * CHUNK_TILES
    const ty0 = cy * CHUNK_TILES
    const tx1 = Math.min(m.widthTiles, tx0 + CHUNK_TILES)
    const ty1 = Math.min(m.heightTiles, ty0 + CHUNK_TILES)
    // 1. Every cell's own floor (streets, gaps between rooms).
    for (let y = ty0; y < ty1; y++)
      for (let x = tx0; x < tx1; x++) {
        const id = m.layers.floor[y * m.widthTiles + x]!
        if (id) this.tiles.draw(c, id, x * TILE_PX - ox, y * TILE_PX - oy, x, y)
      }
    // 2. Each room's floor clipped to its exact box: cells straddling two rooms split at the wall.
    for (const r of m.rooms) {
      const id = this.floors.get(r.id)
      const b = r.box
      if (!id || b.x >= ox + CHUNK_PX || b.y >= oy + CHUNK_PX || b.x + b.w <= ox || b.y + b.h <= oy)
        continue
      c.save()
      c.beginPath()
      c.rect(b.x - ox, b.y - oy, b.w, b.h)
      c.clip()
      for (
        let y = Math.max(ty0, Math.floor(b.y / TILE_PX));
        y < Math.min(ty1, Math.ceil((b.y + b.h) / TILE_PX));
        y++
      )
        for (
          let x = Math.max(tx0, Math.floor(b.x / TILE_PX));
          x < Math.min(tx1, Math.ceil((b.x + b.w) / TILE_PX));
          x++
        ) {
          // Cells wholly inside the room already show its floor.
          const inside =
            x * TILE_PX >= b.x &&
            y * TILE_PX >= b.y &&
            (x + 1) * TILE_PX <= b.x + b.w &&
            (y + 1) * TILE_PX <= b.y + b.h
          if (inside && m.layers.floor[y * m.widthTiles + x] === id) continue
          this.tiles.draw(c, id, x * TILE_PX - ox, y * TILE_PX - oy, x, y)
        }
      c.restore()
    }
    // 3. Flat walls (no ¾ face) are part of the floor plan; faced walls y-sort with characters.
    c.translate(-ox, -oy)
    for (const w of m.walls) {
      const b = w.box
      if (
        !flatWall(w) ||
        b.x >= ox + CHUNK_PX ||
        b.y >= oy + CHUNK_PX ||
        b.x + b.w <= ox ||
        b.y + b.h <= oy
      )
        continue
      this.paintWall(c, w)
    }
    c.setTransform(1, 0, 0, 1, 0, 0)
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
