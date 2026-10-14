// The Harness tab of Agent Details (the Compliance Inspector) and the Minimal-mode badge, as pure
// data (docs/harness.md). Coverage uses the fixed words; nothing here ever says "guaranteed".
import type {
  CheckState,
  Completion,
  FlowProgressView,
  PermissionRequestVM,
  StepCheckKind,
  StepState,
  HarnessPreview,
  GateResultView,
  HarnessBadge,
  HarnessInspection,
  Verification,
} from '@agent-office/shared'
import { INSPECTOR_COPY } from './harness-inspector-copy.ts'
import { HARNESS_COPY } from './workspace/harness-copy.ts'
import {
  COVERAGE_WORD,
  enforcementReportVM,
  type EnforcementReportVM,
} from './workspace/harness-vm.ts'
import type { NewSessionHarnessVM } from './session-types.ts'
import type { Tone } from './workspace/types.ts'

const T = HARNESS_COPY.tab

const VERIFICATION_TONE: Record<Verification, Tone> = {
  'not-run': 'neutral',
  running: 'neutral',
  failed: 'bad',
  verified: 'good',
  stale: 'warn',
  'flow-incomplete': 'warn',
}
const COMPLETION_TONE: Record<Completion, Tone> = {
  'agent-reported': 'warn',
  'validation-pending': 'warn',
  'validation-failed': 'bad',
  'harness-verified': 'good',
  'user-approved': 'good',
}

export interface GateRowTabVM {
  id: string
  name: string
  command: string
  mark: string
  statusLabel: string
  required: boolean
  tone: Tone
  /** Redacted tail of the last run (≤ 8 KB), shown on failure. */
  tail: string
}
export interface DeniedRowVM {
  id: string
  ts: number
  tool: string
  summary: string
  ruleNames: string[]
}
/** A button of the flow stepper; `confirm` is set when the click needs `#p-step-confirm` first. */
export interface FlowButtonVM {
  action: 'approve' | 'mark-done' | 'skip' | 'reopen'
  label: string
  primary: boolean
  /** The exit check this applies to (approve). */
  checkIndex?: number
  confirm?: string
}
export interface FlowCheckVM {
  index: number
  kind: StepCheckKind
  kindLabel: string
  label: string
  state: CheckState
  stateLabel: string
}
export interface FlowStepRowVM {
  id: string
  /** 1-based, as the user counts. */
  index: number
  name: string
  goal: string
  state: StepState
  stateLabel: string
  /** The step the agent is on: `aria-current="step"`. */
  current: boolean
  optional: boolean
  checks: FlowCheckVM[]
  buttons: FlowButtonVM[]
}
export interface FlowTabVM {
  heading: string
  progress: string
  modeLabel: string
  steps: FlowStepRowVM[]
}
/** An `ask` card waiting for the user, mirrored from the Details permission card. */
export interface PendingAskVM {
  requestId: string
  tool: string
  summary: string
  ruleName: string
  text: string
}
export interface HarnessTabVM {
  state: 'loading' | 'none' | 'ready'
  message: string
  /** The flow stepper; present when the effective harness has steps. */
  flow?: FlowTabVM
  /** Ask cards awaiting the user (with the rule that asked). */
  pending: PendingAskVM[]
  applied: string[]
  coverage: EnforcementReportVM | null
  countsLine: string
  gates: GateRowTabVM[]
  gatesEmpty: string
  /** "Running Check… (12s)" while validation runs. */
  runningLine?: string
  run: { action: 'run-gates' | 'cancel-gates'; label: string; enabled: boolean; hint?: string }
  completion: { text: string; tone: Tone }
  verification: { text: string; tone: Tone }
  denied: DeniedRowVM[]
  /** Denied rows beyond the first 10 that "Show more" reveals. */
  deniedMore: number
  deniedEmpty: string
  retries?: string
  pinWarning?: string
  instructions: string
  labels: {
    applied: string
    coverage: string
    activity: string
    gates: string
    denied: string
    open: string
    pending: string
    showOutput: string
    showMore: string
    showLess: string
    allow: string
    deny: string
  }
}

