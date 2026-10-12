import {
  PROVIDER_IDS,
  type HookStatus,
  type ModelOption,
  type ProviderId,
  type ProviderStatus,
  type Settings,
} from '@agent-office/shared'
import { PROVIDER_DECLS, providerState } from '../domain/providers.ts'
import type {
  AgentRepository,
  AgentRunner,
  Clock,
  Logger,
  ProbeResult,
  ProviderProbe,
  Scheduler,
} from '../ports/driven.ts'
import type { ProviderCatalog, SettingsManagement } from '../ports/driving.ts'
import { FALLBACK_MODELS } from './managed-session-service.ts'

export const PROBE_TTL_MS = 30_000
export const PROBE_TIMEOUT_MS = 3_000

/** What the composition root wires for one provider. Everything is optional. */
export interface ProviderBinding {
  provider: ProviderId
  probe?: ProviderProbe
  runner?: AgentRunner
  hooks?: { status(): Promise<HookStatus> }
}

export interface ProviderServiceDeps {
  bindings: ProviderBinding[]
  settings: Pick<SettingsManagement, 'get' | 'update'>
  agents: AgentRepository
  clock: Clock
  scheduler: Scheduler
  log: Logger
  /** Something visible changed (refresh, enable): push ConnectionInfo through its throttle. */
  onChange?: () => void
  /** Models a running session of this provider reported (wins over the fallback). */
  liveModels?: (provider: ProviderId) => ModelOption[] | undefined
  probeTtlMs?: number
  probeTimeoutMs?: number
}

const TIMED_OUT: ProbeResult = {
  installed: true,
  flagsOk: false,
  auth: 'unknown',
  error: 'timeout',
}
const FAILED: ProbeResult = { installed: true, flagsOk: false, auth: 'unknown', error: 'spawn' }

/**
 * The provider registry: declarations + probes + settings + live agents → one status per provider.
 * `list` probes enabled providers only (cached); `refresh` probes on request, enabled or not.
 */
export class ProviderService implements ProviderCatalog {
  private cache = new Map<ProviderId, { at: number; result: Promise<ProbeResult> }>()
  /** Probes still running: a refresh never starts a second copy of the same CLI. */
  private inFlight = new Map<ProviderId, Promise<ProbeResult>>()
  private bindings: Map<ProviderId, ProviderBinding>

  constructor(private d: ProviderServiceDeps) {
    this.bindings = new Map(d.bindings.map((b) => [b.provider, b]))
  }

  async list(): Promise<ProviderStatus[]> {
    return this.build(false)
  }

  async refresh(provider?: ProviderId): Promise<ProviderStatus[]> {
    if (provider) this.cache.delete(provider)
    else this.cache.clear()
    const list = await this.build(provider ?? true)
    this.d.onChange?.()
    return list
  }

  async setEnabled(provider: ProviderId, enabled: boolean): Promise<ProviderStatus[]> {
    const s = await this.d.settings.get()
    await this.d.settings.update({ providers: { ...s.providers, [provider]: { enabled } } })
    const list = await this.list()
    this.d.onChange?.()
    return list
  }

  async models(provider: ProviderId): Promise<ModelOption[]> {
    const live = this.d.liveModels?.(provider)
    if (live?.length) return live
    const fallback = this.bindings.get(provider)?.runner?.decl?.fallbackModels
    if (fallback) return fallback
    return provider === 'claude-code' ? FALLBACK_MODELS : []
  }

  /** `force`: true = probe every provider, an id = probe that one even if disabled. */
  private async build(force: boolean | ProviderId): Promise<ProviderStatus[]> {
    const settings = await this.d.settings.get()
    const live = this.liveCounts()
    return Promise.all(
      PROVIDER_IDS.map(async (id) => {
        const enabled = isEnabled(settings, id)
        const probing = enabled || force === true || force === id
        return this.status(id, enabled, probing, live.get(id) ?? 0)
      }),
    )
  }

