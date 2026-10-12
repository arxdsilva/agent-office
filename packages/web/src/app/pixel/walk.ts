// The 2D player's movement (plan "2D at GBA scale" §2, §4b): 4-direction input, per-axis collision
// of a circle against the map's px rects (`PixelMap.solids` through `solidIndex`), a doorway assist,
// and sub-stepping so a large dt never tunnels through a 4 px wall.
import type { BuildingLayout, Vec2 } from '../office-types.ts'
import { dirVector } from './project.ts'
import { PX_PER_M, type Dir4, type PixelMap } from './types.ts'

/** The 2D player's collision circle (m): 3.5 px at 16 px/m. */
export const PLAYER_RADIUS = 0.22
/** m/s: walking (about 3 tiles/s at GBA scale), and running / sprinting (Shift, or the R toggle). */
export const WALK_SPEED = 3.0
export const SPRINT_SPEED = 5.0
/** Longest sub-step (m), well under the radius. */
const SUB_STEP = 0.1
/** Doorway assist: sideways probes up to 0.45 m (a door approached off-centre). */
const ASSIST_OFFSETS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45]
/** `nearestFree` search step (m). */
const SEARCH_STEP = 0.25

/** The player's speed: Shift sprints; the run toggle (R) makes running the default. */
export const playerSpeed = (i: { sprint: boolean; run: boolean }): number =>
  i.sprint || i.run ? SPRINT_SPEED : WALK_SPEED

/** Movement direction from held keys in press order: the last pressed one wins (GBA style). */
export function moveFromKeys(held: readonly Dir4[]): Vec2 {
  const last = held.at(-1)
  return last ? dirVector(last) : { x: 0, z: 0 }
}

type Collision = Pick<PixelMap, 'originM' | 'widthPx' | 'heightPx' | 'solids' | 'solidIndex'>

/** True when a circle at `p` (radius `r` m) overlaps a solid rect or leaves the map. */
export function blocked(map: Collision, p: Vec2, r = PLAYER_RADIUS): boolean {
  const cx = (p.x - map.originM.x) * PX_PER_M
  const cy = (p.z - map.originM.z) * PX_PER_M
  const rp = r * PX_PER_M
  if (cx - rp < 0 || cy - rp < 0 || cx + rp > map.widthPx || cy + rp > map.heightPx) return true
  const r2 = rp * rp - 1e-6 // strict overlap: touching an edge doesn't block
  const { cellPx, cols, rows, buckets } = map.solidIndex
  const c0 = Math.max(0, Math.floor((cx - rp) / cellPx))
  const c1 = Math.min(cols - 1, Math.floor((cx + rp) / cellPx))
  const r0 = Math.max(0, Math.floor((cy - rp) / cellPx))
  const r1 = Math.min(rows - 1, Math.floor((cy + rp) / cellPx))
  for (let row = r0; row <= r1; row++)
    for (let col = c0; col <= c1; col++)
      for (const i of buckets[row * cols + col]!) {
        const s = map.solids[i]!
        const dx = cx - Math.max(s.x, Math.min(cx, s.x + s.w))
        const dy = cy - Math.max(s.y, Math.min(cy, s.y + s.h))
        if (dx * dx + dy * dy < r2) return true
      }
  return false
}

/** One movement update: `dir` (unit or zero) at `speed` m/s for `dt` s. Returns the new position. */
export function stepPlayer(map: Collision, from: Vec2, dir: Vec2, speed: number, dt: number): Vec2 {
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
function assist(map: Collision, p: Vec2, mx: number, mz: number, step: number): boolean {
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

/**
 * Closest free point to `p` on a 0.25 m lattice around it (ring by ring, nearest first within a
 * ring); `p` itself when it's free or nothing is.
 */
export function nearestFree(
  map: Collision & Pick<PixelMap, 'widthTiles' | 'heightTiles'>,
  p: Vec2,
): Vec2 {
  if (!blocked(map, p)) return p
  const rings = Math.ceil(Math.max(map.widthTiles, map.heightTiles) / SEARCH_STEP)
  for (let k = 1; k <= rings; k++) {
    let best: Vec2 | undefined
    let bestD = Infinity
    for (let i = -k; i <= k; i++)
      for (let j = -k; j <= k; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== k) continue
        const d = i * i + j * j
        if (d >= bestD) continue
        const q = { x: p.x + i * SEARCH_STEP, z: p.z + j * SEARCH_STEP }
        if (!blocked(map, q)) ((best = q), (bestD = d))
      }
    if (best) return best
  }
  return p
}

/** Where the player starts: `spot:elevator:0`'s approach point in the atrium, on a free spot. */
export function spawnPoint(
  map: Collision & Pick<PixelMap, 'widthTiles' | 'heightTiles'>,
  layout: BuildingLayout,
): Vec2 {
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
