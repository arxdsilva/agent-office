// Floor tiles: implements PL's `TileResolver` (tile query → id) and draws ids as 16×16 px (1 m)
// cells. An atlas tile is used when the pixel atlas (agent AR) has one for the query; otherwise a
// procedural placeholder (flat colours with a little texture), so the map always draws. Walls
// aren't tiles at GBA scale: `effects.drawWall` draws them from `PixelMap.walls`.
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

const queryKey = (q: TileQuery) => `${q.layer}:${q.kind}:${q.theme ?? ''}`

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

  /** Draws floor tile `id` at (dx, dy); (tx, ty) picks a variant. */
  draw(
    c: CanvasRenderingContext2D,
    id: number,
    dx: number,
    dy: number,
    tx: number,
    ty: number,
  ): void {
    const q = this.queries[id]
    if (!q || q.layer !== 'floor') return
    const f = this.atlas?.tile(q)
    if (f) {
      c.drawImage(f.image, f.x, f.y, f.w, f.h, dx - f.ax, dy - f.ay, f.w, f.h)
      return
    }
    const variant = hash(tx, ty) % 4
    const parity = (tx + ty) & 1
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
