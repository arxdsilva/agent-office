// A session's flow (docs/harness.md §2a): user actions on steps (approve, mark done, skip, reopen),
// the agent's single write (`report_step`, scoped to its own session and to `report` checks), gate
// and artifact checks from the trusted side, events and the system message naming the next step.
import type { FlowApprovalView, FlowProgressView } from '@agent-office/shared'
import { assertAuthorized, USER, type Principal } from '../domain/authz.ts'
import { ForbiddenError, NotFoundError, RateLimitedError } from '../domain/errors.ts'
import {
  advance,
  applyCheck,
  approve,
  artifactChecks,
  flowEvent,
  markDone,
  pendingApprovals,
  reopen,
  report,
  skip,
  transitions,
  voidGateChecks,
} from '../domain/harness-flow.ts'
import { checkInWords } from '../domain/harness-instructions.ts'
import type { FlowProgress, HarnessSnapshot } from '../domain/harness-types.ts'
import { oneLine } from '../domain/text.ts'
import type { AgentRepository, Clock, Logger, RepoFiles } from '../ports/driven.ts'
import type { ComposedMessage, HarnessFlow, McpPrincipal, ProjectRepos } from '../ports/driving.ts'
import type { HarnessPolicyService } from './harness-policy-service.ts'
import type { ProjectsStore } from './projects-store.ts'

export const REPORTS_PER_MIN = 20
export const MAX_STEP_MESSAGE = 1000
const MINUTE = 60_000

export interface HarnessFlowDeps {
  store: ProjectsStore
  clock: Clock
  policy: HarnessPolicyService
  repos: ProjectRepos
  /** Read-only artifact checks; without it artifact checks stay pending. */
  repoFiles?: RepoFiles
  /** Managed sessions, resolved lazily; step messages need their `send`. */
  sessions?: () => object | undefined
  /** Agent names for the Overview approvals. */
  agents?: AgentRepository
  log?: Logger
}

interface Sink {
  send?(agentId: string, m: ComposedMessage): Promise<unknown>
}

interface Ctx {
  agentId: string
  snap: HarnessSnapshot
  progress: FlowProgress
}

/** What the project MCP server needs (get_project_context's `flow` block, `report_step`). */
export interface McpFlow {
  contextFor(sessionId: string): FlowContext | null
  reportStep(p: McpPrincipal, stepId: string, note?: string): Promise<FlowProgressView>
}

export interface FlowContext {
  current: string | null
  steps: { id: string; name: string; goal: string; exit: string[] }[]
}

/** A repo-relative glob without traversal (the RepoFiles adapter checks again). */
const isRelativeGlob = (p: string) =>
  !!p &&
  !p.startsWith('/') &&
  !p.startsWith('\\') &&
  !/^[a-zA-Z]:/.test(p) &&
  !p.split(/[\\/]/).includes('..')

export class HarnessFlowService implements HarnessFlow, McpFlow {
  private reports = new Map<string, number[]>()

  constructor(private d: HarnessFlowDeps) {}

  // ── user (IPC) ──

  progress(agentId: string, as: Principal = USER): FlowProgressView | null {
    const ctx = this.ctxOf(agentId)
    this.authorize(as, 'harness.read', ctx?.snap.projectId ?? null)
    return ctx ? this.view(ctx.snap) : null
  }

  async approve(
    o: { agentId: string; stepId: string; checkIndex: number },
    as: Principal = USER,
  ): Promise<FlowProgressView> {
    const ctx = this.requireCtx(o.agentId, as)
    const next = approve(ctx.snap.effective, ctx.progress, o.stepId, o.checkIndex, this.now())
    return this.commit(ctx, next, { approved: o.stepId })
  }

  async markDone(o: { agentId: string; stepId: string }, as: Principal = USER) {
    const ctx = this.requireCtx(o.agentId, as)
    // Artifacts may have appeared since the last look: check before refusing.
    await this.refreshChecks(o.agentId)
    const fresh = this.requireCtx(o.agentId, as)
    const next = markDone(fresh.snap.effective, fresh.progress, o.stepId, 'user', this.now())
    return this.commit({ ...fresh, agentId: ctx.agentId }, next)
  }

  async skip(o: { agentId: string; stepId: string; confirmed: boolean }, as: Principal = USER) {
    const ctx = this.requireCtx(o.agentId, as)
    const next = skip(ctx.snap.effective, ctx.progress, o.stepId, o, this.now())
    return this.commit(ctx, next)
  }

