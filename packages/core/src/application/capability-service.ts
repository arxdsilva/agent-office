import type { Capability, CapabilityDecl } from '@agent-office/shared'
import type { AgentState } from '../domain/agent.ts'
import {
  classifyUse,
  declare,
  mergeUse,
  sortCapabilities,
  withActive,
} from '../domain/capabilities.ts'
import type {
  CapabilityRepository,
  Clock,
  EventPublisher,
  EventSubscriber,
  Scheduler,
} from '../ports/driven.ts'
import type { ReportCapabilities } from '../ports/driving.ts'

/** At most one `capabilities.changed` per provider in this window. */
export const CAPABILITY_DEBOUNCE_MS = 250
/** New capabilities beyond this per provider are ignored (bounded memory for any producer). */
export const MAX_CAPABILITIES_PER_PROVIDER = 128

export interface CapabilityDeps {
  repo: CapabilityRepository
  bus: EventPublisher & EventSubscriber
  clock: Clock
  scheduler: Scheduler
  debounceMs?: number
  maxPerProvider?: number
}

interface CurrentUse {
  provider: string
  id: string
  /** Identifies one tool call, so repeated upserts of the same call count once. */
  key: string
}

/**
 * Keeps each provider's catalog of adapters, skills and rules: declared by sources, and observed
 * from tool calls (`agent.upserted` with status `tool`). Publishes `capabilities.changed`.
 */
export class CapabilityService implements ReportCapabilities {
  private using = new Map<string, CurrentUse>()
  private lastAt = new Map<string, number>()
  private pending = new Map<string, () => void>()
  private unsubscribe: () => void

  constructor(private d: CapabilityDeps) {
    this.unsubscribe = d.bus.subscribe((e) => {
      if (e.type === 'agent.upserted') this.onAgent(e.agent)
      else if (e.type === 'agent.removed') this.release(e.id)
    })
  }

  declare(provider: string, decls: CapabilityDecl[]): void {
    let changed = false
    for (const decl of decls) {
      const prev = this.d.repo.get(provider, decl.id)
      if (!prev && this.full(provider)) continue
      this.d.repo.put(declare(prev, provider, decl))
      changed = true
    }
    if (changed) this.changed(provider)
  }

  /** Every provider's capabilities (or one provider's), adapters → skills → rules. */
  list(provider?: string): Capability[] {
    const providers = provider ? [provider] : this.d.repo.providers()
    return providers.flatMap((p) => sortCapabilities(this.d.repo.listByProvider(p)))
  }

  stop(): void {
    this.unsubscribe()
    for (const cancel of this.pending.values()) cancel()
    this.pending.clear()
  }

  private onAgent(a: AgentState): void {
    const ref =
      a.status === 'tool' && a.tool ? classifyUse(a.provider, a.tool, a.target, a.capability) : null
    const key = `${a.tool}\u0000${a.target ?? ''}\u0000${a.capability ?? ''}`
    const cur = this.using.get(a.id)
    if (ref && cur && cur.provider === a.provider && cur.id === ref.id && cur.key === key) return
    this.release(a.id)
    if (!ref) return
    const prev = this.d.repo.get(a.provider, ref.id)
    if (!prev && this.full(a.provider)) return
    const used = mergeUse(prev, a.provider, ref, {
      ...(ref.tool ? { tool: ref.tool } : {}),
      ...(a.target ? { target: a.target } : {}),
      now: this.d.clock.now(),
    })
    this.d.repo.put(withActive(used, a.id, true))
    this.using.set(a.id, { provider: a.provider, id: ref.id, key })
    this.changed(a.provider)
  }

  /** The agent no longer uses what it used. */
  private release(agentId: string): void {
    const cur = this.using.get(agentId)
    if (!cur) return
    this.using.delete(agentId)
    const c = this.d.repo.get(cur.provider, cur.id)
    if (!c) return
    const next = withActive(c, agentId, false)
    if (next === c) return
    this.d.repo.put(next)
    this.changed(cur.provider)
  }

  private full(provider: string): boolean {
    const max = this.d.maxPerProvider ?? MAX_CAPABILITIES_PER_PROVIDER
    return this.d.repo.listByProvider(provider).length >= max
  }

  /** Leading edge right away, then one trailing publish per window. */
  private changed(provider: string): void {
    if (this.pending.has(provider)) return
    const window = this.d.debounceMs ?? CAPABILITY_DEBOUNCE_MS
    const last = this.lastAt.get(provider)
    const wait = last === undefined ? 0 : last + window - this.d.clock.now()
    if (wait <= 0) return this.publish(provider)
    this.pending.set(
      provider,
      this.d.scheduler.after(wait, () => {
        this.pending.delete(provider)
        this.publish(provider)
      }),
    )
  }

  private publish(provider: string): void {
    this.lastAt.set(provider, this.d.clock.now())
    this.d.bus.publish({
      type: 'capabilities.changed',
      provider,
      capabilities: this.list(provider),
    })
  }
}
