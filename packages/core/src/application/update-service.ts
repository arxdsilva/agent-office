import type { UpdateState } from '@agent-office/shared'
import { updatePolicy } from '../domain/update-policy.ts'
import type { PlatformInfo, Scheduler, Updater } from '../ports/driven.ts'
import type { UpdateManagement } from '../ports/driving.ts'

export interface UpdateDeps {
  updater: Updater
  platform: PlatformInfo
  scheduler: Scheduler
  /** User setting (Settings.autoUpdate). */
  enabled: boolean
  /** Release page for notify-only installs. */
  releaseUrl: string
  intervalMs?: number
}

const SIX_HOURS = 6 * 60 * 60 * 1000

export class UpdateService implements UpdateManagement {
  private current: UpdateState
  private listeners = new Set<(s: UpdateState) => void>()
  private cancel: (() => void) | undefined
  private enabled: boolean

  constructor(private d: UpdateDeps) {
    this.enabled = d.enabled
    this.current = { policy: this.policy(), status: 'idle' }
  }

  state(): UpdateState {
    return this.current
  }

  async start(): Promise<void> {
    if (this.current.policy === 'off') return
    this.cancel = this.d.scheduler.every(this.d.intervalMs ?? SIX_HOURS, () => void this.check())
    await this.check()
  }

  stop(): void {
    this.cancel?.()
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.set({ policy: this.policy(), status: 'idle' })
  }

  async check(): Promise<UpdateState> {
    const policy = this.current.policy
    if (policy === 'off') return this.current
    this.set({ policy, status: 'checking' })
    try {
      const info = await this.d.updater.check()
      if (!info) return this.set({ policy, status: 'up-to-date' })
      this.set({
        policy,
        status: 'available',
        version: info.version,
        url: info.url ?? this.d.releaseUrl,
      })
      if (policy !== 'auto') return this.current
      this.set({ ...this.current, status: 'downloading' })
      await this.d.updater.download()
      return this.set({ ...this.current, status: 'ready' })
    } catch (err) {
      return this.set({ policy, status: 'error', error: (err as Error).message })
    }
  }

  install(): void {
    if (this.current.policy === 'auto' && this.current.status === 'ready')
      this.d.updater.restartToInstall()
  }

  onChange(fn: (s: UpdateState) => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  private policy() {
    return updatePolicy({ ...this.d.platform, enabled: this.enabled })
  }

  private set(s: UpdateState): UpdateState {
    this.current = s
    for (const l of this.listeners) l(s)
    return s
  }
}
