// The minimap's base image (plan §2c): floors in their theme colour, the street, walls and solid
// furniture, at 4 px per metre (one 1 m tile = 4×4 px). Rendered once per `PixelMap.key`: the
// building's floor from the pure colour grid (`app/pixel/minimap-colors.ts`), then rooms, furniture
// and walls at their exact px boxes; the HUD draws agents, the player, labels and the viewport on top.
import { minimapColors, type MinimapPalette } from '../../app/pixel/minimap-colors.ts'
import { TILE_PX, type PixelMap, type PxRect } from '../../app/pixel/types.ts'
import type { Atlas } from './sprites.ts'

export const MINIMAP_PX_PER_TILE = 4
const GLASS = '#8fb8cc'

const DEFAULT_FLOOR = '#d9d2c6'

/** Theme floor colours from the atlas (`themes.<id>.colors.F`), muted fixed colours otherwise. */
export function minimapPalette(atlas: Atlas | null): MinimapPalette {
  const themes = (atlas?.raw.themes ?? {}) as Record<string, { colors?: Record<string, string> }>
  return {
    floor: (theme) => (theme && themes[theme]?.colors?.F) || DEFAULT_FLOOR,
    street: '#9a948c',
    wall: '#2a2632',
    door: '#f4f1ea',
    furniture: '#6f6779',
  }
}

export class MinimapBase {
  private key = ''
  private canvas: HTMLCanvasElement | null = null

  /** The image for `map`; `changed` is true when it was (re)rendered by this call. */
  render(map: PixelMap, atlas: Atlas | null): { img: HTMLCanvasElement; changed: boolean } {
    const key = `${map.key}|${atlas ? 1 : 0}`
    if (this.canvas && key === this.key) return { img: this.canvas, changed: false }
    const c = this.canvas ?? document.createElement('canvas')
    const s = MINIMAP_PX_PER_TILE
    c.width = Math.max(1, map.widthTiles * s)
    c.height = Math.max(1, map.heightTiles * s)
    const g = c.getContext('2d')
    if (g) {
      g.clearRect(0, 0, c.width, c.height)
      const palette = minimapPalette(atlas)
      const colors = minimapColors(map, palette)
      const w = map.widthTiles
      // 1. The building's floor per 1 m cell (walls and furniture come from the exact geometry).
      const coarse = new Set([palette.wall, palette.furniture, palette.door])
      for (let y = 0; y < map.heightTiles; y++) {
        let x = 0
        while (x < w) {
          const col = colors[y * w + x]
          let end = x + 1
          while (end < w && colors[y * w + end] === col) end++
          if (col && !coarse.has(col)) {
            g.fillStyle = col
            g.fillRect(x * s, y * s, (end - x) * s, s)
          }
          x = end
        }
      }
      // 2. Rooms at their exact boxes (largest first, so nested rooms win), then solid
      //    furniture and the walls (at least 1 px), all at 4 px per metre.
      const k = s / TILE_PX
      const rect = (b: PxRect, col: string) => {
        g.fillStyle = col
        const x0 = Math.floor(b.x * k)
        const y0 = Math.floor(b.y * k)
        g.fillRect(
          x0,
          y0,
          Math.max(1, Math.round((b.x + b.w) * k) - x0),
          Math.max(1, Math.round((b.y + b.h) * k) - y0),
        )
      }
      const rooms = [...map.rooms].sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)
      for (const r of rooms)
        rect(r.box, r.placement.startsWith('street') ? palette.street : palette.floor(r.theme))
      for (const o of map.objects) if (o.solid) rect(o.box, palette.furniture)
      for (const wl of map.walls) rect(wl.box, wl.kind === 'glass' ? GLASS : palette.wall)
    }
    this.canvas = c
    this.key = key
    return { img: c, changed: true }
  }

  dispose(): void {
    if (this.canvas) this.canvas.width = this.canvas.height = 0
    this.canvas = null
    this.key = ''
  }
}
