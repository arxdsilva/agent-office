// The 2D player's movement (plan §6, §3.3): 4-direction input, per-axis collision against solid
// tiles (circle vs tile AABB, the same rule as the 3D walk's `blocked()`), doorway assist and
// sub-stepping so a large dt never tunnels through a wall.
import type { BuildingLayout, Vec2 } from '../office-types.ts'
import { dirVector, tileCenter, toTile } from './project.ts'
import { TILE_M, type Dir4, type PixelMap } from './types.ts'

/** The 2D player's collision circle (m): the sprite is one 0.5 m tile wide (plan §1.4). */
export const PLAYER_RADIUS = 0.22
/** m/s: walking (4.5 tiles/s) and with Shift. */
export const WALK_SPEED = 1.4
export const SPRINT_SPEED = 2.4
/** Longest sub-step (m), well under the radius. */
const SUB_STEP = 0.1
/** Doorway assist: sideways probes up to 0.35 m (a one-tile door approached off-centre). */
const ASSIST_OFFSETS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35]

/** Movement direction from held keys in press order: the last pressed one wins (GBA style). */
export function moveFromKeys(held: readonly Dir4[]): Vec2 {
  const last = held.at(-1)
  return last ? dirVector(last) : { x: 0, z: 0 }
}

/** True when a player circle at `p` overlaps a solid tile or leaves the map (circle vs tile box). */
export function blocked(map: PixelMap, p: Vec2, r = PLAYER_RADIUS): boolean {
  const lx = (p.x - map.originM.x) / TILE_M
  const lz = (p.z - map.originM.z) / TILE_M
  const rt = r / TILE_M
  if (lx - rt < 0 || lz - rt < 0 || lx + rt > map.widthTiles || lz + rt > map.heightTiles)
    return true
  const r2 = rt * rt - 1e-9 // strict overlap: touching a tile edge doesn't block
  for (let ty = Math.floor(lz - rt); ty < Math.ceil(lz + rt); ty++)
    for (let tx = Math.floor(lx - rt); tx < Math.ceil(lx + rt); tx++) {
      if (!map.solid[ty * map.widthTiles + tx]) continue
      const dx = lx - Math.max(tx, Math.min(lx, tx + 1))
      const dz = lz - Math.max(ty, Math.min(lz, ty + 1))
      if (dx * dx + dz * dz < r2) return true
    }
  return false
}

/** One movement update: `dir` (unit or zero) at `speed` m/s for `dt` s. Returns the new position. */
export function stepPlayer(map: PixelMap, from: Vec2, dir: Vec2, speed: number, dt: number): Vec2 {
  const dist = speed * dt
  if (dist <= 0 || (dir.x === 0 && dir.z === 0)) return from
  const n = Math.max(1, Math.ceil(dist / SUB_STEP))
  const step = dist / n
  const p = { ...from }
  for (let i = 0; i < n; i++) {
    const mx = dir.x * step
    const mz = dir.z * step
    const x0 = p.x
    const z0 = p.z
    if (mx && !blocked(map, { x: p.x + mx, z: p.z })) p.x += mx
    if (mz && !blocked(map, { x: p.x, z: p.z + mz })) p.z += mz
    if (p.x === x0 && p.z === z0 && !assist(map, p, mx, mz, step)) break
  }
  return p
}

/** Walking into a door jamb: slide sideways toward a gap the move fits through. */
function assist(map: PixelMap, p: Vec2, mx: number, mz: number, step: number): boolean {
  const l = Math.hypot(mx, mz) || 1
  const side = { x: -mz / l, z: mx / l }
  for (const off of ASSIST_OFFSETS)
    for (const sign of [1, -1]) {
      const x = p.x + side.x * off * sign
      const z = p.z + side.z * off * sign
      if (blocked(map, { x, z }) || blocked(map, { x: x + mx, z: z + mz })) continue
      const k = Math.min(off, step) * sign
      p.x += side.x * k
      p.z += side.z * k
      return true
    }
  return false
}

/** Closest free tile centre to `p` (breadth-first over tiles); `p` itself when it's free. */
export function nearestFree(map: PixelMap, p: Vec2): Vec2 {
  if (!blocked(map, p)) return p
  const start = toTile(p, map)
  const seen = new Set<number>()
  let ring = [start]
  for (let depth = 0; depth < Math.max(map.widthTiles, map.heightTiles); depth++) {
    const next: typeof ring = []
    for (const t of ring) {
      const k = t.ty * map.widthTiles + t.tx
      if (t.tx < 0 || t.ty < 0 || t.tx >= map.widthTiles || t.ty >= map.heightTiles || seen.has(k))
        continue
      seen.add(k)
      const c = tileCenter(t, map)
      if (!blocked(map, c)) return c
      next.push(
        { tx: t.tx + 1, ty: t.ty },
        { tx: t.tx - 1, ty: t.ty },
        { tx: t.tx, ty: t.ty + 1 },
        { tx: t.tx, ty: t.ty - 1 },
      )
    }
    if (!next.length) break
    ring = next
  }
  return p
}

/** Where the player starts: `spot:elevator:0`'s approach point in the atrium, on a free tile. */
export function spawnPoint(map: PixelMap, layout: BuildingLayout): Vec2 {
  const anchors = [...layout.anchors.values()]
  const a =
    anchors.find((x) => x.placement === 'atrium' && x.local === 'spot:elevator:0') ??
    anchors.find((x) => x.local.startsWith('spot:elevator:'))
  const p = a?.approach ?? {
    x: (layout.bounds.minX + layout.bounds.maxX) / 2,
    z: (layout.bounds.minZ + layout.bounds.maxZ) / 2,
  }
  return nearestFree(map, { ...p })
}
