// The command palette: commands plus search hits, with keyboard selection.
import type { SearchHit } from '@agent-office/shared'
import type { WorkspaceState } from './state.ts'
import type { PaletteItemVM, PaletteVM, WorkspaceAction } from './types.ts'
import { HARNESS_COPY } from './harness-copy.ts'
import { WS_COPY } from './workspace-copy.ts'

const P = WS_COPY.palette
interface Cmd {
  id: string
  label: string
  keywords: string
  action: WorkspaceAction
}

export function paletteCommands(
  s: Pick<WorkspaceState, 'projects' | 'projectId'> &
    Partial<Pick<WorkspaceState, 'harness' | 'overview'>>,
): Cmd[] {
  const pid = s.projectId ?? undefined
  const cmds: Cmd[] = [
    {
      id: 'new-project',
      label: P.cmd.newProject,
      keywords: 'create new project',
      action: { type: 'new-project' },
    },
    {
      id: 'start-agent',
      label: P.cmd.startAgent,
      keywords: 'new agent session launch',
      action: { type: 'start-agent', projectId: pid },
    },
    {
      id: 'find-session',
      label: P.cmd.findSession,
      keywords: 'search history sessions vault',
      action: { type: 'open-sessions', projectId: pid },
    },
    {
      id: 'search-memory',
      label: P.cmd.searchMemory,
      keywords: 'memory knowledge notes',
      action: { type: 'open-memory', projectId: pid },
    },
    {
      id: 'review',
      label: P.cmd.review,
      keywords: 'approve pending memory proposals',
      action: { type: 'review-approvals', projectId: pid },
    },
    {
      id: 'inspect',
      label: P.cmd.inspect,
      keywords: 'context inspector retrieved delivered',
      action: { type: 'inspect-context', projectId: pid },
    },
    ...(pid
      ? [
          {
            id: 'continue',
            label: P.cmd.continueWork,
            keywords: 'handoff continue provider',
            action: { type: 'continue-work', projectId: pid } satisfies WorkspaceAction,
          },
        ]
      : []),
    {
      id: 'harnesses',
      label: P.cmd.harnesses,
      keywords: 'harness rules standards policy gates compliance',
      action: { type: 'open-harnesses', projectId: pid },
    },
    {
      id: 'harness-new',
      label: HARNESS_COPY.palette.newHarness,
      keywords: 'harness create new flow standards rules',
      action: { type: 'harness-new' },
    },
    ...(pid
      ? [
          {
            id: 'harness-import',
            label: P.cmd.importRules,
            keywords: 'harness import rules agents.md claude.md cursor standards',
            action: { type: 'harness-import', projectId: pid } satisfies WorkspaceAction,
          },
        ]
      : []),
    {
      id: 'import-history',
      label: P.cmd.importHistory,
      keywords: 'import claude history sessions experimental',
      action: { type: 'import-history' },
    },
    {
      id: 'remove-imported',
      label: P.cmd.removeImported,
      keywords: 'remove delete clear auto imported claude sessions memory',
      action: { type: 'remove-imported' },
    },
    {
      id: 'mode-2d',
      label: P.cmd.to2d,
      keywords: 'pixel rpg switch view mode',
      action: { type: 'switch-mode', mode: 'pixel' },
    },
    {
      id: 'mode-3d',
      label: P.cmd.to3d,
      keywords: 'three d switch view mode',
      action: { type: 'switch-mode', mode: '3d' },
    },
    {
      id: 'connect',
      label: P.cmd.connect,
      keywords: 'provider connect setup claude codex',
      action: { type: 'connect-provider' },
    },
    {
      id: 'overview',
      label: P.cmd.overview,
      keywords: 'home attention',
      action: { type: 'open-overview' },
    },
    {
      id: 'office',
      label: P.cmd.office,
      keywords: '3d 2d scene agents',
      action: { type: 'open-office' },
    },
  ]
  for (const h of s.harness?.list ?? []) {
    cmds.push({
      id: `harness:${h.id}`,
      label: HARNESS_COPY.palette.harness(h.name),
      keywords: `harness flow edit ${h.name} ${h.description ?? ''}`,
      action: { type: 'harness-edit', harnessId: h.id },
    })
  }
  // Flow approvals waiting on the user, for the selected project (one click, logged by main).
  if (pid) {
    for (const a of s.overview?.flowApprovals ?? []) {
      if (a.projectId !== pid) continue
      cmds.push({
        id: `approve:${a.agentId}:${a.stepId}:${a.checkIndex}`,
        label: HARNESS_COPY.palette.approve(a.prompt),
        keywords: `approve approval flow step ${a.stepName} ${a.agentName}`,
        action: {
          type: 'flow-approve',
          agentId: a.agentId,
          stepId: a.stepId,
          checkIndex: a.checkIndex,
        },
      })
    }
  }
  for (const p of s.projects.filter((x) => !x.archived)) {
    cmds.push({
      id: `project:${p.id}`,
      label: P.cmd.openProject(p.name),
      keywords: `open project ${p.name}`,
      action: { type: 'open-project', projectId: p.id },
    })
  }
  return cmds
}

const matches = (c: Cmd, q: string): boolean => {
  const hay = `${c.label} ${c.keywords}`.toLowerCase()
  return q
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t))
}

export function hitAction(h: SearchHit): WorkspaceAction {
  switch (h.kind) {
    case 'project':
      return { type: 'open-project', projectId: h.id }
    case 'session':
      return { type: 'open-session', sessionId: h.id }
    case 'message':
      return { type: 'open-session', sessionId: h.sessionId ?? h.id, messageId: h.messageId }
    case 'memory':
      return { type: 'open-memory', memoryId: h.id, projectId: h.projectId ?? undefined }
    case 'handoff':
      return { type: 'open-handoff', handoffId: h.id }
    case 'agent':
      return { type: 'focus-agent', agentId: h.id }
  }
}

const hitKey = (h: SearchHit): string => `${h.kind}:${h.id}:${h.messageId ?? ''}`

/** Merges a later (deep) result into the earlier hits: the earlier order is kept, duplicates drop. */
export function mergeHits(current: SearchHit[], more: SearchHit[]): SearchHit[] {
  const seen = new Set(current.map(hitKey))
  return [
    ...current,
    ...more.filter((h) => (seen.has(hitKey(h)) ? false : (seen.add(hitKey(h)), true))),
  ]
}

export function paletteItems(s: WorkspaceState): Omit<PaletteItemVM, 'selected'>[] {
  const q = s.palette.query.trim().toLowerCase()
  const cmds = paletteCommands(s)
    .filter((c) => !q || matches(c, q))
    .map((c) => ({
      id: `cmd:${c.id}`,
      group: c.id.startsWith('project:') ? ('project' as const) : ('command' as const),
      label: c.label,
      detail: '',
      action: c.action,
    }))
  const hits = q
    ? s.palette.hits.map((h) => ({
        id: `hit:${h.kind}:${h.id}${h.messageId ? `:${h.messageId}` : ''}`,
        group: h.kind,
        label: h.title,
        detail: h.snippet,
        action: hitAction(h),
      }))
    : []
  return [...cmds, ...hits]
}

export function paletteVM(s: WorkspaceState): PaletteVM {
  const base = paletteItems(s)
  const selected = Math.min(s.palette.selected, Math.max(0, base.length - 1))
  return {
    open: s.palette.open,
    placeholder: P.placeholder,
    query: s.palette.query,
    items: base.map((it, i) => ({ ...it, selected: i === selected })),
    empty: P.empty,
    searching: s.palette.searching,
  }
}
