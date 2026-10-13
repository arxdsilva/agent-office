// Persists what matters from the live office (docs/projects.md §3): session records and
// agent-office chat. The live repositories stay in memory; the vault outlives every agent.
import type { ChatMessage } from '@agent-office/shared'
import type { AgentState } from '../domain/agent.ts'
import type { SessionRecord } from '../domain/session-record.ts'
import { cleanText } from '../domain/text.ts'
import type { AgentRepository, Clock, EventSubscriber } from '../ports/driven.ts'
import type { ProjectsStore } from './projects-store.ts'
import type { SessionVaultService } from './session-vault-service.ts'

/** A lastSeen-only change is persisted at most this often. */
export const LAST_SEEN_PERSIST_MS = 60_000
const MAX_TOOLS = 20

export interface RecorderDeps {
  store: ProjectsStore
  vault: SessionVaultService
  agents: AgentRepository
  bus: EventSubscriber
  clock: Clock
}

export class VaultRecorder {
  private off: (() => void) | undefined
  private persistedSeen = new Map<string, number>()

  constructor(private d: RecorderDeps) {}

  /** Backfills live agents and ends records whose agents are gone, then follows the bus. */
  start(): void {
    for (const r of [...this.d.store.sessions.values()])
      if (r.state === 'active' && !this.d.agents.get(r.agentId)) this.d.vault.end(r)
    for (const a of this.d.agents.list()) this.onAgent(a)
    this.off ??= this.d.bus.subscribe((e) => {
      if (e.type === 'agent.upserted') this.onAgent(e.agent)
      else if (e.type === 'agent.removed') this.onRemoved(e.id)
      else if (e.type === 'message.changed') this.onMessage(e.message)
    })
  }

  stop(): void {
    this.off?.()
    this.off = undefined
  }

  private onAgent(a: AgentState): void {
    let r = this.d.vault.ensure(a.id, a.provider)
    if (r.state !== 'active') {
      if (a.status === 'done') return
      r = this.d.vault.reactivate(r)
    }
    const next: SessionRecord = { ...r, lastSeenAt: Math.max(r.lastSeenAt, a.lastSeen) }
    if (a.managed && next.origin !== 'managed') next.origin = 'managed'
    if (a.name && a.name !== a.id && a.name !== next.title) next.title = a.name.slice(0, 120)
    if (
      a.status === 'tool' &&
      a.tool &&
      !next.tools.includes(a.tool) &&
      next.tools.length < MAX_TOOLS
    )
      next.tools = [...next.tools, a.tool.slice(0, 60)]
    const meaningful =
      next.origin !== r.origin || next.title !== r.title || next.tools.length !== r.tools.length
    const seen = this.persistedSeen.get(r.id) ?? r.startedAt
    if (meaningful || next.lastSeenAt - seen >= LAST_SEEN_PERSIST_MS) {
      this.persistedSeen.set(r.id, next.lastSeenAt)
      void this.d.store.putSession(next)
    } else {
      this.d.store.sessions.set(next.id, next) // in memory; persisted with the next change
    }

    // Project: an explicit start in a project assigns once; otherwise the record wins.
    if (a.projectId && next.assignment.by === 'none' && next.projectId === null)
      void this.d.vault.applyAssignment(next, a.projectId, 'user', 'managed')
    else this.d.vault.syncAgent(next)

    if (a.status === 'done') this.d.vault.end(this.d.store.sessions.get(next.id)!)
  }

  private onRemoved(agentId: string): void {
    const r = this.d.store.sessionByAgent(agentId)
    if (r) this.d.vault.end(r)
  }

  private onMessage(m: ChatMessage): void {
    const agent = this.d.agents.get(m.agentId)
    const r =
      this.d.store.sessionByAgent(m.agentId) ??
      (agent ? this.d.vault.ensure(agent.id, agent.provider) : undefined)
    if (!r) return
    void this.d.store.putChat(r.id, {
      id: m.id.slice(0, 100),
      role: m.from,
      text: cleanText(m.text, 4000),
      ts: m.ts,
    })
  }
}
