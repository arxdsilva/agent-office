// The projects layer's in-memory state, rebuilt from the vault (RecordLog) at startup and appended
// on every change (docs/projects.md §3). Partitions: 'catalog' (projects, repo links, session
// records, assignments, project-less memory), 'p/<prj>' (memory versions, tasks, handoffs,
// activity), 's/<ses>' (agent-office chat, harness snapshot, harness events and gate results of
// that session). Harness versions live in 'catalog' (docs/harness.md §1).
import type { ActivityEvent } from '../domain/activity.ts'
import type { Handoff } from '../domain/handoff.ts'
import type { GateResult, Harness, HarnessEvent, HarnessSnapshot } from '../domain/harness-types.ts'
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
  | { type: 'harness'; harnessId?: string; projectId?: string; agentId?: string }

/** A gate the trusted runner is executing now (memory only; the final GateResult is stored). */
export type RunningGate = Pick<
  GateResult,
  'gateId' | 'name' | 'required' | 'harnessVersion' | 'startedAt'
>

export interface StoreDeps {
  log: RecordLog
  clock: Clock
  /** Ids come from it when present (else a non-secure fallback; never used for tokens). */
  random?: SecureRandom
  logger: Logger
}

const MAX_ACTIVITY = 2000
const MAX_HARNESS_EVENTS = 500
const MAX_GATE_RESULTS = 100
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
  if (r.t === 'harness') return `harness:${String(d.id)}:${String(d.version)}`
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
  /** Harness lineage id → every version, oldest first. */
  private harnesses = new Map<string, Harness[]>()
  private snapshots = new Map<string, HarnessSnapshot>()
  private harnessEvents = new Map<string, HarnessEvent[]>()
  private gateResults = new Map<string, GateResult[]>()
  private running = new Map<string, Map<string, RunningGate>>()
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
      case 'harness':
        if (hasId(d, 'hrn_') && typeof d.version === 'number' && Array.isArray(d.rules))
          this.indexHarness(d as unknown as Harness)
        return
      case 'harness-snapshot':
        if (hasId(d, 'hsn_') && typeof d.sessionId === 'string')
          this.snapshots.set(d.sessionId, d as unknown as HarnessSnapshot)
        return
      case 'harness-event':
        if (hasId(d, 'hev_') && typeof d.sessionId === 'string')
          this.indexHarnessEvent(d as unknown as HarnessEvent)
        return
      case 'gate-result':
        if (hasId(d, 'gtr_') && typeof d.sessionId === 'string')
          this.indexGateResult(d as unknown as GateResult)
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

  putHarness(h: Harness): Promise<void> {
    this.indexHarness(h)
    this.emit({ type: 'harness', harnessId: h.id })
    return this.write('catalog', 'harness', h)
  }

  putHarnessSnapshot(s: HarnessSnapshot): Promise<void> {
    this.snapshots.set(s.sessionId, s)
    this.emit({ type: 'harness', agentId: s.agentId, projectId: s.projectId })
    return this.write(`s/${s.sessionId}`, 'harness-snapshot', s)
  }

  addHarnessEvent(e: HarnessEvent): Promise<void> {
    this.indexHarnessEvent(e)
    this.emit({ type: 'harness', agentId: e.agentId, projectId: e.projectId })
    return this.write(`s/${e.sessionId}`, 'harness-event', e)
  }

  putGateResult(r: GateResult): Promise<void> {
    this.indexGateResult(r)
    this.emit({ type: 'harness', projectId: r.projectId })
    return this.write(`s/${r.sessionId}`, 'gate-result', r)
  }

  /** Marks a gate running (memory only); `undefined` clears `gateId`. */
  setGateRunning(sessionId: string, g: RunningGate | undefined, gateId = g?.gateId): void {
    const m = this.running.get(sessionId) ?? new Map<string, RunningGate>()
    if (g) m.set(g.gateId, g)
    else if (gateId) m.delete(gateId)
    if (m.size) this.running.set(sessionId, m)
    else this.running.delete(sessionId)
  }

  // ── reads ──

  harnessVersions(id: string): Harness[] {
    return [...(this.harnesses.get(id) ?? [])]
  }

  /** The latest version of a lineage. */
  harness(id: string): Harness | undefined {
    return this.harnesses.get(id)?.at(-1)
  }

  /** The latest version of every lineage. */
  allHarnesses(): Harness[] {
    return [...this.harnesses.values()].map((v) => v.at(-1)!)
  }

  harnessSnapshot(sessionId: string): HarnessSnapshot | undefined {
    return this.snapshots.get(sessionId)
  }

  harnessEventsOf(sessionId: string): HarnessEvent[] {
    return [...(this.harnessEvents.get(sessionId) ?? [])]
  }

  gateResultsOf(sessionId: string): GateResult[] {
    return [...(this.gateResults.get(sessionId) ?? [])]
  }

  runningGates(sessionId: string): RunningGate[] {
    return [...(this.running.get(sessionId)?.values() ?? [])]
  }

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

  private indexHarness(h: Harness): void {
    const list = (this.harnesses.get(h.id) ?? []).filter((v) => v.version !== h.version)
    list.push(h)
    list.sort((a, b) => a.version - b.version)
    this.harnesses.set(h.id, list)
  }

  private indexHarnessEvent(e: HarnessEvent): void {
    const list = this.harnessEvents.get(e.sessionId) ?? []
    list.push(e)
    if (list.length > MAX_HARNESS_EVENTS) list.splice(0, list.length - MAX_HARNESS_EVENTS)
    this.harnessEvents.set(e.sessionId, list)
  }

  private indexGateResult(r: GateResult): void {
    const list = this.gateResults.get(r.sessionId) ?? []
    const i = list.findIndex((x) => x.id === r.id)
    if (i >= 0) list[i] = r
    else list.push(r)
    if (list.length > MAX_GATE_RESULTS) list.splice(0, list.length - MAX_GATE_RESULTS)
    this.gateResults.set(r.sessionId, list)
  }

  private indexChat(sessionId: string, m: ChatRecord): void {
    const list = this.chat.get(sessionId) ?? []
    const i = list.findIndex((x) => x.id === m.id)
    if (i >= 0) list[i] = m
    else list.push(m)
    this.chat.set(sessionId, list)
  }
}
