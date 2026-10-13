// Session records: listing, assignment (with history), where sessions work (SessionObservation),
// and their messages (docs/projects.md §1, §3, §4). The vault, not the live state, is the truth.
import type { SessionMessageView, SessionSummary } from '@agent-office/shared'
import type { AgentState } from '../domain/agent.ts'
import { assertAuthorized, USER, type Principal } from '../domain/authz.ts'
import { NotFoundError } from '../domain/errors.ts'
import { matchProject, type MatchResult, type Suggestion } from '../domain/repo-identity.ts'
import {
  archiveSession,
  assignSession,
  deterministicSummary,
  endSession,
  newSessionRecord,
  reactivateSession,
  toSessionSummary,
  type AssignedBy,
  type AssignmentEntry,
  type SessionOrigin,
  type SessionRecord,
} from '../domain/session-record.ts'
import type {
  AgentRepository,
  Clock,
  EventPublisher,
  Logger,
  RepoIdentity,
  TranscriptReader,
} from '../ports/driven.ts'
import type { SessionAssignment, SessionObservation, SessionVault } from '../ports/driving.ts'
import type { ActivityLog } from './activity-log.ts'
import { requireProject } from './project-views.ts'
import type { ProjectsStore } from './projects-store.ts'

export interface SessionVaultDeps {
  store: ProjectsStore
  activity: ActivityLog
  agents: AgentRepository
  bus: EventPublisher
  clock: Clock
  log: Logger
  repoIdentity?: RepoIdentity
  transcripts?: TranscriptReader
  /** A session ended (its final summary is written): automatic knowledge import. */
  onEnded?: (r: SessionRecord) => void
  /** A session was (re)assigned: automatic knowledge import re-homes its item. */
  onAssigned?: (r: SessionRecord) => void
}

/** Transcript messages read when a session ended without agent-office chat replies. */
const END_TRANSCRIPT_PAGE = 40

type Where = { cwd?: string; workspaceKey?: string; transcriptRef?: string }

export class SessionVaultService implements SessionVault, SessionAssignment, SessionObservation {
  /** `wk_` key → linked repos with that git common dir. */
  private workspaceKeys = new Map<string, { projectId: string; repoId: string }[]>()

  constructor(private d: SessionVaultDeps) {}

  // ── SessionVault ──

