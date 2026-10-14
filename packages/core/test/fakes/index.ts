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
import type { GateRun, GateSpec } from '../../src/domain/harness-types.ts'
import type { CancelSignal } from '../../src/ports/driving.ts'
import type {
  AgentRepository,
  CapabilityRepository,
  ClaudeSettingsStore,
  Clock,
  EventPublisher,
  EventSubscriber,
  GateRunner,
  HookRunner,
  RepoFiles,
  IdGenerator,
  JsonConfigStore,
  LoginItem,
  Logger,
  MessageRepository,
  Notifier,
  OfficeEvent,
  PlatformInfo,
  ProbeResult,
  ProviderProbe,
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

/** A provider's hook config file in memory (`raw` = file contents, undefined = no file). */
export class FakeJsonConfigStore implements JsonConfigStore {
  writes = 0
  removed = false
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
    this.writes++
    this.lastBackup ??= this.raw
    this.raw = JSON.stringify(json)
  }
  async remove() {
    if (this.raw !== undefined) this.removed = true
    this.raw = undefined
  }
  get json(): Record<string, unknown> | undefined {
    return this.raw === undefined ? undefined : (JSON.parse(this.raw) as Record<string, unknown>)
  }
}

/**
 * Scripted ProviderProbe. `behavior` 'throw' and 'hang' break the port's promise on purpose, to test
 * that the core isolates misbehaving adapters (the contract runs the default 'ok').
 */
export class FakeProviderProbe implements ProviderProbe {
  calls = 0
  constructor(
    readonly provider: ProviderProbe['provider'],
    public result: ProbeResult = { installed: true, version: '1.0.0', flagsOk: true, auth: 'ok' },
    public behavior: 'ok' | 'throw' | 'hang' = 'ok',
  ) {}
  detect(): Promise<ProbeResult> {
    this.calls++
    if (this.behavior === 'throw') return Promise.reject(new Error('boom /secret/path'))
    if (this.behavior === 'hang') return new Promise(() => {})
    return Promise.resolve({ ...this.result })
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
export * from './projects.ts'

/**
 * Scripted validation runner: results by gate id (in order, the last one repeats), every call
 * recorded, `hold(id)` keeps a gate running until `release(id)` or an abort (→ cancelled).
 */
export class FakeGateRunner implements GateRunner {
  calls: { spec: GateSpec; cwd: string }[] = []
  private scripts = new Map<string, Partial<GateRun>[]>()
  private held = new Set<string>()
  private waiting = new Map<string, (() => void)[]>()

  script(gateId: string, ...runs: Partial<GateRun>[]): this {
    this.scripts.set(gateId, runs)
    return this
  }

  hold(gateId: string): this {
    this.held.add(gateId)
    return this
  }

  /** Lets held runs of this gate finish (and stops holding it). */
  release(gateId: string): void {
    this.held.delete(gateId)
    for (const go of this.waiting.get(gateId)?.splice(0) ?? []) go()
  }

  /** Gate ids currently held open. */
  running(): string[] {
    return [...this.waiting].flatMap(([id, w]) => w.map(() => id))
  }

  async run(spec: GateSpec, o: { cwd: string; signal?: CancelSignal }): Promise<GateRun> {
    this.calls.push({ spec, cwd: o.cwd })
    const cancelled: GateRun = {
      status: 'cancelled',
      exitCode: null,
      durationMs: 1,
      outputTail: '',
    }
    if (o.signal?.aborted) return cancelled
    if (this.held.has(spec.id)) {
      const aborted = await new Promise<boolean>((resolve) => {
        const list = this.waiting.get(spec.id) ?? []
        this.waiting.set(spec.id, list)
        const onAbort = () => {
          const i = list.indexOf(go)
          if (i >= 0) list.splice(i, 1)
          resolve(true)
        }
        const go = () => {
          o.signal?.removeEventListener('abort', onAbort)
          resolve(false)
        }
        list.push(go)
        o.signal?.addEventListener('abort', onAbort, { once: true })
      })
      if (aborted) return cancelled
    }
    const runs = this.scripts.get(spec.id)
    const next = runs && runs.length > 1 ? runs.shift()! : runs?.[0]
    const status = next?.status ?? 'pass'
    return {
      status,
      exitCode:
        next && 'exitCode' in next
          ? next.exitCode!
          : status === 'pass'
            ? 0
            : status === 'fail'
              ? 1
              : null,
      durationMs: next?.durationMs ?? 1,
      outputTail: next?.outputTail ?? '',
      ...(next?.pinChanged !== undefined ? { pinChanged: next.pinChanged } : {}),
      ...(next?.spawnError !== undefined ? { spawnError: next.spawnError } : {}),
    }
  }
}

/** A glob (`**`, `*`, `?`) over repo-relative '/' paths, as a regular expression. */
function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') {
        i++
        out += '(?:.*/)?'
      } else out += '.*'
    } else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

/** In-memory `RepoFiles`: a set of repo-relative file paths (the same for every repo path). */
export class FakeRepoFiles implements RepoFiles {
  constructor(private readonly files: Iterable<string> = []) {}
  async exists(_repoPath: string, relGlob: string): Promise<boolean> {
    if (!relGlob || relGlob.startsWith('/') || /^[A-Za-z]:|\\/.test(relGlob)) return false
    if (relGlob.split('/').includes('..')) return false
    const re = globToRegExp(relGlob)
    for (const f of this.files) if (re.test(f)) return true
    return false
  }
}
