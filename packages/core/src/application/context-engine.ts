// The Context Engine (docs/projects.md §6): what a principal may receive, ranked and explained;
// and the Context Inspector's available / retrieved / delivered (never what a model "used").
import type { ContextBundleView, ContextInspection, ProviderId } from '@agent-office/shared'
import { assertAuthorized, authorize, USER, type Principal } from '../domain/authz.ts'
import {
  rankContext,
  toBundleView,
  type ContextCandidate,
  type RankedContext,
} from '../domain/context-rank.ts'
import type { Project } from '../domain/project.ts'
import type { Clock } from '../ports/driven.ts'
import type { ContextEngine } from '../ports/driving.ts'
import type { ActivityLog } from './activity-log.ts'
import { requireProject } from './project-views.ts'
import type { ProjectsStore } from './projects-store.ts'

/** A provider id no one has: lets the user preview "what the policy exposes" through authz. */
const PREVIEW = '__preview__'

export interface ContextDeps {
  store: ProjectsStore
  activity: ActivityLog
  clock: Clock
}

export class ContextEngineService implements ContextEngine {
  constructor(private d: ContextDeps) {}

  preview(
    o: { projectId: string; objective?: string; provider?: ProviderId },
    as: Principal = USER,
  ): ContextBundleView {
    const project = requireProject(this.d.store, o.projectId)
    assertAuthorized(as, 'context.preview', { kind: 'project', projectId: project.id }, project)
    const r = o.provider
      ? this.bundleFor(
          { kind: 'runtime', provider: o.provider, projectId: project.id },
          o.objective,
        )
      : this.rank(this.policyView(project), o.objective)
    return toBundleView(project.id, o.objective, r)
  }

  /** The ranked bundle `p` (an agent or a runtime) may receive. */
  bundleFor(p: Principal, objective?: string, exclude?: ReadonlySet<string>): RankedContext {
    if (p.kind === 'user') throw new Error('bundleFor needs an agent principal')
    const project = this.d.store.projects.get(p.projectId)
    return this.rank(project ? { p, project } : undefined, objective, exclude)
  }

  inspect(agentId: string, as: Principal = USER): ContextInspection {
    assertAuthorized(as, 'session.read', { kind: 'session', projectId: null }, undefined)
    const r = this.d.store.sessionByAgent(agentId)
    if (!r?.projectId)
      return {
        agentId,
        projectId: r?.projectId ?? null,
        available: 0,
        retrieved: [],
        delivered: [],
      }
    const mine = this.d.store.activityOf(r.projectId).filter((e) => e.refs?.sessionId === r.id)
    const runtime: Principal = { kind: 'runtime', provider: r.provider, projectId: r.projectId }
    return {
      agentId,
      projectId: r.projectId,
      available: this.candidates(runtime, this.d.store.projects.get(r.projectId)).length,
      retrieved: mine
        .filter((e) => e.kind === 'mcp.retrieval')
        .map((e) => ({
          ts: e.ts,
          tool: e.data?.tool ?? '',
          ...(e.data?.query ? { query: e.data.query } : {}),
          memoryIds: (e.data?.returned ?? []).map((x) => x.id),
        })),
      delivered: mine
        .filter((e) => e.kind === 'context.delivered')
        .map((e) => ({
          ts: e.ts,
          memoryIds: [...(e.data?.memoryIds ?? [])],
          via: e.data?.via ?? 'first-message',
        })),
    }
  }

  recordDelivered(
    projectId: string,
    sessionId: string,
    agentId: string,
    memoryIds: string[],
    via: 'first-message' | 'handoff',
  ): Promise<void> {
    return this.d.activity.add(
      projectId,
      'context.delivered',
      'agent-office',
      `Delivered ${memoryIds.length} item${memoryIds.length === 1 ? '' : 's'} to the agent`,
      { sessionId, agentId },
      { memoryIds: [...memoryIds], via },
    )
  }

  recordRetrieval(
    p: Exclude<Principal, { kind: 'user' }>,
    agentId: string | undefined,
    tool: string,
    query: string | undefined,
    returned: { id: string; version: number }[],
  ): Promise<void> {
    const sessionId = p.kind === 'mcp' ? p.sessionId : undefined
    this.d.store.emit({
      type: 'retrieval',
      projectId: p.projectId,
      agentId: agentId ?? '',
      memoryIds: returned.map((x) => x.id),
    })
    return this.d.activity.add(
      p.projectId,
      'mcp.retrieval',
      p.provider,
      `${tool}: retrieved ${returned.length} item${returned.length === 1 ? '' : 's'}`,
      { ...(sessionId ? { sessionId } : {}), ...(agentId ? { agentId } : {}) },
      { tool, ...(query ? { query } : {}), returned },
    )
  }

  /** Approved memory (+ summaries with `sessionExcerpts`) the principal may read in its project. */
  candidates(p: Principal, project: Project | undefined): ContextCandidate[] {
    return project ? this.candidatesIn(p, project) : []
  }

  private policyView(project: Project): { p: Principal; project: Project } {
    return {
      p: { kind: 'runtime', provider: PREVIEW, projectId: project.id },
      project: {
        ...project,
        policy: {
          ...project.policy,
          providers: { ...project.policy.providers, [PREVIEW]: 'read' },
        } as Project['policy'],
      },
    }
  }

  private rank(
    v: { p: Principal; project: Project } | undefined,
    objective?: string,
    exclude?: ReadonlySet<string>,
  ): RankedContext {
    const cands = v ? this.candidatesIn(v.p, v.project) : []
    return rankContext(cands, {
      ...(objective ? { objective } : {}),
      now: this.d.clock.now(),
      ...(exclude ? { exclude } : {}),
    })
  }

  /** Like `candidates`, but authorized against the given (possibly synthetic) project object. */
  private candidatesIn(p: Principal, project: Project): ContextCandidate[] {
    if (p.kind === 'user') return []
    const out: ContextCandidate[] = []
    for (const m of this.d.store.memory.values())
      if (
        authorize(
          p,
          'memory.read',
          { kind: 'memory', projectId: m.projectId, scope: m.scope, state: m.state },
          project,
        ).ok
      )
        out.push({
          ref: { kind: 'memory', id: m.id },
          version: m.version,
          kind: m.kind,
          scope: m.scope,
          title: m.title,
          body: m.body,
          ts: m.updatedAt,
        })
    if (authorize(p, 'summary.read', { kind: 'summary', projectId: project.id }, project).ok)
      for (const s of this.d.store.sessions.values())
        if (s.projectId === project.id && s.summary)
          out.push({
            ref: { kind: 'summary', id: s.id },
            version: 1,
            kind: 'summary',
            scope: 'session',
            title: s.title,
            body: s.summary.text,
            ts: s.lastSeenAt,
          })
    return out
  }
}
