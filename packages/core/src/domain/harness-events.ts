// Harness audit events (docs/harness.md §1, §6): tool name and a ≤ 120-char redacted summary built
// like permission cards. Raw tool input never enters an event. Pure.
import type { HarnessEventKind, HarnessEventView } from '@agent-office/shared'
import type { HarnessEvent } from './harness-types.ts'
import { summarizeToolRequest } from './session-prompt.ts'
import { oneLine } from './text.ts'

const R = '[redacted]'
const PATTERNS: [RegExp, string][] = [
  [/\b(bearer|basic|token)\s+[^\s"']+/gi, `$1 ${R}`],
  [/:\/\/[^@\s/]+@/g, `://${R}@`],
  [/(\s-u\s+)[^\s:]+:\S+/g, `$1${R}`],
  [/(--?[a-z-]*(?:password|passwd|token|secret|key|auth)[a-z-]*(?:=|\s+))\S+/gi, `$1${R}`],
  [/\b([A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|AUTH|COOKIE)[A-Za-z_]*=)\S+/gi, `$1${R}`],
  [
    /\b(authorization|cookie|api[-_]?key|password|passwd|secret|token)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"']+)/gi,
    `$1$2${R}`,
  ],
  [/\b[A-Za-z0-9_\-+/=]{32,}\b/g, R],
]

/** Best-effort removal of credentials from a one-line summary. */
export function redactSummary(s: string): string {
  let out = s
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep)
  return out
}

export function newHarnessEvent(o: {
  id: string
  projectId: string
  sessionId: string
  agentId: string
  ts: number
  kind: HarnessEventKind
  ruleIds: string[]
  tool?: string
  /** Read only to build the summary; never stored. */
  input?: unknown
  cwd?: string
  gateId?: string
  exitCode?: number | null
  durationMs?: number
  agentRole?: string
  harnessVersions?: string[]
}): HarnessEvent {
  const detail: HarnessEvent['detail'] = {}
  if (o.tool !== undefined) {
    detail.tool = oneLine(o.tool, 100)
    // A question's text is shown live only (docs/harness.md §8): the audit keeps a fixed label.
    const { summary } =
      o.tool === 'AskUserQuestion'
        ? { summary: 'Asked you a question' }
        : summarizeToolRequest(o.tool, o.input, o.cwd ?? '')
    detail.summary = oneLine(redactSummary(summary), 120)
  }
  if (o.gateId !== undefined) detail.gateId = o.gateId
  if (o.exitCode !== undefined) detail.exitCode = o.exitCode
  if (o.durationMs !== undefined) detail.durationMs = o.durationMs
  if (o.agentRole !== undefined) detail.agentRole = oneLine(o.agentRole, 60)
  if (o.harnessVersions) detail.harnessVersions = [...o.harnessVersions]
  return {
    id: o.id,
    projectId: o.projectId,
    sessionId: o.sessionId,
    agentId: o.agentId,
    ts: o.ts,
    kind: o.kind,
    ruleIds: [...o.ruleIds],
    detail,
  }
}

export function toEventView(e: HarnessEvent): HarnessEventView {
  return {
    id: e.id,
    ts: e.ts,
    kind: e.kind,
    ruleIds: [...e.ruleIds],
    ...(e.detail.tool !== undefined ? { tool: e.detail.tool } : {}),
    ...(e.detail.summary !== undefined ? { summary: e.detail.summary } : {}),
    ...(e.detail.gateId !== undefined ? { gateId: e.detail.gateId } : {}),
    ...(e.detail.agentRole !== undefined ? { agentRole: e.detail.agentRole } : {}),
  }
}
