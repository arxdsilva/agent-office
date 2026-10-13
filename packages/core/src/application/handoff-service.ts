// Handoffs (docs/projects.md §5–§6): continue a session's work with another provider, with a
// reviewed context bundle delivered as a delimited data block in the first message.
import type { HandoffView, ProviderId } from '@agent-office/shared'
import { assertAuthorized, USER, type Principal } from '../domain/authz.ts'
import { NotFoundError, SessionStartError, ValidationError } from '../domain/errors.ts'
import {
  cancelHandoff,
  createHandoff,
  handoffFirstMessage,
  launchHandoff,
  renderContextBlock,
  updateHandoff,
  type BlockItem,
  type Handoff,
} from '../domain/handoff.ts'
import type { Project } from '../domain/project.ts'
import { toBundleView } from '../domain/context-rank.ts'
import type { Clock } from '../ports/driven.ts'
import type { HandoffService, ManagedSessions, StartSession } from '../ports/driving.ts'
import type { ActivityLog } from './activity-log.ts'
import type { ContextEngineService } from './context-engine.ts'
import { requireProject } from './project-views.ts'
import type { ProjectsStore } from './projects-store.ts'
import type { SessionVaultService } from './session-vault-service.ts'

export interface HandoffDeps {
  store: ProjectsStore
  context: ContextEngineService
  vault: SessionVaultService
  activity: ActivityLog
  clock: Clock
  sessions?: () => ManagedSessions | undefined
}

const runtime = (provider: string, projectId: string): Principal => ({
  kind: 'runtime',
  provider,
  projectId,
})

export class HandoffManager implements HandoffService {
  constructor(private d: HandoffDeps) {}

  async prepare(
    o: { sessionId: string; toProvider: ProviderId; objective: string },
    as: Principal = USER,
  ): Promise<HandoffView> {
    const r = this.d.store.sessions.get(o.sessionId)
    if (!r) throw new NotFoundError('session')
    if (!r.projectId) throw new ValidationError('assign the session to a project first')
    const project = requireProject(this.d.store, r.projectId)
    assertAuthorized(as, 'handoff.manage', { kind: 'project', projectId: project.id }, project)
    const ranked = this.d.context.bundleFor(runtime(o.toProvider, project.id), o.objective)
    const h = createHandoff({
      id: this.d.store.newId('hof'),
      projectId: project.id,
      from: { sessionId: r.id, provider: r.provider, title: r.title },
      toProvider: o.toProvider,
      objective: o.objective,
      bundle: toBundleView(project.id, o.objective, ranked),
      include: ranked.items.filter((i) => i.included).map((i) => i.ref.id),
      now: this.d.clock.now(),
    })
    await this.d.store.putHandoff(h)
    void this.d.activity.add(
      project.id,
      'handoff.prepared',
      'you',
      `Prepared a handoff to ${o.toProvider}`,
      { handoffId: h.id, sessionId: r.id },
    )
    return this.view(h)
  }

  async update(
    o: { handoffId: string; note?: string; include?: string[] },
    as: Principal = USER,
  ): Promise<HandoffView> {
    const h = this.require(o.handoffId, as)
    let bundle = h.bundle
    if (o.include) {
      const keep = new Set(o.include)
      const exclude = new Set(h.bundle.items.map((i) => i.ref.id).filter((id) => !keep.has(id)))
      bundle = toBundleView(
        h.projectId,
        h.objective,
        this.d.context.bundleFor(runtime(h.toProvider, h.projectId), h.objective, exclude),
      )
    }
    const next = updateHandoff(h, {
      ...(o.note !== undefined ? { note: o.note } : {}),
      ...(o.include
        ? { include: bundle.items.filter((i) => i.included).map((i) => i.ref.id), bundle }
        : {}),
    })
    await this.d.store.putHandoff(next)
    return this.view(next)
  }

