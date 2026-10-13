// The harness policy engine for managed sessions (docs/harness.md §2–§3) and the Compliance
// Inspector's read model. Resolves a project's effective harness, refuses strict launches the
// runtime cannot enforce, compiles the policy runners receive, and records every decision as a
// redacted HarnessEvent. Raw tool input is never stored.
import type {
  Coverage,
  EffectiveHarnessView,
  GateResultView,
  HarnessBadge,
  HarnessEventKind,
  HarnessInspection,
  HarnessPreview,
  ProviderId,
} from '@agent-office/shared'
import { assertAuthorized, USER, type Principal } from '../domain/authz.ts'
import { SessionStartError } from '../domain/errors.ts'
import { coverageFor, toReportView, weakest } from '../domain/harness-coverage.ts'
import { newHarnessEvent, toEventView } from '../domain/harness-events.ts'
import { compilePolicy, nativeOf, toolClass } from '../domain/harness-policy.ts'
import { resolveEffective, versionKey } from '../domain/harness-resolve.ts'
import type {
  ActionPolicy,
  EffectiveHarness,
  EnforcementDecl,
  EnforcementReport,
  GateResult,
  Harness,
  HarnessSnapshot,
  PolicyAction,
  PolicyDecision,
  SessionHarnessHooks,
} from '../domain/harness-types.ts'
import { completionState, verificationState } from '../domain/harness-verification.ts'
import type { Project } from '../domain/project.ts'
import { oneLine } from '../domain/text.ts'
import type { Clock } from '../ports/driven.ts'
import type { HarnessPolicyEngine } from '../ports/driving.ts'
import type { ActivityLog } from './activity-log.ts'
import { requireProject } from './project-views.ts'
import type { ProjectsStore, RunningGate } from './projects-store.ts'

const MAX_BUFFER = 100
const MAX_VIEW_EVENTS = 50
/** The same decision about the same call (hook, then approval) is recorded once. */
const DEDUPE_MS = 5_000
const KIND: Record<PolicyDecision['action'], HarnessEventKind> = {
  allow: 'action-allowed',
  deny: 'action-denied',
  ask: 'action-asked',
}
const ALLOW: PolicyDecision = { action: 'allow', ruleIds: [], reason: '', basis: 'exact' }

interface Ids {
  agentId: string
  /** The vault session (`ses_…`) whose partition holds the snapshot and events. */
  sessionId: string
  projectId: string
}

interface Pending {
  a: PolicyAction
  d: PolicyDecision
  ts: number
}

interface State {
  policy: ActionPolicy
  effective: EffectiveHarness
  report: EnforcementReport
  ids?: Ids
  buffer: Pending[]
  ended: boolean
  last?: { key: string; ts: number }
  lastWriteAt?: number
}

export interface HarnessPolicyDeps {
  store: ProjectsStore
  activity: ActivityLog
  clock: Clock
  /** What each runtime can enforce (the runners' declarations). */
  enforcementOf?: (provider: ProviderId) => EnforcementDecl | undefined
  /** Main's platform: gates limited to other platforms do not count towards verification. */
  platform?: string
}

const isWrite = (tool: string | undefined) => {
  const c = tool ? toolClass(tool) : undefined
  return c === 'write' || c === 'exec'
}

export class HarnessPolicyService implements HarnessPolicyEngine, SessionHarnessHooks {
  private states = new WeakMap<ActionPolicy, State>()
  private byAgent = new Map<string, State>()
  private turnListener:
    ((agentId: string, r: { isError: boolean; interrupted: boolean }) => void) | undefined
  private endListener: ((agentId: string) => void) | undefined
  private retries = new Map<string, number>()

  constructor(private d: HarnessPolicyDeps) {}

  /** The validation service follows turns and session ends (wired by createProjects). */
  connect(o: {
    turnEnded: (agentId: string, r: { isError: boolean; interrupted: boolean }) => void
    ended: (agentId: string) => void
  }): void {
    this.turnListener = o.turnEnded
    this.endListener = o.ended
  }

  // ── resolution ──

  /** Attached harnesses: the newest published version of each lineage that is not archived. */
  attachedPublished(p: Project): Harness[] {
    const out: Harness[] = []
    for (const a of p.harnesses ?? []) {
      const versions = this.d.store.harnessVersions(a.harnessId)
      if (!versions.length || versions.at(-1)!.status === 'archived') continue
      const pub = versions.filter((v) => v.status === 'published').at(-1)
      if (pub) out.push(pub)
    }
    return out
  }

  effectiveFor(p: Project, provider: ProviderId): EffectiveHarness {
    return resolveEffective({
      project: p,
      harnesses: this.attachedPublished(p),
      provider,
      now: this.d.clock.now(),
    })
  }

