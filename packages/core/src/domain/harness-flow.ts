// Flow progress (docs/harness.md §2a): ordered steps with exit checks, followed sequentially (one
// active step) or freely (a checklist). Pure: time and ids are passed in; every function returns a
// new FlowProgress. Agents only ever pass `report` checks (`report`); approvals, gates and
// artifacts come from the user or the trusted runner.
import type { CheckState, FlowMode, FlowProgressView, HarnessEventKind } from '@agent-office/shared'
import { ValidationError } from './errors.ts'
import { checkLabel } from './harness.ts'
import { describePolicy } from './harness-instructions.ts'
import { versionKey } from './harness-resolve.ts'
import { newHarnessEvent } from './harness-events.ts'
import type {
  EffectiveHarness,
  FlowProgress,
  FlowStep,
  HarnessEvent,
  PolicyRule,
} from './harness-types.ts'
import { oneLine } from './text.ts'

export type FlowHarness = Pick<EffectiveHarness, 'steps' | 'flowMode' | 'resolved' | 'gates'>
type StepProgress = FlowProgress['steps'][number]
type By = NonNullable<StepProgress['by']>

export const NO_REPO_ACCESS = '(cannot check: no repository access)'

const modeOf = (e: FlowHarness): FlowMode => e.flowMode ?? 'sequential'
const stepsOf = (e: FlowHarness): FlowStep[] => e.steps ?? []
const finished = (s: StepProgress) => s.state === 'done' || s.state === 'skipped'

/** A step the agent may work on now: the active one (sequential) or any unfinished one (free). */
function available(p: FlowProgress, s: StepProgress): boolean {
  return p.mode === 'free' ? !finished(s) : s.state === 'active'
}

export function startFlow(
  e: FlowHarness,
  o: {
    sessionId: string
    agentId: string
    projectId: string
    now: number
    newId: (prefix: string) => string
  },
): FlowProgress {
  const mode = modeOf(e)
  const steps = stepsOf(e)
  const first = mode === 'sequential' ? (steps[0]?.id ?? null) : null
  return {
    id: o.newId('fpg'),
    sessionId: o.sessionId,
    agentId: o.agentId,
    projectId: o.projectId,
    harnessVersion: versionKey(e),
    mode,
    current: first,
    steps: steps.map((s) => ({
      stepId: s.id,
      state: s.id === first ? 'active' : 'pending',
      checks: s.exit.map((): CheckState => 'pending'),
    })),
    updatedAt: o.now,
  }
}

/** The progress belongs to another harness version than `e` (fresh progress on the next session). */
export function isStale(p: FlowProgress, e: Pick<EffectiveHarness, 'resolved'>): boolean {
  return p.harnessVersion !== versionKey(e)
}

function find(e: FlowHarness, p: FlowProgress, stepId: string) {
  const i = p.steps.findIndex((s) => s.stepId === stepId)
  const def = stepsOf(e).find((s) => s.id === stepId)
  if (i < 0 || !def) throw new ValidationError('unknown step')
  return { i, def, sp: p.steps[i]! }
}

function withStep(p: FlowProgress, i: number, next: StepProgress, now: number): FlowProgress {
  const steps = p.steps.slice()
  steps[i] = next
  return { ...p, steps, updatedAt: now }
}

function requireAvailable(p: FlowProgress, sp: StepProgress): void {
  if (!available(p, sp))
    throw new ValidationError(
      p.mode === 'free' ? 'this step is finished' : 'this step is not active',
    )
}

/** Sets one check's state (no advance). Unknown steps or indexes are ignored. */
export function applyCheck(
  p: FlowProgress,
  stepId: string,
  checkIndex: number,
  state: CheckState,
  now: number,
): FlowProgress {
  const i = p.steps.findIndex((s) => s.stepId === stepId)
  const sp = p.steps[i]
  if (!sp || checkIndex < 0 || checkIndex >= sp.checks.length || sp.checks[checkIndex] === state)
    return p
  const checks = sp.checks.slice()
  checks[checkIndex] = state
  return withStep(p, i, { ...sp, checks }, now)
}

/**
 * Finishes every available step whose checks all pass (`by` names who made the last move), then in
 * sequential mode starts the next unfinished step.
 */
export function advance(
  p: FlowProgress,
  mode: FlowMode,
  now: number,
  by: By = 'checks',
): FlowProgress {
  let changed = false
  const steps = p.steps.map((s) => {
    if (!available(p, s) || !s.checks.every((c) => c === 'pass')) return s
    changed = true
    return { ...s, state: 'done' as const, doneAt: now, by }
  })
  let current = p.current
  if (mode === 'sequential') {
    const cur = steps.findIndex((s) => s.stepId === current)
    if (cur < 0 || finished(steps[cur]!)) {
      const after = steps.findIndex((s, i) => i > cur && s.state === 'pending')
      const next = after >= 0 ? after : steps.findIndex((s) => s.state === 'pending')
      current = next >= 0 ? steps[next]!.stepId : null
      if (next >= 0) steps[next] = { ...steps[next]!, state: 'active' }
      changed = changed || current !== p.current
    }
  } else current = null
  return changed ? { ...p, steps, current, updatedAt: now } : p
}

