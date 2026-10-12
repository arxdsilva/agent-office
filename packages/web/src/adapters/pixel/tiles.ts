// Tiles: implements PL's `TileResolver` (tile query → id) and draws ids as 16×16 pixels. An atlas
// tile is used when the pixel atlas (agent AR) has one for the query; otherwise a procedural
// placeholder (flat colours with a little texture), so the map always draws.
import type { TileQuery, TileResolver } from '../../app/pixel/map.ts'
import { TILE_PX } from '../../app/pixel/types.ts'
import type { Atlas } from './sprites.ts'

/** Accent colours per wing theme (carpets, curtains). */
const THEME: Record<string, [string, string]> = {
  terracotta: ['#c98d6e', '#b67b5d'],
  nordic: ['#cfd6dc', '#bcc4cb'],
  forest: ['#86a072', '#76905f'],
  ocean: ['#7397b8', '#6487a8'],
  neon: ['#6f5f93', '#615284'],
  brass: ['#bea26a', '#ab8f58'],
}

const hash = (x: number, y: number) => {
  let h = (x * 374761393 + y * 668265263) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  return (h ^ (h >>> 16)) >>> 0
}

const queryKey = (q: TileQuery) => `${q.layer}:${q.kind}:${q.theme ?? ''}:${q.edge ?? ''}`

export class PixelTiles implements TileResolver {
  private ids = new Map<string, number>()
  private queries: TileQuery[] = [{ layer: 'floor', kind: 'empty' }]
  private cache = new Map<string, HTMLCanvasElement>()
  private atlas: Atlas | null = null

  /** Stable ids per query (1-based; 0 = empty), so a map built once keeps drawing right. */
  tile(q: TileQuery): number {
    const k = queryKey(q)
    let id = this.ids.get(k)
    if (id === undefined) {
      id = this.queries.length
      this.queries.push({ ...q })
      this.ids.set(k, id)
    }
    return id
  }

  setAtlas(atlas: Atlas | null): void {
    this.atlas = atlas
  }

  /** Draws tile `id` at (dx, dy); (tx, ty) picks a variant, `mask` the connected wall neighbours. */
  draw(
    c: CanvasRenderingContext2D,
    id: number,
    dx: number,
    dy: number,
    tx: number,
    ty: number,
    mask = 0,
  ): void {
    const q = this.queries[id]
    if (!q) return
    const v = hash(tx, ty)
    const f = this.atlas?.tile(q, mask)
    if (f) {
      c.drawImage(f.image, f.x, f.y, f.w, f.h, dx - f.ax, dy - f.ay, f.w, f.h)
      return
    }
    const variant = q.layer === 'floor' ? v % 4 : 0
    const parity = q.edge === 'v' ? ty & 1 : (tx + ty) & 1
    const key = `${id}:${variant}:${parity}`
    let t = this.cache.get(key)
    if (!t) {
      t = document.createElement('canvas')
      t.width = t.height = TILE_PX
      paint(t.getContext('2d')!, q, variant, parity)
      this.cache.set(key, t)
    }
    c.drawImage(t, dx, dy)
  }

  dispose(): void {
    for (const t of this.cache.values()) t.width = t.height = 0
    this.cache.clear()
  }
}