  preview(projectId: string, provider: ProviderId, as: Principal = USER): HarnessPreview {
    const p = requireProject(this.d.store, projectId)
    assertAuthorized(as, 'harness.read', { kind: 'harness', projectId }, p)
    const effective = this.effectiveFor(p, provider)
    const report = coverageFor(effective, this.d.enforcementOf?.(provider), { mode: 'default' })
    return { effective: effectiveView(effective, report), report: toReportView(report) }
  }

  // ── SessionHarnessHooks ──

  async prepare(o: {
    projectId: string
    provider: ProviderId
    cwd: string
    mode: string
    modeId?: string
    enforcement?: EnforcementDecl
  }): Promise<ActionPolicy | undefined> {
    const p = this.d.store.projects.get(o.projectId)
    if (!p) return undefined
    const effective = this.effectiveFor(p, o.provider)
    if (!effective.resolved.length) return undefined
    const decl = o.enforcement
    const blind = !!decl?.nonInterceptingModes?.some((m) => m === o.mode || m === o.modeId)
    // Advisory: the session service coerces a non-intercepting mode; strict: coverage refuses it.
    const mode =
      blind && effective.launchPolicy === 'advisory' && decl?.interceptingMode
        ? { mode: decl.interceptingMode }
        : { mode: o.mode, ...(o.modeId !== undefined ? { modeId: o.modeId } : {}) }
    const report = coverageFor(effective, decl, mode)
    // The reasons are in `preview()` (the New Session dialog); the error carries the code only.
    if (!report.launch.ok) throw new SessionStartError('harness')
    const evaluateFn = compilePolicy(effective.policies)
    const state = {} as State
    const policy: ActionPolicy = {
      evaluate: (a) => {
        let d: PolicyDecision
        try {
          d = evaluateFn(a)
        } catch {
          d = { action: 'deny', ruleIds: [], reason: 'policy error', basis: 'exact' }
        }
        try {
          this.record(state, a, d)
        } catch {
          /* auditing never changes the decision */
        }
        return d
      },
      ...(effective.instructions ? { instructions: effective.instructions } : {}),
      native: nativeOf(effective.policies, effective.fsIsolation),
      interceptAll: effective.policies.length > 0,
      unsupported: effective.rules
        .filter(
          (r) => r.severity === 'required' && report.perRule[r.id]?.coverage === 'unsupported',
        )
        .map((r) => ({ ruleId: r.id, reason: report.perRule[r.id]!.reason })),
    }
    Object.assign(state, { policy, effective, report, buffer: [], ended: false })
    this.states.set(policy, state)
    return policy
  }

  bind(o: { agentId: string; sessionId: string; projectId: string; policy: ActionPolicy }): void {
    const state = this.states.get(o.policy)
    if (!state || state.ids) return
    const sessionId = this.d.store.sessionByAgent(o.agentId)?.id ?? fallbackSession(o.sessionId)
    state.ids = { agentId: o.agentId, sessionId, projectId: o.projectId }
    this.byAgent.set(o.agentId, state)
    this.retries.set(o.agentId, state.effective.retryBudget)
    const now = this.d.clock.now()
    const snapshot: HarnessSnapshot = {
      id: this.d.store.newId('hsn'),
      sessionId,
      agentId: o.agentId,
      projectId: o.projectId,
      provider: state.effective.provider,
      effective: state.effective,
      report: state.report,
      createdAt: now,
    }
    void this.d.store.putHarnessSnapshot(snapshot)
    const versions = state.effective.resolved.map((r) => `${r.harnessId}@${r.version}`)
    this.event(state, 'attached', [], { harnessVersions: versions })
    this.event(state, 'resolved', state.effective.rules.map((r) => r.id).slice(0, 200), {
      harnessVersions: versions,
    })
    if (state.effective.instructions)
      this.event(
        state,
        'instructions-delivered',
        state.effective.rules
          .filter((r) => r.enforcement !== 'runtime-policy')
          .map((r) => r.id)
          .slice(0, 200),
        {},
      )
    const buffered = state.buffer
    state.buffer = []
    for (const b of buffered) this.write(state, b.a, b.d, b.ts)
  }

  evaluate(agentId: string, a: PolicyAction): PolicyDecision {
    const s = this.byAgent.get(agentId)
    if (!s || s.ended) return ALLOW
    return s.policy.evaluate(a)
  }

  /** The rule's display name for permission cards (empty for unknown ids). */
  ruleName(agentId: string, ruleId: string): string {
    return this.byAgent.get(agentId)?.effective.rules.find((r) => r.id === ruleId)?.name ?? ''
  }

  turnEnded(agentId: string, r: { isError: boolean; interrupted: boolean }): void {
    if (!this.byAgent.has(agentId)) return
    this.turnListener?.(agentId, r)
  }

