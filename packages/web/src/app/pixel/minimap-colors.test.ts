import { describe, expect, it } from 'vitest'
import { indexSolids } from './map.ts'
import { minimapColors, type MinimapPalette } from './minimap-colors.ts'
import type { MapObject, PixelMap, PxRect } from './types.ts'

const palette: MinimapPalette = {
  floor: (theme) => (theme ? `floor:${theme}` : 'floor'),
  street: 'street',
  wall: 'wall',
  door: 'door',
  furniture: 'furniture',
}

const px = (tx: number, ty: number, tw: number, th: number): PxRect => ({
  x: tx * 16,
  y: ty * 16,
  w: tw * 16,
  h: th * 16,
})
const obj = (id: string, kind: MapObject['kind'], box: PxRect, solid: boolean): MapObject => ({
  id,
  kind,
  box,
  sortY: box.y + box.h,
  solid,
})

/**
 * A 6×4 m map: a street column, a forest hall (cells 2..5 × 0..3) with an ocean pod inside, a 4 px
 * wall along the hall's top edge with a 1 m door at cell 3, a desk, a rug and a small plant.
 */
function fixture(): PixelMap {
  const w = 6
  const h = 4
  const objects = [
    obj('door', 'door', { x: 48, y: 0, w: 16, h: 4 }, false),
    obj('desk', 'desk', px(2, 2, 2, 1), true),
    obj('rug', 'rug', px(2, 3, 1, 1), false),
    obj('plant', 'plant', { x: 84, y: 4, w: 8, h: 8 }, true),
  ]
  const walls: PixelMap['walls'] = [
    { box: { x: 32, y: 0, w: 16, h: 4 }, kind: 'solid', face: 's' },
    { box: { x: 64, y: 0, w: 32, h: 4 }, kind: 'solid', face: 's' },
    // A vertical 4 px wall down column 5's centre line, rows 2..3.
    { box: { x: 86, y: 32, w: 4, h: 32 }, kind: 'glass', face: null },
  ]
  const solids = [...walls.map((x) => x.box), ...objects.filter((o) => o.solid).map((o) => o.box)]
  return {
    widthTiles: w,
    heightTiles: h,
    widthPx: w * 16,
    heightPx: h * 16,
    originM: { x: 0, z: 0 },
    layers: { floor: new Uint16Array(w * h) },
    objects,
    walls,
    solids,
    solidIndex: indexSolids(solids, w * 16, h * 16),
    rooms: [
      {
        id: 's/street',
        name: 'Main Street',
        box: px(0, 0, 1, 4),
        rect: { tx: 0, ty: 0, tw: 1, th: 4 },
        placement: 'street:0',
      },
      {
        id: 'w/hall',
        name: 'Hall',
        box: px(2, 0, 4, 4),
        rect: { tx: 2, ty: 0, tw: 4, th: 4 },
        placement: 'wing:p:0',
        theme: 'forest',
      },
      {
        id: 'w/pod',
        name: 'Pod',
        box: { x: 64, y: 30, w: 32, h: 34 },
        rect: { tx: 4, ty: 1, tw: 2, th: 3 },
        placement: 'wing:p:0',
        theme: 'ocean',
      },
    ],
    key: 'k',
    dirty: [],
  }
}

describe('minimap colours (MMC)', () => {
  // MMC-1: one colour per 1 m cell, rasterised from the rooms, walls, doors and solid boxes.
  it('colours floors by theme, the street, walls, doors and solid furniture', () => {
    const map = fixture()
    const c = minimapColors(map, palette)
    const at = (x: number, y: number) => c[y * map.widthTiles + x]
    expect(c).toHaveLength(24)
    expect(at(0, 1)).toBe('street')
    expect(at(1, 1)).toBeNull()
    expect(at(2, 0)).toBe('wall')
    expect(at(3, 0)).toBe('door')
    expect(at(4, 0)).toBe('wall')
    expect(at(2, 1)).toBe('floor:forest')
    // The pod's box starts 2 px above row 2: the cell centre decides, and the smallest room wins.
    expect(at(4, 1)).toBe('floor:forest')
    expect(at(4, 3)).toBe('floor:ocean')
    expect(at(2, 2)).toBe('furniture')
    expect(at(3, 2)).toBe('furniture')
    expect(at(2, 3)).toBe('floor:forest') // rugs are floor
    expect(at(5, 1)).toBe('floor:forest') // an 8 px plant covers too little of its cell
    expect(at(5, 2)).toBe('wall') // the vertical wall runs through the cell's centre line
    expect(at(5, 3)).toBe('wall')
  })

  // MMC-2: deterministic: the same map gives the same colours.
  it('is deterministic', () => {
    expect(minimapColors(fixture(), palette)).toEqual(minimapColors(fixture(), palette))
  })

  it('ignores geometry outside the map and uses the plain floor without a theme', () => {
    const map = fixture()
    map.rooms[1]!.theme = undefined
    map.objects.push(obj('x', 'desk', { x: 80, y: 48, w: 64, h: 64 }, true))
    map.walls.push({ box: { x: -40, y: -40, w: 20, h: 4 }, kind: 'solid', face: null })
    const c = minimapColors(map, palette)
    expect(c).toHaveLength(24)
    expect(c[1 * 6 + 2]).toBe('floor')
    expect(c[3 * 6 + 5]).toBe('wall')
    expect(c[3 * 6 + 4]).toBe('floor:ocean')
  })
})
