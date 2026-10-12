// The minimap base image's colour per tile (plan §2c), from the map's own data. Pure and
// deterministic: room floors in their theme colour, the street, walls, doors and solid furniture.
import type { ThemeId } from '../office-types.ts'
import type { PixelMap } from './types.ts'

export interface MinimapPalette {
  floor(theme?: ThemeId): string
  street: string
  wall: string
  door: string
  furniture: string
}

/** Row-major colours (null = outside the building). */
export function minimapColors(map: PixelMap, palette: MinimapPalette): (string | null)[] {
  const w = map.widthTiles
  const h = map.heightTiles
  const out: (string | null)[] = new Array(w * h).fill(null)
  const fill = (
    r: { tx: number; ty: number; tw: number; th: number },
    color: string,
    only?: (i: number) => boolean,
  ) => {
    for (let y = Math.max(0, r.ty); y < Math.min(h, r.ty + r.th); y++)
      for (let x = Math.max(0, r.tx); x < Math.min(w, r.tx + r.tw); x++) {
        const i = y * w + x
        if (!only || only(i)) out[i] = color
      }
  }
  const hasFloor = (i: number) => map.layers.floor[i] !== 0
  // Rooms, largest first, so nested (smaller) rooms win.
  const rooms = [...map.rooms].sort((a, b) => b.rect.tw * b.rect.th - a.rect.tw * a.rect.th)
  for (const r of rooms)
    fill(
      r.rect,
      r.placement.startsWith('street') ? palette.street : palette.floor(r.theme),
      hasFloor,
    )
  for (const o of map.objects) if (o.solid && o.kind !== 'door') fill(o.rect, palette.furniture)
  for (let i = 0; i < w * h; i++) if (map.layers.walls[i]) out[i] = palette.wall
  for (const o of map.objects) if (o.kind === 'door') fill(o.rect, palette.door)
  return out
}
