// One agent session as the vault remembers it (docs/projects.md §1). Pure.
import type { SessionSummary } from '@agent-office/shared'
import { ValidationError } from './errors.ts'
import type { MatchRule, Suggestion } from './repo-identity.ts'
import type { RepoIdentityInfo } from '../ports/driven.ts'

export type SessionOrigin = 'managed' | 'observed' | 'imported'
export type SessionState = 'active' | 'inactive' | 'archived'
export type AssignedBy = 'none' | 'auto' | 'user'

export interface AssignmentEntry {
  projectId: string | null
  by: AssignedBy
  rule?: MatchRule | 'managed' | 'handoff'
  at: number
}

export interface SessionRecord {
  id: string
  agentId: string
  provider: string
  origin: SessionOrigin
  projectId: string | null
  assignment: AssignmentEntry & { history: AssignmentEntry[] }
  suggestions: Suggestion[]
  title: string
  startedAt: number
  lastSeenAt: number
  endedAt?: number
  state: SessionState
  summary?: { text: string; source: 'last-replies' | 'user' | 'provider'; provider?: string }
  /** Opaque `tr_` ref registered by the source (main only). */
  transcriptRef?: string
  /** The repository identity where it works (keys only, no paths; main only). */
  identity?: RepoIdentityInfo
  /** The `wk_` key an observe hook sent (main only). */
  workspaceKey?: string
  /** Where it works (absolute; main only, never in a view): the folder a native resume starts in. */
  cwd?: string
  /** The matched repo link, when auto-assigned by identity. */
  repoId?: string
  /** Tool names seen (≤ 20). */
  tools: string[]
  continuedFrom?: { handoffId: string; sessionId: string; provider: string }
  /** The user removed its auto-imported memory then; not imported again until it ends again. */
  knowledgeRemovedAt?: number
}

export function newSessionRecord(o: {
  id: string
  agentId: string
  provider: string
  origin: SessionOrigin
  title: string
  now: number
}): SessionRecord {
  return {
    id: o.id,
    agentId: o.agentId,
    provider: o.provider,
    origin: o.origin,
    projectId: null,
    assignment: { projectId: null, by: 'none', at: o.now, history: [] },
    suggestions: [],
    title: o.title.slice(0, 120),
    startedAt: o.now,
    lastSeenAt: o.now,
    state: 'active',
    tools: [],
  }
}

/** Reassignment keeps the previous assignment (provenance) in `history`. */
export function assignSession(
  r: SessionRecord,
  projectId: string | null,
  by: AssignedBy,
  rule: AssignmentEntry['rule'] | undefined,
  at: number,
): SessionRecord {
  const { history, ...prev } = r.assignment
  return {
    ...r,
    projectId,
    suggestions: [],
    assignment: {
      projectId,
      by,
      ...(rule ? { rule } : {}),
      at,
      history: [...history, prev].slice(-20),
    },
  }
}

export function endSession(r: SessionRecord, now: number): SessionRecord {
  if (r.state !== 'active') return r
  return { ...r, state: 'inactive', endedAt: now, lastSeenAt: Math.max(r.lastSeenAt, now) }
}

export function reactivateSession(r: SessionRecord, now: number): SessionRecord {
  if (r.state === 'active') return r
  const { endedAt: _e, ...rest } = r
  return { ...rest, state: 'active', lastSeenAt: Math.max(r.lastSeenAt, now) }
}

export function archiveSession(r: SessionRecord, now: number): SessionRecord {
  if (r.state === 'active') throw new ValidationError('end the session before archiving it')
  return { ...r, state: 'archived', lastSeenAt: Math.max(r.lastSeenAt, now) }
}

const CLAUDE_ID = /^[A-Za-z0-9_-]{1,100}$/

/** Claude Code's own session id: agent ids are `cc:<id>`. Main only; never put it in a view. */
export function providerSessionIdOf(r: SessionRecord): string | undefined {
  if (r.provider !== 'claude-code' || !r.agentId.startsWith('cc:')) return undefined
  const id = r.agentId.slice(3)
  return CLAUDE_ID.test(id) ? id : undefined
}

/** Experimental native resume: Claude only, a known session id and folder, and not running now. */
export function canResume(r: SessionRecord): boolean {
  return r.state !== 'active' && !!r.cwd && !!providerSessionIdOf(r)
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)

/** Deterministic: title + the last three agent replies (truncated) + tools used + duration. */
export function deterministicSummary(r: SessionRecord, agentReplies: string[]): string {
  const end = r.endedAt ?? r.lastSeenAt
  const minutes = Math.max(0, Math.round((end - r.startedAt) / 60_000))
  const lines = [r.title]
  for (const t of agentReplies.slice(-3))
    lines.push(`• ${clip(t.replace(/\s+/g, ' ').trim(), 500)}`)
  if (r.tools.length) lines.push(`Tools: ${r.tools.join(', ')}`)
  lines.push(`Duration: ${minutes} min`)
  return clip(lines.join('\n'), 2000)
}

/** A summary worth importing: user/provider text, or last-replies text with at least one reply. */
export function hasAgentReplies(summary: SessionRecord['summary']): boolean {
  if (!summary) return false
  return summary.source !== 'last-replies' || /^• /m.test(summary.text)
}

export function toSessionSummary(
  r: SessionRecord,
  projectName: (id: string) => string | undefined,
  knowledgeOf?: (sessionId: string) => string | undefined,
): SessionSummary {
  const knowledge = knowledgeOf?.(r.id)
  const suggestions = r.suggestions.flatMap((s) => {
    const name = projectName(s.projectId)
    return name ? [{ projectId: s.projectId, name, rule: s.rule, confidence: s.confidence }] : []
  })
  return {
    id: r.id,
    ...(r.state === 'active' ? { agentId: r.agentId } : {}),
    provider: r.provider,
    origin: r.origin,
    projectId: r.projectId,
    title: r.title,
    state: r.state,
    startedAt: r.startedAt,
    lastSeenAt: r.lastSeenAt,
    ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
    ...(r.summary ? { summary: { ...r.summary } } : {}),
    ...(r.projectId === null ? { suggestions } : {}),
    ...(r.assignment.by !== 'none' && r.projectId ? { assignedBy: r.assignment.by } : {}),
    ...(r.continuedFrom ? { continuedFrom: { ...r.continuedFrom } } : {}),
    hasTranscript: !!r.transcriptRef,
    ...(canResume(r) ? { canResume: true } : {}),
    ...(knowledge ? { knowledgeMemoryId: knowledge } : {}),
  }
}
