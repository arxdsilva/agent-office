import { describe, expect, it } from 'vitest'
import { fixtureManifest } from '../__fixtures__/manifest.ts'
import { planBuilding } from '../building.ts'
import { buildPixelMap, tileIndex } from './map.ts'
import { tileCenter, toTile } from './project.ts'
import type { PixelMap } from './types.ts'
import {
  PLAYER_RADIUS,
  SPRINT_SPEED,
  WALK_SPEED,
  blocked,
  moveFromKeys,
  nearestFree,
  spawnPoint,
  stepPlayer,
} from './walk.ts'

/** A 20×20 tile open map with origin (0, 0); `walls` marks solid tiles. */
function grid(walls: [number, number][] = []): PixelMap {
  const w = 20
  const solid = new Uint8Array(w * w)
  for (const [tx, ty] of walls) solid[ty * w + tx] = 1
  return {
    widthTiles: w,
    heightTiles: w,
    originM: { x: 0, z: 0 },
    layers: {
      floor: new Uint16Array(w * w),
      walls: new Uint16Array(w * w),
      overhead: new Uint16Array(w * w),
    },
    objects: [],
    solid,
    rooms: [],
    key: 'g',
    dirty: [],
  }
}
/** A vertical wall at tile column `tx`, with door rows `door` left open. */
const column = (tx: number, door: number[] = []) =>
  Array.from({ length: 20 }, (_, ty) => [tx, ty] as [number, number]).filter(
    ([, ty]) => !door.includes(ty),
  )

describe('player walk (WK)', () => {
  // WK-1: free movement at 1.4 m/s; Shift is faster.
  it('moves freely at walking speed, faster when sprinting', () => {
    const m = grid()
    const p = stepPlayer(m, { x: 2, z: 2 }, { x: 1, z: 0 }, WALK_SPEED, 1)
    expect(p.x).toBeCloseTo(2 + WALK_SPEED, 5)
    expect(p.z).toBe(2)
    expect(SPRINT_SPEED).toBeGreaterThan(WALK_SPEED)
    expect(stepPlayer(m, { x: 2, z: 2 }, { x: 0, z: 0 }, WALK_SPEED, 1)).toEqual({ x: 2, z: 2 })
  })

  // WK-2: a wall tile stops the player at its radius.
  it('is blocked by a wall tile', () => {
    const m = grid(column(10))
    const p = stepPlayer(m, { x: 3, z: 3 }, { x: 1, z: 0 }, WALK_SPEED, 5)
    expect(p.x).toBeLessThanOrEqual(5 - PLAYER_RADIUS + 1e-9)
    expect(p.x).toBeGreaterThan(5 - PLAYER_RADIUS - 0.11)
    expect(blocked(m, { x: 5, z: 3 })).toBe(true)
    expect(blocked(m, { x: 3, z: 3 })).toBe(false)
    // Off the map counts as blocked.
    expect(blocked(m, { x: -1, z: 3 })).toBe(true)
  })

  // WK-3: pushing diagonally into a wall slides along it.
  it('slides along a wall per axis', () => {
    const m = grid(column(10))
    const p = stepPlayer(m, { x: 4.6, z: 3 }, { x: Math.SQRT1_2, z: Math.SQRT1_2 }, WALK_SPEED, 1)
    expect(p.x).toBeLessThanOrEqual(5 - PLAYER_RADIUS + 1e-9)
    expect(p.z).toBeGreaterThan(3.9)
  })

  // WK-4: a slightly misaligned approach to a 2-tile door is nudged through it.
  it('assists through a two-tile doorway', () => {
    const m = grid(column(10, [6, 7])) // door gap z ∈ [3, 4)
    let pos = { x: 4, z: 3.85 }
    for (let i = 0; i < 60; i++) pos = stepPlayer(m, pos, { x: 1, z: 0 }, WALK_SPEED, 1 / 30)
    expect(pos.x).toBeGreaterThan(5.5)
  })

  // WK-5: a huge dt is sub-stepped, so the player never tunnels through a 1-tile wall.
  it('does not tunnel at large dt', () => {
    const m = grid(column(10))
    const p = stepPlayer(m, { x: 3, z: 3 }, { x: 1, z: 0 }, SPRINT_SPEED, 10)
    expect(p.x).toBeLessThan(5)
  })

  // WK-6: the spawn is the elevator approach, pushed to a free tile when furniture covers it.
  it('spawns at the elevator approach on a free tile', () => {
    const layout = planBuilding([{ provider: 'p', agents: 1 }], fixtureManifest, undefined, 0)
    const elevator = [...layout.anchors.values()].find((a) => a.local === 'spot:elevator:0')!
    const free = buildPixelMap(layout, {}, { tile: () => 1 })
    const s = spawnPoint(free, layout)
    expect(s.x).toBeCloseTo(elevator.approach.x)
    expect(s.z).toBeCloseTo(elevator.approach.z)
    const covered = buildPixelMap(
      layout,
      {
        atrium: {
          rooms: [],
          walls: [],
          furniture: [
            { kind: 'plant', x: elevator.approach.x, z: elevator.approach.z, w: 1, d: 1, yaw: 0 },
          ],
        },
      },
      { tile: () => 1 },
    )
    const t = spawnPoint(covered, layout)
    expect(blocked(covered, t)).toBe(false)
    expect(covered.solid[tileIndex(covered, toTile(t, covered))]).toBe(0)
  })

  it('reads 4-direction input GBA style: the last pressed key wins', () => {
    expect(moveFromKeys([])).toEqual({ x: 0, z: 0 })
    expect(moveFromKeys(['e'])).toEqual({ x: 1, z: 0 })
    expect(moveFromKeys(['e', 'n'])).toEqual({ x: 0, z: -1 })
    expect(moveFromKeys(['s', 'w'])).toEqual({ x: -1, z: 0 })
  })

  it('finds the nearest free tile centre', () => {
    const m = grid([[4, 4]])
    const c = tileCenter({ tx: 4, ty: 4 }, m)
    const f = nearestFree(m, c)
    expect(blocked(m, f)).toBe(false)
    expect(Math.hypot(f.x - c.x, f.z - c.z)).toBeLessThanOrEqual(1.1)
    const full = grid(
      Array.from({ length: 400 }, (_, i) => [i % 20, Math.floor(i / 20)] as [number, number]),
    )
    expect(nearestFree(full, c)).toEqual(c)
  })
})

