// What the holo displays show (the atrium's giant screen, the Command Center's central holo): the
// selected project's name and counts from its ProjectDashboard, or the GlobalOverview's counts.
// Counts and names only (plan §7): never task titles, memory bodies, transcripts or paths.
import type { GlobalOverview, ProjectDashboard } from '@agent-office/shared'
import { SPECIAL_COPY } from './copy.ts'
import { plain } from './hud-vm.ts'

export interface DisplayInput {
  dashboard: ProjectDashboard | null
  overview: GlobalOverview | null
  /** Live counts from the office (working, waiting). */
  live: { active: number; waiting: number }
  now: number
}

export interface DisplayVM {
  title: string
  tiles: { label: string; value: number }[]
  footer: string
}

export function displayVM(i: DisplayInput): DisplayVM {
  const d = i.dashboard
  if (d) {
    const last = d.completed.reduce((m, c) => Math.max(m, c.at), -Infinity)
    return {
      title: plain(d.project.name),
      tiles: [
        { label: 'Active', value: d.active.length },
        { label: 'Waiting', value: d.active.filter((a) => a.status === 'waiting').length },
        { label: 'Completed', value: d.completed.length },
        { label: 'Open tasks', value: d.project.openTasks },
        { label: 'Pending memory', value: d.knowledge.pending },
        { label: 'Decisions', value: d.knowledge.decisions.length },
      ],
      footer: Number.isFinite(last)
        ? SPECIAL_COPY.display.lastCompletion(Math.floor(Math.max(0, i.now - last) / 60_000))
        : SPECIAL_COPY.display.noCompletions,
    }
  }
  const o = i.overview
  if (o)
    return {
      title: SPECIAL_COPY.allProjects,
      tiles: [
        { label: 'Projects', value: o.projects.filter((p) => !p.archived).length },
        { label: 'Active', value: i.live.active },
        { label: 'Waiting', value: o.waiting.length },
        { label: 'Approvals', value: o.pendingApprovals },
        { label: 'Handoffs', value: o.unfinishedHandoffs.length },
      ],
      footer: SPECIAL_COPY.display.vault(o.vault),
    }
  return {
    title: SPECIAL_COPY.allProjects,
    tiles: [
      { label: 'Active', value: i.live.active },
      { label: 'Waiting', value: i.live.waiting },
    ],
    footer: '',
  }
}
