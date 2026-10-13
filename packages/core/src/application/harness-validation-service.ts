// Validation gates through the trusted runner (docs/harness.md §4). Gate argv comes only from the
// session's harness snapshot (the published version in the vault), never from the repository or
// the UI. One run at a time per project; failures are fed back to the agent within the budget.
import type { GateResultView } from '@agent-office/shared'
import { assertAuthorized, USER, type Principal } from '../domain/authz.ts'
import { NotFoundError, ValidationError } from '../domain/errors.ts'
import { versionKey } from '../domain/harness-resolve.ts'
import type {
  GateResult,
  GateRun,
  HarnessSnapshot,
  ValidationGate,
} from '../domain/harness-types.ts'
import { gateFeedback } from '../domain/harness-verification.ts'
import { newHarnessEvent } from '../domain/harness-events.ts'
import { oneLine } from '../domain/text.ts'
import type { Clock, GateRunner, Logger } from '../ports/driven.ts'
import type {
  CancelSignal,
  ComposedMessage,
  HarnessValidation,
  ProjectRepos,
} from '../ports/driving.ts'
import type { ActivityLog } from './activity-log.ts'
import { gateResultView, type HarnessPolicyService } from './harness-policy-service.ts'
import type { ProjectsStore } from './projects-store.ts'

/** A minimal AbortController for core (no host globals). */
export class CancelController {
  private fns = new Set<() => void>()
  private done = false
  readonly signal: CancelSignal

  constructor() {
    const read = () => this.done
    this.signal = {
      get aborted() {
        return read()
      },
      addEventListener: (_t, fn) => {
        if (this.done) fn()
        else this.fns.add(fn)
      },
      removeEventListener: (_t, fn) => void this.fns.delete(fn),
    }
  }

  get aborted(): boolean {
    return this.done
  }

  abort(): void {
    if (this.done) return
    this.done = true
    const fns = [...this.fns]
    this.fns.clear()
    for (const fn of fns) {
      try {
        fn()
      } catch {
        /* isolated */
      }
    }
  }
}

/** Where feedback goes: the managed session's own chat (ManagedSessionService.send). */
export interface FeedbackSink {
  send?(agentId: string, m: ComposedMessage): Promise<unknown>
}

export interface HarnessValidationDeps {
  store: ProjectsStore
  activity: ActivityLog
  clock: Clock
  policy: HarnessPolicyService
  repos: ProjectRepos
  runner?: GateRunner
  /** Managed sessions, resolved lazily; feedback needs their `send` (ManagedSessionService). */
  sessions?: () => object | undefined
  /** `process.platform` of main ('darwin' | 'linux' | 'win32'); gates for other platforms are skipped. */
  platform?: string
  log?: Logger
}

const FAILED = new Set(['fail', 'timeout', 'error'])

function safeSubdir(subdir: string | undefined): string | null {
  if (!subdir) return ''
  const s = subdir.replace(/\\/g, '/')
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null
  const parts = s.split('/').filter((x) => x && x !== '.')
  if (parts.some((x) => x === '..')) return null
  return parts.join('/')
}

export class HarnessValidationService implements HarnessValidation {
  private queues = new Map<string, Promise<unknown>>()
  private controllers = new Map<string, Set<CancelController>>()
  /** When gates last started for an agent (a turn-end run needs a write since then). */
  private lastRunAt = new Map<string, number>()

  constructor(private d: HarnessValidationDeps) {}

  async run(
    o: { agentId: string; gateIds?: string[] },
    as: Principal = USER,
  ): Promise<GateResultView[]> {
    const snap = this.d.policy.snapshotOf(o.agentId)
    assertAuthorized(
      as,
      'harness.manage',
      { kind: 'harness', projectId: snap?.projectId ?? null },
      snap ? this.d.store.projects.get(snap.projectId) : undefined,
    )
    if (!this.d.runner) throw new ValidationError('validation unavailable')
    if (!snap) throw new NotFoundError('harness session')
    const known = new Map(snap.effective.gates.map((g) => [g.id, g]))
    for (const id of o.gateIds ?? []) if (!known.has(id)) throw new ValidationError('unknown gate')
    const gates = (o.gateIds ? o.gateIds.map((id) => known.get(id)!) : snap.effective.gates).filter(
      (g) =>
        !g.platforms?.length || !this.d.platform || g.platforms.includes(this.d.platform as never),
    )
    if (!gates.length) return []
    const cwd = this.cwdOf(snap)
    const prev = this.queues.get(snap.projectId) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(() => this.execute(o.agentId, snap, gates, cwd))
    this.queues.set(snap.projectId, next)
    try {
      return await next
    } finally {
      if (this.queues.get(snap.projectId) === next) this.queues.delete(snap.projectId)
    }
  }

