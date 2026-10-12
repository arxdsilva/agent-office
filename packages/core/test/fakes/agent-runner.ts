import type { AgentEvent, ModelOption, PermissionMode } from '@agent-office/shared'
import type {
  AgentRunner,
  RunnerDecision,
  RunnerExit,
  RunnerPermission,
  RunnerSession,
  RunnerStart,
} from '../../src/ports/driven.ts'

type Ev = Omit<AgentEvent, 'agentId'>

/**
 * Scripted AgentRunner for use-case tests. Each `start` creates a FakeRunnerSession that records
 * what it was asked and lets the test drive what the "SDK" does (init, events, results, permissions).
 */
export class FakeAgentRunner implements AgentRunner {
  readonly sessions: FakeRunnerSession[] = []
  private n = 0
  /** Set to make the next start fail before init. */
  failNext: RunnerExit | undefined
  /** When false, the test calls `session.init()` itself (default: init right away). */
  autoInit = true

  start(o: RunnerStart): FakeRunnerSession {
    const s = new FakeRunnerSession(o, `sess-${++this.n}`)
    this.sessions.push(s)
    const fail = this.failNext
    this.failNext = undefined
    if (fail) void Promise.resolve().then(() => s.exit(fail))
    else if (this.autoInit) void Promise.resolve().then(() => s.init())
    return s
  }

  last(): FakeRunnerSession {
    const s = this.sessions.at(-1)
    if (!s) throw new Error('no session started')
    return s
  }
}

export class FakeRunnerSession implements RunnerSession {
  readonly sessionId: Promise<string>
  readonly prompts: string[] = []
  readonly calls: string[] = []
  mode: PermissionMode
  model: string | undefined
  closed = false
  models: ModelOption[] = [
    { id: 'default', label: 'Default' },
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
  ]
  private resolveId!: (id: string) => void
  private rejectId!: (e: RunnerExit) => void
  private events = new Set<(e: Ev) => void>()
  private results = new Set<(r: { text: string; isError: boolean }) => void>()
  private permissionFn: ((r: RunnerPermission) => Promise<RunnerDecision>) | undefined
  private exitFns = new Set<(e: RunnerExit) => void>()

  constructor(
    readonly options: RunnerStart,
    readonly id: string,
  ) {
    this.mode = options.mode
    this.model = options.model
    this.sessionId = new Promise((res, rej) => {
      this.resolveId = res
      this.rejectId = rej
    })
    this.sessionId.catch(() => {}) // tests that never await it must not see an unhandled rejection
  }

  // ── driven by the code under test ──
  push(prompt: string): void {
    this.prompts.push(prompt)
  }
  async setMode(mode: PermissionMode): Promise<void> {
    this.calls.push(`mode:${mode}`)
    this.mode = mode
  }
  async setModel(model: string): Promise<void> {
    this.calls.push(`model:${model}`)
    this.model = model
  }
  async supportedModels(): Promise<ModelOption[]> {
    return this.models
  }
  async interrupt(): Promise<void> {
    this.calls.push('interrupt')
  }
  async close(): Promise<void> {
    this.calls.push('close')
    this.closed = true
  }
  onEvent(fn: (e: Ev) => void): () => void {
    this.events.add(fn)
    return () => this.events.delete(fn)
  }
  onResult(fn: (r: { text: string; isError: boolean }) => void): () => void {
    this.results.add(fn)
    return () => this.results.delete(fn)
  }
  onPermission(fn: (r: RunnerPermission) => Promise<RunnerDecision>): void {
    this.permissionFn = fn
  }
  onExit(fn: (e: RunnerExit) => void): void {
    this.exitFns.add(fn)
  }

  // ── driven by the test (what the SDK would do) ──
  init(): void {
    this.resolveId(this.id)
  }
  emit(e: Ev): void {
    for (const fn of this.events) fn(e)
  }
  result(text: string, isError = false): void {
    for (const fn of this.results) fn({ text, isError })
  }
  /** Asks for approval; resolves with the decision the code under test gives. */
  ask(tool: string, input: Record<string, unknown> = {}): Promise<RunnerDecision> {
    if (!this.permissionFn) throw new Error('no permission handler registered')
    return this.permissionFn({ tool, input, cwd: this.options.cwd })
  }
  exit(e: RunnerExit = {}): void {
    this.rejectId(e)
    for (const fn of this.exitFns) fn(e)
  }
}