  list(o: { scope?: string; query?: string }, as: Principal = USER): SessionSummary[] {
    assertAuthorized(as, 'session.read', { kind: 'session', projectId: null }, undefined)
    const q = o.query?.trim().toLowerCase()
    return [...this.d.store.sessions.values()]
      .filter(
        (r) =>
          o.scope === undefined ||
          (o.scope === 'unassigned' ? r.projectId === null : r.projectId === o.scope),
      )
      .filter(
        (r) =>
          !q || r.title.toLowerCase().includes(q) || !!r.summary?.text.toLowerCase().includes(q),
      )
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, 500)
      .map((r) => this.view(r))
  }

  get(sessionId: string, as: Principal = USER): SessionSummary {
    const r = this.require(sessionId)
    assertAuthorized(as, 'session.read', { kind: 'session', projectId: r.projectId }, undefined)
    return this.view(r)
  }

  async messages(
    o: { sessionId: string; before?: string; limit: number },
    as: Principal = USER,
  ): Promise<{ messages: SessionMessageView[]; more: boolean }> {
    const r = this.require(o.sessionId)
    const res = { kind: 'session' as const, projectId: r.projectId }
    const project = r.projectId ? this.d.store.projects.get(r.projectId) : undefined
    assertAuthorized(as, 'chat.read', res, project)
    const limit = Math.max(1, Math.min(200, o.limit))
    if (r.transcriptRef && this.d.transcripts) {
      assertAuthorized(as, 'transcript.read', res, project)
      try {
        const page = await this.d.transcripts.page(r.transcriptRef, {
          ...(o.before ? { before: o.before } : {}),
          limit,
        })
        if (page.messages.length || o.before)
          return {
            more: page.more,
            messages: page.messages.map((m) => ({
              id: m.uuid,
              role: m.role === 'assistant' ? 'agent' : 'user',
              text: m.text.slice(0, 4000),
              ts: m.ts,
              ...(m.tools.length ? { tools: [...m.tools] } : {}),
              source: 'transcript',
            })),
          }
      } catch {
        this.d.log.warn('transcript unreadable; showing agent-office chat')
      }
    }
    const chat = this.d.store.chatOf(r.id).sort((a, b) => a.ts - b.ts)
    const at = o.before ? chat.findIndex((m) => m.id === o.before) : chat.length
    const end = at < 0 ? chat.length : at
    const start = Math.max(0, end - limit)
    return {
      more: start > 0,
      messages: chat.slice(start, end).map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        ts: m.ts,
        ...(m.tools?.length ? { tools: [...m.tools] } : {}),
        source: 'chat',
      })),
    }
  }

  async archive(sessionId: string, as: Principal = USER): Promise<SessionSummary> {
    const r = this.require(sessionId)
    assertAuthorized(as, 'session.assign', { kind: 'session', projectId: r.projectId }, undefined)
    const next = archiveSession(r, this.d.clock.now())
    await this.d.store.putSession(next)
    return this.view(next)
  }

  // ── SessionAssignment ──

  async assign(
    sessionId: string,
    projectId: string | null,
    as: Principal = USER,
  ): Promise<SessionSummary> {
    const r = this.require(sessionId)
    const p = projectId ? requireProject(this.d.store, projectId) : undefined
    assertAuthorized(as, 'session.assign', { kind: 'session', projectId }, p)
    return this.view(await this.applyAssignment(r, projectId, 'user', undefined))
  }

  // ── SessionObservation ──

  async located(agentId: string, provider: string, where: Where): Promise<void> {
    try {
      let r = this.ensure(agentId, provider)
      if (where.transcriptRef && /^tr_[A-Za-z0-9_-]{1,100}$/.test(where.transcriptRef))
        r = { ...r, transcriptRef: where.transcriptRef }
      if (where.workspaceKey && /^wk_[a-f0-9]{32}$/.test(where.workspaceKey))
        r = { ...r, workspaceKey: where.workspaceKey }
      if (where.cwd && where.cwd.length <= 1000) r = { ...r, cwd: where.cwd }
      if (where.cwd && this.d.repoIdentity) {
        const identity = await this.d.repoIdentity.resolve(where.cwd).catch(() => null)
        if (identity) r = { ...r, identity }
      }
      // A newer record for this agent may have been written while we waited.
      const cur = this.d.store.sessions.get(r.id)!
      r = { ...cur, ...pick(r) }
      await this.d.store.putSession(r)
      if (r.assignment.by === 'none' && r.projectId === null) await this.match(r)
    } catch {
      this.d.log.warn('session location could not be resolved')
    }
  }

  /**
   * Adds a past session found on disk (history import): resolves where it worked, stores it
   * unassigned and records project suggestions exactly like an observed session.
   */
  async adopt(r: SessionRecord): Promise<void> {
    let next = r
    if (r.cwd && this.d.repoIdentity) {
      const identity = await this.d.repoIdentity.resolve(r.cwd).catch(() => null)
      if (identity) next = { ...next, identity }
    }
    await this.d.store.putSession(next)
    await this.match(next)
  }

  // ── used by the recorder, catalog and handoffs ──

  /** The record of this agent's current session, created (unassigned) when missing. */
  ensure(
    agentId: string,
    provider: string,
    hint: { origin?: SessionOrigin; title?: string } = {},
  ): SessionRecord {
    const cur = this.d.store.sessionByAgent(agentId)
    if (cur) return cur
    const agent = this.d.agents.get(agentId)
    const r = newSessionRecord({
      id: this.d.store.newId('ses'),
      agentId,
      provider,
      origin: hint.origin ?? (agent?.managed ? 'managed' : 'observed'),
      title: hint.title ?? agent?.name ?? agentId,
      now: this.d.clock.now(),
    })
    void this.d.store.putSession(r)
    return r
  }

  /** Records a new assignment, patches the live agent and logs the activity. */
  async applyAssignment(
    r: SessionRecord,
    projectId: string | null,
    by: AssignedBy,
    rule: AssignmentEntry['rule'] | undefined,
  ): Promise<SessionRecord> {
    const next = assignSession(r, projectId, by, rule, this.d.clock.now())
    if (projectId === null) next.suggestions = r.suggestions
    const write = this.d.store.putSession(next)
    this.syncAgent(next)
    if (projectId) {
      const started = rule === 'managed' || rule === 'handoff'
      void this.d.activity.add(
        projectId,
        started ? 'session.started' : 'session.assigned',
        by === 'user' && !started ? 'you' : r.provider,
        `${started ? 'Started' : 'Assigned'} “${r.title}” (${r.provider})`,
        { sessionId: r.id, agentId: r.agentId },
      )
    }
    await write
    this.notify(this.d.onAssigned, next)
    return next
  }

  /**
   * Session ended: inactive, with the deterministic summary. Without agent-office chat replies
   * (typical for observed sessions) the last agent replies of its transcript are used instead
   * (read on demand; only the ≤ 2000-char summary is stored).
   */
  end(r: SessionRecord): void {
    if (r.state !== 'active') return
    const ended = endSession(r, this.d.clock.now())
    const replies = this.d.store
      .chatOf(r.id)
      .filter((m) => m.role === 'agent')
      .map((m) => m.text)
    const next: SessionRecord = {
      ...ended,
      summary: { text: deterministicSummary(ended, replies), source: 'last-replies' },
    }
    void this.d.store.putSession(next)
    if (next.projectId)
      void this.d.activity.add(next.projectId, 'session.ended', r.provider, `Ended “${r.title}”`, {
        sessionId: r.id,
      })
    if (replies.length || !next.transcriptRef || !this.d.transcripts) {
      this.notify(this.d.onEnded, next)
      return
    }
    void this.summaryFromTranscript(next).then((final) => this.notify(this.d.onEnded, final))
  }

  private async summaryFromTranscript(r: SessionRecord): Promise<SessionRecord> {
    try {
      const page = await this.d.transcripts!.page(r.transcriptRef!, { limit: END_TRANSCRIPT_PAGE })
      const replies = page.messages
        .filter((m) => m.role === 'assistant' && m.text.trim())
        .map((m) => m.text)
      const cur = this.d.store.sessions.get(r.id)
      // Only while it is still the summary written at end (not reactivated or summarized since).
      if (
        !replies.length ||
        !cur ||
        cur.state === 'active' ||
        cur.summary?.text !== r.summary?.text
      )
        return cur ?? r
      const next: SessionRecord = {
        ...cur,
        summary: { text: deterministicSummary(cur, replies), source: 'last-replies' },
      }
      await this.d.store.putSession(next)
      return next
    } catch {
      this.d.log.warn('transcript unreadable; summary from agent-office chat')
      return this.d.store.sessions.get(r.id) ?? r
    }
  }

  private notify(fn: ((r: SessionRecord) => void) | undefined, r: SessionRecord): void {
    try {
      fn?.(r)
    } catch {
      this.d.log.warn('session hook failed')
    }
  }

  reactivate(r: SessionRecord): SessionRecord {
    const next = reactivateSession(r, this.d.clock.now())
    void this.d.store.putSession(next)
    return next
  }

  /** The live agent carries its session's project for the UI (additive `Agent.projectId`). */
  syncAgent(r: SessionRecord): void {
    const a = this.d.agents.get(r.agentId)
    if (!a || r.state !== 'active') return
    const want = r.projectId ?? undefined
    if (a.projectId === want) return
    const next: AgentState = { ...a }
    if (want) next.projectId = want
    else delete next.projectId
    this.d.agents.put(next)
    this.d.store.emit({ type: 'agent-project', agentId: r.agentId, projectId: r.projectId })
    this.d.bus.publish({ type: 'agent.upserted', agent: next })
  }

  /** Repo links changed: refresh `wk_` keys and rematch every never-assigned session. */
  async reposChanged(): Promise<void> {
    await this.refreshWorkspaceKeys()
    for (const r of [...this.d.store.sessions.values()])
      if (r.assignment.by === 'none' && r.projectId === null && r.state !== 'archived')
        await this.match(r)
  }

  async refreshWorkspaceKeys(): Promise<void> {
    const keys = new Map<string, { projectId: string; repoId: string }[]>()
    if (this.d.repoIdentity)
      for (const p of this.d.store.projects.values())
        for (const link of p.repos) {
          const k = await this.d.repoIdentity.workspaceKey(link.locator).catch(() => null)
          if (k) keys.set(k, [...(keys.get(k) ?? []), { projectId: p.id, repoId: link.id }])
        }
    this.workspaceKeys = keys
  }

  private async match(r: SessionRecord): Promise<void> {
    const projects = [...this.d.store.projects.values()]
    let m: MatchResult = { kind: 'none' }
    if (r.identity) m = matchProject(r.identity, projects)
    if (m.kind === 'none' && r.workspaceKey) m = this.matchKey(r.workspaceKey)
    if (m.kind === 'auto') {
      await this.applyAssignment({ ...r, repoId: m.repoId }, m.projectId, 'auto', m.rule)
      return
    }
    const suggestions: Suggestion[] = m.kind === 'suggest' ? m.suggestions : []
    if (JSON.stringify(suggestions) !== JSON.stringify(r.suggestions))
      await this.d.store.putSession({ ...r, suggestions })
  }

  private matchKey(key: string): MatchResult {
    const live = (this.workspaceKeys.get(key) ?? []).filter(
      (l) => this.d.store.projects.get(l.projectId)?.archivedAt === undefined,
    )
    const projects = [...new Set(live.map((l) => l.projectId))]
    if (projects.length === 1)
      return {
        kind: 'auto',
        projectId: projects[0]!,
        repoId: live[0]!.repoId,
        rule: 'workspace-key',
      }
    if (!projects.length) return { kind: 'none' }
    return {
      kind: 'suggest',
      suggestions: projects.map((projectId) => ({
        projectId,
        rule: 'workspace-key',
        confidence: 'high',
      })),
    }
  }

  private require(sessionId: string): SessionRecord {
    const r = this.d.store.sessions.get(sessionId)
    if (!r) throw new NotFoundError('session')
    return r
  }

  private view(r: SessionRecord): SessionSummary {
    return toSessionSummary(
      r,
      (id) => this.d.store.projects.get(id)?.name,
      (id) => {
        const k = this.d.store.knowledgeOf(id)
        return k?.state === 'approved' ? k.id : undefined
      },
    )
  }
}

/** The fields `located` may set. */
function pick(r: SessionRecord): Partial<SessionRecord> {
  return {
    ...(r.cwd ? { cwd: r.cwd } : {}),
    ...(r.transcriptRef ? { transcriptRef: r.transcriptRef } : {}),
    ...(r.workspaceKey ? { workspaceKey: r.workspaceKey } : {}),
    ...(r.identity ? { identity: r.identity } : {}),
  }
}
