import type {
  Agent,
  Capability,
  PermissionRequestVM,
  ServerMessage,
  Snapshot,
} from '@agent-office/shared'
import { toDto } from '../domain/agent.ts'
import type { AgentRepository, EventSubscriber, MessageRepository } from '../ports/driven.ts'
import type { OfficeQuery } from '../ports/driving.ts'

export interface QueryDeps {
  agents: AgentRepository
  messages: MessageRepository
  bus: EventSubscriber
  /** Capability catalog (CapabilityService); omitted → snapshots carry no capabilities. */
  capabilities?: { list(): Capability[] }
  snapshotMessagesPerAgent?: number
  /** Pending permission requests of managed sessions; omitted → none. */
  permissions?: { pending(agentId: string): PermissionRequestVM[] }
}

/** Read model for UIs: snapshots plus a change stream in UI message shape. */
export class OfficeQueryService implements OfficeQuery {
  constructor(private d: QueryDeps) {}

  agents(): Agent[] {
    return this.d.agents
      .list()
      .map(toDto)
      .sort(
        (a, b) =>
          a.provider.localeCompare(b.provider) ||
          a.topic.localeCompare(b.topic) ||
          a.since - b.since,
      )
  }

  agent(id: string): Agent | undefined {
    const a = this.d.agents.get(id)
    return a && toDto(a)
  }

  snapshot(): Snapshot {
    return {
      agents: this.agents(),
      messages: this.d.messages.recent(this.d.snapshotMessagesPerAgent ?? 50),
      ...(this.d.capabilities ? { capabilities: this.d.capabilities.list() } : {}),
    }
  }

  watch(fn: (m: ServerMessage) => void): () => void {
    return this.d.bus.subscribe((e) => {
      if (e.type === 'agent.upserted') fn({ type: 'upsert', agent: toDto(e.agent) })
      else if (e.type === 'agent.removed') fn({ type: 'remove', id: e.id })
      else if (e.type === 'message.changed') fn({ type: 'chat', message: e.message })
      else if (e.type === 'capabilities.changed')
        fn({ type: 'capabilities', provider: e.provider, capabilities: e.capabilities })
      else if (e.type === 'permission.changed')
        fn({
          type: 'permission',
          agentId: e.agentId,
          requests: this.d.permissions?.pending(e.agentId) ?? [],
        })
    })
  }
}
