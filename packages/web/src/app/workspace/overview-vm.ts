// The global Overview: what needs the user's attention across every project.
import type { ProviderStatus } from '@agent-office/shared'
import { ago } from '../format.ts'
import { healthVM } from './shell-vm.ts'
import type { WorkspaceState } from './state.ts'
import type { OverviewCardVM, OverviewSectionVM, OverviewVM } from './types.ts'
import { WS_COPY } from './workspace-copy.ts'

const C = WS_COPY.overview

export function overviewVM(s: WorkspaceState, now: number): OverviewVM {
  const o = s.overview
  const nameOf = (id: string | null): string =>
    id ? (s.projects.find((p) => p.id === id)?.name ?? 'Project') : WS_COPY.sessions.noProject

  const attention: OverviewCardVM[] = []
  for (const w of o?.waiting ?? []) {
    attention.push({
      id: `wait:${w.agentId}`,
      title: w.name,
      detail: `${w.provider} · ${nameOf(w.projectId)}`,
      tone: 'good',
      action: { type: 'focus-agent', agentId: w.agentId },
      actionLabel: C.focus,
    })
  }
  if (o && o.unassignedSessions > 0) {
    attention.push({
      id: 'unassigned',
      title: C.unassigned(o.unassignedSessions),
      detail: 'Suggestions are never applied until you accept them.',
      tone: 'warn',
      action: { type: 'open-sessions' },
      actionLabel: C.sessionsAction,
    })
  }

  // A provider that needs attention is something the user must act on, so it is listed here too.
  for (const p of s.providers.filter((x) => x.enabled && healthVM([x]).tone === 'warn')) {
    attention.push({
      id: `provider:${p.id}`,
      title: C.providerNeedsAttention(p.label),
      detail: `${p.state}`,
      tone: 'warn',
      action: { type: 'connect-provider' },
      actionLabel: C.connect,
    })
  }

  const projects: OverviewCardVM[] = (o?.projects ?? s.projects)
    .filter((p) => !p.archived && (p.activeAgents > 0 || p.pendingMemories > 0 || p.openTasks > 0))
    .map((p) => ({
      id: p.id,
      title: p.name,
      detail: `${p.activeAgents} active · ${p.openTasks} open tasks · ${p.pendingMemories} pending${
        p.lastActivityAt ? ` · ${ago(p.lastActivityAt, now)}` : ''
      }`,
      tone: 'neutral' as const,
      action: { type: 'open-project' as const, projectId: p.id },
      actionLabel: C.open,
    }))

  const completions: OverviewCardVM[] = (o?.recentCompletions ?? []).map((a) => ({
    id: a.id,
    title: a.text,
    detail: `${a.actor} · ${nameOf(a.projectId)} · ${ago(a.ts, now)}`,
    tone: 'good' as const,
    action: { type: 'open-project' as const, projectId: a.projectId },
    actionLabel: C.open,
  }))

  const decisions: OverviewCardVM[] = (o?.recentDecisions ?? []).map((m) => ({
    id: m.id,
    title: m.title,
    detail: `${nameOf(m.projectId)} · ${m.decision?.status ?? m.state}`,
    tone: 'neutral' as const,
    action: { type: 'open-memory' as const, memoryId: m.id, projectId: m.projectId ?? undefined },
    actionLabel: C.open,
  }))

  const approvals: OverviewCardVM[] =
    o && o.pendingApprovals > 0
      ? [
          {
            id: 'approvals',
            title: C.approvalsCount(o.pendingApprovals),
            detail: 'Agent proposals stay pending until you approve them.',
            tone: 'warn',
            action: { type: 'review-approvals' },
            actionLabel: C.review,
          },
        ]
      : []

  const handoffs: OverviewCardVM[] = (o?.unfinishedHandoffs ?? []).map((h) => ({
    id: h.id,
    title: h.objective,
    detail: `${h.from.title} → ${h.toProvider} · ${nameOf(h.projectId)}`,
    tone: 'warn' as const,
    action: { type: 'open-handoff' as const, handoffId: h.id },
    actionLabel: C.continueWork,
  }))

  const providers: OverviewCardVM[] = s.providers
    .filter((p: ProviderStatus) => p.enabled)
    .map((p) => ({
      id: p.id,
      title: p.label,
      detail: `${p.state} · ${p.activeSessions} active`,
      tone: healthVM([p]).tone,
      action: healthVM([p]).tone === 'warn' ? { type: 'connect-provider' as const } : undefined,
      actionLabel: healthVM([p]).tone === 'warn' ? C.connect : undefined,
    }))

  const sec = (
    id: OverviewSectionVM['id'],
    heading: string,
    items: OverviewCardVM[],
    empty: string,
  ): OverviewSectionVM => ({ id, heading, items, empty })

  return {
    heading: C.heading,
    loading: s.loading && !o,
    error: s.error,
    noProjects: s.projectsLoaded && s.projects.length === 0,
    noProjectsText: C.noProjects,
    createProject: {
      id: 'create-project',
      label: C.createProject,
      enabled: true,
      action: { type: 'new-project' },
    },
    sections: [
      sec('attention', C.attention, attention, C.attentionEmpty),
      sec('approvals', C.approvals, approvals, C.approvalsEmpty),
      sec('handoffs', C.handoffs, handoffs, C.handoffsEmpty),
      sec('projects', C.projects, projects, C.projectsEmpty),
      sec('completions', C.completions, completions, C.completionsEmpty),
      sec('decisions', C.decisions, decisions, C.decisionsEmpty),
      sec('providers', C.providers, providers, C.providersEmpty),
    ],
  }
}
