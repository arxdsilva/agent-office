import type { AgentEvent } from '@agent-office/shared'
import { applyEvent, isVisibleChange, sweepAgent, type SweepPolicy } from '../domain/agent.ts'
import type { AgentRepository, Clock, EventPublisher, MessageRepository } from '../ports/driven.ts'
import type { Housekeeping, ReportActivity } from '../ports/driving.ts'

export interface ActivityDeps {
  agents: AgentRepository
  messages: MessageRepository
  bus: EventPublisher
  clock: Clock
  policy: SweepPolicy
  /** Ids a managed session owns: only its own (source 'managed') events may update them. */
  owned?: (agentId: string) => boolean
}

/** Applies agent activity from any producer and keeps the office tidy. */
export class ActivityService implements ReportActivity, Housekeeping {
  constructor(private d: ActivityDeps) {}

  report(events: AgentEvent[]): number {
    const now = this.d.clock.now()
    let accepted = 0
    for (const e of events) {
      if (e.source !== 'managed' && this.d.owned?.(e.agentId)) continue
      const prev = this.d.agents.get(e.agentId)
      const next = applyEvent(prev, e, now)
      if (!next) continue
      accepted++
      this.d.agents.put(next)
      if (isVisibleChange(prev, next)) this.d.bus.publish({ type: 'agent.upserted', agent: next })
    }
    return accepted
  }

  sweep(): void {
    const now = this.d.clock.now()
    for (const a of this.d.agents.list()) {
      const r = sweepAgent(a, now, this.d.policy)
      if (r.kind === 'remove') {
        this.d.agents.delete(a.id)
        this.d.messages.dropAgent(a.id)
        this.d.bus.publish({ type: 'agent.removed', id: a.id })
      } else if (r.kind === 'update') {
        this.d.agents.put(r.agent)
        this.d.bus.publish({ type: 'agent.upserted', agent: r.agent })
      }
    }
  }
}
