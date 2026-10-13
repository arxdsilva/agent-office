// Read models for the workspace UI (docs/projects.md §9): the Global Overview, Project Dashboards
// and the `prj:push` stream. Ids, names, labels, counts and states only.
import type { GlobalOverview, ProjectDashboard, ProjectMessage } from '@agent-office/shared'
import { toActivityView } from '../domain/activity.ts'
import { assertAuthorized, USER, type Principal } from '../domain/authz.ts'
import { toMemoryView } from '../domain/memory.ts'
import { toSessionSummary } from '../domain/session-record.ts'
import { strongestEvidence, toTaskView } from '../domain/task.ts'
import type { AgentRepository } from '../ports/driven.ts'
import type { ProjectWorkspaceQuery } from '../ports/driving.ts'
import type { HandoffManager } from './handoff-service.ts'
import { projectDetail, projectSummary, requireProject, sortedProjects } from './project-views.ts'
import type { ProjectsStore, StoreChange } from './projects-store.ts'

const COMPLETIONS = new Set(['task.completed', 'session.ended', 'handoff.launched'])

export class WorkspaceQueryService implements ProjectWorkspaceQuery {
  constructor(
    private d: { store: ProjectsStore; agents: AgentRepository; handoffs: HandoffManager },
  ) {}

  overview(as: Principal = USER): GlobalOverview {
    assertAuthorized(as, 'project.manage', { kind: 'project', projectId: null }, undefined)
    const s = this.d.store
    const memory = [...s.memory.values()]
    return {
      projects: sortedProjects(s).map((p) => projectSummary(s, this.d.agents, p)),
      waiting: this.d.agents
        .list()
        .filter((a) => a.status === 'waiting' || (a.managed?.pending ?? 0) > 0)
        .map((a) => ({
          agentId: a.id,
          name: a.name,
          provider: a.provider,
          projectId: a.projectId ?? null,
        })),
      recentCompletions: s
        .recentActivity(undefined, 200)
        .filter((e) => COMPLETIONS.has(e.kind))
        .slice(0, 10)
        .map(toActivityView),
      recentDecisions: memory
        .filter((m) => m.kind === 'decision' && m.state === 'approved')
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 5)
        .map(toMemoryView),
      pendingApprovals: memory.filter((m) => m.state === 'pending').length,
      unfinishedHandoffs: this.d.handoffs.list().filter((h) => h.state === 'draft'),
      unassignedSessions: [...s.sessions.values()].filter(
        (r) => r.projectId === null && r.state !== 'archived',
      ).length,
      vault: s.status(),
    }
  }

  dashboard(projectId: string, as: Principal = USER): ProjectDashboard {
    const s = this.d.store
    const p = requireProject(s, projectId)
    assertAuthorized(as, 'project.manage', { kind: 'project', projectId }, p)
    const tasks = [...s.tasks.values()].filter((t) => t.projectId === p.id)
    const memory = [...s.memory.values()].filter((m) => m.projectId === p.id)
    const name = (id: string) => s.projects.get(id)?.name
    return {
      project: projectDetail(s, this.d.agents, p),
      active: this.d.agents
        .list()
        .filter((a) => a.projectId === p.id && a.status !== 'done')
        .map((a) => ({
          agentId: a.id,
          name: a.name,
          provider: a.provider,
          status: a.status,
          ...(a.tool || a.text ? { activity: (a.tool ?? a.text)!.slice(0, 80) } : {}),
        })),
      activity: s.recentActivity(p.id, 50).map(toActivityView),
      completed: tasks
        .filter((t) => t.state === 'done')
        .map((t) => ({
          taskId: t.id,
          title: t.title,
          evidence: strongestEvidence(t) ?? 'agent-reported',
          at: t.doneAt ?? t.createdAt,
        }))
        .sort((a, b) => b.at - a.at),
      tasks: tasks.sort((a, b) => b.createdAt - a.createdAt).map(toTaskView),
      knowledge: {
        approved: memory.filter((m) => m.state === 'approved').length,
        pending: memory.filter((m) => m.state === 'pending').length,
        decisions: memory
          .filter((m) => m.kind === 'decision' && m.state === 'approved')
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map(toMemoryView),
      },
      sessions: [...s.sessions.values()]
        .filter((r) => r.projectId === p.id)
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .slice(0, 50)
        .map((r) => toSessionSummary(r, name)),
    }
  }

  watch(fn: (m: ProjectMessage) => void): () => void {
    return this.d.store.onChange((c) => {
      const m = this.message(c)
      if (m) fn(m)
    })
  }

  private message(c: StoreChange): ProjectMessage | undefined {
    const s = this.d.store
    switch (c.type) {
      case 'project':
        return {
          type: 'projects',
          projects: sortedProjects(s).map((p) => projectSummary(s, this.d.agents, p)),
        }
      case 'session': {
        const r = s.sessions.get(c.id)
        return (
          r && { type: 'session', session: toSessionSummary(r, (id) => s.projects.get(id)?.name) }
        )
      }
      case 'memory': {
        const m = s.memory.get(c.id)
        return m && { type: 'memory', memory: toMemoryView(m) }
      }
      case 'activity':
        return { type: 'activity', event: toActivityView(c.event) }
      case 'retrieval':
        return {
          type: 'retrieval',
          projectId: c.projectId,
          agentId: c.agentId,
          memoryIds: [...c.memoryIds],
        }
      case 'agent-project':
        return { type: 'agent-project', agentId: c.agentId, projectId: c.projectId }
      case 'harness':
        return {
          type: 'harness',
          ...(c.harnessId ? { harnessId: c.harnessId } : {}),
          ...(c.projectId ? { projectId: c.projectId } : {}),
          ...(c.agentId ? { agentId: c.agentId } : {}),
        }
      default:
        return undefined
    }
  }
}
