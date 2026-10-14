// The shell: sidebar, project list and top bar.
import type { ProviderState, ProviderStatus } from '@agent-office/shared'
import { dropIntent } from './harness-dnd.ts'
import type { WorkspaceState } from './state.ts'
import type { ShellVM, SidebarItemVM, SidebarTarget, Tone } from './types.ts'
import { WS_COPY } from './workspace-copy.ts'

const OK_STATES: ReadonlySet<ProviderState> = new Set([
  'connected',
  'managed-available',
  'observe-only',
  'installed',
])

/** Sidebar entry that is active for each view. */
const ACTIVE_FOR: Record<string, SidebarTarget | null> = {
  overview: 'overview',
  office: 'office',
  sessions: 'sessions',
  memory: 'memory',
  harness: 'harness',
  context: null,
  project: null,
}
const SIDEBAR = ['overview', 'office', 'sessions', 'memory', 'harness'] as const

export function notificationCount(s: Pick<WorkspaceState, 'overview'>): number {
  const o = s.overview
  return o ? o.waiting.length + o.pendingApprovals : 0
}

export function healthVM(providers: ProviderStatus[]): ShellVM['topbar']['health'] {
  const enabled = providers.filter((p) => p.enabled)
  if (!enabled.length) return { tone: 'neutral', ...WS_COPY.health.none }
  const bad = enabled.filter((p) => !OK_STATES.has(p.state)).map((p) => p.label)
  if (bad.length) return { tone: 'warn', ...WS_COPY.health.warn(bad) }
  return { tone: 'good', ...WS_COPY.health.ok(enabled.length) }
}

export function shellVM(
  s: WorkspaceState,
  layout: ShellVM['layout'] = { sidebarCollapsed: false },
): ShellVM {
  const active = ACTIVE_FOR[s.view] ?? null
  const o = s.overview
  const counts: Record<SidebarTarget, number> = {
    // Flow approvals (overview-vm's flowApprovalCount; not imported: overview-vm imports this file).
    overview: notificationCount(s) + (o?.flowApprovals?.length ?? 0),
    office: 0,
    sessions: o?.unassignedSessions ?? 0,
    memory: o?.pendingApprovals ?? 0,
    harness: s.harness.list.filter((h) => h.status === 'draft').length,
  }
  const sidebar: SidebarItemVM[] = SIDEBAR.map((id) => ({
    id,
    label: WS_COPY.nav[id],
    active: active === id,
    count: counts[id],
  }))
  const h = s.harness
  // Only a library card can be dropped on a project (attach to that project).
  const drag = h.drag?.source === 'library' ? h.drag : null
  const attached = (pid: string): string[] =>
    s.projects.find((p) => p.id === pid)?.harnessIds ??
    h.list.filter((x) => x.projectIds.includes(pid)).map((x) => x.id)
  const projects = s.projects
    .filter((p) => !p.archived)
    .map((p) => {
      const intent = drag
        ? dropIntent(
            drag,
            { kind: 'project', projectId: p.id },
            { scopeProjectId: h.projectId, applied: [], library: [], attached },
          )
        : null
      const over = drag?.over?.kind === 'project' && drag.over.projectId === p.id
      return {
        projectId: p.id,
        name: p.name,
        color: p.color,
        active: s.projectId === p.id,
        count: p.activeAgents,
        pending: p.pendingMemories,
        ...(intent && {
          dropTarget: intent.kind === 'attach' ? ('ok' as const) : ('reject' as const),
        }),
        ...(over && { dropHover: true }),
        ...(h.justDropped === p.id && { justDropped: true }),
      }
    })
  const cur = s.projects.find((p) => p.id === s.projectId)
  const vault: ShellVM['topbar']['vault'] = {
    status: s.vault,
    tone: (s.vault === 'encrypted'
      ? 'good'
      : s.vault === 'memory-only'
        ? 'warn'
        : 'neutral') as Tone,
    label: WS_COPY.vault[s.vault],
  }
  const n = notificationCount(s)
  return {
    view: s.view,
    stageVisible: s.view === 'office',
    layout,
    sidebar,
    projectsHeading: WS_COPY.projectsHeading,
    projects,
    projectsEmpty: projects.length ? null : WS_COPY.projectsEmpty,
    newProjectLabel: WS_COPY.newProjectLabel,
    topbar: {
      searchPlaceholder: WS_COPY.searchPlaceholder,
      currentProject: cur ? { id: cur.id, name: cur.name, color: cur.color } : null,
      projectLabel: cur ? cur.name : WS_COPY.noProject,
      newAgentLabel: WS_COPY.newAgent,
      notifications: n,
      notificationsLabel: WS_COPY.notifications(n),
      health: healthVM(s.providers),
      vault,
    },
  }
}
