// The minimap base image's colour per 1 m cell (plan §2c), rasterised from the map's px geometry.
// Pure and deterministic: room floors in their theme colour (the smallest room holding the cell
// centre), the street, solid furniture covering most of a cell, then walls and doors on their
// centre line, so a 4 px wall still reads as a line of cells.
import type { ThemeId } from '../office-types.ts'
import { TILE_PX, type PixelMap, type PxRect } from './types.ts'

export interface MinimapPalette {
  floor(theme?: ThemeId): string
  street: string
  wall: string
  door: string
  furniture: string
}

/** A solid box must cover this share of a cell to colour it. */
const FURNITURE_COVER = 0.5
/** A wall or door must run at least this many px through a cell to mark it. */
const LINE_MIN_PX = TILE_PX / 2

const overlap = (a0: number, a1: number, b0: number, b1: number) =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))

/** Row-major colours (null = outside the building). */
export function minimapColors(map: PixelMap, palette: MinimapPalette): (string | null)[] {
  const w = map.widthTiles
  const h = map.heightTiles
  const out: (string | null)[] = new Array(w * h).fill(null)
  const cells = (b: PxRect) => ({
    x0: Math.max(0, Math.floor(b.x / TILE_PX)),
    y0: Math.max(0, Math.floor(b.y / TILE_PX)),
    x1: Math.min(w - 1, Math.ceil((b.x + b.w) / TILE_PX) - 1),
    y1: Math.min(h - 1, Math.ceil((b.y + b.h) / TILE_PX) - 1),
  })

  // Rooms, largest first, so nested (smaller) rooms win; a cell belongs to the room at its centre.
  const rooms = [...map.rooms].sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)
  for (const r of rooms) {
    const color = r.placement.startsWith('street') ? palette.street : palette.floor(r.theme)
    const c = cells(r.box)
    for (let y = c.y0; y <= c.y1; y++)
      for (let x = c.x0; x <= c.x1; x++) {
        const cx = (x + 0.5) * TILE_PX
        const cy = (y + 0.5) * TILE_PX
        if (cx >= r.box.x && cx < r.box.x + r.box.w && cy >= r.box.y && cy < r.box.y + r.box.h)
          out[y * w + x] = color
      }
  }

  for (const o of map.objects) {
    if (!o.solid || o.kind === 'door') continue
    const c = cells(o.box)
    for (let y = c.y0; y <= c.y1; y++)
      for (let x = c.x0; x <= c.x1; x++) {
        const a =
          overlap(x * TILE_PX, (x + 1) * TILE_PX, o.box.x, o.box.x + o.box.w) *
          overlap(y * TILE_PX, (y + 1) * TILE_PX, o.box.y, o.box.y + o.box.h)
        if (a >= FURNITURE_COVER * TILE_PX * TILE_PX) out[y * w + x] = palette.furniture
      }
  }

  /** Marks the cells a thin box runs through along its centre line. */
  const line = (b: PxRect, color: string) => {
    const horizontal = b.w >= b.h
    const across = Math.floor((horizontal ? b.y + b.h / 2 : b.x + b.w / 2) / TILE_PX)
    if (across < 0 || across >= (horizontal ? h : w)) return
    const s0 = horizontal ? b.x : b.y
    const s1 = s0 + (horizontal ? b.w : b.h)
    const n = horizontal ? w : h
    for (
      let i = Math.max(0, Math.floor(s0 / TILE_PX));
      i < Math.min(n, Math.ceil(s1 / TILE_PX));
      i++
    )
      if (overlap(i * TILE_PX, (i + 1) * TILE_PX, s0, s1) >= LINE_MIN_PX)
        out[horizontal ? across * w + i : i * w + across] = color
  }
  for (const wall of map.walls) line(wall.box, palette.wall)
  for (const o of map.objects) if (o.kind === 'door') line(o.box, palette.door)
  return out
}