  private async status(
    id: ProviderId,
    enabled: boolean,
    probing: boolean,
    activeSessions: number,
  ): Promise<ProviderStatus> {
    const decl = PROVIDER_DECLS[id]
    const b = this.bindings.get(id)
    const [probe, hooks] = await Promise.all([
      b?.probe ? (probing ? this.probe(b.probe) : this.cached(id)) : undefined,
      b?.hooks ? this.hookStatus(id, b.hooks) : undefined,
    ])
    const hasRuntime = !!b?.runner
    const { state, hint } = providerState(decl, probe, {
      enabled,
      liveSessions: activeSessions,
      hasRuntime,
      ...(hooks ? { hooks } : {}),
    })
    const modes = b?.runner?.decl?.modes
    return {
      id,
      label: decl.label,
      state,
      enabled,
      ...(probe?.version ? { version: probe.version } : {}),
      ...(decl.testedVersion ? { testedVersion: decl.testedVersion } : {}),
      managedCaps: hasRuntime ? [...decl.managedCaps] : [],
      observedCaps: [...decl.observedCaps],
      integration: { ...decl.integration },
      ...(hooks && hooks !== 'invalid' ? { hooks } : {}),
      ...(modes ? { modes: modes.map((m) => ({ ...m })) } : {}),
      activeSessions,
      ...(hint ? { hint } : {}),
    }
  }

  private cached(id: ProviderId): Promise<ProbeResult> | undefined {
    const c = this.cache.get(id)
    return c && this.fresh(c.at) ? c.result : undefined
  }

  private fresh(at: number): boolean {
    return this.d.clock.now() - at < (this.d.probeTtlMs ?? PROBE_TTL_MS)
  }

  private probe(p: ProviderProbe): Promise<ProbeResult> {
    const running = this.inFlight.get(p.provider)
    if (running) return running
    const c = this.cache.get(p.provider)
    if (c && this.fresh(c.at)) return c.result
    const result = this.isolated(p)
    this.inFlight.set(p.provider, result)
    void result.finally(() => this.inFlight.delete(p.provider))
    this.cache.set(p.provider, { at: this.d.clock.now(), result })
    return result
  }

  /** Never rejects, never outlives the timeout; logs without error text (it may hold paths). */
  private isolated(p: ProviderProbe): Promise<ProbeResult> {
    return new Promise((resolve) => {
      const cancel = this.d.scheduler.after(this.d.probeTimeoutMs ?? PROBE_TIMEOUT_MS, () => {
        this.d.log.warn(`provider probe timed out: ${p.provider}`)
        resolve(TIMED_OUT)
      })
      let run: Promise<ProbeResult>
      try {
        run = p.detect()
      } catch (err) {
        run = Promise.reject(err)
      }
      run.then(
        (r) => {
          cancel()
          resolve(r)
        },
        () => {
          cancel()
          this.d.log.warn(`provider probe failed: ${p.provider}`)
          resolve(FAILED)
        },
      )
    })
  }

  private async hookStatus(
    id: ProviderId,
    hooks: NonNullable<ProviderBinding['hooks']>,
  ): Promise<HookStatus | 'invalid'> {
    try {
      return await hooks.status()
    } catch {
      this.d.log.warn(`provider hooks unreadable: ${id}`)
      return 'invalid'
    }
  }

  private liveCounts(): Map<ProviderId, number> {
    const counts = new Map<ProviderId, number>()
    const prefixed = PROVIDER_IDS.filter((id) => PROVIDER_DECLS[id].prefix)
    for (const a of this.d.agents.list()) {
      if (a.status === 'done') continue
      const id = prefixed.find((p) => a.id.startsWith(PROVIDER_DECLS[p].prefix))
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return counts
  }
}

function isEnabled(s: Settings, id: ProviderId): boolean {
  return s.providers?.[id]?.enabled ?? (id === 'claude-code' ? s.claudeAdapter : false)
}
