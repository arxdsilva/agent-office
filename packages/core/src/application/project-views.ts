// Store state → the IPC views of shared/projects.ts. Never paths, keys, remotes or tokens.
import type { ProjectDetail, ProjectSummary } from '@agent-office/shared'
import { NotFoundError } from '../domain/errors.ts'
import type { Project } from '../domain/project.ts'
import type { AgentRepository } from '../ports/driven.ts'
import type { ProjectsStore } from './projects-store.ts'

export function requireProject(store: ProjectsStore, id: string): Project {
  const p = store.projects.get(id)
  if (!p) throw new NotFoundError('project')
  return p
}

export function projectSummary(
  store: ProjectsStore,
  agents: AgentRepository,
  p: Project,
): ProjectSummary {
  let sessions = 0
  for (const s of store.sessions.values()) if (s.projectId === p.id) sessions++
  let approved = 0
  let pending = 0
  for (const m of store.memory.values())
    if (m.projectId === p.id) {
      if (m.state === 'approved') approved++
      else if (m.state === 'pending') pending++
    }
  let openTasks = 0
  for (const t of store.tasks.values())
    if (t.projectId === p.id && (t.state === 'open' || t.state === 'doing')) openTasks++
  const last = store.recentActivity(p.id, 1)[0]?.ts
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    repos: p.repos.map((r) => ({ id: r.id, label: r.label, isWorktree: r.identity.isWorktree })),
    activeAgents: agents.list().filter((a) => a.projectId === p.id && a.status !== 'done').length,
    sessions,
    approvedMemories: approved,
    pendingMemories: pending,
    openTasks,
    ...(last !== undefined ? { lastActivityAt: last } : {}),
    archived: p.archivedAt !== undefined,
    harnessIds: (p.harnesses ?? []).map((h) => h.harnessId),
  }
}

export function projectDetail(
  store: ProjectsStore,
  agents: AgentRepository,
  p: Project,
): ProjectDetail {
  return {
    ...projectSummary(store, agents, p),
    policy: JSON.parse(JSON.stringify(p.policy)) as ProjectDetail['policy'],
    createdAt: p.createdAt,
  }
}

/** Active projects first (by name), archived last. */
export function sortedProjects(store: ProjectsStore): Project[] {
  return [...store.projects.values()].sort(
    (a, b) =>
      Number(a.archivedAt !== undefined) - Number(b.archivedAt !== undefined) ||
      a.name.localeCompare(b.name),
  )
}
