// World metres ↔ 2D tiles and pixels (plan §3.1). North is −z: the atrium sits at the top.
// Heading convention (navigation.ts): heading 0 faces +z (south on the map), π/2 faces +x (east).
import { normalizeAngle } from '../building.ts'
import type { AABB, Vec2 } from '../office-types.ts'
import { PX_PER_M, TILE_M, type Dir4, type TilePos } from './types.ts'

/** Empty tiles around the building. */
export const PAD_TILES = 2

export interface Projection {
  /** World metres of tile (0, 0)'s top-left corner (snapped to the 0.5 m grid). */
  originM: Vec2
  widthTiles: number
  heightTiles: number
}

const EPS = 1e-9

/** The tile grid covering `bounds` plus the padding, origin snapped to multiples of TILE_M. */
export function projectionFor(bounds: AABB): Projection {
  const ox = Math.floor(bounds.minX / TILE_M + EPS) * TILE_M - PAD_TILES * TILE_M
  const oz = Math.floor(bounds.minZ / TILE_M + EPS) * TILE_M - PAD_TILES * TILE_M
  return {
    originM: { x: ox, z: oz },
    widthTiles: Math.ceil((bounds.maxX - ox) / TILE_M - EPS) + PAD_TILES,
    heightTiles: Math.ceil((bounds.maxZ - oz) / TILE_M - EPS) + PAD_TILES,
  }
}

type Origin = Pick<Projection, 'originM'>

export const toPixel = (p: Vec2, at: Origin) => ({
  px: (p.x - at.originM.x) * PX_PER_M,
  py: (p.z - at.originM.z) * PX_PER_M,
})

export const pixelToWorld = (px: number, py: number, at: Origin): Vec2 => ({
  x: px / PX_PER_M + at.originM.x,
  z: py / PX_PER_M + at.originM.z,
})

export const toTile = (p: Vec2, at: Origin): TilePos => ({
  tx: Math.floor((p.x - at.originM.x) / TILE_M + EPS),
  ty: Math.floor((p.z - at.originM.z) / TILE_M + EPS),
})

export const tileCenter = (t: TilePos, at: Origin): Vec2 => ({
  x: at.originM.x + (t.tx + 0.5) * TILE_M,
  z: at.originM.z + (t.ty + 0.5) * TILE_M,
})

/** Facing for a heading: 45° sectors; ±45° and ±135° edges go to east/west. */
export function dir4(heading: number): Dir4 {
  const a = normalizeAngle(heading)
  const q = Math.PI / 4
  if (Math.abs(a) < q - EPS) return 's'
  if (Math.abs(a) > 3 * q + EPS) return 'n'
  return a > 0 ? 'e' : 'w'
}

const HEADINGS: Record<Dir4, number> = { s: 0, e: Math.PI / 2, n: Math.PI, w: -Math.PI / 2 }
export const headingOf4 = (d: Dir4) => HEADINGS[d]

/** Unit vector (x, z) for a facing. */
export const dirVector = (d: Dir4): Vec2 => ({
  x: d === 'e' ? 1 : d === 'w' ? -1 : 0,
  z: d === 's' ? 1 : d === 'n' ? -1 : 0,
})
