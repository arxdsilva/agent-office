import { randomUUID } from 'node:crypto'
import type { Clock, IdGenerator, Logger, Scheduler } from '@agent-office/core'

export class SystemClock implements Clock {
  now(): number {
    return Date.now()
  }
}

export class RandomIds implements IdGenerator {
  next(): string {
    return randomUUID()
  }
}

/** Never logs message or transcript content — callers pass short operational text only. */
export class ConsoleLogger implements Logger {
  constructor(private sink: (line: string) => void = (l) => console.log(l)) {}
  info(msg: string): void {
    this.sink(`[agent-office] ${msg}`)
  }
  warn(msg: string): void {
    this.sink(`[agent-office] warn: ${msg}`)
  }
}

/** Real timers. `dispose()` cancels everything still pending (used on shutdown). */
export class TimerScheduler implements Scheduler {
  private handles = new Set<NodeJS.Timeout>()

  every(ms: number, fn: () => void): () => void {
    const h = setInterval(fn, ms)
    h.unref?.()
    this.handles.add(h)
    return () => this.clear(h)
  }

  after(ms: number, fn: () => void): () => void {
    const h = setTimeout(() => {
      this.handles.delete(h)
      fn()
    }, ms)
    this.handles.add(h)
    return () => this.clear(h)
  }

  dispose(): void {
    for (const h of this.handles) clearTimeout(h)
    this.handles.clear()
  }

  private clear(h: NodeJS.Timeout): void {
    clearTimeout(h)
    this.handles.delete(h)
  }
}
