import type { EventPublisher, EventSubscriber, Logger, OfficeEvent } from '@agent-office/core'

/** Synchronous in-process bus. A failing subscriber never breaks the publisher or other subscribers. */
export class InMemoryEventBus implements EventPublisher, EventSubscriber {
  private subs = new Set<(e: OfficeEvent) => void>()

  constructor(private log?: Logger) {}

  publish(e: OfficeEvent): void {
    for (const fn of [...this.subs]) {
      try {
        fn(e)
      } catch (err) {
        this.log?.warn(`event subscriber failed on ${e.type}: ${(err as Error).message}`)
      }
    }
  }

  subscribe(fn: (e: OfficeEvent) => void): () => void {
    this.subs.add(fn)
    return () => void this.subs.delete(fn)
  }
}