  cancel(agentId: string, as: Principal = USER): void {
    const snap = this.d.policy.snapshotOf(agentId)
    assertAuthorized(
      as,
      'harness.manage',
      { kind: 'harness', projectId: snap?.projectId ?? null },
      snap ? this.d.store.projects.get(snap.projectId) : undefined,
    )
    for (const c of this.controllers.get(agentId) ?? []) c.abort()
  }

  results(agentId: string, as: Principal = USER): GateResultView[] {
    const snap = this.d.policy.snapshotOf(agentId)
    assertAuthorized(
      as,
      'harness.read',
      { kind: 'harness', projectId: snap?.projectId ?? null },
      snap ? this.d.store.projects.get(snap.projectId) : undefined,
    )
    if (!snap) return []
    return this.d.policy.validationOf(agentId, snap).gates
  }

  /** After a turn: run gates when the harness asks for it and the agent wrote something since. */
  turnEnded(agentId: string, r: { isError: boolean; interrupted: boolean }): void {
    if (r.isError || r.interrupted || !this.d.runner) return
    const snap = this.d.policy.snapshotOf(agentId)
    if (!snap || snap.effective.gateTrigger !== 'turn-end' || !snap.effective.gates.length) return
    const wrote = this.d.policy.lastWriteAt(agentId)
    if (wrote === undefined || wrote <= (this.lastRunAt.get(agentId) ?? -Infinity)) return
    void this.run({ agentId })
      .then((results) => this.afterAutoRun(agentId, snap, results))
      .catch(() => this.d.log?.warn('harness validation failed to run'))
  }

  /** The session ended: running gates are cancelled. */
  ended(agentId: string): void {
    for (const c of this.controllers.get(agentId) ?? []) c.abort()
  }

  // ── internals ──

  private cwdOf(snap: HarnessSnapshot): string {
    const repo = this.d.store.projects.get(snap.projectId)?.repos[0]
    const root = repo ? this.d.repos.repoPath(snap.projectId, repo.id) : undefined
    if (!root) throw new ValidationError('the project has no repository')
    return root
  }

  private async execute(
    agentId: string,
    snap: HarnessSnapshot,
    gates: ValidationGate[],
    root: string,
  ): Promise<GateResultView[]> {
    const ctl = new CancelController()
    const set = this.controllers.get(agentId) ?? new Set()
    set.add(ctl)
    this.controllers.set(agentId, set)
    const harnessVersion = versionKey(snap.effective)
    this.lastRunAt.set(agentId, this.d.clock.now())
    void this.d.activity.add(
      snap.projectId,
      'validation.started',
      'agent-office',
      `Validation started: ${gates.length} gate${gates.length === 1 ? '' : 's'}`,
      { sessionId: snap.sessionId, agentId },
    )
    const out: GateResult[] = []
    try {
      for (const g of gates) {
        if (ctl.aborted) break
        out.push(await this.runGate(agentId, snap, g, root, harnessVersion, ctl))
      }
    } finally {
      set.delete(ctl)
      if (!set.size) this.controllers.delete(agentId)
    }
    const failed = out.filter((r) => FAILED.has(r.run.status))
    if (out.length)
      void this.d.activity.add(
        snap.projectId,
        failed.length ? 'validation.failed' : 'validation.passed',
        'agent-office',
        failed.length
          ? `Validation failed: ${failed.map((r) => r.name).join(', ')}`
          : `Validation passed: ${out.length} gate${out.length === 1 ? '' : 's'}`,
        { sessionId: snap.sessionId, agentId },
      )
    return out.map(gateResultView)
  }