/** The agent reports a step done: passes its `report` checks only (never approval/gate/artifact). */
export function report(e: FlowHarness, p: FlowProgress, stepId: string, now: number): FlowProgress {
  const { i, def, sp } = find(e, p, stepId)
  requireAvailable(p, sp)
  if (!def.exit.some((c) => c.kind === 'report'))
    throw new ValidationError('this step is not finished by a report')
  const checks = sp.checks.map((c, k) => (def.exit[k]!.kind === 'report' ? 'pass' : c))
  return advance(withStep(p, i, { ...sp, checks }, now), p.mode, now, 'agent')
}

/** The user (or the agent, via `report`) marks a step done: other checks must already pass. */
export function markDone(
  e: FlowHarness,
  p: FlowProgress,
  stepId: string,
  by: 'agent' | 'user',
  now: number,
): FlowProgress {
  const { i, def, sp } = find(e, p, stepId)
  requireAvailable(p, sp)
  const open = def.exit.find((c, k) => c.kind !== 'report' && sp.checks[k] !== 'pass')
  if (open) throw new ValidationError(`this step still needs its ${open.kind} check`)
  const checks = sp.checks.map(() => 'pass' as const)
  return advance(withStep(p, i, { ...sp, checks }, now), p.mode, now, by)
}

/** The user approves one `approval` check of an available step. */
export function approve(
  e: FlowHarness,
  p: FlowProgress,
  stepId: string,
  checkIndex: number,
  now: number,
): FlowProgress {
  const { def, sp } = find(e, p, stepId)
  requireAvailable(p, sp)
  if (def.exit[checkIndex]?.kind !== 'approval')
    throw new ValidationError('this check is not an approval')
  return advance(applyCheck(p, stepId, checkIndex, 'pass', now), p.mode, now, 'user')
}

/** Skips an unfinished step; a required one needs `confirmed`. */
export function skip(
  e: FlowHarness,
  p: FlowProgress,
  stepId: string,
  o: { confirmed: boolean },
  now: number,
): FlowProgress {
  const { i, def, sp } = find(e, p, stepId)
  if (finished(sp)) throw new ValidationError('this step is already finished')
  if (!def.optional && !o.confirmed) throw new ValidationError('confirm skipping a required step')
  const next = withStep(p, i, { ...sp, state: 'skipped', doneAt: now, by: 'user' }, now)
  return advance(next, p.mode, now)
}

/** Re-opens a finished step with fresh checks; in sequential mode it becomes the active step. */
export function reopen(e: FlowHarness, p: FlowProgress, stepId: string, now: number): FlowProgress {
  const { i, def, sp } = find(e, p, stepId)
  if (!finished(sp)) throw new ValidationError('this step is not finished')
  const fresh: StepProgress = {
    stepId,
    state: p.mode === 'sequential' ? 'active' : 'pending',
    checks: def.exit.map((): CheckState => 'pending'),
  }
  const steps = p.steps.map((s, k) =>
    k === i
      ? fresh
      : p.mode === 'sequential' && s.state === 'active'
        ? { ...s, state: 'pending' as const }
        : s,
  )
  return { ...p, steps, current: p.mode === 'sequential' ? stepId : null, updatedAt: now }
}

/** A write after a gate pass voids the pass on unfinished steps. */
export function voidGateChecks(e: FlowHarness, p: FlowProgress, now: number): FlowProgress {
  let out = p
  for (const sp of p.steps) {
    if (finished(sp)) continue
    const def = stepsOf(e).find((s) => s.id === sp.stepId)
    def?.exit.forEach((c, k) => {
      if (c.kind === 'gate' && sp.checks[k] === 'pass')
        out = applyCheck(out, sp.stepId, k, 'pending', now)
    })
  }
  return out
}

/** Every `gate` check naming `gateId`. */
export function gateChecksFor(
  e: FlowHarness,
  gateId: string,
): { stepId: string; checkIndex: number }[] {
  const out: { stepId: string; checkIndex: number }[] = []
  for (const s of stepsOf(e))
    s.exit.forEach((c, k) => {
      if (c.kind === 'gate' && c.gateId === gateId) out.push({ stepId: s.id, checkIndex: k })
    })
  return out
}

/** Unpassed `artifact` checks of available steps (what the trusted runner should stat). */
export function artifactChecks(
  e: FlowHarness,
  p: FlowProgress,
): { stepId: string; checkIndex: number; path: string; mustExist: boolean }[] {
  const out: { stepId: string; checkIndex: number; path: string; mustExist: boolean }[] = []
  for (const sp of p.steps) {
    if (!available(p, sp)) continue
    const def = stepsOf(e).find((s) => s.id === sp.stepId)
    def?.exit.forEach((c, k) => {
      if (c.kind === 'artifact' && sp.checks[k] !== 'pass')
        out.push({
          stepId: sp.stepId,
          checkIndex: k,
          path: c.path,
          mustExist: c.mustExist !== false,
        })
    })
  }
  return out
}

