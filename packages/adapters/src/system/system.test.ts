import { describe, expect, it, vi } from 'vitest'
import { ConsoleLogger, RandomIds, SystemClock, TimerScheduler } from './index.ts'

describe('system adapters', () => {
  it('clock and ids', () => {
    expect(Math.abs(new SystemClock().now() - Date.now())).toBeLessThan(50)
    const ids = new RandomIds()
    expect(ids.next()).not.toBe(ids.next())
  })

  it('scheduler runs and cancels intervals and one-shot timers', async () => {
    const s = new TimerScheduler()
    const tick = vi.fn()
    const once = vi.fn()
    const never = vi.fn()
    const stop = s.every(5, tick)
    s.after(5, once)
    s.after(5, never)()
    await new Promise((r) => setTimeout(r, 30))
    stop()
    const calls = tick.mock.calls.length
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toBeGreaterThan(0)
    expect(tick.mock.calls.length).toBe(calls)
    expect(once).toHaveBeenCalledTimes(1)
    expect(never).not.toHaveBeenCalled()
    s.dispose()
  })

  it('logger writes to the given sink', () => {
    const lines: string[] = []
    const log = new ConsoleLogger((l) => lines.push(l))
    log.info('a')
    log.warn('b')
    expect(lines).toEqual(['[agent-office] a', '[agent-office] warn: b'])
  })
})
