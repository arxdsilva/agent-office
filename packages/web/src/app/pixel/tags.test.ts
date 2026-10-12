import { describe, expect, it } from 'vitest'
import { declutterTags } from './tags.ts'

// Name tags in the 2D view must never overlap: clustered agents otherwise read as "THEO LORE".
describe('declutterTags', () => {
  const tag = (id: string, x: number, y: number, priority: number, w = 30) => ({
    id,
    x,
    y,
    w,
    h: 11,
    priority,
  })

  it('keeps every tag when none overlap', () => {
    expect([...declutterTags([tag('a', 0, 0, 1), tag('b', 100, 0, 1)])].sort()).toEqual(['a', 'b'])
  })

  it('drops the lower-priority tag of an overlapping pair', () => {
    expect([...declutterTags([tag('far', 10, 0, 1), tag('near', 0, 0, 5)])]).toEqual(['near'])
  })

  it('keeps tags that only touch at the edge, and resolves chains greedily', () => {
    // a (prio 3) overlaps b (2); b overlaps c (1); a and c are apart → a and c stay.
    const kept = declutterTags([tag('a', 0, 0, 3), tag('b', 25, 0, 2), tag('c', 50, 0, 1)])
    expect([...kept].sort()).toEqual(['a', 'c'])
    expect([...declutterTags([tag('x', 0, 0, 1), tag('y', 30, 0, 1)])].sort()).toEqual(['x', 'y'])
  })

  it('breaks priority ties by id, so the result is stable frame to frame', () => {
    expect([...declutterTags([tag('b', 0, 0, 1), tag('a', 5, 0, 1)])]).toEqual(['a'])
  })

  // Zoomed out (fewer than 2 device px per art px) only essential tags show: selected, hovered,
  // waiting or error agents. At 2 and above every tag competes as usual.
  it('keeps only essential tags when zoomed out below 2', () => {
    const tags = [
      { ...tag('sel', 0, 0, 9), essential: true },
      tag('plain', 100, 0, 1),
      { ...tag('err', 200, 0, 1), essential: true },
    ]
    expect([...declutterTags(tags, 1)].sort()).toEqual(['err', 'sel'])
    expect([...declutterTags(tags, 2)].sort()).toEqual(['err', 'plain', 'sel'])
    expect([...declutterTags(tags)].sort()).toEqual(['err', 'plain', 'sel'])
    // Essential tags still never overlap each other.
    const pile = [
      { ...tag('a', 0, 0, 2), essential: true },
      { ...tag('b', 5, 0, 1), essential: true },
    ]
    expect([...declutterTags(pile, 1)]).toEqual(['a'])
  })
})
