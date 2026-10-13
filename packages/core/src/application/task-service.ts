// Project tasks with evidence levels (docs/projects.md §8). User actions; agents never write tasks.
import type { EvidenceLevel, TaskView } from '@agent-office/shared'
import { assertAuthorized, USER, type Principal } from '../domain/authz.ts'
import { NotFoundError } from '../domain/errors.ts'
import {
  addEvidence,
  createTask,
  setTaskState,
  toTaskView,
  type Task,
  type TaskState,
} from '../domain/task.ts'
import type { Clock } from '../ports/driven.ts'
import type { ActivityLog } from './activity-log.ts'
import { requireProject } from './project-views.ts'
import type { ProjectsStore } from './projects-store.ts'

export class TaskService {
  constructor(private d: { store: ProjectsStore; activity: ActivityLog; clock: Clock }) {}

  list(projectId: string, as: Principal = USER): TaskView[] {
    assertAuthorized(as, 'project.manage', { kind: 'project', projectId }, undefined)
    return [...this.d.store.tasks.values()]
      .filter((t) => t.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(toTaskView)
  }

  async create(
    projectId: string,
    title: string,
    o: { sessionId?: string; source?: Task['source'] } = {},
    as: Principal = USER,
  ): Promise<TaskView> {
    const p = requireProject(this.d.store, projectId)
    assertAuthorized(as, 'project.manage', { kind: 'project', projectId }, p)
    const t = createTask({
      id: this.d.store.newId('tsk'),
      projectId,
      title,
      source: o.source ?? 'user',
      now: this.d.clock.now(),
      ...(o.sessionId ? { sessionId: o.sessionId } : {}),
    })
    await this.d.store.putTask(t)
    void this.d.activity.add(projectId, 'task.created', 'you', `Task “${t.title}”`, {})
    return toTaskView(t)
  }

  async setState(taskId: string, state: TaskState, as: Principal = USER): Promise<TaskView> {
    const t = this.require(taskId, as)
    const next = setTaskState(t, state, this.d.clock.now())
    await this.d.store.putTask(next)
    if (state === 'done')
      void this.d.activity.add(t.projectId, 'task.completed', 'you', `Completed “${t.title}”`, {})
    return toTaskView(next)
  }

  async addEvidence(
    taskId: string,
    e: { level: EvidenceLevel; ref?: string; note?: string },
    as: Principal = USER,
  ): Promise<TaskView> {
    const t = this.require(taskId, as)
    const next = addEvidence(t, { ...e, at: this.d.clock.now() })
    await this.d.store.putTask(next)
    return toTaskView(next)
  }

  private require(id: string, as: Principal): Task {
    const t = this.d.store.tasks.get(id)
    if (!t) throw new NotFoundError('task')
    assertAuthorized(
      as,
      'project.manage',
      { kind: 'project', projectId: t.projectId },
      this.d.store.projects.get(t.projectId),
    )
    return t
  }
}
