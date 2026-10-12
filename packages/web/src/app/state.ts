import type {
  Agent,
  Capability,
  ChatMessage,
  PermissionRequestVM,
  ServerMessage,
} from '@agent-office/shared'

const MAX_MESSAGES_PER_AGENT = 200

export interface OfficeState {
  agents: Map<string, Agent>
  /** Chat thread per agent id, oldest first. */
  messages: Map<string, ChatMessage[]>
  /** What each provider's agents can use (adapters, skills, rules), keyed by provider. */
  capabilities: Map<string, Capability[]>
  /** Pending permission requests of managed sessions, keyed by agent id (oldest first). */
  permissions?: Map<string, PermissionRequestVM[]>
}

export const emptyState = (): OfficeState => ({
  agents: new Map(),
  messages: new Map(),
  capabilities: new Map(),
  permissions: new Map(),
})

function byProvider(caps: Capability[]): Map<string, Capability[]> {
  const out = new Map<string, Capability[]>()
  for (const c of caps) out.set(c.provider, [...(out.get(c.provider) ?? []), c])
  return out
}

/** Pure reducer for server messages. Returns a new state; the input is not mutated. */
export function applyMessage(state: OfficeState, msg: ServerMessage): OfficeState {
  switch (msg.type) {
    case 'snapshot': {
      const messages = new Map<string, ChatMessage[]>()
      for (const m of msg.messages) messages.set(m.agentId, [...(messages.get(m.agentId) ?? []), m])
      const agents = new Map(msg.agents.map((a) => [a.id, a]))
      return {
        agents,
        messages,
        // Older backends send no capabilities: keep what we have.
        capabilities: msg.capabilities ? byProvider(msg.capabilities) : state.capabilities,
        // Not part of the snapshot: keep the requests of agents that are still here.
        permissions: new Map([...(state.permissions ?? [])].filter(([id]) => agents.has(id))),
      }
    }
    case 'upsert': {
      const agents = new Map(state.agents)
      agents.set(msg.agent.id, msg.agent)
      return { ...state, agents }
    }
    case 'remove': {
      const agents = new Map(state.agents)
      const messages = new Map(state.messages)
      const permissions = new Map(state.permissions ?? [])
      agents.delete(msg.id)
      messages.delete(msg.id)
      permissions.delete(msg.id)
      return { ...state, agents, messages, permissions }
    }
    case 'capabilities': {
      const capabilities = new Map(state.capabilities)
      if (msg.capabilities.length) capabilities.set(msg.provider, msg.capabilities)
      else capabilities.delete(msg.provider)
      return { ...state, capabilities }
    }
    case 'chat': {
      const m = msg.message
      const thread = [...(state.messages.get(m.agentId) ?? [])]
      const i = thread.findIndex((x) => x.id === m.id)
      if (i >= 0) thread[i] = m
      else thread.push(m)
      const messages = new Map(state.messages)
      messages.set(m.agentId, thread.slice(-MAX_MESSAGES_PER_AGENT))
      return { ...state, messages }
    }
    case 'permission': {
      const permissions = new Map(state.permissions ?? [])
      if (msg.requests.length) permissions.set(msg.agentId, msg.requests)
      else permissions.delete(msg.agentId)
      return { ...state, permissions }
    }
    default:
      // Newer backends may send message types this renderer doesn't know yet.
      return state
  }
}