  async launch(handoffId: string, as: Principal = USER): Promise<{ agentId: string }> {
    const h = this.require(handoffId, as)
    if (h.state !== 'draft') throw new ValidationError(`this handoff is ${h.state}`)
    this.managed()
    const project = requireProject(this.d.store, h.projectId)
    const from = this.d.store.sessions.get(h.from.sessionId)
    const items = this.deliverable(h.toProvider, project, h.include)
    const agentId = await this.start({
      provider: h.toProvider,
      projectId: project.id,
      cwd: this.cwd(project, from?.repoId),
      name: `${project.name} · handoff`.slice(0, 40),
      mode: 'default',
      extraDirs: [],
      chrome: false,
      first: { text: handoffFirstMessage(h, items), context: [], use: [] },
    })
    const rec = this.d.vault.ensure(agentId, h.toProvider, { origin: 'managed' })
    const continued = {
      ...rec,
      continuedFrom: { handoffId: h.id, sessionId: h.from.sessionId, provider: h.from.provider },
    }
    if (continued.projectId !== project.id)
      await this.d.vault.applyAssignment(continued, project.id, 'user', 'handoff')
    else await this.d.store.putSession(continued)
    await this.d.store.putHandoff(launchHandoff(h, rec.id, this.d.clock.now()))
    void this.d.activity.add(
      project.id,
      'handoff.launched',
      'you',
      `Launched a handoff to ${h.toProvider}`,
      { handoffId: h.id, sessionId: rec.id, agentId },
    )
    await this.d.context.recordDelivered(
      project.id,
      rec.id,
      agentId,
      items.map((i) => i.id),
      'handoff',
    )
    return { agentId }
  }

  async cancel(handoffId: string, as: Principal = USER): Promise<HandoffView> {
    const next = cancelHandoff(this.require(handoffId, as))
    await this.d.store.putHandoff(next)
    return this.view(next)
  }

  list(projectId?: string, as: Principal = USER): HandoffView[] {
    assertAuthorized(
      as,
      'handoff.manage',
      { kind: 'project', projectId: projectId ?? null },
      undefined,
    )
    return [...this.d.store.handoffs.values()]
      .filter((h) => !projectId || h.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((h) => this.view(h))
  }

  async startWithContext(
    o: StartSession & { projectId: string },
    memoryIds: string[],
    as: Principal = USER,
  ): Promise<string> {
    const project = requireProject(this.d.store, o.projectId)
    assertAuthorized(as, 'handoff.manage', { kind: 'project', projectId: project.id }, project)
    const items = this.deliverable(o.provider ?? 'claude-code', project, memoryIds)
    const block = renderContextBlock(items)
    const agentId = await this.start({
      ...o,
      first: { ...o.first, text: block ? `${o.first.text}\n\n${block}` : o.first.text },
    })
    if (items.length) {
      const rec = this.d.vault.ensure(agentId, o.provider ?? 'claude-code', { origin: 'managed' })
      await this.d.context.recordDelivered(
        project.id,
        rec.id,
        agentId,
        items.map((i) => i.id),
        'first-message',
      )
    }
    return agentId
  }

  /** The chosen items the target may still receive now (approved, readable, in budget order). */
  private deliverable(provider: string, project: Project, ids: string[]): BlockItem[] {
    const want = new Set(ids)
    const ranked = this.d.context.bundleFor(runtime(provider, project.id))
    return ranked.items
      .filter((i) => want.has(i.ref.id))
      .map((i) => ({
        id: i.ref.id,
        version: i.version,
        kind: i.kind,
        title: i.title,
        body: i.body,
      }))
  }

  private cwd(project: Project, repoId: string | undefined): string {
    const repo = project.repos.find((r) => r.id === repoId) ?? project.repos[0]
    if (!repo) throw new ValidationError('link a repository to this project first')
    return repo.locator
  }

  private managed(): ManagedSessions {
    const sessions = this.d.sessions?.()
    if (!sessions) throw new SessionStartError('runtime')
    return sessions
  }

  private start(o: StartSession): Promise<string> {
    return this.managed().start(o)
  }

  private require(id: string, as: Principal): Handoff {
    const h = this.d.store.handoffs.get(id)
    if (!h) throw new NotFoundError('handoff')
    assertAuthorized(
      as,
      'handoff.manage',
      { kind: 'project', projectId: h.projectId },
      this.d.store.projects.get(h.projectId),
    )
    return h
  }

  private view(h: Handoff): HandoffView {
    return {
      id: h.id,
      projectId: h.projectId,
      from: { ...h.from },
      toProvider: h.toProvider,
      objective: h.objective,
      note: h.note,
      bundle: h.bundle,
      state: h.state,
      ...(h.launchedSessionId ? { launchedSessionId: h.launchedSessionId } : {}),
    }
  }
}