  ended(agentId: string): void {
    const s = this.byAgent.get(agentId)
    if (!s) return
    s.ended = true
    this.endListener?.(agentId)
  }

  // ── read model ──

  /** The vault session of a bound (or previously bound) agent. */
  sessionOf(agentId: string): string | undefined {
    return this.byAgent.get(agentId)?.ids?.sessionId ?? this.d.store.sessionByAgent(agentId)?.id
  }

  snapshotOf(agentId: string): HarnessSnapshot | undefined {
    const sid = this.sessionOf(agentId)
    return sid ? this.d.store.harnessSnapshot(sid) : undefined
  }

  isLive(agentId: string): boolean {
    const s = this.byAgent.get(agentId)
    return !!s && !s.ended
  }

  /** The time of the last allowed write or command (memory, else rebuilt from events). */
  lastWriteAt(agentId: string): number | undefined {
    const s = this.byAgent.get(agentId)
    if (s?.lastWriteAt !== undefined) return s.lastWriteAt
    const sid = this.sessionOf(agentId)
    if (!sid) return undefined
    let t: number | undefined
    for (const e of this.d.store.harnessEventsOf(sid))
      if (e.kind === 'action-allowed' && isWrite(e.detail.tool)) t = Math.max(t ?? 0, e.ts)
    return t
  }

  retriesLeft(agentId: string): number | undefined {
    return this.retries.get(agentId)
  }

  setRetriesLeft(agentId: string, n: number): void {
    this.retries.set(agentId, Math.max(0, n))
  }

  inspect(agentId: string, as: Principal = USER): HarnessInspection {
    const snap = this.snapshotOf(agentId)
    assertAuthorized(
      as,
      'harness.read',
      { kind: 'harness', projectId: snap?.projectId ?? null },
      snap ? this.d.store.projects.get(snap.projectId) : undefined,
    )
    const empty: HarnessInspection = {
      agentId,
      effective: null,
      report: null,
      counts: { allowed: 0, denied: 0, asked: 0 },
      events: [],
      gates: [],
      verification: 'not-run',
      completion: 'agent-reported',
    }
    if (!snap) return empty
    const events = this.d.store.harnessEventsOf(snap.sessionId)
    const counts = { allowed: 0, denied: 0, asked: 0 }
    for (const e of events) {
      if (e.kind === 'action-allowed') counts.allowed++
      else if (e.kind === 'action-denied') counts.denied++
      else if (e.kind === 'action-asked') counts.asked++
    }
    const views = events
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MAX_VIEW_EVENTS)
      .map(toEventView)
    const { verification, completion, gates } = this.validationOf(agentId, snap)
    const retriesLeft = this.retries.get(agentId)
    return {
      agentId,
      sessionId: snap.sessionId,
      projectId: snap.projectId,
      effective: effectiveView(snap.effective, snap.report),
      report: toReportView(snap.report),
      counts,
      events: views,
      gates,
      verification,
      completion,
      ...(retriesLeft !== undefined ? { retriesLeft } : {}),
      ...(views[0] ? { lastEvent: views[0] } : {}),
    }
  }

  badges(as: Principal = USER): HarnessBadge[] {
    assertAuthorized(as, 'harness.read', { kind: 'harness', projectId: null }, undefined)
    const out: HarnessBadge[] = []
    for (const [agentId, s] of this.byAgent) {
      if (!s.ids) continue
      const snap = this.d.store.harnessSnapshot(s.ids.sessionId)
      if (!snap) continue
      const required = s.effective.rules.filter((r) => r.severity === 'required')
      const levels = (required.length ? required : s.effective.rules).map(
        (r) => s.report.perRule[r.id]?.coverage ?? 'unsupported',
      ) as Coverage[]
      const { verification, completion } = this.validationOf(agentId, snap)
      out.push({
        agentId,
        harnessNames: s.effective.resolved.map((r) => r.name),
        ruleCount: s.effective.rules.length,
        coverage: weakest(levels),
        verification,
        completion,
        denied: this.d.store
          .harnessEventsOf(s.ids.sessionId)
          .filter((e) => e.kind === 'action-denied').length,
      })
    }
    return out
  }

  /** Gate result views (running first, then newest), verification and completion. */
  validationOf(
    agentId: string,
    snap: HarnessSnapshot,
  ): Pick<HarnessInspection, 'verification' | 'completion' | 'gates'> {
    const results = this.d.store.gateResultsOf(snap.sessionId)
    const running = this.d.store.runningGates(snap.sessionId)
    const lastWriteAt = this.lastWriteAt(agentId)
    const platform = this.d.platform
    const applicable = snap.effective.gates.filter(
      (g) => !platform || !g.platforms?.length || g.platforms.includes(platform as never),
    )
    const verification = verificationState(applicable, results, {
      harnessVersion: versionKey(snap.effective),
      running: running.length > 0,
      ...(lastWriteAt !== undefined ? { lastWriteAt } : {}),
    })
    const completion = completionState({
      phase: this.isLive(agentId) ? 'live' : 'ended',
      verification,
      userApproved: false,
    })
    const gates = [
      ...running.map(runningView),
      ...results
        .slice()
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(gateResultView),
    ]
    return { verification, completion, gates }
  }

  // ── recording ──

  private record(state: State, a: PolicyAction, d: PolicyDecision): void {
    const ts = this.d.clock.now()
    if (!state.ids) {
      if (state.buffer.length < MAX_BUFFER) state.buffer.push({ a, d, ts })
      return
    }
    this.write(state, a, d, ts)
  }

  private write(state: State, a: PolicyAction, d: PolicyDecision, ts: number): void {
    const ids = state.ids!
    const e = newHarnessEvent({
      id: this.d.store.newId('hev'),
      projectId: ids.projectId,
      sessionId: ids.sessionId,
      agentId: ids.agentId,
      ts,
      kind: KIND[d.action],
      ruleIds: d.ruleIds,
      tool: a.tool,
      input: a.input,
      cwd: a.cwd,
      ...(a.agentRole ? { agentRole: a.agentRole } : {}),
    })
    if (d.action === 'allow' && isWrite(a.tool))
      state.lastWriteAt = Math.max(state.lastWriteAt ?? 0, ts)
    const key = `${e.kind}|${e.detail.tool}|${e.detail.summary}|${e.detail.agentRole ?? ''}`
    if (state.last && state.last.key === key && ts - state.last.ts < DEDUPE_MS) return
    state.last = { key, ts }
    void this.d.store.addHarnessEvent(e)
    if (d.action === 'deny') {
      const name =
        state.effective.rules.find((r) => r.id === d.ruleIds[0])?.name ?? d.reason.slice(0, 60)
      void this.d.activity.add(
        ids.projectId,
        'harness.denied',
        state.effective.provider,
        `Blocked ${e.detail.tool ?? 'a tool'}: ${name}`,
        { sessionId: ids.sessionId, agentId: ids.agentId },
      )
    }
  }

  private event(
    state: State,
    kind: HarnessEventKind,
    ruleIds: string[],
    o: { harnessVersions?: string[] },
  ): void {
    const ids = state.ids!
    void this.d.store.addHarnessEvent(
      newHarnessEvent({
        id: this.d.store.newId('hev'),
        projectId: ids.projectId,
        sessionId: ids.sessionId,
        agentId: ids.agentId,
        ts: this.d.clock.now(),
        kind,
        ruleIds,
        ...o,
      }),
    )
  }
}

