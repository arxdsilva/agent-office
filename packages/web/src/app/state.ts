import type { Agent, ChatMessage, ServerMessage } from '@agent-office/shared'

const MAX_MESSAGES_PER_AGENT = 200

export interface OfficeState {
  agents: Map<string, Agent>
  /** Chat thread per agent id, oldest first. */
  messages: Map<string, ChatMessage[]>
}

export const emptyState = (): OfficeState => ({ agents: new Map(), messages: new Map() })

/** Pure reducer for server messages. Returns a new state; the input is not mutated. */
export function applyMessage(state: OfficeState, msg: ServerMessage): OfficeState {
  switch (msg.type) {
    case 'snapshot': {
      const messages = new Map<string, ChatMessage[]>()
      for (const m of msg.messages) messages.set(m.agentId, [...(messages.get(m.agentId) ?? []), m])
      return { agents: new Map(msg.agents.map((a) => [a.id, a])), messages }
    }
    case 'upsert': {
      const agents = new Map(state.agents)
      agents.set(msg.agent.id, msg.agent)
      return { ...state, agents }
    }
    case 'remove': {
      const agents = new Map(state.agents)
      const messages = new Map(state.messages)
      agents.delete(msg.id)
      messages.delete(msg.id)
      return { agents, messages }
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
  }
}
