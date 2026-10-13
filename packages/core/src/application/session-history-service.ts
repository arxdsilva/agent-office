// Experimental: import past Claude Code sessions and resume one natively (docs/projects.md §3).
// Import stores references only (a `tr_` ref, never transcript content); resume is user-only.
import type { ImportResult, ProviderId } from '@agent-office/shared'
import { assertAuthorized, USER, type Principal } from '../domain/authz.ts'
import { NotFoundError, ValidationError } from '../domain/errors.ts'
import { PROVIDER_DECLS } from '../domain/providers.ts'
import {
  canResume,
  newSessionRecord,
  providerSessionIdOf,
  type SessionRecord,
} from '../domain/session-record.ts'
import type { Clock, HistorySource, HistorySources, PastSession } from '../ports/driven.ts'
import type { HistoryImport, ManagedSessions, SessionResume } from '../ports/driving.ts'
import type { ProjectsStore } from './projects-store.ts'
import type { SessionVaultService } from './session-vault-service.ts'

const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/
const REF = /^tr_[A-Za-z0-9_-]{1,100}$/
const CONTINUE = 'Continue where we left off.'

export interface SessionHistoryDeps {
  store: ProjectsStore
  vault: SessionVaultService
  clock: Clock
  /** One source per provider that has a history; none means history import is unavailable. */
  history?: HistorySources
  sessions?: () => ManagedSessions | undefined
}

export class SessionHistoryService implements HistoryImport, SessionResume {
  constructor(private d: SessionHistoryDeps) {}

  async importHistory(o: { limit: number }, as: Principal = USER): Promise<ImportResult> {
    assertAuthorized(as, 'session.assign', { kind: 'session', projectId: null }, undefined)
    const sources = Object.entries(this.d.history ?? {}) as [ProviderId, HistorySource][]
    if (sources.length === 0) throw new ValidationError('history import is not available')
    const limit = Math.max(1, Math.min(500, Math.floor(o.limit)))
    // List every source first: a failing one is skipped while another works, and when all fail
    // nothing is imported and the error is thrown (no half-imported state).
    const listed: [ProviderId, HistorySource, PastSession[]][] = []
    let failure: unknown
    for (const [provider, source] of sources) {
      try {
        listed.push([provider, source, (await source.list({ limit })).slice(0, limit)])
      } catch (err) {
        failure ??= err
      }
    }
    if (listed.length === 0) throw failure
    let imported = 0
    let skipped = 0
    for (const [provider, source, past] of listed) {
      const r = await this.importProvider(provider, source, past)
      imported += r.imported
      skipped += r.skipped
    }
    return { imported, skipped }
  }

  private async importProvider(
    provider: ProviderId,
    source: HistorySource,
    past: PastSession[],
  ): Promise<ImportResult> {
    const idPattern = source.idPattern ?? SESSION_ID
    const prefix = PROVIDER_DECLS[provider].prefix
    let imported = 0
    let skipped = 0
    for (const p of past) {
      const agentId = `${prefix}${p.providerSessionId}`
      if (
        p.provider !== provider ||
        !idPattern.test(p.providerSessionId) ||
        !REF.test(p.transcriptRef) ||
        this.d.store.sessionByAgent(agentId)
      ) {
        skipped++
        continue
      }
      const base = newSessionRecord({
        id: this.d.store.newId('ses'),
        agentId,
        provider,
        origin: 'imported',
        title: p.title,
        now: p.startedAt,
      })
      const r: SessionRecord = {
        ...base,
        state: 'inactive',
        startedAt: p.startedAt,
        lastSeenAt: p.lastSeenAt,
        endedAt: p.lastSeenAt,
        transcriptRef: p.transcriptRef,
        ...(p.cwd ? { cwd: p.cwd } : {}),
      }
      try {
        await this.d.vault.adopt(r)
        imported++
      } catch {
        skipped++
      }
    }
    return { imported, skipped }
  }

  async resume(sessionId: string, as: Principal = USER): Promise<{ agentId: string }> {
    const r = this.d.store.sessions.get(sessionId)
    if (!r) throw new NotFoundError('session')
    assertAuthorized(as, 'session.assign', { kind: 'session', projectId: r.projectId }, undefined)
    const resumeId = providerSessionIdOf(r)
    if (!canResume(r) || !resumeId || !r.cwd)
      throw new ValidationError('this session cannot be resumed')
    const sessions = this.d.sessions?.()
    if (!sessions) throw new ValidationError('sessions are not available')
    const agentId = await sessions.start({
      provider: 'claude-code',
      ...(r.projectId && this.d.store.projects.has(r.projectId) ? { projectId: r.projectId } : {}),
      cwd: r.cwd,
      name: r.title.slice(0, 40),
      mode: 'default',
      extraDirs: [],
      chrome: false,
      first: { text: CONTINUE, context: [], use: [] },
      resume: resumeId,
    })
    if (agentId !== r.agentId) {
      // The runtime gave the resumed conversation a new id: link it back to the original.
      const rec = this.d.vault.ensure(agentId, 'claude-code', { origin: 'managed' })
      const next: SessionRecord = {
        ...rec,
        cwd: r.cwd,
        continuedFrom: { handoffId: 'resume', sessionId: r.id, provider: r.provider },
      }
      if (r.projectId && next.projectId !== r.projectId)
        await this.d.vault.applyAssignment(next, r.projectId, 'user', 'managed')
      else await this.d.store.putSession(next)
    }
    return { agentId }
  }
}
