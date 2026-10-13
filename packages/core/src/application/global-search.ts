// Global search (Cmd/Ctrl+K) over projects, sessions, chat, memory and handoffs, plus live agents
// and (deep) provider transcripts read on demand. User only; the index lives in memory.
import type { SearchHit } from '@agent-office/shared'
import { assertAuthorized, USER, type Principal } from '../domain/authz.ts'
import { tokenize } from '../domain/context-rank.ts'
import { oneLine } from '../domain/text.ts'
import type { AgentRepository, SearchDoc, SearchIndex, TranscriptReader } from '../ports/driven.ts'
import type { GlobalSearch } from '../ports/driving.ts'
import type { ProjectsStore, StoreChange } from './projects-store.ts'

/** Core's default index: every query word must appear; score = occurrences. Never persisted. */
export class InMemorySearchIndex implements SearchIndex {
  private docs = new Map<string, SearchDoc & { hay: string }>()
  upsert(d: SearchDoc): void {
    this.docs.set(d.id, { ...d, hay: `${d.title} ${d.text}`.toLowerCase() })
  }
  remove(id: string): void {
    this.docs.delete(id)
  }
  query(
    q: string,
    o: { projectIds?: (string | null)[]; kinds?: SearchDoc['kind'][]; limit: number },
  ) {
    const words = tokenize(q)
    if (!words.length) return []
    const out: { id: string; score: number; snippet: string }[] = []
    for (const d of this.docs.values()) {
      if (o.projectIds && !o.projectIds.includes(d.projectId)) continue
      if (o.kinds && !o.kinds.includes(d.kind)) continue
      if (!words.every((w) => d.hay.includes(w))) continue
      const score = words.reduce((n, w) => n + d.hay.split(w).length - 1, 0)
      const at = Math.max(0, d.hay.indexOf(words[0]!) - 60)
      out.push({ id: d.id, score, snippet: `${d.title} ${d.text}`.slice(at, at + 200) })
    }
    return out.sort((a, b) => b.score - a.score).slice(0, o.limit)
  }
}

const msgDoc = (sessionId: string, id: string) => `msg:${sessionId}:${id}`

export class GlobalSearchService implements GlobalSearch {
  private index: SearchIndex

  constructor(
    private d: {
      store: ProjectsStore
      agents: AgentRepository
      index?: SearchIndex
      transcripts?: TranscriptReader
    },
  ) {
    this.index = d.index ?? new InMemorySearchIndex()
    d.store.onChange((c) => this.onChange(c))
  }

  /** Indexes everything loaded from the vault (startup). */
  rebuild(): void {
    const s = this.d.store
    for (const p of s.projects.values()) this.onChange({ type: 'project', id: p.id })
    for (const r of s.sessions.values()) this.onChange({ type: 'session', id: r.id })
    for (const m of s.memory.values()) this.onChange({ type: 'memory', id: m.id })
    for (const h of s.handoffs.values()) this.onChange({ type: 'handoff', id: h.id })
  }

  async search(
    o: { query: string; projectId?: string; deep?: boolean },
    as: Principal = USER,
  ): Promise<SearchHit[]> {
    assertAuthorized(as, 'search', { kind: 'project', projectId: o.projectId ?? null }, undefined)
    const s = this.d.store
    const q = o.query.trim().slice(0, 200)
    const hits: SearchHit[] = []
    for (const h of this.index.query(q, {
      ...(o.projectId ? { projectIds: [o.projectId] } : {}),
      limit: 40,
    })) {
      const hit = this.hit(h.id, oneLine(h.snippet, 200))
      if (hit) hits.push(hit)
    }
    const needle = q.toLowerCase()
    for (const a of this.d.agents.list())
      if (
        (!o.projectId || a.projectId === o.projectId) &&
        `${a.name} ${a.topic}`.toLowerCase().includes(needle)
      )
        hits.push({
          kind: 'agent',
          id: a.id,
          projectId: a.projectId ?? null,
          title: a.name,
          snippet: oneLine(a.topic, 200),
        })
    if (o.deep && this.d.transcripts) {
      const sessions = [...s.sessions.values()]
        .filter((r) => r.transcriptRef && (!o.projectId || r.projectId === o.projectId))
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .slice(0, 10)
      for (const r of sessions) {
        const found = await this.d.transcripts.search(r.transcriptRef!, q, 3).catch(() => [])
        for (const f of found)
          hits.push({
            kind: 'message',
            id: f.uuid,
            projectId: r.projectId,
            title: r.title,
            snippet: oneLine(f.snippet, 200),
            sessionId: r.id,
            messageId: f.uuid,
          })
      }
    }
    return hits
  }

  private hit(id: string, snippet: string): SearchHit | undefined {
    const s = this.d.store
    if (id.startsWith('msg:')) {
      const [, sessionId, messageId] = id.split(':') as [string, string, string]
      const r = s.sessions.get(sessionId)
      return (
        r && {
          kind: 'message',
          id: messageId,
          projectId: r.projectId,
          title: r.title,
          snippet,
          sessionId,
          messageId,
        }
      )
    }
    const p = s.projects.get(id)
    if (p) return { kind: 'project', id, projectId: id, title: p.name, snippet }
    const r = s.sessions.get(id)
    if (r)
      return { kind: 'session', id, projectId: r.projectId, title: r.title, snippet, sessionId: id }
    const m = s.memory.get(id)
    if (m) return { kind: 'memory', id, projectId: m.projectId, title: m.title, snippet }
    const h = s.handoffs.get(id)
    if (h)
      return {
        kind: 'handoff',
        id,
        projectId: h.projectId,
        title: h.objective.slice(0, 120),
        snippet,
      }
    return undefined
  }

  private onChange(c: StoreChange): void {
    const s = this.d.store
    const ix = this.index
    switch (c.type) {
      case 'project': {
        const p = s.projects.get(c.id)
        if (p)
          ix.upsert({
            id: p.id,
            projectId: p.id,
            kind: 'project',
            title: p.name,
            text: p.repos.map((r) => r.label).join(' '),
            ts: p.createdAt,
          })
        return
      }
      case 'session': {
        const r = s.sessions.get(c.id)
        if (!r) return
        ix.upsert({
          id: r.id,
          projectId: r.projectId,
          kind: 'session',
          title: r.title,
          text: r.summary?.text ?? '',
          ts: r.lastSeenAt,
        })
        for (const m of s.chatOf(r.id))
          ix.upsert({
            id: msgDoc(r.id, m.id),
            projectId: r.projectId,
            kind: 'message',
            title: r.title,
            text: m.text,
            ts: m.ts,
          })
        return
      }
      case 'chat': {
        const r = s.sessions.get(c.sessionId)
        ix.upsert({
          id: msgDoc(c.sessionId, c.message.id),
          projectId: r?.projectId ?? null,
          kind: 'message',
          title: r?.title ?? '',
          text: c.message.text,
          ts: c.message.ts,
        })
        return
      }
      case 'memory': {
        const m = s.memory.get(c.id)
        if (m)
          ix.upsert({
            id: m.id,
            projectId: m.projectId,
            kind: 'memory',
            title: m.title,
            text: m.body,
            ts: m.updatedAt,
          })
        return
      }
      case 'handoff': {
        const h = s.handoffs.get(c.id)
        if (h)
          ix.upsert({
            id: h.id,
            projectId: h.projectId,
            kind: 'handoff',
            title: h.objective.slice(0, 120),
            text: h.note,
            ts: h.createdAt,
          })
        return
      }
      default:
    }
  }
}
