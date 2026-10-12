import { describe, expect, it } from 'vitest'
import { fixtureManifest } from '../__fixtures__/manifest.ts'
import { planBuilding } from '../building.ts'
import { buildPixelMap, indexSolids } from './map.ts'
import { PX_PER_M, type PixelMap, type PxRect } from './types.ts'
import {
  PLAYER_RADIUS,
  SPRINT_SPEED,
  WALK_SPEED,
  blocked,
  moveFromKeys,
  nearestFree,
  playerSpeed,
  spawnPoint,
  stepPlayer,
} from './walk.ts'

/** A 20×20 m open map with origin (0, 0); `rects` are solid boxes in metres [x0, z0, x1, z1]. */
function world(rects: [number, number, number, number][] = []): PixelMap {
  const w = 20
  const px = w * PX_PER_M
  const solids: PxRect[] = rects.map(([x0, z0, x1, z1]) => ({
    x: Math.round(x0 * PX_PER_M),
    y: Math.round(z0 * PX_PER_M),
    w: Math.round((x1 - x0) * PX_PER_M),
    h: Math.round((z1 - z0) * PX_PER_M),
  }))
  return {
    widthTiles: w,
    heightTiles: w,
    widthPx: px,
    heightPx: px,
    originM: { x: 0, z: 0 },
    layers: { floor: new Uint16Array(w * w) },
    objects: [],
    walls: [],
    solids,
    solidIndex: indexSolids(solids, px, px),
    rooms: [],
    key: 'g',
    dirty: [],
  }
}
/** A 0.25 m (4 px) vertical wall at x = 5 m, with door gaps [z0, z1) left open. */
function wall(doors: [number, number][] = []): [number, number, number, number][] {
  const out: [number, number, number, number][] = []
  let z = 0
  for (const [d0, d1] of [...doors, [20, 20] as [number, number]]) {
    if (d0 > z) out.push([5, z, 5.25, d0])
    z = d1
  }
  return out
}

