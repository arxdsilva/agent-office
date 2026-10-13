// The projects layer's in-memory state, rebuilt from the vault (RecordLog) at startup and appended
// on every change (docs/projects.md §3). Partitions: 'catalog' (projects, repo links, session
// records, assignments, project-less memory), 'p/<prj>' (memory versions, tasks, handoffs,
// activity), 's/<ses>' (agent-office chat for that session).
import type { ActivityEvent } from '../domain/activity.ts'
import type { Handoff } from '../domain/handoff.ts'
import { IMPORT_ORIGIN, isMoveTombstone, moveTombstone, type MemoryItem } from '../domain/memory.ts'
import { idFrom, type Project } from '../domain/project.ts'
import type { SessionRecord } from '../domain/session-record.ts'
import type { Task } from '../domain/task.ts'
import type { Clock, Logger, RecordLog, SecureRandom, VaultRecord } from '../ports/driven.ts'

export interface ChatRecord {
  id: string
  role: 'user' | 'agent' | 'system'
  /** ≤ 4000 chars. */
  text: string
  ts: number
  tools?: string[]
}

export type StoreChange =
  | { type: 'project'; id: string }
  | { type: 'session'; id: string }
  | { type: 'memory'; id: string }
  | { type: 'handoff'; id: string }
  | { type: 'task'; id: string }
  | { type: 'activity'; event: ActivityEvent }
  | { type: 'chat'; sessionId: string; message: ChatRecord }
  | { type: 'retrieval'; projectId: string; agentId: string; memoryIds: string[] }
  | { type: 'agent-project'; agentId: string; projectId: string | null }

export interface StoreDeps {
  log: RecordLog
  clock: Clock
  /** Ids come from it when present (else a non-secure fallback; never used for tokens). */
  random?: SecureRandom
  logger: Logger
}

const MAX_ACTIVITY = 2000
const COMPACT_MIN = 200

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const hasId = (d: unknown, prefix: string) =>
  isObj(d) && typeof d.id === 'string' && d.id.startsWith(prefix)

export const partitionOf = (projectId: string | null) => (projectId ? `p/${projectId}` : 'catalog')

/** Which records are the same object (compaction keeps the last; memory keeps every version). */
function keyOf(r: VaultRecord): string {
  const d = r.data
  if (r.t === 'memory') return `memory:${String(d.id)}:${String(d.version)}`
  if (r.t === 'activity') return `activity:${String(d.id)}`
  return `${r.t}:${String(d.id)}`
}

export class ProjectsStore {
  readonly projects = new Map<string, Project>()
  readonly sessions = new Map<string, SessionRecord>()
  /** Current version of each memory lineage. */
  readonly memory = new Map<string, MemoryItem>()
  readonly tasks = new Map<string, Task>()
  readonly handoffs = new Map<string, Handoff>()
  private memoryVersions = new Map<string, MemoryItem[]>()
  /** Session id → the lineages auto-imported from it (docs/projects.md §8b), rebuilt on load. */
  private knowledgeBySession = new Map<string, Set<string>>()
  private activity = new Map<string, ActivityEvent[]>()
  private chat = new Map<string, ChatRecord[]>()
  private byAgent = new Map<string, string>()
  private subs = new Set<(c: StoreChange) => void>()
  private queue: Promise<void> = Promise.resolve()
  private n = 0
  writeErrors = 0

  constructor(private d: StoreDeps) {}

  status(): 'encrypted' | 'memory-only' {
    return this.d.log.status()
  }

  newId(prefix: string): string {
    const token =
      this.d.random?.token(12) ??
      `${(++this.n).toString(36)}${this.d.clock.now().toString(36)}${Math.random().toString(36).slice(2)}`.padEnd(
        16,
        'x',
      )
    return idFrom(prefix, token)
  }

  // ── load ──

  async load(): Promise<void> {
    const parts = [
      'catalog',
      ...(await this.d.log.partitions('p/')),
      ...(await this.d.log.partitions('s/')),
    ]
    for (const p of parts) {
      let records: VaultRecord[]
      try {
        records = await this.d.log.read(p)
      } catch {
        this.d.logger.warn('vault partition unreadable')
        continue
      }
      for (const r of records) this.apply(p, r)
      await this.maybeCompact(p, records)
    }
  }

