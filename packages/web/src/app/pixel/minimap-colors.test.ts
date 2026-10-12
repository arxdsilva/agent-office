import { describe, expect, it } from 'vitest'
import { minimapColors, type MinimapPalette } from './minimap-colors.ts'
import type { PixelMap } from './types.ts'

const palette: MinimapPalette = {
  floor: (theme) => (theme ? `floor:${theme}` : 'floor'),
  street: 'street',
  wall: 'wall',
  door: 'door',
  furniture: 'furniture',
}

/** A 6×4 map: a forest wing room (2..5 × 0..3) with a pod inside, a street column, one wall row. */
function fixture(): PixelMap {
  const w = 6
  const h = 4
  const size = w * h
  const map: PixelMap = {
    widthTiles: w,
    heightTiles: h,
    originM: { x: 0, z: 0 },
    layers: {
      floor: new Uint16Array(size),
      walls: new Uint16Array(size),
      overhead: new Uint16Array(size),
    },
    objects: [],
    solid: new Uint8Array(size),
    rooms: [
      {
        id: 's/street',
        name: 'Main Street',
        rect: { tx: 0, ty: 0, tw: 1, th: 4 },
        placement: 'street:0',
      },
      {
        id: 'w/hall',
        name: 'Hall',
        rect: { tx: 2, ty: 0, tw: 4, th: 4 },
        placement: 'wing:p:0',
        theme: 'forest',
      },
      {
        id: 'w/pod',
        name: 'Pod',
        rect: { tx: 4, ty: 2, tw: 2, th: 2 },
        placement: 'wing:p:0',
        theme: 'ocean',
      },
    ],
    key: 'k',
    dirty: [],
  }
  for (const r of map.rooms)
    for (let y = r.rect.ty; y < r.rect.ty + r.rect.th; y++)
      for (let x = r.rect.tx; x < r.rect.tx + r.rect.tw; x++) map.layers.floor[y * w + x] = 1
  // A wall along row 0 of the wing, with a door at (3, 0).
  for (let x = 2; x < 6; x++) map.layers.walls[x] = 5
  map.objects.push(
    { id: 'door', kind: 'door', rect: { tx: 3, ty: 0, tw: 1, th: 1 }, sortY: 0, solid: false },
    { id: 'desk', kind: 'desk', rect: { tx: 2, ty: 2, tw: 2, th: 1 }, sortY: 0, solid: true },
    { id: 'rug', kind: 'rug', rect: { tx: 2, ty: 3, tw: 1, th: 1 }, sortY: 0, solid: false },
  )
  return map
}

describe('minimap colours (MMC)', () => {
  // MMC-1: one colour per tile from the map's own data.
  it('colours floors by theme, the street, walls, doors and solid furniture', () => {
    const map = fixture()
    const c = minimapColors(map, palette)
    const at = (x: number, y: number) => c[y * map.widthTiles + x]
    expect(at(0, 1)).toBe('street')
    expect(at(1, 1)).toBeNull()
    expect(at(2, 0)).toBe('wall')
    expect(at(3, 0)).toBe('door')
    expect(at(2, 1)).toBe('floor:forest')
    expect(at(4, 3)).toBe('floor:ocean') // the smallest room wins
    expect(at(2, 2)).toBe('furniture')
    expect(at(3, 2)).toBe('furniture')
    expect(at(2, 3)).toBe('floor:forest') // rugs are floor
  })

  // MMC-2: deterministic: the same map gives the same colours.
  it('is deterministic', () => {
    expect(minimapColors(fixture(), palette)).toEqual(minimapColors(fixture(), palette))
  })

  it('ignores objects outside the map and uses the plain floor without a theme', () => {
    const map = fixture()
    map.rooms[1]!.theme = undefined
    map.objects.push({
      id: 'x',
      kind: 'desk',
      rect: { tx: 5, ty: 3, tw: 4, th: 4 },
      sortY: 0,
      solid: true,
    })
    const c = minimapColors(map, palette)
    expect(c).toHaveLength(24)
    expect(c[1 * 6 + 2]).toBe('floor')
    expect(c[3 * 6 + 5]).toBe('furniture')
  })
})
