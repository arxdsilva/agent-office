// The Session Vault: sessions grouped by project, the selected session's history, suggestions.
import type { ImportStatus, SessionSummary } from '@agent-office/shared'
import { UNASSIGNED } from '@agent-office/shared'
import { ago } from '../format.ts'
import { SESSION_ALL, type WorkspaceState } from './state.ts'
import type {
  ButtonVM,
  SessionDetailVM,
  SessionGroupVM,
  SessionMessageVM,
  SessionRowVM,
  SessionsVM,
} from './types.ts'
import { WS_COPY } from './workspace-copy.ts'

const S = WS_COPY.sessions

/** Whether a session belongs to a scope ('all', 'unassigned' or a project id). */
export const sessionInScope = (x: SessionSummary, scope: string): boolean =>
  scope === SESSION_ALL ? true : scope === UNASSIGNED ? x.projectId === null : x.projectId === scope

/** The default memory title for a saved message: its first 80 characters on one line. */
export const memoryTitleOf = (text: string): string =>
  [...text.replace(/\s+/g, ' ').trim()].slice(0, 80).join('')

export function sessionsVM(s: WorkspaceState, now: number): SessionsVM {
  const nameOf = (id: string | null): string | null =>
    id ? (s.projects.find((p) => p.id === id)?.name ?? 'Project') : null
  const list = s.sessions
    .filter((x) => sessionInScope(x, s.sessionScope))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)

  const row = (x: SessionSummary): SessionRowVM => ({
    id: x.id,
    title: x.title,
    provider: String(x.provider),
    stateLabel: S.state[x.state],
    originLabel: S.origin[x.origin],
    when: ago(x.lastSeenAt, now),
    selected: x.id === s.selectedSessionId,
    unassigned: x.projectId === null,
  })

  const groups: SessionGroupVM[] = []
  const byKey = new Map<string, SessionGroupVM>()
  const order = [...s.projects.map((p) => p.id), UNASSIGNED]
  for (const key of order) {
    const rows = list.filter((x) => (x.projectId ?? UNASSIGNED) === key).map(row)
    if (rows.length) {
      const g = { key, heading: key === UNASSIGNED ? S.unassigned : (nameOf(key) ?? key), rows }
      groups.push(g)
      byKey.set(key, g)
    }
  }
  // Sessions of a project missing from the project list still appear.
  for (const x of list) {
    const key = x.projectId ?? UNASSIGNED
    if (!byKey.has(key)) {
      const g = { key, heading: nameOf(key) ?? key, rows: [] as SessionRowVM[] }
      groups.push(g)
      byKey.set(key, g)
      g.rows.push(...list.filter((y) => (y.projectId ?? UNASSIGNED) === key).map(row))
    }
  }
  // Unassigned goes first so it cannot be missed.
  groups.sort((a, b) => (a.key === UNASSIGNED ? -1 : b.key === UNASSIGNED ? 1 : 0))

  const scopes = [
    { key: SESSION_ALL, label: S.all },
    { key: UNASSIGNED, label: S.unassigned },
    ...s.projects.filter((p) => !p.archived).map((p) => ({ key: p.id, label: p.name })),
  ].map((x) => ({ ...x, active: x.key === s.sessionScope }))

  const sel = s.sessions.find((x) => x.id === s.selectedSessionId)
  return {
    heading: S.heading,
    searchPlaceholder: S.searchPlaceholder,
    query: s.sessionQuery,
    error: s.error,
    loading: s.loading,
    scopes,
    groups,
    empty: S.empty,
    detail: sel ? sessionDetailVM(s, sel, now, nameOf(sel.projectId)) : null,
    detailEmpty: S.detailEmpty,
    importHistory: importButton(s.importStatus),
    importStatus: importStatusLine(s.importStatus, now),
    notice: s.notice,
  }
}

function sessionDetailVM(
  s: WorkspaceState,
  x: SessionSummary,
  now: number,
  projectName: string | null,
): SessionDetailVM {
  const m = s.messages[x.id]
  const messages: SessionMessageVM[] = (m?.messages ?? []).map((msg) => ({
    id: msg.id,
    role: msg.role,
    roleLabel: S.role[msg.role],
    text: msg.text,
    when: ago(msg.ts, now),
    tools: msg.tools ?? [],
    sourceBadge: msg.source === 'chat' ? S.sourceChat : S.sourceTranscript,
    highlighted: msg.id === s.highlightMessageId,
    save: { label: S.saveAsMemory, defaultTitle: memoryTitleOf(msg.text) },
  }))
  // Suggestions only for unassigned sessions, and only ever as buttons the user presses.
  const suggestions =
    x.projectId === null
      ? (x.suggestions ?? []).map((g) => ({
          projectId: g.projectId,
          name: g.name,
          rule: g.rule,
          confidence: g.confidence,
          assign: {
            id: `assign:${g.projectId}`,
            label: S.assign(g.name),
            enabled: true,
            hint: S.confidence[g.confidence],
          },
        }))
      : []
  return {
    id: x.id,
    title: x.title,
    provider: String(x.provider),
    projectName,
    assignedByLabel: x.assignedBy ? S.assignedBy[x.assignedBy] : null,
    summary: x.summary
      ? { text: x.summary.text, sourceLabel: S.summarySource[x.summary.source] }
      : null,
    continuedFrom: x.continuedFrom ? S.continuedFrom(x.continuedFrom.provider) : null,
    messages,
    moreMessages: m?.more ?? false,
    messagesEmpty: S.messagesEmpty,
    suggestions,
    resume: {
      id: 'resume',
      label: S.resume,
      enabled: x.canResume === true,
      hint: x.canResume === true ? S.resumeOn : S.resumeHint,
    },
    continueWith: {
      id: 'continue-with',
      label: S.continueWith,
      enabled: x.projectId !== null,
      hint: x.projectId !== null ? S.continueHint : 'Assign the session to a project first.',
      action:
        x.projectId !== null
          ? { type: 'continue-work', projectId: x.projectId, sessionId: x.id }
          : undefined,
    },
    assignOptions: [
      { projectId: null, name: S.noProject, current: x.projectId === null },
      ...s.projects
        .filter((p) => !p.archived)
        .map((p) => ({ projectId: p.id, name: p.name, current: p.id === x.projectId })),
    ],
  }
}

/** While automatic import is on the one-shot button is replaced by a disabled "is on" label. */
const importButton = (st: ImportStatus | null): ButtonVM =>
  st?.on
    ? { id: 'import', label: S.autoOn, enabled: false }
    : { id: 'import', label: S.importHistory, enabled: true, hint: S.importHint }

const importStatusLine = (st: ImportStatus | null, now: number): string | null =>
  !st?.on
    ? null
    : st.lastRunAt === undefined
      ? S.autoWaiting
      : S.lastRun(ago(st.lastRunAt, now), st.imported, st.added)
