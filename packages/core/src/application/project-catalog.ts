// Projects and their repository links (docs/projects.md §1, §4).
import type { ProjectDetail, ProjectSummary, ProviderId } from '@agent-office/shared'
import { assertAuthorized, USER, type Principal } from '../domain/authz.ts'
import { ValidationError } from '../domain/errors.ts'
import {
  addRepo,
  createProject,
  defaultPolicy,
  removeRepo,
  updateProject,
  type Project,
  type ProjectPatch,
} from '../domain/project.ts'
import type { AgentRepository, Clock, RepoIdentity } from '../ports/driven.ts'
import type { ProjectCatalog, ProjectRepos } from '../ports/driving.ts'
import { projectDetail, projectSummary, requireProject, sortedProjects } from './project-views.ts'
import type { ProjectsStore } from './projects-store.ts'

export interface CatalogDeps {
  store: ProjectsStore
  agents: AgentRepository
  clock: Clock
  repoIdentity?: RepoIdentity
  enabledProviders?: () => Promise<ProviderId[]>
  /** Repo links changed: refresh workspace keys and rematch unassigned sessions. */
  onReposChanged?: () => Promise<void>
}

export class ProjectCatalogService implements ProjectCatalog, ProjectRepos {
  constructor(private d: CatalogDeps) {}

  list(as: Principal = USER): ProjectSummary[] {
    assertAuthorized(as, 'project.manage', { kind: 'project', projectId: null }, undefined)
    return sortedProjects(this.d.store).map((p) => projectSummary(this.d.store, this.d.agents, p))
  }

  get(projectId: string, as: Principal = USER): ProjectDetail {
    const p = requireProject(this.d.store, projectId)
    assertAuthorized(as, 'project.manage', { kind: 'project', projectId }, p)
    return projectDetail(this.d.store, this.d.agents, p)
  }

  async create(
    o: { name: string; folders: string[] },
    as: Principal = USER,
  ): Promise<ProjectSummary> {
    assertAuthorized(as, 'project.manage', { kind: 'project', projectId: null }, undefined)
    const enabled = (await this.d.enabledProviders?.()) ?? (['claude-code'] as ProviderId[])
    let p = createProject({
      id: this.d.store.newId('prj'),
      name: o.name,
      now: this.d.clock.now(),
      index: this.d.store.projects.size,
      policy: defaultPolicy(enabled),
    })
    p = await this.link(p, o.folders)
    return this.save(p, o.folders.length > 0)
  }

  async update(
    o: { projectId: string } & ProjectPatch,
    as: Principal = USER,
  ): Promise<ProjectSummary> {
    const p = requireProject(this.d.store, o.projectId)
    assertAuthorized(as, 'project.manage', { kind: 'project', projectId: p.id }, p)
    const { projectId: _id, ...patch } = o
    return this.save(updateProject(p, patch, this.d.clock.now()), patch.archived !== undefined)
  }

  async addRepos(
    projectId: string,
    folders: string[],
    as: Principal = USER,
  ): Promise<ProjectSummary> {
    const p = requireProject(this.d.store, projectId)
    assertAuthorized(as, 'project.manage', { kind: 'project', projectId }, p)
    return this.save(await this.link(p, folders), true)
  }

  async removeRepo(
    projectId: string,
    repoId: string,
    as: Principal = USER,
  ): Promise<ProjectSummary> {
    const p = requireProject(this.d.store, projectId)
    assertAuthorized(as, 'project.manage', { kind: 'project', projectId }, p)
    return this.save(removeRepo(p, repoId), true)
  }

  repoPath(projectId: string, repoId: string): string | undefined {
    return this.d.store.projects.get(projectId)?.repos.find((r) => r.id === repoId)?.locator
  }

  private async link(p: Project, folders: string[]): Promise<Project> {
    if (folders.length && !this.d.repoIdentity)
      throw new ValidationError('repository discovery is not available')
    let next = p
    for (const folder of folders) {
      const identity = await this.d.repoIdentity!.resolve(folder).catch(() => null)
      if (!identity) throw new ValidationError('this folder cannot be linked')
      next = addRepo(next, { id: this.d.store.newId('rp'), identity, locator: folder })
    }
    return next
  }

  private async save(p: Project, reposChanged: boolean): Promise<ProjectSummary> {
    await this.d.store.putProject(p)
    if (reposChanged) await this.d.onReposChanged?.()
    return projectSummary(this.d.store, this.d.agents, p)
  }
}