describe('player walk (WK)', () => {
  // WK-1: free movement at 3 m/s (about 3 tiles/s at GBA scale); Shift sprints at 5 m/s.
  it('moves freely at walking speed, faster when sprinting', () => {
    expect(WALK_SPEED).toBe(3)
    expect(SPRINT_SPEED).toBe(5)
    const m = world()
    const p = stepPlayer(m, { x: 2, z: 2 }, { x: 1, z: 0 }, WALK_SPEED, 1)
    expect(p.x).toBeCloseTo(2 + WALK_SPEED, 5)
    expect(p.z).toBe(2)
    expect(stepPlayer(m, { x: 2, z: 2 }, { x: 0, z: 0 }, WALK_SPEED, 1)).toEqual({ x: 2, z: 2 })
  })

  // WK-run: R makes running the default; Shift while running still sprints (never slows down).
  it('picks the speed from Shift and the run toggle', () => {
    expect(playerSpeed({ sprint: false, run: false })).toBe(WALK_SPEED)
    expect(playerSpeed({ sprint: true, run: false })).toBe(SPRINT_SPEED)
    expect(playerSpeed({ sprint: false, run: true })).toBe(SPRINT_SPEED)
    expect(playerSpeed({ sprint: true, run: true })).toBe(SPRINT_SPEED)
  })

  // WK-2: a wall rect stops the player at its radius; off the map counts as blocked.
  it('is blocked by a wall rect', () => {
    const m = world(wall())
    const p = stepPlayer(m, { x: 3, z: 3 }, { x: 1, z: 0 }, WALK_SPEED, 2)
    expect(p.x).toBeLessThanOrEqual(5 - PLAYER_RADIUS + 1e-9)
    expect(p.x).toBeGreaterThan(5 - PLAYER_RADIUS - 0.11)
    expect(blocked(m, { x: 5.1, z: 3 })).toBe(true)
    expect(blocked(m, { x: 3, z: 3 })).toBe(false)
    expect(blocked(m, { x: -1, z: 3 })).toBe(true)
    expect(blocked(m, { x: 19.9, z: 3 })).toBe(true)
  })

  // WK-3: pushing diagonally into a wall slides along it.
  it('slides along a wall per axis', () => {
    const m = world(wall())
    const p = stepPlayer(m, { x: 4.6, z: 3 }, { x: Math.SQRT1_2, z: Math.SQRT1_2 }, WALK_SPEED, 1)
    expect(p.x).toBeLessThanOrEqual(5 - PLAYER_RADIUS + 1e-9)
    expect(p.z).toBeGreaterThan(5)
  })

  // WK-4: a 1 m door approached 0.4 m off its middle: the assist (up to 0.45 m) slides the player in.
  it('assists through an offset doorway', () => {
    const m = world(wall([[3, 4]]))
    let pos = { x: 4, z: 3.9 }
    for (let i = 0; i < 60; i++) pos = stepPlayer(m, pos, { x: 1, z: 0 }, WALK_SPEED, 1 / 30)
    expect(pos.x).toBeGreaterThan(5.5)
  })

  // WK-5: a huge dt is sub-stepped, so the player never tunnels through a 4 px wall.
  it('does not tunnel at large dt', () => {
    const m = world(wall())
    const p = stepPlayer(m, { x: 3, z: 3 }, { x: 1, z: 0 }, SPRINT_SPEED, 10)
    expect(p.x).toBeLessThan(5)
  })

  // WK-6: the spawn is the elevator approach, pushed to a free spot when furniture covers it.
  it('spawns at the elevator approach on a free spot', () => {
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
    expect(blocked(covered, elevator.approach)).toBe(true)
    const t = spawnPoint(covered, layout)
    expect(blocked(covered, t)).toBe(false)
    expect(Math.hypot(t.x - elevator.approach.x, t.z - elevator.approach.z)).toBeLessThan(1.5)
  })

  it('reads 4-direction input GBA style: the last pressed key wins', () => {
    expect(moveFromKeys([])).toEqual({ x: 0, z: 0 })
    expect(moveFromKeys(['e'])).toEqual({ x: 1, z: 0 })
    expect(moveFromKeys(['e', 'n'])).toEqual({ x: 0, z: -1 })
    expect(moveFromKeys(['s', 'w'])).toEqual({ x: -1, z: 0 })
  })

  it('finds the nearest free spot, or keeps the point when nothing is free', () => {
    const m = world([[4, 4, 5, 5]])
    const c = { x: 4.5, z: 4.5 }
    const f = nearestFree(m, c)
    expect(blocked(m, f)).toBe(false)
    expect(Math.hypot(f.x - c.x, f.z - c.z)).toBeLessThanOrEqual(0.75 + 1e-9)
    expect(nearestFree(m, { x: 2, z: 2 })).toEqual({ x: 2, z: 2 })
    const full = world([[0, 0, 20, 20]])
    expect(nearestFree(full, c)).toEqual(c)
  })
})

// The player is a 0.22 m circle against px rects, so the doors and corridors agents use fit.
describe('player walk: circle collision (WK-C)', () => {
  // WK-C1: the radius is 0.22 m (3.5 px).
  it('uses a 0.22 m player radius', () => {
    expect(PLAYER_RADIUS).toBeCloseTo(0.22)
  })

  // WK-C2: near a rect corner, only the round distance counts (a square would block here).
  it('tests a circle against rects', () => {
    const m = world([[5, 5, 5.5, 5.5]])
    expect(blocked(m, { x: 4.83, z: 4.83 })).toBe(false) // 0.24 m from the corner
    expect(blocked(m, { x: 4.86, z: 4.86 })).toBe(true) // 0.198 m from the corner
    expect(blocked(m, { x: 4.79, z: 5.25 })).toBe(true) // 0.21 m from the face
    expect(blocked(m, { x: 4.78, z: 5.25 })).toBe(false) // exactly touching does not block
  })

  // WK-C3: a 1 m door (the narrowest in the office, 16 px) is passable straight through.
  it('fits through a one-metre doorway', () => {
    const m = world(wall([[3, 4]]))
    let pos = { x: 4, z: 3.5 }
    for (let i = 0; i < 30; i++) pos = stepPlayer(m, pos, { x: 1, z: 0 }, WALK_SPEED, 1 / 30)
    expect(pos.x).toBeGreaterThan(5.5)
    expect(pos.z).toBeCloseTo(3.5)
  })
})
