import type { CapabilityRepository } from '@agent-office/core'
import type { Capability } from '@agent-office/shared'

const copy = (c: Capability): Capability => ({
  ...c,
  sees: [...c.sees],
  tools: [...c.tools],
  active: [...c.active],
})

/** Capabilities per provider, kept for this app session only. */
export class InMemoryCapabilityRepository implements CapabilityRepository {
  private byProvider = new Map<string, Map<string, Capability>>()

  get(provider: string, id: string): Capability | undefined {
    const c = this.byProvider.get(provider)?.get(id)
    return c && copy(c)
  }

  put(c: Capability): void {
    let byId = this.byProvider.get(c.provider)
    if (!byId) this.byProvider.set(c.provider, (byId = new Map()))
    byId.set(c.id, copy(c))
  }

  listByProvider(provider: string): Capability[] {
    return [...(this.byProvider.get(provider)?.values() ?? [])].map(copy)
  }

  providers(): string[] {
    return [...this.byProvider.keys()]
  }
}
