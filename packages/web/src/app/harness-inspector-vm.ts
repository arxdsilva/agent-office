// The Harness tab of Agent Details (the Compliance Inspector) and the Minimal-mode badge, as pure
// data (docs/harness.md). Coverage uses the fixed words; nothing here ever says "guaranteed".
import type {
  Completion,
  HarnessPreview,
  GateResultView,
  HarnessBadge,
  HarnessInspection,
  Verification,
} from '@agent-office/shared'
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
export interface HarnessTabVM {
  state: 'loading' | 'none' | 'ready'
  message: string
  applied: string[]
  coverage: EnforcementReportVM | null
  countsLine: string
  gates: GateRowTabVM[]
  gatesEmpty: string
  run: { action: 'run-gates' | 'cancel-gates'; label: string; enabled: boolean; hint?: string }
  completion: { text: string; tone: Tone }
  verification: { text: string; tone: Tone }
  denied: DeniedRowVM[]
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
  }
}

const LABELS = {
  applied: T.applied,
  coverage: T.coverage,
  activity: T.activity,
  gates: T.gates,
  denied: T.denied,
  open: T.open,
}

const EMPTY: Omit<HarnessTabVM, 'state' | 'message'> = {
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

export function harnessTabVM(ins: HarnessInspection | null): HarnessTabVM {
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
      tail: r && r.status !== 'pass' && r.status !== 'running' ? r.outputTail : '',
    }
  })
  const denied = ins.events
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
  const noGates = eff.gates.length === 0
  return {
    state: 'ready',
    message: '',
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
    labels: LABELS,
  }
}

// ── Minimal mode ─────────────────────────────────────────────────────────────────────────────
export interface HarnessBadgeVM {
  text: string
  title: string
  coverage: HarnessBadge['coverage']
  verification: Verification
  completion: Completion
  denied: number
}

export function harnessBadgeVM(b: HarnessBadge): HarnessBadgeVM {
  const B = HARNESS_COPY.badge
  return {
    text: B.label(HARNESS_COPY.completionShort[b.completion]),
    title: [
      b.harnessNames.join(', '),
      B.rules(b.ruleCount),
      COVERAGE_WORD[b.coverage],
      HARNESS_COPY.verification[b.verification],
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
  /** Blocked actions, once the inspection is known. */
  badge?: string
}

/** The Details | Harness tab strip (the controller shows it only for agents in a project). */
export function panelTabsVM(active: PanelTab, ins: HarnessInspection | null): PanelTabsVM {
  return {
    show: true,
    active,
    details: T_TABS.details,
    harness: T_TABS.harness,
    ...(ins && ins.counts.denied > 0 && { badge: String(ins.counts.denied) }),
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
  return {
    ...base,
    visible: true,
    state: 'ready',
    message: '',
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
