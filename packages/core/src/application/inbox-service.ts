import type { ChatMessage } from '@agent-office/shared'
import { isVisibleChange } from '../domain/agent.ts'
import { RateLimitedError, UnknownAgentError } from '../domain/errors.ts'
import { deliver, isAwaitingReply, markReplied, newReply, newUserMessage } from '../domain/message.ts'
import { RateWindow } from '../domain/rate-limit.ts'
import type { AgentRepository, Clock, EventPublisher, EventSubscriber, IdGenerator, MessageRepository, Scheduler } from '../ports/driven.ts'
import type { AgentInbox, CancelSignal, UserChat } from '../ports/driving.ts'

export interface InboxDeps {
  agents: AgentRepository
  messages: MessageRepository
  bus: EventPublisher & EventSubscriber
  clock: Clock
  ids: IdGenerator
  scheduler: Scheduler
  rateLimitPerSec?: number
}

/** Messages between the human (UserChat) and agents (AgentInbox). */
export class InboxService implements AgentInbox, UserChat {
  private rate: RateWindow

  constructor(private d: InboxDeps) {
    this.rate = new RateWindow(d.rateLimitPerSec ?? 10)
  }

  send(agentId: string, text: string): ChatMessage {
    if (!this.d.agents.get(agentId)) throw new UnknownAgentError(agentId)
    const now = this.d.clock.now()
    if (!this.rate.allow(agentId, now)) throw new RateLimitedError()
    const m = newUserMessage(this.d.ids.next(), agentId, text, now)
    this.d.messages.append(m)
    this.d.bus.publish({ type: 'message.changed', message: m })
    this.d.bus.publish({ type: 'inbox.queued', agentId })
    this.syncAgent(agentId)
    return m
  }

  history(agentId: string): ChatMessage[] {
    return this.d.messages.byAgent(agentId)
  }

  claim(agentId: string): ChatMessage[] {
    const delivered = this.queued(agentId).map(deliver)
    for (const m of delivered) {
      this.d.messages.update(m)
      this.d.bus.publish({ type: 'message.changed', message: m })
    }
    this.syncAgent(agentId, true)
    return delivered
  }

  peek(agentId: string): ChatMessage[] {
    this.syncAgent(agentId, true)
    return this.queued(agentId)
  }

  waitForMessages(agentId: string, ms: number, signal?: CancelSignal): Promise<boolean> {
    if (this.queued(agentId).length > 0) return Promise.resolve(true)
    if (signal?.aborted) return Promise.resolve(false)
    return new Promise((resolve) => {
      const done = (v: boolean) => {
        cancelTimer()
        off()
        signal?.removeEventListener('abort', onAbort)
        resolve(v)
      }
      const off = this.d.bus.subscribe((e) => e.type === 'inbox.queued' && e.agentId === agentId && done(true))
      const onAbort = () => done(false)
      const cancelTimer = this.d.scheduler.after(ms, () => done(false))
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  reply(agentId: string, text: string, opts: { inReplyTo?: string; requireAwaiting?: boolean } = {}): ChatMessage | null {
    const awaiting = this.d.messages
      .byAgent(agentId)
      .filter((m) => isAwaitingReply(m) && (!opts.inReplyTo || m.id === opts.inReplyTo))
    if (opts.requireAwaiting && awaiting.length === 0) return null
    for (const m of awaiting.map(markReplied)) {
      this.d.messages.update(m)
      this.d.bus.publish({ type: 'message.changed', message: m })
    }
    const r = newReply(this.d.ids.next(), agentId, text, this.d.clock.now(), opts.inReplyTo)
    this.d.messages.append(r)
    this.d.bus.publish({ type: 'message.changed', message: r })
    return r
  }

  private queued(agentId: string): ChatMessage[] {
    return this.d.messages.byAgent(agentId).filter((m) => m.state === 'queued')
  }

  /** Keeps the agent's unread badge (and interactive flag, when its inbox is read) in sync. */
  private syncAgent(agentId: string, inboxRead = false): void {
    const prev = this.d.agents.get(agentId)
    if (!prev) return
    const next = { ...prev, unread: this.queued(agentId).length }
    if (inboxRead) {
      next.interactive = true
      next.inboxReadAt = this.d.clock.now()
    }
    this.d.agents.put(next)
    if (isVisibleChange(prev, next)) this.d.bus.publish({ type: 'agent.upserted', agent: next })
  }
}
