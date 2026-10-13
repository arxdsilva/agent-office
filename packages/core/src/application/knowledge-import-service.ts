// Automatic knowledge import (docs/projects.md §8b): after the user's one explicit opt-in, Claude
// sessions are imported continuously and each session's deterministic summary becomes ONE approved
// memory item in its project. Bounded (≤ 500 sessions per run, ≤ 200 items per project, one run at a
// time) and reversible (`removeImported`). Only the ≤ 2000-char summary is stored, never transcripts.
import type { ImportResult, ImportStatus } from '@agent-office/shared'
import { assertAuthorized, USER, type Principal } from '../domain/authz.ts'
import {
  createImportedMemory,
  IMPORT_ORIGIN,
  MAX_IMPORTED_BODY,
  rehomeImportedMemory,
  retractMemory,
  reviseImportedMemory,
  supersedeByCap,
  type MemoryItem,
} from '../domain/memory.ts'
import {
  deterministicSummary,
  hasAgentReplies,
  type SessionRecord,
} from '../domain/session-record.ts'
import { cleanText } from '../domain/text.ts'
import type { Clock, Logger, Scheduler, TranscriptReader } from '../ports/driven.ts'
import type { HistoryImport, KnowledgeImport } from '../ports/driving.ts'
import type { ActivityLog } from './activity-log.ts'
import type { ProjectsStore } from './projects-store.ts'

export const IMPORT_EVERY_MS = 10 * 60_000
export const MAX_IMPORTED_PER_PROJECT = 200
export const MAX_SESSIONS_PER_RUN = 500
/** Transcript messages read for an imported session's last replies. */
const TRANSCRIPT_PAGE = 40

const USER_ONLY = { kind: 'memory', projectId: null, scope: 'project', state: 'pending' } as const
const EMPTY = { imported: 0, skipped: 0, added: 0 }

type Outcome = 'created' | 'changed' | 'none'

export interface KnowledgeImportDeps {
  store: ProjectsStore
  history: HistoryImport
  activity: ActivityLog
  clock: Clock
  log: Logger
  transcripts?: TranscriptReader
  scheduler?: Scheduler
}

export class KnowledgeImportService implements KnowledgeImport {
  private on = false
  private approvedAt = 0
  private cancel: (() => void) | undefined
  private running: Promise<ImportResult & { added: number }> | null = null
  private queued: Promise<ImportResult & { added: number }> | null = null
  /** Every item mutation runs one at a time (hooks and runs never race on one session). */
  private lock: Promise<unknown> = Promise.resolve()
  /** Items created per project during the current run (null key: unassigned). */
  private tally: Map<string | null, number> | null = null
  /** Sessions whose transcript had no agent text, by the lastSeenAt it was read at. */
  private noReplies = new Map<string, number>()
  private last: { lastRunAt?: number; imported: number; added: number } = {
    imported: 0,
    added: 0,
  }

  constructor(private d: KnowledgeImportDeps) {}

  setEnabled(on: boolean, approvedAt: number): void {
    if (!on) {
      this.on = false
      this.cancel?.()
      this.cancel = undefined
      return
    }
    this.approvedAt = approvedAt
    if (this.on) return
    this.on = true
    this.cancel = this.d.scheduler?.every(IMPORT_EVERY_MS, () => void this.runAll())
    void this.runAll()
  }

  /** Single flight: a call during a run joins one queued rerun. Never rejects. */
  runAll(): Promise<ImportResult & { added: number }> {
    if (!this.on) return Promise.resolve({ ...EMPTY })
    if (this.running) {
      this.queued ??= this.running.then(() => {
        this.queued = null
        return this.runAll()
      })
      return this.queued
    }
    this.running = this.run()
      .catch(() => {
        this.d.log.warn('knowledge import run failed')
        return { ...EMPTY }
      })
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  async sync(sessionId: string): Promise<void> {
    if (!this.on) return
    const outcome = await this.exclusive(() => this.syncNow(sessionId))
    if (outcome !== 'none') {
      const r = this.d.store.sessions.get(sessionId)
      if (r) await this.exclusive(() => this.enforceCap(r.projectId))
    }
  }

  async removeImported(projectId?: string, as: Principal = USER): Promise<{ removed: number }> {
    assertAuthorized(as, 'memory.review', USER_ONLY, undefined)
    return this.exclusive(async () => {
      const now = this.d.clock.now()
      const perProject = new Map<string, number>()
      let removed = 0
      for (const m of [...this.d.store.memory.values()]) {
        if (m.provenance.origin !== IMPORT_ORIGIN || m.state !== 'approved') continue
        if (projectId !== undefined && m.projectId !== projectId) continue
        await this.d.store.putMemory(retractMemory(m, now))
        removed++
        if (m.projectId) perProject.set(m.projectId, (perProject.get(m.projectId) ?? 0) + 1)
        const sid = m.provenance.sessionId
        const r = sid ? this.d.store.sessions.get(sid) : undefined
        if (r) await this.d.store.putSession({ ...r, knowledgeRemovedAt: now })
      }
      for (const [pid, n] of perProject)
        void this.d.activity.add(
          pid,
          'memory.rejected',
          'you',
          `Removed ${n} auto-imported ${n === 1 ? 'summary' : 'summaries'}`,
        )
      return { removed }
    })
  }

  status(): ImportStatus {
    return { on: this.on, ...this.last }
  }

  // ── internals ──

  private async run(): Promise<ImportResult & { added: number }> {
    const startedAt = this.d.clock.now()
    this.tally = new Map()
    let res: ImportResult = { imported: 0, skipped: 0 }
    try {
      res = await this.d.history.importHistory({ limit: MAX_SESSIONS_PER_RUN })
    } catch {
      // No history source (Claude adapter off) or an unreadable folder: still sync known sessions.
    }
    for (const r of [...this.d.store.sessions.values()]) {
      if (!this.on) break
      if (this.candidate(r)) await this.exclusive(() => this.syncNow(r.id))
    }
    const tally = this.tally
    this.tally = null
    for (const pid of tally.keys()) await this.exclusive(() => this.enforceCap(pid))
    let added = 0
    for (const [pid, n] of tally) {
      added += n
      if (pid && n)
        void this.d.activity.add(
          pid,
          'memory.imported',
          'auto-import',
          `Imported ${n} session ${n === 1 ? 'summary' : 'summaries'}`,
        )
    }
    this.last = { lastRunAt: startedAt, imported: res.imported, added }
    return { ...res, added }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn)
    this.lock = next.catch(() => undefined)
    return next
  }

