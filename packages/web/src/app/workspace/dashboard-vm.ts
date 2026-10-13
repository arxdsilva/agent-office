// The Project Dashboard: five questions, each with its evidence.
import type { ActivityKind, ActivityView, EvidenceLevel, TaskView } from '@agent-office/shared'
import { ago } from '../format.ts'
import type { WorkspaceState } from './state.ts'
import type {
  ActivityFilter,
  DashboardRowVM,
  DashboardSectionVM,
  DashboardVM,
  WorkspaceAction,
} from './types.ts'
import { WS_COPY } from './workspace-copy.ts'

const D = WS_COPY.dashboard
const H = WS_COPY.harness
const taskForm = { placeholder: D.taskPlaceholder, addLabel: D.taskAdd }
export const ACTIVITY_FILTERS: readonly ActivityFilter[] = [
  'all',
  'sessions',
  'memory',
  'handoffs',
  'problems',
]

const GROUP: Record<ActivityKind, Exclude<ActivityFilter, 'all'>> = {
  'session.started': 'sessions',
  'session.ended': 'sessions',
  'session.assigned': 'sessions',
  'memory.proposed': 'memory',
  'memory.approved': 'memory',
  'memory.rejected': 'memory',
  'memory.superseded': 'memory',
  'memory.imported': 'memory',
  'context.delivered': 'memory',
  'mcp.retrieval': 'memory',
  'handoff.prepared': 'handoffs',
  'handoff.launched': 'handoffs',
  'task.created': 'sessions',
  'task.completed': 'sessions',
  'commit.detected': 'sessions',
  'permission.requested': 'problems',
  'agent.error': 'problems',
  // Harnesses (docs/harness.md): provisional grouping until the dashboard gets its own filter.
  'harness.attached': 'sessions',
  'harness.published': 'sessions',
  'harness.denied': 'problems',
  'validation.started': 'sessions',
  'validation.passed': 'sessions',
  'validation.failed': 'problems',
}

export const activityMatches = (a: ActivityView, f: ActivityFilter): boolean =>
  f === 'all' || GROUP[a.kind] === f

const TASK_STATE: Record<TaskView['state'], string> = D.taskStates
const taskEvidence = (t: TaskView): EvidenceLevel | undefined =>
  t.evidence ?? (t.source === 'agent-reported' ? 'agent-reported' : undefined)
const TASK_ORDER: readonly TaskView['state'][] = ['open', 'doing', 'done', 'dropped']

