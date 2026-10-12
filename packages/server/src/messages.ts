import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ChatMessage } from '@agent-office/shared'

export interface MessageStoreOptions {
  /** Messages kept per agent (ring buffer). */
  max?: number
  now?: () => number
  id?: () => string
}

type Events = { chat: [ChatMessage]; queued: [string] }

/** Per-agent inbox and chat history. In memory only — never persisted. */
export class MessageStore extends EventEmitter<Events> {
  private byAgent = new Map<string, ChatMessage[]>()
  private max: number
  private now: () => number
  private id: () => string

  constructor(opts: MessageStoreOptions = {}) {
    super()
    this.max = opts.max ?? 200
    this.now = opts.now ?? Date.now
    this.id = opts.id ?? randomUUID
    this.setMaxListeners(0)
  }

  enqueue(agentId: string, text: string): ChatMessage {
    const m: ChatMessage = {
      id: this.id(),
      agentId,
      from: 'user',
      text,
      ts: this.now(),
      state: 'queued',
    }
    this.push(m)
    this.emit('queued', agentId)
    return m
  }

  /** Atomically moves every queued message to delivered and returns them. */
  claim(agentId: string): ChatMessage[] {
    const claimed: ChatMessage[] = []
    for (const m of this.byAgent.get(agentId) ?? []) {
      if (m.state !== 'queued') continue
      m.state = 'delivered'
      claimed.push({ ...m })
      this.emit('chat', { ...m })
    }
    return claimed
  }

  /** Delivered user messages that have no reply yet. */
  awaitingReply(agentId: string): ChatMessage[] {
    return (this.byAgent.get(agentId) ?? []).filter(
      (m) => m.from === 'user' && m.state === 'delivered',
    )
  }

  /** Records an agent reply. Without `inReplyTo`, it answers every delivered message. */
  reply(agentId: string, text: string, inReplyTo?: string): ChatMessage {
    for (const m of this.byAgent.get(agentId) ?? []) {
      if (m.from !== 'user' || m.state !== 'delivered') continue
      if (inReplyTo && m.id !== inReplyTo) continue
      m.state = 'replied'
      this.emit('chat', { ...m })
    }
    const r: ChatMessage = {
      id: this.id(),
      agentId,
      from: 'agent',
      text,
      ts: this.now(),
      state: 'replied',
      ...(inReplyTo ? { inReplyTo } : {}),
    }
    this.push(r)
    return r
  }

  unread(agentId: string): number {
    return (this.byAgent.get(agentId) ?? []).filter((m) => m.state === 'queued').length
  }

  history(agentId: string): ChatMessage[] {
    return (this.byAgent.get(agentId) ?? []).map((m) => ({ ...m }))
  }

  /** Last `perAgent` messages of every agent, for WebSocket snapshots. */
  recent(perAgent: number): ChatMessage[] {
    return [...this.byAgent.values()].flatMap((ms) => ms.slice(-perAgent).map((m) => ({ ...m })))
  }

  drop(agentId: string): void {
    this.byAgent.delete(agentId)
  }

  /** Resolves true as soon as the agent has queued messages, false on timeout or abort. */
  waitFor(agentId: string, ms: number, signal?: AbortSignal): Promise<boolean> {
    if (this.unread(agentId) > 0) return Promise.resolve(true)
    return new Promise((resolve) => {
      const done = (v: boolean) => {
        clearTimeout(timer)
        this.off('queued', onQueued)
        signal?.removeEventListener('abort', onAbort)
        resolve(v)
      }
      const onQueued = (id: string) => id === agentId && done(true)
      const onAbort = () => done(false)
      const timer = setTimeout(() => done(false), ms)
      this.on('queued', onQueued)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private push(m: ChatMessage): void {
    const list = this.byAgent.get(m.agentId) ?? []
    list.push(m)
    if (list.length > this.max) list.splice(0, list.length - this.max)
    this.byAgent.set(m.agentId, list)
    this.emit('chat', { ...m })
  }
}