  /** A Claude session that ended and was not removed by the user since it last ended. */
  private candidate(r: SessionRecord): boolean {
    if (r.provider !== 'claude-code' || r.state !== 'inactive') return false
    if (r.knowledgeRemovedAt !== undefined && (r.endedAt ?? r.lastSeenAt) <= r.knowledgeRemovedAt)
      return false
    return true
  }

  private async syncNow(sessionId: string): Promise<Outcome> {
    if (!this.on) return 'none'
    const r = this.d.store.sessions.get(sessionId)
    if (!r || !this.candidate(r)) return 'none'
    const summary = await this.summaryOf(r)
    if (!summary) return 'none'
    // Re-read: the record may have changed while the transcript was read.
    const cur = this.d.store.sessions.get(sessionId)
    if (!cur || !this.candidate(cur)) return 'none'
    const now = this.d.clock.now()
    const item = this.d.store.knowledgeOf(cur.id)
    if (!item) {
      const m = createImportedMemory({
        id: this.d.store.newId('mem'),
        session: { id: cur.id, title: cur.title },
        summary,
        projectId: cur.projectId,
        now,
        approvedAt: this.approvedAt,
      })
      await this.d.store.putMemory(m)
      this.tally?.set(m.projectId, (this.tally.get(m.projectId) ?? 0) + 1)
      return 'created'
    }
    // Retired by the cap: not recreated, not revised.
    if (item.state !== 'approved') return 'none'
    let next = rehomeImportedMemory(
      reviseImportedMemory(item, summary, now, cur.title),
      cur.projectId,
      now,
    )
    if (next === item) return 'none'
    next = { ...next, version: item.version + 1 }
    await this.d.store.putMemory(next)
    return 'changed'
  }

  /** The record's summary when it holds replies; else the last agent replies of its transcript. */
  private async summaryOf(r: SessionRecord): Promise<string | undefined> {
    if (r.summary && hasAgentReplies(r.summary)) return r.summary.text
    if (!r.transcriptRef || !this.d.transcripts) return undefined
    if (this.noReplies.get(r.id) === r.lastSeenAt) return undefined
    let replies: string[]
    try {
      const page = await this.d.transcripts.page(r.transcriptRef, { limit: TRANSCRIPT_PAGE })
      replies = page.messages
        .filter((m) => m.role === 'assistant' && m.text.trim())
        .map((m) => m.text)
    } catch {
      this.d.log.warn('transcript unreadable; session not imported')
      return undefined
    }
    if (!replies.length) {
      this.noReplies.set(r.id, r.lastSeenAt)
      return undefined
    }
    const text = cleanText(deterministicSummary(r, replies), MAX_IMPORTED_BODY)
    const cur = this.d.store.sessions.get(r.id)
    if (cur) await this.d.store.putSession({ ...cur, summary: { text, source: 'last-replies' } })
    return text
  }

  /** ≤ 200 approved auto-imported items per project (and unassigned): the oldest (updatedAt) retire. */
  private async enforceCap(projectId: string | null): Promise<void> {
    const live: MemoryItem[] = [...this.d.store.memory.values()]
      .filter(
        (m) =>
          m.provenance.origin === IMPORT_ORIGIN &&
          m.state === 'approved' &&
          m.projectId === projectId,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt || b.provenance.createdAt - a.provenance.createdAt)
    const now = this.d.clock.now()
    for (const m of live.slice(MAX_IMPORTED_PER_PROJECT))
      await this.d.store.putMemory(supersedeByCap(m, now))
  }
}
