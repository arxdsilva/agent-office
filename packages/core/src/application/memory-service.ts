// Shared project memory with review and provenance (docs/projects.md §1, §2, §5).
import type {
  MemoryDraft,
  MemoryKind,
  MemoryOrigin,
  MemoryScope,
  MemoryState,
  MemoryView,
} from '@agent-office/shared'
import { assertAuthorized, authorize, USER, type Principal } from '../domain/authz.ts'
import { NotFoundError } from '../domain/errors.ts'
import {
  approveMemory,
  createMemory,
  editMemory,
  mergeMemories,
  rejectMemory,
  supersedeMemory,
  toMemoryView,
  type MemoryItem,
} from '../domain/memory.ts'
import type { Clock } from '../ports/driven.ts'
import type { McpPrincipal, MemoryService } from '../ports/driving.ts'
import type { ActivityLog } from './activity-log.ts'
import { requireProject } from './project-views.ts'
import type { ProjectsStore } from './projects-store.ts'

const USER_ONLY = { kind: 'memory', projectId: null, scope: 'project', state: 'pending' } as const

export interface MemoryDeps {
  store: ProjectsStore
  activity: ActivityLog
  clock: Clock
}

export class ProjectMemoryService implements MemoryService {
  constructor(private d: MemoryDeps) {}

