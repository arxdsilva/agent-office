// In-memory/recording test doubles for every driven port. Each fake passes its port's contract suite.
import {
  DEFAULT_SETTINGS,
  type Capability,
  type ChatMessage,
  type Settings,
} from '@agent-office/shared'
import type { AgentState } from '../../src/domain/agent.ts'
import type { Note } from '../../src/domain/attention.ts'
import { ValidationError } from '../../src/domain/errors.ts'
import type { TrayModel } from '../../src/domain/tray.ts'
import type {
  AgentRepository,
  CapabilityRepository,
  ClaudeSettingsStore,
  Clock,
  EventPublisher,
  EventSubscriber,
  HookRunner,
  IdGenerator,
  LoginItem,
  Logger,
  MessageRepository,
  Notifier,
  OfficeEvent,
  PlatformInfo,
  Scheduler,
  SettingsRepository,
  TrayView,
  UpdateInfo,
  Updater,
  WindowState,
} from '../../src/ports/driven.ts'

export class FakeClock implements Clock {
  constructor(public t = 1_000_000) {}
  now() {
    return this.t
  }
  advance(ms: number) {
    this.t += ms
  }
}

export class SeqIds implements IdGenerator {
  private n = 0
  next() {
    return `id${++this.n}`
  }
}

export class MemoryLogger implements Logger {
  lines: string[] = []
  info(m: string) {
    this.lines.push(`info ${m}`)
  }
  warn(m: string) {
    this.lines.push(`warn ${m}`)
  }
}

/** Time only moves when a test says so: runAll() fires intervals, fireTimers() fires one-shot timers. */
export class ManualScheduler implements Scheduler {
  jobs: { ms: number; fn: () => void; cancelled: boolean }[] = []
  timers: { ms: number; fn: () => void; cancelled: boolean }[] = []
  every(ms: number, fn: () => void) {
    const job = { ms, fn, cancelled: false }
    this.jobs.push(job)
    return () => {
      job.cancelled = true
    }
  }
  after(ms: number, fn: () => void) {
    const t = { ms, fn, cancelled: false }
    this.timers.push(t)
    return () => {
      t.cancelled = true
    }
  }
  runAll() {
    for (const j of this.jobs) if (!j.cancelled) j.fn()
  }
  fireTimers() {
    for (const t of this.timers.splice(0)) if (!t.cancelled) t.fn()
  }
}

/** Minimal AbortController stand-in for core tests (the core has no host globals). */
export class FakeSignal {
  aborted = false
  private fns = new Set<() => void>()
  addEventListener(_t: 'abort', fn: () => void) {
    this.fns.add(fn)
  }
  removeEventListener(_t: 'abort', fn: () => void) {
    this.fns.delete(fn)
  }
  abort() {
    this.aborted = true
    for (const f of [...this.fns]) f()
  }
}

export class FakeAgentRepository implements AgentRepository {
  private m = new Map<string, AgentState>()
  get(id: string) {
    const a = this.m.get(id)
    return a && { ...a }
  }
  put(a: AgentState) {
    this.m.set(a.id, { ...a })
  }
  delete(id: string) {
    this.m.delete(id)
  }
  list() {
    return [...this.m.values()].map((a) => ({ ...a }))
  }
}

const copyCap = (c: Capability): Capability => ({
  ...c,
  sees: [...c.sees],
  tools: [...c.tools],
  active: [...c.active],
})

export class FakeCapabilityRepository implements CapabilityRepository {
  private m = new Map<string, Map<string, Capability>>()
  get(provider: string, id: string) {
    const c = this.m.get(provider)?.get(id)
    return c && copyCap(c)
  }
  put(c: Capability) {
    const byId = this.m.get(c.provider) ?? new Map<string, Capability>()
    byId.set(c.id, copyCap(c))
    this.m.set(c.provider, byId)
  }
  listByProvider(provider: string) {
    return [...(this.m.get(provider)?.values() ?? [])].map(copyCap)
  }
  providers() {
    return [...this.m.keys()]
  }
}

export class FakeMessageRepository implements MessageRepository {
  private m = new Map<string, ChatMessage[]>()
  constructor(private cap = 200) {}
  append(msg: ChatMessage) {
    const list = [...(this.m.get(msg.agentId) ?? []), { ...msg }]
    this.m.set(msg.agentId, list.slice(-this.cap))
  }
  update(msg: ChatMessage) {
    const list = this.m.get(msg.agentId)
    const i = list?.findIndex((x) => x.id === msg.id) ?? -1
    if (list && i >= 0) list[i] = { ...msg }
  }
  byAgent(id: string) {
    return (this.m.get(id) ?? []).map((x) => ({ ...x }))
  }
  recent(n: number) {
    return [...this.m.values()].flatMap((l) => l.slice(-n).map((x) => ({ ...x })))
  }
  dropAgent(id: string) {
    this.m.delete(id)
  }
}

export class FakeEventBus implements EventPublisher, EventSubscriber {
  events: OfficeEvent[] = []
  private subs = new Set<(e: OfficeEvent) => void>()
  publish(e: OfficeEvent) {
    this.events.push(e)
    for (const s of [...this.subs]) {
      try {
        s(e)
      } catch {
        /* isolated */
      }
    }
  }
  subscribe(fn: (e: OfficeEvent) => void) {
    this.subs.add(fn)
    return () => void this.subs.delete(fn)
  }
}

export class FakeSettingsRepository implements SettingsRepository {
  saved: Settings | undefined
  async load() {
    return { ...(this.saved ?? DEFAULT_SETTINGS) }
  }
  async save(s: Settings) {
    this.saved = { ...s }
  }
}

export class FakeClaudeSettingsStore implements ClaudeSettingsStore {
  lastBackup: string | undefined
  constructor(public raw?: string) {}
  async read() {
    if (this.raw === undefined) return undefined
    try {
      return JSON.parse(this.raw) as Record<string, unknown>
    } catch {
      throw new ValidationError('invalid JSON')
    }
  }
  async write(json: Record<string, unknown>) {
    this.lastBackup = this.raw
    this.raw = JSON.stringify(json)
  }
}

export class FakeHookRunner implements HookRunner {
  installed = false
  constructor(private cmd = '"/fake/agent-office-hook.sh"') {}
  command() {
    return this.cmd
  }
  async ensureInstalled() {
    this.installed = true
  }
  async remove() {
    this.installed = false
  }
}

export class RecordingNotifier implements Notifier {
  notes: Note[] = []
  notify(n: Note) {
    this.notes.push(n)
  }
}

export class RecordingTray implements TrayView {
  models: TrayModel[] = []
  render(m: TrayModel) {
    this.models.push(m)
  }
  get last() {
    return this.models.at(-1)
  }
}

export class RecordingLoginItem implements LoginItem {
  calls: boolean[] = []
  setOpenAtLogin(v: boolean) {
    this.calls.push(v)
  }
}

export class ScriptedUpdater implements Updater {
  checks = 0
  downloads = 0
  restarted = false
  constructor(public next: UpdateInfo | null | Error = null) {}
  async check() {
    this.checks++
    if (this.next instanceof Error) throw this.next
    return this.next
  }
  async download() {
    this.downloads++
  }
  restartToInstall() {
    this.restarted = true
  }
}

export const fakePlatform = (over: Partial<PlatformInfo> = {}): PlatformInfo => ({
  platform: 'win32',
  packaged: true,
  signed: false,
  linuxAppImage: false,
  version: '1.2.3',
  ...over,
})

export class FakeWindow implements WindowState {
  constructor(public focused = false) {}
  isFocused() {
    return this.focused
  }
}
export * from './agent-runner.ts'