export interface HarnessTabOpts {
  now?: number
  /** Pending permission requests of this agent (ask cards carry `rule`). */
  requests?: PermissionRequestVM[]
  /** "Show more" was pressed: list every blocked action. */
  showAllDenied?: boolean
}

const MAX_DENIED = 10

const LABELS = {
  applied: T.applied,
  coverage: T.coverage,
  activity: T.activity,
  gates: T.gates,
  denied: T.denied,
  open: T.open,
  pending: INSPECTOR_COPY.pending.heading,
  showOutput: INSPECTOR_COPY.gate.showOutput,
  showMore: '',
  showLess: INSPECTOR_COPY.denied.showLess,
  allow: INSPECTOR_COPY.pending.allow,
  deny: INSPECTOR_COPY.pending.deny,
}

const EMPTY: Omit<HarnessTabVM, 'state' | 'message'> = {
  pending: [],
  deniedMore: 0,
  applied: [],
  coverage: null,
  countsLine: '',
  gates: [],
  gatesEmpty: T.noGates,
  run: { action: 'run-gates', label: T.run, enabled: false, hint: T.runHintNoGates },
  completion: { text: '', tone: 'neutral' },
  verification: { text: '', tone: 'neutral' },
  denied: [],
  deniedEmpty: T.noDenied,
  instructions: '',
  labels: LABELS,
}

/** The newest result per gate id. */
function latestByGate(results: GateResultView[]): Map<string, GateResultView> {
  const out = new Map<string, GateResultView>()
  for (const r of results) {
    const cur = out.get(r.gateId)
    if (!cur || r.startedAt >= cur.startedAt) out.set(r.gateId, r)
  }
  return out
}

const markOf = (r: GateResultView | undefined): string =>
  !r
    ? HARNESS_COPY.gateMark.none
    : r.status === 'pass'
      ? HARNESS_COPY.gateMark.pass
      : r.status === 'running'
        ? HARNESS_COPY.gateMark.running
        : HARNESS_COPY.gateMark.fail

export function harnessTabVM(
  ins: HarnessInspection | null,
  opts: HarnessTabOpts = {},
): HarnessTabVM {
  if (!ins) return { ...EMPTY, state: 'loading', message: T.loading }
  const eff = ins.effective
  if (!eff) return { ...EMPTY, state: 'none', message: ins.projectId ? T.none : T.noProject }

  const latest = latestByGate(ins.gates)
  const running = ins.gates.some((g) => g.status === 'running')
  const ruleName = new Map(eff.rules.map((r) => [r.id, r.name]))
  const gates = eff.gates.map((g): GateRowTabVM => {
    const r = latest.get(g.id)
    return {
      id: g.id,
      name: g.name,
      command: g.argv.join(' '),
      mark: markOf(r),
      statusLabel: r ? HARNESS_COPY.gateStatus[r.status] : 'Not run',
      required: g.required,
      tone: !r
        ? 'neutral'
        : r.status === 'pass'
          ? 'good'
          : r.status === 'running'
            ? 'neutral'
            : 'bad',
      tail: r && r.status !== 'running' ? r.outputTail : '',
    }
  })
  const deniedAll = ins.events
    .filter((e) => e.kind === 'action-denied')
    .sort((a, b) => b.ts - a.ts)
    .map((e): DeniedRowVM => ({
      id: e.id,
      ts: e.ts,
      tool: e.tool ?? '',
      summary: e.summary ?? '',
      ruleNames: (e.ruleIds.length ? e.ruleIds : ['']).map((id) =>
        id ? (ruleName.get(id) ?? T.unknownRule) : T.unknownRule,
      ),
    }))
  const denied = opts.showAllDenied ? deniedAll : deniedAll.slice(0, MAX_DENIED)
  const deniedMore = deniedAll.length - denied.length
  const noGates = eff.gates.length === 0
  const runningGate = ins.gates.find((g) => g.status === 'running')
  const pending = (opts.requests ?? [])
    .filter((r) => r.rule && !r.question)
    .map((r): PendingAskVM => ({
      requestId: r.id,
      tool: r.tool,
      summary: r.summary,
      ruleName: r.rule!.name,
      text: T.askedBy(r.rule!.name),
    }))
  return {
    state: 'ready',
    message: '',
    pending,
    ...(ins.flow && { flow: flowVM(ins.flow) }),
    deniedMore,
    ...(runningGate && {
      runningLine: INSPECTOR_COPY.gate.running(
        runningGate.name,
        elapsed((opts.now ?? runningGate.startedAt) - runningGate.startedAt),
      ),
    }),
    applied: eff.resolved.map((h) => `${h.name} v${h.version}`),
    coverage: ins.report ? enforcementReportVM(ins.report) : null,
    countsLine: T.counts(ins.counts.allowed, ins.counts.denied, ins.counts.asked),
    gates,
    gatesEmpty: T.noGates,
    run: running
      ? { action: 'cancel-gates', label: T.cancel, enabled: true }
      : {
          action: 'run-gates',
          label: T.run,
          enabled: !noGates,
          ...(noGates && { hint: T.runHintNoGates }),
        },
    completion: {
      text: HARNESS_COPY.completion[ins.completion],
      tone: COMPLETION_TONE[ins.completion],
    },
    verification: {
      text: HARNESS_COPY.verification[ins.verification],
      tone: VERIFICATION_TONE[ins.verification],
    },
    denied,
    deniedEmpty: T.noDenied,
    ...(ins.retriesLeft !== undefined && { retries: T.retries(ins.retriesLeft) }),
    ...(ins.gates.some((g) => g.pinChanged) && { pinWarning: T.pinChanged }),
    instructions: T.instructions(eff.instructionsChars),
    labels: { ...LABELS, showMore: INSPECTOR_COPY.denied.showMore(deniedMore) },
  }
}

const elapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/** The stepper: one row per step with the buttons its state and exit checks allow. */
export function flowVM(f: FlowProgressView): FlowTabVM {
  const C = INSPECTOR_COPY.flow
  return {
    heading: C.heading,
    progress: C.progress(f.done, f.total),
    modeLabel: f.mode === 'free' ? C.free : C.sequential,
    steps: f.steps.map((st): FlowStepRowVM => {
      const open = st.state === 'active' || (f.mode === 'free' && st.state === 'pending')
      const buttons: FlowButtonVM[] = []
      if (open) {
        for (const c of st.checks)
          if (c.kind === 'approval' && c.state === 'waiting-user')
            buttons.push({
              action: 'approve',
              label: C.approve,
              primary: true,
              checkIndex: c.index,
            })
        if (st.checks.some((c) => c.kind === 'report' && c.state !== 'pass'))
          buttons.push({ action: 'mark-done', label: C.markDone, primary: false })
        buttons.push({
          action: 'skip',
          label: C.skip,
          primary: false,
          ...(!st.optional && { confirm: C.confirmSkip(st.name) }),
        })
      } else if (st.state === 'done' || st.state === 'skipped')
        buttons.push({ action: 'reopen', label: C.reopen, primary: false })
      return {
        id: st.stepId,
        index: st.index + 1,
        name: st.name,
        goal: st.goal,
        state: st.state,
        stateLabel: C.state[st.state],
        current: f.current === st.stepId || (f.mode === 'free' && st.state === 'active'),
        optional: st.optional,
        checks: st.checks.map((c) => ({
          index: c.index,
          kind: c.kind,
          kindLabel: C.kind[c.kind],
          label: c.label,
          state: c.state,
          stateLabel: C.check[c.state],
        })),
        buttons,
      }
    }),
  }
}

// ── Minimal mode ─────────────────────────────────────────────────────────────────────────────
export interface HarnessBadgeVM {
  text: string
  /** The active flow step, when the badge shows it. */
  step?: { index: number; total: number; name: string }
  title: string
  coverage: HarnessBadge['coverage']
  verification: Verification
  completion: Completion
  denied: number
}