  private apply(partition: string, r: VaultRecord): void {
    const d = r.data
    switch (r.t) {
      case 'project':
        if (hasId(d, 'prj_') && Array.isArray(d.repos) && isObj(d.policy))
          this.projects.set(d.id as string, d as unknown as Project)
        return
      case 'session':
        if (hasId(d, 'ses_') && typeof d.agentId === 'string')
          this.indexSession(d as unknown as SessionRecord)
        return
      case 'memory':
        if (hasId(d, 'mem_') && typeof d.version === 'number')
          this.indexMemory(d as unknown as MemoryItem)
        return
      case 'task':
        if (hasId(d, 'tsk_')) this.tasks.set(d.id as string, d as unknown as Task)
        return
      case 'handoff':
        if (hasId(d, 'hof_')) this.handoffs.set(d.id as string, d as unknown as Handoff)
        return
      case 'activity':
        if (hasId(d, 'act_') && typeof d.projectId === 'string')
          this.indexActivity(d as unknown as ActivityEvent)
        return
      case 'message':
        if (partition.startsWith('s/') && typeof d.id === 'string' && typeof d.text === 'string')
          this.indexChat(partition.slice(2), d as unknown as ChatRecord)
        return
      default:
      // unknown record types from newer versions are kept on disk and ignored
    }
  }

  private async maybeCompact(partition: string, records: VaultRecord[]): Promise<void> {
    if (records.length < COMPACT_MIN) return
    const last = new Map<string, VaultRecord>()
    for (const r of records) {
      const k = keyOf(r)
      last.delete(k)
      last.set(k, r)
    }
    if (last.size > records.length / 2) return
    const kept = [...last.values()].map(({ t, ts, data }) => ({ t, ts, data }))
    try {
      await this.d.log.compact(partition, kept)
    } catch {
      this.d.logger.warn('vault compaction failed')
    }
  }

  // ── writes ──

  private write(partition: string, t: string, data: object): Promise<void> {
    const rec: VaultRecord = {
      t,
      ts: this.d.clock.now(),
      data: JSON.parse(JSON.stringify(data)) as Record<string, unknown>,
    }
    const next = this.queue.then(() =>
      this.d.log.append(partition, [rec]).catch(() => {
        this.writeErrors++
        this.d.logger.warn(`vault write failed (${t})`)
      }),
    )
    this.queue = next
    return next
  }

  flush(): Promise<void> {
    return this.queue
  }

  putProject(p: Project): Promise<void> {
    this.projects.set(p.id, p)
    this.emit({ type: 'project', id: p.id })
    return this.write('catalog', 'project', p)
  }

  putSession(r: SessionRecord): Promise<void> {
    this.indexSession(r)
    this.emit({ type: 'session', id: r.id })
    return this.write('catalog', 'session', r)
  }

  /**
   * Writes a version to its project's partition. When the lineage moves to another partition (a
   * re-home, or an edit to global scope), a tombstone of the same version goes to the OLD one, so a
   * reload resolves to the newest place whatever the partition order, and nothing resurfaces in the
   * old place if the new partition is dropped.
   */
  putMemory(m: MemoryItem): Promise<void> {
    const prev = this.memory.get(m.id)
    this.indexMemory(m)
    this.emit({ type: 'memory', id: m.id })
    const to = partitionOf(m.projectId)
    const written = this.write(to, 'memory', m)
    if (!prev || partitionOf(prev.projectId) === to) return written
    return this.write(partitionOf(prev.projectId), 'memory', moveTombstone(prev, m))
  }

  putTask(t: Task): Promise<void> {
    this.tasks.set(t.id, t)
    this.emit({ type: 'task', id: t.id })
    return this.write(partitionOf(t.projectId), 'task', t)
  }

  putHandoff(h: Handoff): Promise<void> {
    this.handoffs.set(h.id, h)
    this.emit({ type: 'handoff', id: h.id })
    return this.write(partitionOf(h.projectId), 'handoff', h)
  }

