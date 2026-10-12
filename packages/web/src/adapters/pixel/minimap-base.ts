// The minimap's base image (plan §2c): floors in their theme colour, the street, walls, doors and
// solid furniture, at 2 px per tile. Rendered once per `PixelMap.key` from the pure colour grid
// (`app/pixel/minimap-colors.ts`); the HUD draws agents, the player, labels and the viewport on top.
import { minimapColors, type MinimapPalette } from '../../app/pixel/minimap-colors.ts'
import type { PixelMap } from '../../app/pixel/types.ts'
import type { Atlas } from './sprites.ts'

export const MINIMAP_PX_PER_TILE = 2

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
      const colors = minimapColors(map, minimapPalette(atlas))
      const w = map.widthTiles
      // Batch runs of the same colour along each row.
      for (let y = 0; y < map.heightTiles; y++) {
        let x = 0
        while (x < w) {
          const col = colors[y * w + x]
          let end = x + 1
          while (end < w && colors[y * w + end] === col) end++
          if (col) {
            g.fillStyle = col
            g.fillRect(x * s, y * s, (end - x) * s, s)
          }
          x = end
        }
      }
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