  list(
    o: { scope: string; states?: MemoryState[]; query?: string; origin?: MemoryOrigin },
    as: Principal = USER,
  ): MemoryView[] {
    assertAuthorized(as, 'memory.review', USER_ONLY, undefined)
    const q = o.query?.trim().toLowerCase()
    return [...this.d.store.memory.values()]
      .filter((m) =>
        o.scope === 'global'
          ? m.projectId === null && (m.scope === 'global' || m.scope === 'workspace')
          : o.scope === 'unassigned'
            ? m.projectId === null && m.scope === 'session'
            : m.projectId === o.scope,
      )
      .filter((m) => !o.states || o.states.includes(m.state))
      .filter((m) => !o.origin || m.provenance.origin === o.origin)
      .filter((m) => !q || `${m.title}\n${m.body}`.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(toMemoryView)
  }

  async create(draft: MemoryDraft, as: Principal = USER): Promise<MemoryView> {
    assertAuthorized(as, 'memory.review', USER_ONLY, undefined)
    const m = this.fromDraft(draft)
    await this.d.store.putMemory(m)
    return toMemoryView(m)
  }

  /** An agent's proposal (MCP `propose_memory`): pending, in the principal's own project. */
  async propose(
    p: McpPrincipal,
    o: { kind: MemoryKind; title: string; body: string; rationale?: string },
  ): Promise<MemoryView> {
    const project = this.d.store.projects.get(p.projectId)
    assertAuthorized(
      p,
      'memory.propose',
      { kind: 'memory', projectId: p.projectId, scope: 'project', state: 'pending' },
      project,
    )
    const body = o.rationale?.trim()
      ? `${o.body.trim()}\n\nRationale: ${o.rationale.trim()}`
      : o.body
    const m = createMemory({
      id: this.d.store.newId('mem'),
      projectId: p.projectId,
      scope: 'project',
      kind: o.kind,
      title: o.title,
      body,
      origin: 'agent-proposal',
      createdBy: p.provider,
      provider: p.provider,
      ...(p.sessionId ? { sessionId: p.sessionId } : {}),
      now: this.d.clock.now(),
    })
    await this.d.store.putMemory(m)
    void this.d.activity.add(p.projectId, 'memory.proposed', p.provider, `Proposed “${m.title}”`, {
      memoryId: m.id,
      ...(p.sessionId ? { sessionId: p.sessionId } : {}),
    })
    return toMemoryView(m)
  }

  async review(
    memoryId: string,
    action: 'approve' | 'reject',
    as: Principal = USER,
  ): Promise<MemoryView> {
    const m = this.require(memoryId)
    assertAuthorized(as, 'memory.review', this.res(m), this.projectOf(m))
    const now = this.d.clock.now()
    const next = action === 'approve' ? approveMemory(m, now) : rejectMemory(m, now)
    await this.d.store.putMemory(next)
    this.log(
      next,
      action === 'approve' ? 'memory.approved' : 'memory.rejected',
      action === 'approve' ? 'Approved' : 'Rejected',
    )
    return toMemoryView(next)
  }

  async edit(
    o: { memoryId: string; title?: string; body?: string; kind?: MemoryKind; scope?: MemoryScope },
    as: Principal = USER,
  ): Promise<MemoryView> {
    const m = this.require(o.memoryId)
    assertAuthorized(as, 'memory.review', this.res(m), this.projectOf(m))
    const { memoryId: _id, ...patch } = o
    const next = editMemory(m, patch, this.d.clock.now())
    await this.d.store.putMemory(next)
    return toMemoryView(next)
  }

  async supersede(
    memoryId: string,
    replacement: MemoryDraft,
    as: Principal = USER,
  ): Promise<MemoryView> {
    const m = this.require(memoryId)
    assertAuthorized(as, 'memory.review', this.res(m), this.projectOf(m))
    const r = supersedeMemory(m, this.fromDraft(replacement), this.d.clock.now())
    await this.d.store.putMemory(r.replacement)
    await this.d.store.putMemory(r.old)
    this.log(r.old, 'memory.superseded', 'Superseded')
    return toMemoryView(r.replacement)
  }

  async merge(memoryIds: string[], into: MemoryDraft, as: Principal = USER): Promise<MemoryView> {
    const items = memoryIds.map((id) => this.require(id))
    for (const m of items) assertAuthorized(as, 'memory.review', this.res(m), this.projectOf(m))
    const r = mergeMemories(items, this.fromDraft(into), this.d.clock.now())
    await this.d.store.putMemory(r.merged)
    for (const s of r.sources) {
      await this.d.store.putMemory(s)
      this.log(s, 'memory.superseded', 'Merged')
    }
    return toMemoryView(r.merged)
  }

  versions(memoryId: string, as: Principal = USER): MemoryView[] {
    const m = this.require(memoryId)
    assertAuthorized(as, 'memory.review', this.res(m), this.projectOf(m))
    return this.d.store.versions(memoryId).map(toMemoryView)
  }

  /** Every item `p` may read now (approved; own project + listed scopes), newest first. */
  readable(p: Principal): MemoryItem[] {
    const project = p.kind === 'user' ? undefined : this.d.store.projects.get(p.projectId)
    return [...this.d.store.memory.values()]
      .filter((m) => authorize(p, 'memory.read', this.res(m), project).ok)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private fromDraft(draft: MemoryDraft): MemoryItem {
    if (draft.projectId) requireProject(this.d.store, draft.projectId)
    let provider: string | undefined
    if (draft.from) {
      const s = this.d.store.sessions.get(draft.from.sessionId)
      if (!s) throw new NotFoundError('session')
      provider = s.provider
    }
    return createMemory({
      id: this.d.store.newId('mem'),
      projectId: draft.projectId,
      scope: draft.scope,
      kind: draft.kind,
      title: draft.title,
      body: draft.body,
      origin: 'user',
      createdBy: 'you',
      ...(provider ? { provider } : {}),
      ...(draft.from ? { sessionId: draft.from.sessionId, messageId: draft.from.messageId } : {}),
      now: this.d.clock.now(),
    })
  }

  private log(
    m: MemoryItem,
    kind: 'memory.approved' | 'memory.rejected' | 'memory.superseded',
    verb: string,
  ) {
    if (m.projectId)
      void this.d.activity.add(m.projectId, kind, 'you', `${verb} “${m.title}”`, { memoryId: m.id })
  }

  private require(id: string): MemoryItem {
    const m = this.d.store.memory.get(id)
    if (!m) throw new NotFoundError('memory')
    return m
  }

  private projectOf(m: MemoryItem) {
    return m.projectId ? this.d.store.projects.get(m.projectId) : undefined
  }

  private res(m: MemoryItem) {
    return { kind: 'memory' as const, projectId: m.projectId, scope: m.scope, state: m.state }
  }
}
