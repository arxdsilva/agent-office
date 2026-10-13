// What a runtime really enforces of an effective harness (docs/harness.md §3). Computed only from
// the adapter's EnforcementDecl and the session mode; never inferred, never rounded up. Pure.
import type {
  ActionRule,
  Coverage,
  EnforcementCapability,
  EnforcementReportView,
} from '@agent-office/shared'
import type {
  EffectiveHarness,
  EnforcementDecl,
  EnforcementReport,
  EnforcementRow,
  HarnessRule,
} from './harness-types.ts'
import { oneLine } from './text.ts'

/** Fixed wording (≤ 160 chars each), shown in the inspector and the New Session dialog. */
export const COVERAGE_REASONS = {
  instructionsNative: 'Delivered in the system prompt or developer instructions',
  instructionsFirst: 'Prepended to the first message; the agent may lose it in a long session',
  instructionsNone: 'This runtime does not receive harness instructions',
  hook: 'A hook blocks the call before it runs',
  approval: 'Only calls the runtime asks approval for are checked',
  partialPath: 'Checked where the runtime reports the path; some writes may not be seen',
  commandHeuristic:
    'Commands are matched by a parser, not a sandbox; unusual shell syntax asks first',
  none: 'This runtime offers no interception point for it',
  mode: 'The session mode skips approvals, so nothing can be intercepted',
  modeRefused: 'The selected mode skips approvals; this strict harness needs interception',
  sandbox: 'An OS sandbox confines file writes',
  sandboxPartial: 'The runtime sandbox floor confines some writes',
  notRequested: 'Not requested by the harness',
  subInherited: 'Subagent calls reach the same policy',
  subOpaque: 'Subagents run without the policy seeing their calls',
  subNone: 'This runtime has no subagents',
  instructionOnly: 'Applied as an instruction; the agent is asked to follow it',
  gate: 'Checked after the turn by validation gates',
  sandboxPath: 'File effects are confined by the OS sandbox',
} as const

const NONE: EnforcementDecl = {
  instructions: 'none',
  toolDeny: 'none',
  pathDeny: 'none',
  commandDeny: 'none',
  fsIsolation: 'none',
  subagents: 'none',
}

const RANK: Record<Coverage, number> = {
  enforced: 3,
  partial: 2,
  'instruction-only': 1,
  unsupported: 0,
}

export function weakest(levels: Coverage[]): Coverage {
  return levels.reduce<Coverage>((a, b) => (RANK[b] < RANK[a] ? b : a), 'enforced')
}

const row = (
  capability: EnforcementCapability,
  level: Coverage,
  reason: string,
): EnforcementRow => ({
  capability,
  level,
  reason,
})

function rowsFor(e: EffectiveHarness, d: EnforcementDecl, blind: boolean): EnforcementRow[] {
  const R = COVERAGE_REASONS
  const deny = (cap: EnforcementCapability, v: string): EnforcementRow => {
    if (v === 'none') return row(cap, 'unsupported', R.none)
    if (blind) return row(cap, 'unsupported', R.mode)
    if (cap === 'command-deny') return row(cap, 'partial', R.commandHeuristic)
    if (v === 'hook') return row(cap, 'enforced', R.hook)
    if (v === 'approval') return row(cap, 'partial', R.approval)
    return row(cap, 'partial', R.partialPath)
  }
  const requested = e.fsIsolation !== 'off'
  return [
    d.instructions === 'native'
      ? row('instructions', 'enforced', R.instructionsNative)
      : d.instructions === 'first-message'
        ? row('instructions', 'instruction-only', R.instructionsFirst)
        : row('instructions', 'unsupported', R.instructionsNone),
    deny('tool-deny', d.toolDeny),
    deny('path-deny', d.pathDeny),
    deny('command-deny', d.commandDeny),
    !requested
      ? row('fs-isolation', 'unsupported', R.notRequested)
      : d.fsIsolation === 'sandbox'
        ? row('fs-isolation', 'enforced', R.sandbox)
        : d.fsIsolation === 'partial'
          ? row('fs-isolation', 'partial', R.sandboxPartial)
          : row('fs-isolation', 'unsupported', R.none),
    d.subagents === 'inherited'
      ? blind
        ? row('subagents', 'unsupported', R.mode)
        : row('subagents', 'enforced', R.subInherited)
      : d.subagents === 'opaque'
        ? row('subagents', 'unsupported', R.subOpaque)
        : row('subagents', 'enforced', R.subNone),
  ]
}

function capabilityOf(p: ActionRule): EnforcementCapability {
  if (p.commands?.length) return 'command-deny'
  if (p.paths?.length) return 'path-deny'
  return 'tool-deny'
}

function ruleCoverage(
  r: HarnessRule,
  rows: Map<EnforcementCapability, EnforcementRow>,
  d: EnforcementDecl,
  sandboxed: boolean,
): { coverage: Coverage; reason: string } {
  if (r.enforcement === 'instruction')
    return d.instructions === 'none'
      ? { coverage: 'unsupported', reason: COVERAGE_REASONS.instructionsNone }
      : { coverage: 'instruction-only', reason: COVERAGE_REASONS.instructionOnly }
  if (r.enforcement === 'validation-gate' || !r.policy)
    return { coverage: 'partial', reason: COVERAGE_REASONS.gate }
  const cap = capabilityOf(r.policy)
  let out: { coverage: Coverage; reason: string } = {
    coverage: rows.get(cap)!.level,
    reason: rows.get(cap)!.reason,
  }
  if (
    cap === 'command-deny' &&
    sandboxed &&
    r.policy.paths?.length &&
    out.coverage !== 'unsupported'
  )
    out = { coverage: 'enforced', reason: COVERAGE_REASONS.sandboxPath }
  if (r.policy.roles?.some((x) => x !== 'main')) {
    const sub = rows.get('subagents')!
    if (RANK[sub.level] < RANK[out.coverage]) out = { coverage: sub.level, reason: sub.reason }
  }
  return out
}

export function coverageFor(
  e: EffectiveHarness,
  decl: EnforcementDecl | undefined,
  mode: { mode: string; modeId?: string },
): EnforcementReport {
  const d = decl ?? NONE
  const blind = !!d.nonInterceptingModes?.some((m) => m === mode.mode || m === mode.modeId)
  const rows = rowsFor(e, d, blind)
  const byCap = new Map(rows.map((x) => [x.capability, x]))
  const sandboxed = d.fsIsolation === 'sandbox' && e.fsIsolation !== 'off'
  const perRule: EnforcementReport['perRule'] = {}
  for (const r of e.rules) perRule[r.id] = ruleCoverage(r, byCap, d, sandboxed)

  const reasons: string[] = []
  if (e.launchPolicy === 'strict') {
    if (blind) reasons.push(COVERAGE_REASONS.modeRefused)
    for (const r of e.rules)
      if (r.severity === 'required' && perRule[r.id]!.coverage === 'unsupported')
        reasons.push(oneLine(`“${oneLine(r.name, 50)}”: ${perRule[r.id]!.reason}`, 160))
  }
  return {
    provider: e.provider,
    rows,
    perRule,
    launch: reasons.length ? { ok: false, reasons } : { ok: true },
  }
}

export function toReportView(r: EnforcementReport): EnforcementReportView {
  return {
    provider: r.provider,
    rows: r.rows.map((x) => ({ ...x })),
    launch: r.launch.ok ? { ok: true } : { ok: false, reasons: [...r.launch.reasons] },
  }
}