  addActivity(e: ActivityEvent): Promise<void> {
    this.indexActivity(e)
    this.emit({ type: 'activity', event: e })
    return this.write(partitionOf(e.projectId), 'activity', e)
  }

  /** Appends or replaces a chat message; identical rewrites are skipped. */
  putChat(sessionId: string, m: ChatRecord): Promise<void> {
    const prev = this.chat.get(sessionId)?.find((x) => x.id === m.id)
    if (prev && JSON.stringify(prev) === JSON.stringify(m)) return Promise.resolve()
    this.indexChat(sessionId, m)
    this.emit({ type: 'chat', sessionId, message: m })
    return this.write(`s/${sessionId}`, 'message', m)
  }

  // ── reads ──

  sessionByAgent(agentId: string): SessionRecord | undefined {
    const id = this.byAgent.get(agentId)
    return id ? this.sessions.get(id) : undefined
  }

  /**
   * The session's auto-imported item: its approved lineage, else a retired one (capped items are
   * not recreated). Rejected ones (removed by the user) never count.
   */
  knowledgeOf(sessionId: string): MemoryItem | undefined {
    let best: MemoryItem | undefined
    for (const id of this.knowledgeBySession.get(sessionId) ?? []) {
      const m = this.memory.get(id)
      if (!m || m.state === 'rejected') continue
      const rank = (x: MemoryItem) => (x.state === 'approved' ? 1 : 0)
      if (!best || rank(m) > rank(best) || (rank(m) === rank(best) && m.updatedAt > best.updatedAt))
        best = m
    }
    return best
  }

  versions(memoryId: string): MemoryItem[] {
    return [...(this.memoryVersions.get(memoryId) ?? [])]
  }

  activityOf(projectId: string): ActivityEvent[] {
    return [...(this.activity.get(projectId) ?? [])]
  }

  recentActivity(projectId: string | undefined, limit: number): ActivityEvent[] {
    const all = projectId ? this.activityOf(projectId) : [...this.activity.values()].flat()
    return all.sort((a, b) => b.ts - a.ts).slice(0, limit)
  }

  chatOf(sessionId: string): ChatRecord[] {
    return [...(this.chat.get(sessionId) ?? [])]
  }

  // ── changes ──

  onChange(fn: (c: StoreChange) => void): () => void {
    this.subs.add(fn)
    return () => void this.subs.delete(fn)
  }

  emit(c: StoreChange): void {
    for (const fn of [...this.subs]) {
      try {
        fn(c)
      } catch {
        /* isolated */
      }
    }
  }

  // ── indexes ──

  private indexSession(r: SessionRecord): void {
    this.sessions.set(r.id, r)
    const cur = this.sessionByAgent(r.agentId)
    if (!cur || cur.id === r.id || cur.startedAt <= r.startedAt) this.byAgent.set(r.agentId, r.id)
  }

  private indexMemory(m: MemoryItem): void {
    const known = this.memoryVersions.get(m.id) ?? []
    // A move tombstone never replaces the live record of the same version.
    if (isMoveTombstone(m) && known.some((v) => v.version === m.version && !isMoveTombstone(v)))
      return
    const list = known.filter((v) => v.version !== m.version)
    list.push(m)
    list.sort((a, b) => a.version - b.version)
    this.memoryVersions.set(m.id, list)
    this.memory.set(m.id, list.at(-1)!)
    const sid = m.provenance?.sessionId
    if (m.provenance?.origin === IMPORT_ORIGIN && sid)
      this.knowledgeBySession.set(sid, (this.knowledgeBySession.get(sid) ?? new Set()).add(m.id))
  }

  private indexActivity(e: ActivityEvent): void {
    const list = this.activity.get(e.projectId) ?? []
    list.push(e)
    if (list.length > MAX_ACTIVITY) list.splice(0, list.length - MAX_ACTIVITY)
    this.activity.set(e.projectId, list)
  }

  private indexChat(sessionId: string, m: ChatRecord): void {
    const list = this.chat.get(sessionId) ?? []
    const i = list.findIndex((x) => x.id === m.id)
    if (i >= 0) list[i] = m
    else list.push(m)
    this.chat.set(sessionId, list)
  }
}