function paint(c: CanvasRenderingContext2D, q: TileQuery, variant: number, parity: number): void {
  const px = (x: number, y: number, col: string, w = 1, h = 1) => {
    c.fillStyle = col
    c.fillRect(x, y, w, h)
  }
  const speckle = (col: string, n: number) => {
    for (let i = 0; i < n; i++) {
      const h = hash(variant * 31 + i, i * 17 + variant)
      px(h % 16, (h >>> 4) % 16, col)
    }
  }
  const [accent, accentD] = THEME[q.theme ?? ''] ?? ['#9aa1ab', '#8a919b']
  if (q.layer === 'floor') {
    switch (q.kind) {
      case 'wood':
        px(0, 0, '#b98a5c', 16, 16)
        for (let y = 3; y < 16; y += 4) px(0, y, '#a3784e', 16, 1)
        px(parity ? 5 : 11, 0, '#a3784e', 1, 3)
        px(parity ? 13 : 2, 4, '#a3784e', 1, 3)
        px(parity ? 8 : 4, 8, '#a3784e', 1, 3)
        speckle('#c79a6a', 3)
        return
      case 'tile':
        px(0, 0, '#d4c9b4', 16, 16)
        px(0, 7, '#bcae95', 16, 1)
        px(7, 0, '#bcae95', 1, 16)
        px(15, 0, '#bcae95', 1, 16)
        px(0, 15, '#bcae95', 16, 1)
        px(1, 1, '#e3d9c6', 5, 1)
        px(9, 9, '#e3d9c6', 5, 1)
        return
      case 'concrete':
        px(0, 0, '#a9a8a4', 16, 16)
        speckle('#9a9995', 6)
        speckle('#b7b6b2', 4)
        return
      case 'street':
        px(0, 0, '#a7abb0', 16, 16)
        px(0, 0, '#8d9297', 16, 1)
        px(0, 8, '#8d9297', 16, 1)
        px(parity ? 4 : 12, 1, '#8d9297', 1, 7)
        px(parity ? 12 : 4, 9, '#8d9297', 1, 7)
        return
      case 'grass':
        px(0, 0, '#6ea85a', 16, 16)
        speckle('#5c9449', 10)
        return
      default: {
        // Carpet (themed) and anything unknown.
        px(0, 0, accent, 16, 16)
        for (let y = 1; y < 16; y += 3)
          for (let x = (y + parity) % 4; x < 16; x += 4) px(x, y, accentD)
        speckle(accentD, 2)
        return
      }
    }
  }
  const h = q.edge !== 'v'
  if (q.layer === 'wall') {
    switch (q.kind) {
      case 'door':
        // Open doorway: a threshold strip on the floor.
        if (h) (px(0, 6, '#8f8676', 16, 4), px(0, 6, '#a69c8a', 16, 1))
        else (px(6, 0, '#8f8676', 4, 16), px(6, 0, '#a69c8a', 1, 16))
        return
      case 'glass':
        if (h) {
          px(0, 2, '#a9cde0', 16, 11)
          px(0, 2, '#d8eef7', 16, 1)
          px(parity ? 3 : 9, 4, '#e9f6fb', 2, 6)
          px(0, 13, '#5f7480', 16, 2)
          px(15, 2, '#5f7480', 1, 11)
        } else {
          px(6, 0, '#5f7480', 4, 16)
          px(7, 0, '#a9cde0', 2, 16)
        }
        return
      case 'curtain':
        if (h) {
          px(0, 1, accent, 16, 13)
          for (let x = parity; x < 16; x += 3) px(x, 1, accentD, 1, 13)
          px(0, 14, '#4a4652', 16, 2)
        } else px(5, 0, accentD, 6, 16)
        return
      default:
        if (h) {
          // The GBA "front wall": a trim line, the wall face and a baseboard.
          px(0, 0, '#eee7da', 16, 2)
          px(0, 2, '#cbc1af', 16, 10)
          px(0, 12, '#b8ad99', 16, 1)
          px(0, 13, '#6f6455', 16, 3)
          px(parity ? 3 : 11, 3, '#bdb29f', 1, 9)
        } else {
          px(4, 0, '#3e3c45', 8, 16)
          px(5, 0, '#5b5966', 6, 16)
        }
        return
    }
  }
  // Overhead (drawn over characters, one row above a horizontal wall): wall tops and lintels.
  if (q.kind === 'door') px(0, 12, '#5b5966', 16, 4)
  else if (q.kind === 'glass') px(0, 14, '#5f7480', 16, 2)
  else (px(0, 10, '#4b4954', 16, 6), px(0, 10, '#625f6d', 16, 1))
}
