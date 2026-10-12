import { describe, expect, it } from 'vitest'
import { createSimClock } from './sim-clock.ts'

describe('sim clock', () => {
  it('follows real time at scale 1', () => {
    let real = 1000
    const c = createSimClock(() => real)
    expect(c.now()).toBe(1000)
    real = 1500
    expect(c.now()).toBe(1500)
    expect(c.scale).toBe(1)
  })

  it('speeds up from the moment the scale changes, without jumping', () => {
    let real = 1000
    const c = createSimClock(() => real)
    real = 2000
    c.setScale(10)
    expect(c.now()).toBe(2000)
    real = 2100
    expect(c.now()).toBe(3000)
    c.setScale(1)
    real = 2200
    expect(c.now()).toBe(3100)
  })

  it('rejects nonsense scales', () => {
    const c = createSimClock(() => 0)
    c.setScale(0)
    expect(c.scale).toBe(1)
    c.setScale(Number.NaN)
    expect(c.scale).toBe(1)
    c.setScale(1000)
    expect(c.scale).toBe(60)
  })
})
