import type { HookStatus } from '@agent-office/shared'
import { addHooks, hookStatus, removeHooks } from '../domain/hook-config.ts'
import type { ClaudeSettingsStore, HookRunner } from '../ports/driven.ts'
import type { HookManagement } from '../ports/driving.ts'

export interface HookDeps {
  claude: ClaudeSettingsStore
  runner: HookRunner
}

/** Installs/removes the agent-office hook in Claude Code's settings. */
export class HookService implements HookManagement {
  constructor(private d: HookDeps) {}

  async status(): Promise<HookStatus> {
    return hookStatus(await this.d.claude.read(), this.d.runner.command())
  }

  async install(): Promise<HookStatus> {
    const current = (await this.d.claude.read()) ?? {}
    await this.d.runner.ensureInstalled()
    await this.d.claude.write(addHooks(current, this.d.runner.command()))
    return this.status()
  }

  async uninstall(): Promise<HookStatus> {
    const current = await this.d.claude.read()
    if (current) {
      const next = removeHooks(current)
      if (JSON.stringify(next) !== JSON.stringify(current)) await this.d.claude.write(next)
    }
    await this.d.runner.remove()
    return this.status()
  }

  async heal(): Promise<void> {
    const status = await this.status()
    if (status === 'not-installed') return
    await this.d.runner.ensureInstalled()
    if (status === 'outdated')
      await this.d.claude.write(
        addHooks((await this.d.claude.read()) ?? {}, this.d.runner.command()),
      )
  }
}