// Plan §1.4: the player is a 0.22 m circle (not a square), so corridors and doors agents use fit.
describe('player walk: circle collision (WK-C)', () => {
  // WK-C1: the radius is 0.22 m (the sprite is one 0.5 m tile wide).
  it('uses a 0.22 m player radius', () => {
    expect(PLAYER_RADIUS).toBeCloseTo(0.22)
  })

  // WK-C2: near a tile corner, only the round distance counts (a square would block here).
  it('tests a circle against tile boxes', () => {
    const m = grid([[10, 10]]) // box x, z ∈ [5, 5.5]
    expect(blocked(m, { x: 4.83, z: 4.83 })).toBe(false) // 0.24 m from the corner
    expect(blocked(m, { x: 4.86, z: 4.86 })).toBe(true) // 0.198 m from the corner
    expect(blocked(m, { x: 4.79, z: 5.25 })).toBe(true) // 0.21 m from the face
  })

  // WK-C3: a 1-tile (0.5 m) door is passable when walking straight through its middle.
  it('fits through a one-tile doorway', () => {
    const m = grid(column(10, [6])) // gap z ∈ [3, 3.5)
    let pos = { x: 4, z: 3.25 }
    for (let i = 0; i < 60; i++) pos = stepPlayer(m, pos, { x: 1, z: 0 }, WALK_SPEED, 1 / 30)
    expect(pos.x).toBeGreaterThan(5.5)
  })

  // WK-C4: approaching a one-tile door 0.3 m off its middle, the assist slides the player in.
  it('assists through an offset one-tile doorway', () => {
    const m = grid(column(10, [6]))
    let pos = { x: 4, z: 3.55 }
    for (let i = 0; i < 90; i++) pos = stepPlayer(m, pos, { x: 1, z: 0 }, WALK_SPEED, 1 / 30)
    expect(pos.x).toBeGreaterThan(5.5)
  })
})
