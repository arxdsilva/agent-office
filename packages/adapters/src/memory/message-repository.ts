import type { MessageRepository } from '@agent-office/core'
import type { ChatMessage } from '@agent-office/shared'

/** Per-agent ring buffer. Never persisted (PRIVACY_SECURITY rule). */
export class InMemoryMessageRepository implements MessageRepository {
  private byId = new Map<string, ChatMessage[]>()

  constructor(private cap = 200) {}

  append(m: ChatMessage): void {
    const list = this.byId.get(m.agentId) ?? []
    list.push({ ...m })
    if (list.length > this.cap) list.splice(0, list.length - this.cap)
    this.byId.set(m.agentId, list)
  }

  update(m: ChatMessage): void {
    const list = this.byId.get(m.agentId)
    const i = list?.findIndex((x) => x.id === m.id) ?? -1
    if (list && i >= 0) list[i] = { ...m }
  }

  byAgent(agentId: string): ChatMessage[] {
    return (this.byId.get(agentId) ?? []).map((m) => ({ ...m }))
  }

  recent(perAgent: number): ChatMessage[] {
    return [...this.byId.values()].flatMap((l) => l.slice(-perAgent).map((m) => ({ ...m })))
  }

  dropAgent(agentId: string): void {
    this.byId.delete(agentId)
  }
}