  async reopen(o: { agentId: string; stepId: string }, as: Principal = USER) {
    const ctx = this.requireCtx(o.agentId, as)
    const next = reopen(ctx.snap.effective, ctx.progress, o.stepId, this.now())
    return this.commit(ctx, next)
  }

  /** Approval checks waiting on the user in live sessions. */
  pendingApprovals(projectId?: string, as: Principal = USER): FlowApprovalView[] {
    this.authorize(as, 'harness.read', projectId ?? null)
    const out: FlowApprovalView[] = []
    for (const fp of this.d.store.allFlows()) {
      if (projectId && fp.projectId !== projectId) continue
      if (!this.d.policy.isLive(fp.agentId)) continue
      const snap = this.d.store.harnessSnapshot(fp.sessionId)
      if (!snap) continue
      const projectName = this.d.store.projects.get(fp.projectId)?.name ?? ''
      const agentName = this.d.agents?.get(fp.agentId)?.name ?? fp.agentId
      for (const a of pendingApprovals(snap.effective, fp))
        out.push({ projectId: fp.projectId, projectName, agentId: fp.agentId, agentName, ...a })
    }
    return out
  }

  // ── agent (MCP) ──

  /** `report_step`: only the calling session's own progress, only `report` checks. */
  async reportStep(p: McpPrincipal, stepId: string, _note?: string): Promise<FlowProgressView> {
    // The note is accepted for the agent's benefit and never stored.
    const sid = typeof p?.sessionId === 'string' ? p.sessionId : ''
    const progress = sid ? this.d.store.flowOf(sid) : undefined
    const snap = sid ? this.d.store.harnessSnapshot(sid) : undefined
    if (!progress || !snap || progress.projectId !== p.projectId || snap.projectId !== p.projectId)
      throw new ForbiddenError()
    const now = this.now()
    const list = this.reports.get(sid) ?? []
    while (list.length && list[0]! <= now - MINUTE) list.shift()
    if (list.length >= REPORTS_PER_MIN) throw new RateLimitedError()
    list.push(now)
    this.reports.set(sid, list)
    const ctx = { agentId: progress.agentId, snap, progress }
    return this.commit(ctx, report(snap.effective, progress, stepId, now))
  }

  contextFor(sessionId: string): FlowContext | null {
    const progress = this.d.store.flowOf(sessionId)
    const snap = this.d.store.harnessSnapshot(sessionId)
    if (!progress || !snap?.effective.steps?.length) return null
    const e = snap.effective
    return {
      current: progress.current,
      steps: e.steps!.map((s) => ({
        id: s.id,
        name: s.name,
        goal: s.goal,
        exit: s.exit.map((c) => checkInWords(c, e.gates)),
      })),
    }
  }

  // ── trusted side ──

  /** A gate finished: its `gate` checks on available steps pass or fail. */
  gateFinished(agentId: string, gateId: string, passed: boolean): void {
    const ctx = this.ctxOf(agentId)
    if (!ctx) return
    const now = this.now()
    const open = new Set(
      ctx.progress.steps
        .filter((s) =>
          ctx.progress.mode === 'free'
            ? s.state !== 'done' && s.state !== 'skipped'
            : s.state === 'active',
        )
        .map((s) => s.stepId),
    )
    let next = ctx.progress
    for (const s of ctx.snap.effective.steps ?? [])
      if (open.has(s.id))
        s.exit.forEach((c, k) => {
          if (c.kind === 'gate' && c.gateId === gateId)
            next = applyCheck(next, s.id, k, passed ? 'pass' : 'fail', now)
        })
    void this.commit(ctx, advance(next, next.mode, now)).catch(() => {})
  }

  /** An allowed write or command: gate passes on unfinished steps are void. */
  wrote(agentId: string): void {
    const ctx = this.ctxOf(agentId)
    if (!ctx) return
    void this.commit(ctx, voidGateChecks(ctx.snap.effective, ctx.progress, this.now())).catch(
      () => {},
    )
  }

