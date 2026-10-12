import { EventEmitter } from 'node:events'
import type { Agent, AgentEvent } from '@agent-office/shared'

export interface StoreOptions {
  idleAfterMs: number
  expireAfterMs: number
  doneTtlMs: number
  interactiveTtlMs: number
}

type Events = { upsert: [Agent]; remove: [string] }

const VISIBLE: (keyof Agent)[] = [
  'name',
  'provider',
  'topic',
  'model',
  'kind',
  'parentId',
  'status',
  'tool',
  'text',
  'interactive',
  'unread',
]

/** Single in-memory source of truth for agent state. Time is always passed in. */
export class AgentStore extends EventEmitter<Events> {
  private agents = new Map<string, Agent>()
  private inboxReadAt = new Map<string, number>()

  constructor(private opts: StoreOptions) {
    super()
  }

  apply(e: AgentEvent, now = Date.now()): Agent | undefined {
    const ts = e.ts ?? now
    const prev = this.agents.get(e.agentId)
    if (prev && ts < prev.lastSeen) return prev

    const source = e.source ?? prev?.source ?? 'http'
    const next: Agent = prev
      ? { ...prev, lastSeen: ts }
      : {
          id: e.agentId,
          name: e.agentId,
          provider: e.provider ?? source,
          topic: 'untitled',
          status: 'idle',
          source,
          since: ts,
          lastSeen: ts,
          interactive: false,
          unread: 0,
        }
    for (const k of [
      'name',
      'provider',
      'topic',
      'model',
      'kind',
      'parentId',
      'status',
      'tool',
      'text',
    ] as const) {
      if (e[k] !== undefined) (next as unknown as Record<string, unknown>)[k] = e[k]
    }
    if (next.status !== 'tool' && e.tool === undefined) delete next.tool

    this.put(prev, next)
    return next
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id)
  }

  list(): Agent[] {
    return [...this.agents.values()].sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || a.topic.localeCompare(b.topic) || a.since - b.since,
    )
  }

  /** Something read this agent's inbox: it will see messages. */
  markInteractive(id: string, now = Date.now()): void {
    const prev = this.agents.get(id)
    if (!prev) return
    this.inboxReadAt.set(id, now)
    this.put(prev, { ...prev, interactive: true })
  }

  setUnread(id: string, unread: number): void {
    const prev = this.agents.get(id)
    if (prev) this.put(prev, { ...prev, unread })
  }

  sweep(now = Date.now()): void {
    const { idleAfterMs, expireAfterMs, doneTtlMs, interactiveTtlMs } = this.opts
    for (const a of [...this.agents.values()]) {
      const silent = now - a.lastSeen
      if (silent > expireAfterMs || (a.status === 'done' && silent > doneTtlMs)) {
        this.agents.delete(a.id)
        this.inboxReadAt.delete(a.id)
        this.emit('remove', a.id)
        continue
      }
      let next = a
      if (silent > idleAfterMs && (a.status === 'thinking' || a.status === 'tool')) {
        next = { ...next, status: 'idle' }
        delete next.tool
      }
      if (a.interactive && now - (this.inboxReadAt.get(a.id) ?? 0) > interactiveTtlMs) {
        next = { ...next, interactive: false }
      }
      this.put(a, next)
    }
  }

  private put(prev: Agent | undefined, next: Agent): void {
    this.agents.set(next.id, next)
    if (!prev || VISIBLE.some((k) => prev[k] !== next[k])) this.emit('upsert', next)
  }
}
