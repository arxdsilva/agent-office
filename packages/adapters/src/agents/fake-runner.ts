// Test seam (AGENT_OFFICE_FAKE_RUNNER=1): a scripted AgentRunner for the Playwright app specs.
// Never spawns Claude Code. Prompts: anything → "ok"; "/perm" → asks to run Bash `pnpm test`;
// "/slow" → a 5 s tool call that can be interrupted.
import type {
  AgentRunner,
  RunnerDecision,
  RunnerExit,
  RunnerPermission,
  RunnerSession,
  RunnerStart,
} from '@agent-office/core'
import type { AgentEvent, ModelOption, PermissionMode } from '@agent-office/shared'

type Ev = Omit<AgentEvent, 'agentId'>

export interface ScriptedRunnerOptions {
  /** Delay between scripted steps (default 150 ms). */
  stepMs?: number
  /** Length of the "/slow" tool call (default 5 s). */
  slowMs?: number
}

const MODELS: ModelOption[] = [
  { id: 'default', label: 'Default (recommended)' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
]

export class ScriptedAgentRunner implements AgentRunner {
  constructor(private o: ScriptedRunnerOptions = {}) {}

  start(s: RunnerStart): RunnerSession {
    return new ScriptedSession(s, this.o.stepMs ?? 150, this.o.slowMs ?? 5000)
  }
}

class ScriptedSession implements RunnerSession {
  readonly sessionId: Promise<string>
  private events = new Set<(e: Ev) => void>()
  private results = new Set<(r: { text: string; isError: boolean }) => void>()
  private permissionFn: ((r: RunnerPermission) => Promise<RunnerDecision>) | undefined
  private exitFns = new Set<(e: RunnerExit) => void>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private closed = false
  private interrupted = false
  /** Prompts waiting for the current turn to end. */
  private queue: string[] = []
  private busy = false
  private mode: PermissionMode
  private model: string | undefined

  constructor(
    private s: RunnerStart,
    private stepMs: number,
    private slowMs: number,
  ) {
    this.mode = s.mode
    this.model = s.model
    const id = `fake-${Math.random().toString(36).slice(2, 12)}`
    this.sessionId = new Promise((resolve) => this.later(stepMs, () => resolve(id)))
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t)
      if (!this.closed) fn()
    }, ms)
    this.timers.add(t)
  }

  private emit(e: Ev): void {
    for (const fn of this.events) fn({ ts: Date.now(), ...e })
  }

  /** Ends the current turn and starts the next queued prompt (one turn at a time, like the runtime). */
  private result(text: string, isError = false): void {
    for (const fn of this.results) fn({ text, isError })
    this.busy = false
    this.next()
  }

  push(prompt: string): void {
    if (this.closed) return
    this.queue.push(prompt)
    this.next()
  }

  private next(): void {
    if (this.busy || this.closed) return
    const prompt = this.queue.shift()
    if (prompt === undefined) return
    this.busy = true
    this.interrupted = false
    this.later(this.stepMs, () => {
      this.emit({ status: 'thinking', text: '', model: this.model ?? 'claude-sonnet-5' })
      if (prompt.includes('/perm')) return void this.perm()
      if (prompt.includes('/slow')) return this.slow()
      this.later(this.stepMs, () => this.result('ok'))
    })
  }

  private async perm(): Promise<void> {
    const input = { command: 'pnpm test' }
    this.emit({ status: 'tool', tool: 'Bash', target: 'cmd:pnpm', text: 'Run the tests' })
    const d: RunnerDecision = this.permissionFn
      ? await this.permissionFn({ tool: 'Bash', input, cwd: this.s.cwd })
      : { behavior: 'deny', message: 'no approver' }
    if (this.closed || this.interrupted) return
    this.result(d.behavior === 'allow' ? 'ok' : 'denied')
  }

  private slow(): void {
    this.emit({ status: 'tool', tool: 'Bash', target: 'cmd:sleep', text: 'A long task' })
    this.later(this.slowMs, () => {
      if (!this.interrupted) this.result('ok')
    })
  }

  async setMode(mode: PermissionMode): Promise<void> {
    this.mode = mode
  }

  async setModel(model: string): Promise<void> {
    this.model = model
  }

  async supportedModels(): Promise<ModelOption[]> {
    return MODELS
  }

  async interrupt(): Promise<void> {
    this.interrupted = true
    this.result('', true)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    for (const fn of this.exitFns) fn({})
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
}
