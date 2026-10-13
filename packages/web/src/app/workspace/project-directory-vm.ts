// The project directory shown at reception in the 3D and 2D offices: projects with counts and actions.
import type { ProjectSummary } from '@agent-office/shared'
import type { ProjectDirectoryEntryVM, ProjectDirectoryVM } from './types.ts'
import { WS_COPY } from './workspace-copy.ts'

const D = WS_COPY.directory

export function projectDirectoryVM(
  projects: ProjectSummary[],
  selectedId: string | null,
): ProjectDirectoryVM {
  const entries: ProjectDirectoryEntryVM[] = projects
    .filter((p) => !p.archived)
    .map((p) => ({
      projectId: p.id,
      name: p.name,
      color: p.color,
      selected: p.id === selectedId,
      counts: {
        agents: p.activeAgents,
        sessions: p.sessions,
        memories: p.approvedMemories,
        pending: p.pendingMemories,
        tasks: p.openTasks,
      },
      countsLabel: D.counts(p.activeAgents, p.sessions, p.approvedMemories, p.pendingMemories),
      actions: [
        {
          id: 'dashboard',
          label: D.dashboard,
          enabled: true,
          action: { type: 'open-project', projectId: p.id },
        },
        {
          id: 'memory',
          label: D.memory,
          enabled: true,
          action: { type: 'open-memory', projectId: p.id },
        },
        {
          id: 'sessions',
          label: D.sessions,
          enabled: true,
          action: { type: 'open-sessions', projectId: p.id },
        },
        {
          id: 'context',
          label: D.context,
          enabled: true,
          action: { type: 'inspect-context', projectId: p.id },
        },
        {
          id: 'start',
          label: D.start,
          enabled: true,
          action: { type: 'start-agent', projectId: p.id },
        },
      ],
    }))
  return {
    heading: D.heading,
    entries,
    empty: D.empty,
    createProject: {
      id: 'create-project',
      label: WS_COPY.newProjectLabel,
      enabled: true,
      action: { type: 'new-project' },
    },
  }
}