/** 'today' | 'yesterday' | local ISO date, relative to `now`. */
export function dayLabel(ts: number, now: number): string {
  const iso = (t: number): string => {
    const d = new Date(t)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  const day = iso(ts)
  if (day === iso(now)) return 'today'
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  return day === iso(y.getTime()) ? 'yesterday' : day
}

export function dashboardVM(s: WorkspaceState, projectId: string, now: number): DashboardVM | null {
  const d = s.dashboards[projectId]
  const summary = s.projects.find((p) => p.id === projectId)
  if (!d) {
    if (!summary && !s.error) return null
    return {
      projectId,
      name: summary?.name ?? '',
      color: summary?.color ?? '#888888',
      subtitle: '',
      repos: summary?.repos.map((r) => r.label) ?? [],
      metrics: {
        activeAgents: summary?.activeAgents ?? 0,
        waiting: 0,
        sessions: summary?.sessions ?? 0,
        approvedMemories: summary?.approvedMemories ?? 0,
        pendingMemories: summary?.pendingMemories ?? 0,
        openTasks: summary?.openTasks ?? 0,
      },
      providers: [],
      knowledge: {
        approved: summary?.approvedMemories ?? 0,
        pending: summary?.pendingMemories ?? 0,
      },
      error: s.error,
      loading: s.loading,
      sections: [],
      activityFilters: [],
      actions: dashboardActions(projectId, false, false),
      taskForm,
    }
  }
  const p = d.project
  const activity = (s.activity[projectId] ?? d.activity)
    .filter((a) => activityMatches(a, s.activityFilter))
    .sort((a, b) => b.ts - a.ts)

  const active: DashboardRowVM[] = d.active.map((a) => ({
    id: a.agentId,
    title: a.name,
    detail: `${a.provider} · ${a.activity ?? a.status}`,
    tone: a.status === 'waiting' ? 'good' : a.status === 'error' ? 'bad' : 'neutral',
    badge: a.status === 'waiting' ? 'Waiting for you' : undefined,
    action: { type: 'focus-agent', agentId: a.agentId },
  }))
  const activityRows: DashboardRowVM[] = activity.map((a) => ({
    id: a.id,
    title: a.text,
    detail: `${a.actor} · ${ago(a.ts, now)}`,
    tone: GROUP[a.kind] === 'problems' ? 'warn' : 'neutral',
    ts: a.ts,
    day: dayLabel(a.ts, now),
    action: a.refs?.sessionId
      ? { type: 'open-session', sessionId: a.refs.sessionId }
      : a.refs?.memoryId
        ? { type: 'open-memory', projectId, memoryId: a.refs.memoryId }
        : undefined,
  }))
  const completed: DashboardRowVM[] = d.completed.map((c) => ({
    id: c.taskId,
    title: c.title,
    detail: ago(c.at, now),
    badge: WS_COPY.evidence[c.evidence],
    tone: c.evidence === 'agent-reported' ? 'warn' : 'good',
  }))
  const tasks: DashboardRowVM[] = d.tasks
    .filter((t) => t.state === 'open' || t.state === 'doing')
    .map((t) => ({
      id: t.id,
      title: t.title,
      detail: `${TASK_STATE[t.state]} · ${t.source === 'user' ? 'added by you' : 'reported by an agent'}`,
      // Agent-reported work stays labelled unverified until the user (or a commit/test) confirms it.
      badge: taskEvidence(t) ? WS_COPY.evidence[taskEvidence(t) as EvidenceLevel] : undefined,
      tone: taskEvidence(t) === 'agent-reported' ? ('warn' as const) : ('neutral' as const),
      task: {
        taskId: t.id,
        state: t.state,
        stateOptions: TASK_ORDER.map((value) => ({ value, label: TASK_STATE[value] })),
        confirm: {
          id: 'confirm',
          label: D.taskConfirm,
          enabled: t.evidence !== 'user-confirmed',
          hint: t.evidence === 'user-confirmed' ? D.taskConfirmed : undefined,
        },
      },
    }))
  const knowledge: DashboardRowVM[] = []
  if (d.knowledge.approved || d.knowledge.pending) {
    knowledge.push({
      id: 'counts',
      title: `${d.knowledge.approved} approved · ${d.knowledge.pending} pending review`,
      detail: '',
      tone: d.knowledge.pending ? 'warn' : 'good',
      action: d.knowledge.pending
        ? { type: 'review-approvals', projectId }
        : { type: 'open-memory', projectId },
    })
  }
  for (const m of d.knowledge.decisions) {
    knowledge.push({
      id: m.id,
      title: m.title,
      detail: `Decision · ${m.decision?.status ?? m.state}`,
      tone: 'neutral',
      action: { type: 'open-memory', projectId, memoryId: m.id },
    })
  }

  const sec = (
    id: DashboardSectionVM['id'],
    heading: string,
    rows: DashboardRowVM[],
    empty: string,
  ): DashboardSectionVM => ({ id, heading, rows, empty })

  return {
    harness: harnessSection(s, projectId, s.activity[projectId] ?? d.activity, now),
    projectId,
    name: p.name,
    color: p.color,
    subtitle: `${p.activeAgents} active · ${p.sessions} sessions · ${p.openTasks} open tasks`,
    repos: p.repos.map((r) => r.label),
    metrics: {
      activeAgents: p.activeAgents,
      waiting: d.active.filter((a) => a.status === 'waiting').length,
      sessions: p.sessions,
      approvedMemories: p.approvedMemories,
      pendingMemories: p.pendingMemories,
      openTasks: p.openTasks,
    },
    providers: [
      ...new Set([
        ...d.active.map((a) => a.provider),
        ...d.sessions.map((x) => String(x.provider)),
      ]),
    ].map((id) => ({ id, label: id })),
    knowledge: { approved: d.knowledge.approved, pending: d.knowledge.pending },
    error: s.error,
    loading: s.loading,
    sections: [
      sec('active', D.active, active, D.activeEmpty),
      sec('activity', D.activity, activityRows, D.activityEmpty),
      sec('completed', D.completed, completed, D.completedEmpty),
      sec('tasks', D.tasks, tasks, D.tasksEmpty),
      sec('knowledge', D.knowledge, knowledge, D.knowledgeEmpty),
    ],
    activityFilters: ACTIVITY_FILTERS.map((f) => ({
      id: f,
      label: D.filters[f],
      active: s.activityFilter === f,
    })),
    actions: dashboardActions(
      projectId,
      d.sessions.length > 0,
      d.active.length > 0,
      d.sessions[0]?.id,
      d.active[0]?.agentId,
    ),
    taskForm,
  }
}

const VALIDATION_WORD: Partial<Record<ActivityKind, string>> = {
  'validation.passed': 'Passed',
  'validation.failed': 'Failed',
  'validation.started': 'Running',
}

/** The Harness section: attached harnesses, the last validation and today's blocked actions. */
function harnessSection(
  s: WorkspaceState,
  projectId: string,
  activity: ActivityView[],
  now: number,
): DashboardSectionVM {
  const open: WorkspaceAction = { type: 'open-harnesses', projectId }
  const attached = s.harness.list.filter((h) => h.projectIds.includes(projectId))
  const rows: DashboardRowVM[] = attached.map((h) => ({
    id: h.id,
    title: h.name,
    detail: `v${h.version} · ${H.library.rules(h.ruleCount)} · ${H.library.gates(h.gateCount)}`,
    badge: H.status[h.status],
    tone: h.status === 'published' ? 'good' : 'warn',
    action: open,
  }))
  if (attached.length) {
    const last = activity.filter((a) => a.kind in VALIDATION_WORD).sort((a, b) => b.ts - a.ts)[0]
    rows.push(
      last
        ? {
            id: 'validation',
            title: H.dashboard.lastValidation(VALIDATION_WORD[last.kind] ?? '', ago(last.ts, now)),
            detail: last.text,
            tone:
              last.kind === 'validation.failed'
                ? 'bad'
                : last.kind === 'validation.passed'
                  ? 'good'
                  : 'neutral',
            action: open,
          }
        : {
            id: 'validation',
            title: H.dashboard.noValidation,
            detail: '',
            tone: 'neutral',
            action: open,
          },
    )
    const blocked = activity.filter(
      (a) => a.kind === 'harness.denied' && dayLabel(a.ts, now) === 'today',
    ).length
    rows.push({
      id: 'blocked',
      title: blocked ? H.dashboard.blockedToday(blocked) : H.dashboard.noneBlocked,
      detail: '',
      tone: blocked ? 'warn' : 'neutral',
      action: open,
    })
  }
  return { id: 'harness', heading: H.dashboard.heading, rows, empty: H.dashboard.empty }
}

function dashboardActions(
  projectId: string,
  hasSession: boolean,
  hasAgent: boolean,
  sessionId?: string,
  agentId?: string,
): DashboardVM['actions'] {
  return [
    {
      id: 'start',
      label: D.actions.start,
      enabled: true,
      action: { type: 'start-agent', projectId },
    },
    {
      id: 'continue',
      label: D.actions.continue,
      enabled: hasSession,
      hint: hasSession ? undefined : D.noSessionToContinue,
      action: { type: 'continue-work', projectId, sessionId },
    },
    {
      id: 'search',
      label: D.actions.search,
      enabled: true,
      action: { type: 'search-history', projectId },
    },
    {
      id: 'memory',
      label: D.actions.memory,
      enabled: true,
      action: { type: 'open-memory', projectId },
    },
    {
      id: 'context',
      label: D.actions.context,
      enabled: hasAgent,
      hint: hasAgent ? undefined : D.noAgentToInspect,
      action: { type: 'inspect-context', projectId, agentId },
    },
    {
      id: 'handoff',
      label: D.actions.handoff,
      enabled: hasSession,
      hint: hasSession ? undefined : D.noSessionToContinue,
      action: { type: 'prepare-handoff', projectId, sessionId },
    },
  ]
}
