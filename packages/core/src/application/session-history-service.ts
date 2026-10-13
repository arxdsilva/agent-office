// Experimental: import past Claude Code sessions and resume one natively (docs/projects.md §3).
// Import stores references only (a `tr_` ref, never transcript content); resume is user-only.
import type { ImportResult } from '@agent-office/shared'
import { assertAuthorized, USER, type Principal } from '../domain/authz.ts'
import { NotFoundError, ValidationError } from '../domain/errors.ts'
import {
  canResume,
  newSessionRecord,
  providerSessionIdOf,
  type SessionRecord,
} from '../domain/session-record.ts'
import type { Clock, HistorySource } from '../ports/driven.ts'
import type { HistoryImport, ManagedSessions, SessionResume } from '../ports/driving.ts'
import type { ProjectsStore } from './projects-store.ts'
import type { SessionVaultService } from './session-vault-service.ts'

const CLAUDE_ID = /^[A-Za-z0-9_-]{1,100}$/
const REF = /^tr_[A-Za-z0-9_-]{1,100}$/
const CONTINUE = 'Continue where we left off.'

export interface SessionHistoryDeps {
  store: ProjectsStore
  vault: SessionVaultService
  clock: Clock
  history?: HistorySource
  sessions?: () => ManagedSessions | undefined
}

export class SessionHistoryService implements HistoryImport, SessionResume {
  constructor(private d: SessionHistoryDeps) {}

  async importHistory(o: { limit: number }, as: Principal = USER): Promise<ImportResult> {
    assertAuthorized(as, 'session.assign', { kind: 'session', projectId: null }, undefined)
    if (!this.d.history) throw new ValidationError('history import is not available')
    const limit = Math.max(1, Math.min(500, Math.floor(o.limit)))
    const past = (await this.d.history.list({ limit })).slice(0, limit)
    let imported = 0
    let skipped = 0
    for (const p of past) {
      const agentId = `cc:${p.providerSessionId}`
      if (
        p.provider !== 'claude-code' ||
        !CLAUDE_ID.test(p.providerSessionId) ||
        !REF.test(p.transcriptRef) ||
        this.d.store.sessionByAgent(agentId)
      ) {
        skipped++
        continue
      }
      const base = newSessionRecord({
        id: this.d.store.newId('ses'),
        agentId,
        provider: 'claude-code',
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
