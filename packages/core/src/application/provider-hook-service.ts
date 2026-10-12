import type { HookStatus, ProviderId } from '@agent-office/shared'
import { ValidationError } from '../domain/errors.ts'
import { addHooks, hookStatus, removeHooks, type HookFormat } from '../domain/provider-hooks.ts'
import type { HookRunner, JsonConfigStore, Logger } from '../ports/driven.ts'
import type { ProviderHooks } from '../ports/driving.ts'

/** One hook-based provider: its config format, the file holding it, and the observe wrapper. */
export interface ProviderHookTarget {
  format: HookFormat
  store: JsonConfigStore
  runner: HookRunner
}

export type ProviderHookTargets = Partial<Record<ProviderId, ProviderHookTarget>>

export interface ProviderHookDeps {
  targets: ProviderHookTargets
  log: Logger
}

/**
 * Installs/removes agent-office's observation hooks in Cursor, Gemini CLI and Copilot CLI configs.
 * Read errors (invalid JSON) propagate as ValidationError: nothing is written over a broken file.
 */
export class ProviderHookService implements ProviderHooks {
  constructor(private d: ProviderHookDeps) {}

  supports(provider: ProviderId): boolean {
    return !!this.d.targets[provider]
  }

  async status(provider: ProviderId): Promise<HookStatus> {
    const t = this.target(provider)
    return hookStatus(t.format, await t.store.read(), t.runner.command())
  }

  async install(provider: ProviderId): Promise<HookStatus> {
    const t = this.target(provider)
    const current = (await t.store.read()) ?? {}
    const next = addHooks(t.format, current, t.runner.command())
    await t.runner.ensureInstalled()
    await t.store.write(next)
    return this.status(provider)
  }

  async uninstall(provider: ProviderId): Promise<HookStatus> {
    const t = this.target(provider)
    const current = await t.store.read()
    if (current) {
      const next = removeHooks(t.format, current)
      if (next === null) await t.store.remove()
      else if (JSON.stringify(next) !== JSON.stringify(current)) await t.store.write(next)
    }
    await t.runner.remove()
    return this.status(provider)
  }

  async heal(): Promise<void> {
    for (const provider of Object.keys(this.d.targets) as ProviderId[]) {
      try {
        const status = await this.status(provider)
        if (status === 'not-installed') continue
        const t = this.target(provider)
        await t.runner.ensureInstalled()
        if (status === 'outdated')
          await t.store.write(addHooks(t.format, (await t.store.read()) ?? {}, t.runner.command()))
      } catch {
        this.d.log.warn(`provider hooks heal failed: ${provider}`)
      }
    }
  }

  private target(provider: ProviderId): ProviderHookTarget {
    const t = this.d.targets[provider]
    if (!t) throw new ValidationError(`no observation hooks for ${provider}`)
    return t
  }
}