  private async runGate(
    agentId: string,
    snap: HarnessSnapshot,
    g: ValidationGate,
    root: string,
    harnessVersion: string,
    ctl: CancelController,
  ): Promise<GateResult> {
    const startedAt = this.d.clock.now()
    const base = {
      sessionId: snap.sessionId,
      projectId: snap.projectId,
      gateId: g.id,
      name: g.name,
      required: g.required,
      harnessVersion,
      startedAt,
    }
    this.d.store.setGateRunning(snap.sessionId, base)
    this.d.store.emit({ type: 'harness', agentId, projectId: snap.projectId })
    this.event(snap, agentId, 'validation-started', { gateId: g.id })
    let run: GateRun
    const sub = safeSubdir(g.subdir)
    if (sub === null) {
      run = {
        status: 'error',
        exitCode: null,
        durationMs: 0,
        outputTail: '',
        spawnError: 'invalid subdir',
      }
    } else {
      const cwd = sub ? `${root.replace(/[\\/]+$/, '')}/${sub}` : root
      try {
        run = await this.d.runner!.run(
          {
            id: g.id,
            argv: [...g.argv],
            timeoutMs: g.timeoutMs,
            ...(g.pinFiles ? { pinFiles: [...g.pinFiles] } : {}),
          },
          { cwd, signal: ctl.signal },
        )
      } catch {
        run = {
          status: 'error',
          exitCode: null,
          durationMs: this.d.clock.now() - startedAt,
          outputTail: '',
          spawnError: 'runner failed',
        }
      }
    }
    const result: GateResult = { id: this.d.store.newId('gtr'), ...base, run: sanitizeRun(run) }
    this.d.store.setGateRunning(snap.sessionId, undefined, g.id)
    await this.d.store.putGateResult(result)
    this.event(
      snap,
      agentId,
      result.run.status === 'pass' ? 'validation-passed' : 'validation-failed',
      {
        gateId: g.id,
        exitCode: result.run.exitCode,
        durationMs: result.run.durationMs,
      },
    )
    return result
  }

  private afterAutoRun(agentId: string, snap: HarnessSnapshot, views: GateResultView[]): void {
    const results = this.d.store
      .gateResultsOf(snap.sessionId)
      .filter((r) => views.some((v) => v.id === r.id))
    const failedRequired = results.filter((r) => r.required && FAILED.has(r.run.status))
    if (!failedRequired.length) {
      this.d.policy.setRetriesLeft(agentId, snap.effective.retryBudget)
      return
    }
    const left = this.d.policy.retriesLeft(agentId) ?? snap.effective.retryBudget
    if (left <= 0 || !this.d.policy.isLive(agentId)) return
    const text = gateFeedback(failedRequired)
    const sink = this.d.sessions?.() as FeedbackSink | undefined
    if (!text || typeof sink?.send !== 'function') return
    this.d.policy.setRetriesLeft(agentId, left - 1)
    void sink.send(agentId, { text, context: [], use: [] }).catch(() => {})
  }

  private event(
    snap: HarnessSnapshot,
    agentId: string,
    kind: 'validation-started' | 'validation-passed' | 'validation-failed',
    o: { gateId: string; exitCode?: number | null; durationMs?: number },
  ): void {
    void this.d.store.addHarnessEvent(
      newHarnessEvent({
        id: this.d.store.newId('hev'),
        projectId: snap.projectId,
        sessionId: snap.sessionId,
        agentId,
        ts: this.d.clock.now(),
        kind,
        ruleIds: [],
        ...o,
      }),
    )
  }
}

const MAX_TAIL = 8 * 1024

/** Defensive: the runner already redacts; core still caps sizes and strips control characters. */
function sanitizeRun(r: GateRun): GateRun {
  return {
    status: r.status,
    exitCode: typeof r.exitCode === 'number' ? r.exitCode : null,
    durationMs: Math.max(0, Math.round(r.durationMs || 0)),
    outputTail: (r.outputTail ?? '')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .slice(-MAX_TAIL),
    ...(r.pinChanged ? { pinChanged: true } : {}),
    ...(r.spawnError ? { spawnError: oneLine(r.spawnError, 200) } : {}),
  }
}
