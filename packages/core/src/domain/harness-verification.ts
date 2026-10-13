// Validation state of a session's work (docs/harness.md §4). Verified = every required gate of the
// current harness version passed after the session's last write, with no pinned file changed. Pure.
import type { Completion, Verification } from '@agent-office/shared'
import type { GateResult, ValidationGate } from './harness-types.ts'

export const MAX_FEEDBACK = 4000

function latestPerGate(results: GateResult[]): Map<string, GateResult> {
  const out = new Map<string, GateResult>()
  for (const r of results) {
    const prev = out.get(r.gateId)
    if (!prev || r.startedAt >= prev.startedAt) out.set(r.gateId, r)
  }
  return out
}

const FAILED = new Set(['fail', 'timeout', 'error'])

export function verificationState(
  gates: ValidationGate[],
  results: GateResult[],
  o: { lastWriteAt?: number; harnessVersion: string; running?: boolean },
): Verification {
  if (o.running) return 'running'
  if (!results.length) return 'not-run'
  const current = results.filter((r) => r.harnessVersion === o.harnessVersion)
  if (!current.length) return 'stale'
  const latest = latestPerGate(current)
  const required = gates.filter((g) => g.required)
  const checked = required.length ? required : gates
  if (required.some((g) => FAILED.has(latest.get(g.id)?.run.status ?? ''))) return 'failed'
  const fresh = (r: GateResult | undefined) =>
    !!r &&
    r.run.status === 'pass' &&
    !r.run.pinChanged &&
    (o.lastWriteAt ?? -Infinity) < r.startedAt
  const passes = checked.map((g) => latest.get(g.id))
  if (required.length ? passes.every(fresh) : passes.some(fresh)) return 'verified'
  // A pass voided by a later write or a pinned-file change is stale; missing gates are not run.
  return passes.some((r) => r?.run.status === 'pass' && !fresh(r)) ? 'stale' : 'not-run'
}

export function completionState(o: {
  phase: 'live' | 'ended'
  verification: Verification
  userApproved: boolean
}): Completion {
  if (o.userApproved) return 'user-approved'
  switch (o.verification) {
    case 'verified':
      return 'harness-verified'
    case 'failed':
      return 'validation-failed'
    case 'running':
    case 'stale':
      return 'validation-pending'
    default:
      return o.phase === 'ended' ? 'validation-pending' : 'agent-reported'
  }
}

const STATUS_TEXT: Record<string, string> = {
  fail: 'failed',
  timeout: 'timed out',
  error: 'could not run',
}

/** The message fed back to the agent after failed gates (output tails are already redacted). */
export function gateFeedback(results: GateResult[]): string {
  const failed = results.filter((r) => FAILED.has(r.run.status))
  if (!failed.length) return ''
  const head = 'agent-office validation failed. Fix these problems, then finish your turn again:'
  const per = Math.floor((MAX_FEEDBACK - head.length - 40) / failed.length)
  const blocks = failed.map((r) => {
    const title = `## ${r.name} ${STATUS_TEXT[r.run.status]}${r.run.exitCode !== null ? ` (exit ${r.run.exitCode})` : ''}`
    const room = Math.max(0, per - title.length - 2)
    const tail = r.run.outputTail.length > room ? r.run.outputTail.slice(-room) : r.run.outputTail
    return `${title}\n${tail}`.slice(0, per)
  })
  return [head, ...blocks].join('\n\n').slice(0, MAX_FEEDBACK)
}
