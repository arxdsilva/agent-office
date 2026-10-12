import { describe, expect, it } from 'vitest'
import { defaultZoom, nextZoom, viewSize, zoomLevels } from './zoom.ts'

// 2D zoom in whole device px per art px (plan "2D at GBA scale" §4b): pixels stay square and crisp.
describe('2D zoom levels (ZM)', () => {
  // ZM-1: levels run from twice the fit scale (zoomed in) down to 1 (the most zoomed out).
  it('lists integer levels from fitScale·2 down to 1', () => {
    expect(zoomLevels(1)).toEqual([2, 1])
    expect(zoomLevels(2)).toEqual([4, 3, 2, 1])
    expect(zoomLevels(3)).toEqual([6, 5, 4, 3, 2, 1])
    // A fractional or tiny fit scale still gives whole, unique levels.
    expect(zoomLevels(2.6)).toEqual([4, 3, 2, 1])
    expect(zoomLevels(0.4)).toEqual([2, 1])
    expect(defaultZoom(3)).toBe(3)
    expect(defaultZoom(0.4)).toBe(1)
  })

  // ZM-2: −1 zooms out (a smaller level), +1 zooms in, clamped at both ends.
  it('steps between levels and clamps', () => {
    const levels = zoomLevels(3)
    expect(nextZoom(levels, 3, -1)).toBe(2)
    expect(nextZoom(levels, 2, -1)).toBe(1)
    expect(nextZoom(levels, 1, -1)).toBe(1)
    expect(nextZoom(levels, 3, 1)).toBe(4)
    expect(nextZoom(levels, 6, 1)).toBe(6)
  })

  // ZM-3: 0 returns to the default (the fit scale); a level not in the list snaps to the nearest.
  it('returns to the default and snaps unknown levels', () => {
    const levels = zoomLevels(3)
    expect(nextZoom(levels, 1, 0)).toBe(3)
    expect(nextZoom(levels, 6, 0)).toBe(3)
    expect(nextZoom(levels, 9, -1)).toBe(5)
    expect(nextZoom(levels, 2.4, 1)).toBe(3)
    expect(nextZoom([], 2, 1)).toBe(2)
  })

  // ZM-4: the view in art px is the device size over the level (rounded up to cover the screen).
  it('sizes the view per level', () => {
    expect(viewSize(1600, 900, 3)).toEqual({ w: 534, h: 300 })
    expect(viewSize(1600, 900, 2)).toEqual({ w: 800, h: 450 })
    expect(viewSize(1600, 900, 1)).toEqual({ w: 1600, h: 900 })
    // At p = 1 a 1600 px window shows 100 m: most of a 3-provider office.
    expect(viewSize(1600, 900, 1).w / 16).toBe(100)
  })
})