export function harnessBadgeVM(b: HarnessBadge): HarnessBadgeVM {
  const B = HARNESS_COPY.badge
  // Precedence: the active flow step, then blocked actions, then the verification state.
  const text = b.step
    ? INSPECTOR_COPY.minimal.step(b.step.index, b.step.total, b.step.name)
    : b.denied > 0
      ? INSPECTOR_COPY.minimal.blocked(b.denied)
      : B.label(HARNESS_COPY.completionShort[b.completion])
  return {
    text,
    ...(b.step && { step: b.step }),
    title: [
      b.harnessNames.join(', '),
      B.rules(b.ruleCount),
      COVERAGE_WORD[b.coverage],
      HARNESS_COPY.verification[b.verification],
      ...(b.step ? [INSPECTOR_COPY.minimal.step(b.step.index, b.step.total, b.step.name)] : []),
      ...(b.denied > 0 ? [B.blocked(b.denied)] : []),
    ].join(' · '),
    coverage: b.coverage,
    verification: b.verification,
    completion: b.completion,
    denied: b.denied,
  }
}

// ── Agent Details tabs ───────────────────────────────────────────────────────────────────────
export type PanelTab = 'details' | 'harness'
export interface PanelTabsVM {
  show: boolean
  active: PanelTab
  details: string
  harness: string
  /** Pending asks + pending approvals + actions blocked since the panel opened. */
  badge?: string
}

export interface PanelTabsOpts {
  /** `counts.denied` when the panel opened for this agent; only newer blocks count. */
  baselineDenied?: number
  /** Ask cards waiting for the user. */
  pendingAsks?: number
}

/** The Details | Harness tab strip (the controller shows it only for agents in a project). */
export function panelTabsVM(
  active: PanelTab,
  ins: HarnessInspection | null,
  opts: PanelTabsOpts = {},
): PanelTabsVM {
  const approvals =
    ins?.flow?.steps.reduce(
      (n, st) =>
        n + st.checks.filter((c) => c.kind === 'approval' && c.state === 'waiting-user').length,
      0,
    ) ?? 0
  const blocked = ins ? Math.max(0, ins.counts.denied - (opts.baselineDenied ?? 0)) : 0
  const total = (opts.pendingAsks ?? 0) + approvals + blocked
  return {
    show: true,
    active,
    details: T_TABS.details,
    harness: T_TABS.harness,
    ...(total > 0 && { badge: String(total) }),
  }
}
const T_TABS = HARNESS_COPY.tab

// ── New Session dialog ───────────────────────────────────────────────────────────────────────
export function newSessionHarnessVM(input: {
  projectId?: string
  status: 'loading' | 'ready' | 'failed'
  preview?: HarnessPreview
}): NewSessionHarnessVM {
  const N = HARNESS_COPY.newSession
  const base = {
    heading: N.heading,
    names: [] as string[],
    rulesLine: '',
    coverage: null,
    warning: null,
    inspect: { label: N.inspect },
  }
  if (!input.projectId) return { ...base, visible: false, state: 'none', message: '' }
  if (input.status === 'loading')
    return { ...base, visible: true, state: 'loading', message: N.loading }
  if (input.status === 'failed' || !input.preview)
    return { ...base, visible: true, state: 'failed', message: N.failed }
  const { effective, report } = input.preview
  if (!effective.resolved.length) return { ...base, visible: true, state: 'none', message: N.none }
  const coverage = enforcementReportVM(report)
  const limited = effective.unsupported.length > 0
  const steps = effective.steps ?? []
  const NS = INSPECTOR_COPY.newSession
  return {
    ...base,
    visible: true,
    state: 'ready',
    message: '',
    ...(steps.length && {
      flow: {
        line: NS.flow(effective.resolved.map((h) => h.name).join(' → '), steps.length),
        first: NS.first(steps[0]!.name),
      },
    }),
    names: effective.resolved.map((h) => `${h.name} v${h.version}`),
    rulesLine: N.rules(effective.rules.length),
    coverage,
    warning: !report.launch.ok
      ? { text: N.launchBlocked, reasons: coverage.launch.reasons, blocked: true }
      : limited
        ? {
            text: N.launchWarn,
            reasons: effective.unsupported.map((u) => u.reason),
            blocked: false,
          }
        : null,
  }
}
