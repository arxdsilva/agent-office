// Appends meaningful activity to a project's partition (docs/projects.md §7).
import type { ActivityKind } from '@agent-office/shared'
import { newActivity, type ActivityData, type ActivityEvent } from '../domain/activity.ts'
import type { Clock } from '../ports/driven.ts'
import type { ProjectsStore } from './projects-store.ts'

export class ActivityLog {
  constructor(private d: { store: ProjectsStore; clock: Clock }) {}

  add(
    projectId: string,
    kind: ActivityKind,
    actor: string,
    text: string,
    refs?: ActivityEvent['refs'],
    data?: ActivityData,
  ): Promise<void> {
    return this.d.store.addActivity(
      newActivity({
        id: this.d.store.newId('act'),
        projectId,
        ts: this.d.clock.now(),
        kind,
        actor,
        text,
        ...(refs ? { refs } : {}),
        ...(data ? { data } : {}),
      }),
    )
  }
}
