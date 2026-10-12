import type { AgentRepository, AgentState } from '@agent-office/core'

export class InMemoryAgentRepository implements AgentRepository {
  private agents = new Map<string, AgentState>()

  get(id: string): AgentState | undefined {
    const a = this.agents.get(id)
    return a && { ...a }
  }

  put(agent: AgentState): void {
    this.agents.set(agent.id, { ...agent })
  }

  delete(id: string): void {
    this.agents.delete(id)
  }

  list(): AgentState[] {
    return [...this.agents.values()].map((a) => ({ ...a }))
  }
}