  /** Stats the pending artifact checks through RepoFiles (read-only); passes the ones that match. */
  async refreshChecks(agentId: string): Promise<void> {
    const files = this.d.repoFiles
    const first = this.ctxOf(agentId)
    if (!files || !first) return
    const pending = artifactChecks(first.snap.effective, first.progress)
    if (!pending.length) return
    const repo = this.d.store.projects.get(first.snap.projectId)?.repos[0]
    const root = repo ? this.d.repos.repoPath(first.snap.projectId, repo.id) : undefined
    if (!root) return
    const results: { stepId: string; checkIndex: number; ok: boolean }[] = []
    for (const c of pending) {
      if (!isRelativeGlob(c.path)) continue
      let exists = false
      try {
        exists = await files.exists(root, c.path)
      } catch {
        this.d.log?.warn('artifact check failed')
      }
      results.push({ stepId: c.stepId, checkIndex: c.checkIndex, ok: exists === c.mustExist })
    }
    // Apply on the latest progress (it may have moved while we were checking).
    const ctx = this.ctxOf(agentId)
    if (!ctx) return
    const now = this.now()
    let next = ctx.progress
    for (const r of results) if (r.ok) next = applyCheck(next, r.stepId, r.checkIndex, 'pass', now)
    await this.commit(ctx, advance(next, next.mode, now))
  }

  // ── internals ──

  private now(): number {
    return this.d.clock.now()
  }

  private authorize(
    as: Principal,
    action: 'harness.read' | 'harness.manage',
    projectId: string | null,
  ) {
    assertAuthorized(
      as,
      action,
      { kind: 'harness', projectId },
      projectId ? this.d.store.projects.get(projectId) : undefined,
    )
  }

  private ctxOf(agentId: string): Ctx | undefined {
    const sid = this.d.policy.sessionOf(agentId)
    const progress = sid ? this.d.store.flowOf(sid) : undefined
    const snap = sid ? this.d.store.harnessSnapshot(sid) : undefined
    return progress && snap ? { agentId, snap, progress } : undefined
  }

  private requireCtx(agentId: string, as: Principal): Ctx {
    const ctx = this.ctxOf(agentId)
    this.authorize(as, 'harness.manage', ctx?.snap.projectId ?? null)
    if (!ctx) throw new NotFoundError('flow')
    return ctx
  }

  private view(snap: HarnessSnapshot): FlowProgressView | null {
    return this.d.policy.flowView(snap) ?? null
  }

  /** Stores a transition, writes its events and tells a managed session which step is next. */
  private async commit(
    ctx: Ctx,
    next: FlowProgress,
    o: { approved?: string } = {},
  ): Promise<FlowProgressView> {
    const before = ctx.progress
    if (next !== before) {
      await this.d.store.putFlowProgress(next)
      const t = transitions(before, next)
      const names = new Map((ctx.snap.effective.steps ?? []).map((s) => [s.id, s.name]))
      const ev = (
        kind: 'step-started' | 'step-done' | 'step-skipped' | 'approval-granted',
        stepId: string,
      ) =>
        void this.d.store.addHarnessEvent(
          flowEvent({
            id: this.d.store.newId('hev'),
            projectId: next.projectId,
            sessionId: next.sessionId,
            agentId: ctx.agentId,
            ts: this.now(),
            kind,
            stepName: names.get(stepId) ?? stepId,
          }),
        )
      if (o.approved) ev('approval-granted', o.approved)
      for (const d of t.done) ev('step-done', d.stepId)
      for (const id of t.skipped) ev('step-skipped', id)
      for (const id of t.started) ev('step-started', id)
      this.d.store.emit({ type: 'harness', agentId: ctx.agentId, projectId: next.projectId })
      if (next.mode === 'sequential' && t.started.length) {
        this.announce(ctx, next, t.started[0]!)
        void this.refreshChecks(ctx.agentId).catch(() => {})
      }
    }
    return this.view(ctx.snap)!
  }

  private announce(ctx: Ctx, p: FlowProgress, stepId: string): void {
    if (!this.d.policy.isLive(ctx.agentId)) return
    const sink = this.d.sessions?.() as Sink | undefined
    if (typeof sink?.send !== 'function') return
    const e = ctx.snap.effective
    const i = p.steps.findIndex((s) => s.stepId === stepId)
    const def = e.steps?.find((s) => s.id === stepId)
    if (!def || i < 0) return
    const exit = def.exit.map((c) => checkInWords(c, e.gates)).join('; ')
    const text =
      `Step ${i + 1} of ${p.steps.length} is now active: ${oneLine(def.name, 80)} — ${oneLine(def.goal, 600)}. Exit: ${exit}.`
        .replace(/\.\. Exit/, '. Exit')
        .slice(0, MAX_STEP_MESSAGE)
    void sink.send(ctx.agentId, { text, context: [], use: [] }).catch(() => {})
  }
}