/** A partition-safe session key when the vault has no record for the agent (no projects load). */
function fallbackSession(sessionId: string): string {
  const s = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 24)
  return `ses_${s || 'unknown'}`
}

export function effectiveView(
  e: EffectiveHarness,
  report: EnforcementReport,
): EffectiveHarnessView {
  return {
    resolved: e.resolved.map((r) => ({ ...r })),
    rules: e.rules.map((r) => {
      const c = report.perRule[r.id]
      return { ...r, ...(c ? { coverage: c.coverage, coverageReason: c.reason } : {}) }
    }),
    gates: e.gates.map((g) => ({ ...g, argv: [...g.argv] })),
    unsupported: e.rules
      .filter((r) => r.severity === 'required' && report.perRule[r.id]?.coverage === 'unsupported')
      .map((r) => ({ ruleId: r.id, reason: report.perRule[r.id]!.reason })),
    conflicts: e.conflicts.map((c) => ({ ...c, ruleIds: [...c.ruleIds] })),
    launchPolicy: e.launchPolicy,
    gateTrigger: e.gateTrigger,
    fsIsolation: e.fsIsolation,
    instructionsChars: e.instructions.length,
  }
}

export function gateResultView(r: GateResult): GateResultView {
  return {
    id: r.id,
    gateId: r.gateId,
    name: r.name,
    status: r.run.status,
    exitCode: r.run.exitCode,
    startedAt: r.startedAt,
    durationMs: r.run.durationMs,
    outputTail: r.run.outputTail,
    ...(r.run.pinChanged ? { pinChanged: true } : {}),
    required: r.required,
    harnessVersion: r.harnessVersion,
  }
}

function runningView(g: RunningGate): GateResultView {
  return {
    id: `run_${g.gateId}`,
    gateId: g.gateId,
    name: g.name,
    status: 'running',
    exitCode: null,
    startedAt: g.startedAt,
    durationMs: 0,
    outputTail: '',
    required: g.required,
    harnessVersion: g.harnessVersion,
  }
}
