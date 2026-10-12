import { describe, expect, it } from 'vitest'
import { fixtureManifest } from '../__fixtures__/manifest.ts'
import { planBuilding } from '../building.ts'
import {
  PAD_TILES,
  dir4,
  headingOf4,
  pixelToWorld,
  projectionFor,
  tileCenter,
  toPixel,
  toTile,
} from './project.ts'
import { PX_PER_M, TILE_M } from './types.ts'

const bounds = { minX: -10.2, maxX: 10.2, minZ: -24, maxZ: 36 }

describe('projection (PR)', () => {
  // PR-1: metres → pixels → metres is lossless, at 16 px per metre, and tiles are 1 m cells.
  it('round-trips world ↔ pixel at 16 px/m and maps 1 m tiles', () => {
    const p = projectionFor(bounds)
    const w = { x: 3.3, z: -7.25 }
    const px = toPixel(w, p)
    const back = pixelToWorld(px.px, px.py, p)
    expect(back.x).toBeCloseTo(w.x, 9)
    expect(back.z).toBeCloseTo(w.z, 9)
    expect(PX_PER_M).toBe(16)
    expect(TILE_M).toBe(1)
    expect(toPixel({ x: p.originM.x + 1, z: p.originM.z }, p)).toEqual({ px: 16, py: 0 })
    const t = toTile(w, p)
    const c = tileCenter(t, p)
    expect(Math.abs(c.x - w.x)).toBeLessThanOrEqual(TILE_M / 2)
    expect(Math.abs(c.z - w.z)).toBeLessThanOrEqual(TILE_M / 2)
  })

  // PR-2: north is −z; 45° sectors with fixed edges.
  it('maps headings to 4 directions with 45° sectors', () => {
    expect(dir4(0)).toBe('s')
    expect(dir4(Math.PI / 2)).toBe('e')
    expect(dir4(Math.PI)).toBe('n')
    expect(dir4(-Math.PI)).toBe('n')
    expect(dir4(-Math.PI / 2)).toBe('w')
    expect(dir4(Math.PI / 4 - 0.01)).toBe('s')
    // Edges: exactly 45° and 135° belong to east (−45°, −135° to west).
    expect(dir4(Math.PI / 4)).toBe('e')
    expect(dir4((3 * Math.PI) / 4)).toBe('e')
    expect(dir4(-Math.PI / 4)).toBe('w')
    expect(dir4((-3 * Math.PI) / 4)).toBe('w')
    expect(dir4(2 * Math.PI)).toBe('s')
    for (const d of ['n', 'e', 's', 'w'] as const) expect(dir4(headingOf4(d))).toBe(d)
  })

  // PR-3: the world is padded by 1 m, origin snapped to the 1 m grid.
  it('pads the bounds by one metre and snaps the origin to the grid', () => {
    const p = projectionFor(bounds)
    expect(PAD_TILES * TILE_M).toBe(1)
    expect(p.originM.x).toBeLessThanOrEqual(bounds.minX - 1)
    expect(p.originM.x).toBeGreaterThan(bounds.minX - 2)
    expect(p.originM.x).toBe(Math.round(p.originM.x))
    expect(p.originM.x + p.widthTiles).toBeGreaterThanOrEqual(bounds.maxX + 1)
    expect(p.originM.z + p.heightTiles).toBeGreaterThanOrEqual(bounds.maxZ + 1)
  })

  // PR-4: the elevators (atrium, north) land in the top part of the map.
  it('projects the elevator spot into the top region', () => {
    const layout = planBuilding([{ provider: 'p', agents: 3 }], fixtureManifest, undefined, 0)
    const p = projectionFor(layout.bounds)
    const elevator = [...layout.anchors.values()].find((a) => a.local === 'spot:elevator:0')!
    const t = toTile(elevator.pos, p)
    expect(t.ty).toBeLessThan(p.heightTiles / 2)
    expect(t.tx).toBeGreaterThanOrEqual(0)
    expect(t.tx).toBeLessThan(p.widthTiles)
  })
})
