import { describe, expect, it } from 'vitest'
import { FrameLru } from './frame-lru.ts'

describe('FrameLru: an LRU that never evicts what the current frame drew', () => {
  // LRU-1: past the cap, the frame boundary drops the least recently used entry.
  it('evicts the least recently used entry past the cap at the next frame', () => {
    const dropped: string[] = []
    const lru = new FrameLru<number>(2, (k) => dropped.push(k))
    lru.nextFrame()
    lru.get('a', () => 1)
    lru.nextFrame()
    lru.get('b', () => 2)
    lru.nextFrame()
    lru.get('a', () => 0)
    lru.nextFrame()
    lru.get('c', () => 3)
    lru.nextFrame()
    expect(dropped).toEqual(['b'])
    expect(lru.size).toBe(2)
  })

  // LRU-2: zoomed out, more looks than the cap are drawn in one frame. Nothing drawn this frame is
  // evicted, so the next frame reuses every entry instead of rebuilding them all (the 16 fps bug).
  it('keeps everything used in the current frame, even past the cap', () => {
    let built = 0
    const lru = new FrameLru<number>(2)
    const drawAll = () => {
      lru.nextFrame()
      for (const k of ['a', 'b', 'c', 'd']) lru.get(k, () => ++built)
    }
    drawAll()
    drawAll()
    drawAll()
    expect(built).toBe(4)
    expect(lru.size).toBe(4)
  })

  // LRU-3: once those entries go unused, the cache shrinks back to the cap.
  it('shrinks back to the cap once the extra entries go unused', () => {
    const lru = new FrameLru<number>(2)
    lru.nextFrame()
    for (const k of ['a', 'b', 'c', 'd']) lru.get(k, () => 1)
    lru.nextFrame()
    lru.get('d', () => 1)
    lru.get('e', () => 1)
    lru.nextFrame()
    expect(lru.size).toBe(2)
    expect(lru.has('d') && lru.has('e')).toBe(true)
  })
})

describe('FrameLru: iteration and clearing', () => {
  // LRU-4: forEach visits every entry; clear evicts them all through onEvict.
  it('visits every entry and evicts all on clear', () => {
    const dropped: string[] = []
    const lru = new FrameLru<number>(4, (k) => dropped.push(k))
    lru.get('a', () => 1)
    lru.get('b', () => 2)
    let sum = 0
    lru.forEach((v) => (sum += v))
    expect(sum).toBe(3)
    lru.clear()
    expect(dropped).toEqual(['a', 'b'])
    expect(lru.size).toBe(0)
  })
})