/** The current step's restrictions as policy rules (sequential only; free mode has none). */
export function stepPolicies(e: FlowHarness, p: FlowProgress): PolicyRule[] {
  if (p.mode !== 'sequential' || !p.current) return []
  return policiesOfStep(e, p.current)
}

/** One step's restrictions as policy rules (id = step id). */
export function policiesOfStep(e: Pick<FlowHarness, 'steps'>, stepId: string): PolicyRule[] {
  const def = (e.steps ?? []).find((s) => s.id === stepId)
  return (def?.policies ?? []).map((pol) => ({
    ...pol,
    id: def!.id,
    reason: oneLine(`During the “${oneLine(def!.name, 60)}” step — ${describePolicy(pol)}`, 200),
    severity: 'required' as const,
  }))
}

export function toFlowView(
  e: FlowHarness,
  p: FlowProgress,
  o: { repoAccess?: boolean } = {},
): FlowProgressView {
  const defs = new Map(stepsOf(e).map((s) => [s.id, s]))
  const steps = p.steps.flatMap((sp, index) => {
    const def = defs.get(sp.stepId)
    if (!def) return []
    const open = available(p, sp)
    return [
      {
        stepId: sp.stepId,
        index,
        name: def.name,
        goal: def.goal,
        state: sp.state,
        optional: def.optional,
        checks: def.exit.map((c, k) => {
          const state = sp.checks[k] ?? 'pending'
          const label = checkLabel(c, e.gates)
          return {
            index: k,
            kind: c.kind,
            label:
              c.kind === 'artifact' && !o.repoAccess && state !== 'pass'
                ? `${label} ${NO_REPO_ACCESS}`
                : label,
            state: c.kind === 'approval' && open && state === 'pending' ? 'waiting-user' : state,
          } as const
        }),
        ...(sp.doneAt !== undefined ? { doneAt: sp.doneAt } : {}),
        ...(sp.by ? { by: sp.by } : {}),
      },
    ]
  })
  return {
    harnessVersion: p.harnessVersion,
    mode: p.mode,
    current: p.current,
    steps,
    done: steps.filter((s) => s.state === 'done' || s.state === 'skipped').length,
    total: steps.length,
  }
}

/** The active step for badges ("Step 3/5 · Review"): 1-based index; none in free mode. */
export function currentStepBadge(
  e: FlowHarness,
  p: FlowProgress,
): { index: number; total: number; name: string } | undefined {
  if (p.mode !== 'sequential' || !p.current) return undefined
  const i = p.steps.findIndex((s) => s.stepId === p.current)
  const def = stepsOf(e).find((s) => s.id === p.current)
  return i >= 0 && def ? { index: i + 1, total: p.steps.length, name: def.name } : undefined
}

/** Approval checks waiting on the user. */
export function pendingApprovals(
  e: FlowHarness,
  p: FlowProgress,
): { stepId: string; stepName: string; checkIndex: number; prompt: string }[] {
  const out: { stepId: string; stepName: string; checkIndex: number; prompt: string }[] = []
  for (const sp of p.steps) {
    if (!available(p, sp)) continue
    const def = stepsOf(e).find((s) => s.id === sp.stepId)
    def?.exit.forEach((c, k) => {
      if (c.kind === 'approval' && sp.checks[k] !== 'pass')
        out.push({ stepId: sp.stepId, stepName: def.name, checkIndex: k, prompt: c.prompt })
    })
  }
  return out
}

/** What changed between two progress values (for events and messages). */
export function transitions(
  before: FlowProgress,
  after: FlowProgress,
): { started: string[]; done: { stepId: string; by: By }[]; skipped: string[] } {
  const prev = new Map(before.steps.map((s) => [s.stepId, s.state]))
  const out = {
    started: [] as string[],
    done: [] as { stepId: string; by: By }[],
    skipped: [] as string[],
  }
  for (const s of after.steps) {
    const was = prev.get(s.stepId)
    if (was === s.state) continue
    if (s.state === 'active') out.started.push(s.stepId)
    else if (s.state === 'done') out.done.push({ stepId: s.stepId, by: s.by ?? 'checks' })
    else if (s.state === 'skipped') out.skipped.push(s.stepId)
  }
  return out
}

/** A flow event: the step's name (owner-approved data) as the summary; never agent text. */
export function flowEvent(o: {
  id: string
  projectId: string
  sessionId: string
  agentId: string
  ts: number
  kind: Extract<
    HarnessEventKind,
    'step-started' | 'step-done' | 'step-skipped' | 'approval-granted'
  >
  stepName: string
}): HarnessEvent {
  const e = newHarnessEvent({
    id: o.id,
    projectId: o.projectId,
    sessionId: o.sessionId,
    agentId: o.agentId,
    ts: o.ts,
    kind: o.kind,
    ruleIds: [],
  })
  return { ...e, detail: { ...e.detail, summary: oneLine(o.stepName, 120) } }
}
