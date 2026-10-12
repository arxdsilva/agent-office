import type { Agent } from '@agent-office/shared'
import { noteForAgentChange, noteForMessage, type AttentionContext, type Note } from '../domain/attention.ts'
import { trayModel } from '../domain/tray.ts'
import type { Clock, EventSubscriber, Notifier, Scheduler, TrayView, WindowState } from '../ports/driven.ts'
import type { OfficeQuery } from '../ports/driving.ts'

export interface AttentionDeps {
  bus: EventSubscriber
  query: OfficeQuery
  notifier: Notifier
  tray: TrayView
  window: WindowState
  clock: Clock
  scheduler: Scheduler
  /** Tray refresh interval. */
  trayIntervalMs?: number
}

/** Decides when to get the human's attention (notifications) and keeps the tray current. */
export class AttentionService {
  private known = new Map<string, Agent>()
  private lastSentAt = new Map<string, number>()
  private enabled = true
  private hookInstalled = false
  private dirty = false
  private stops: (() => void)[] = []

  constructor(private d: AttentionDeps) {}

  start(): void {
    for (const a of this.d.query.agents()) this.known.set(a.id, a)
    this.stops.push(
      this.d.query.watch((m) => {
        if (m.type === 'upsert') {
          this.maybeNotify(noteForAgentChange(this.known.get(m.agent.id), m.agent, this.ctx()))
          this.known.set(m.agent.id, m.agent)
        } else if (m.type === 'remove') {
          this.known.delete(m.id)
          this.lastSentAt.delete(m.id)
        } else if (m.type === 'chat') {
          this.maybeNotify(noteForMessage(m.message, this.known.get(m.message.agentId), this.ctx()))
        }
        this.dirty = true
      }),
      this.d.scheduler.every(this.d.trayIntervalMs ?? 1000, () => this.dirty && this.renderTray()),
    )
    this.renderTray()
  }

  stop(): void {
    for (const s of this.stops.splice(0)) s()
  }

  setNotificationsEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  setHookInstalled(installed: boolean): void {
    this.hookInstalled = installed
    this.dirty = true
  }

  private ctx(): AttentionContext {
    return { focused: this.d.window.isFocused(), enabled: this.enabled, now: this.d.clock.now(), lastSentAt: this.lastSentAt }
  }

  private maybeNotify(note: Note | null): void {
    if (!note) return
    this.lastSentAt.set(note.agentId, this.d.clock.now())
    this.d.notifier.notify(note)
  }

  private renderTray(): void {
    this.dirty = false
    this.d.tray.render(trayModel(this.d.query.agents(), this.hookInstalled))
  }
}
