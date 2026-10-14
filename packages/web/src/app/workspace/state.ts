// The workspace store: a reducer over pushes and fetched data. Pure; the controller dispatches.
import type {
  ActivityView,
  ContextInspection,
  HarnessBadge,
  HarnessDetail,
  HarnessDraft,
  RuleCategory,
  HarnessInspection,
  HarnessSummary,
  HarnessTemplateView,
  EnforcementReportView,
  ImportPreview,
  ImportSourceView,
  GlobalOverview,
  HandoffView,
  ImportStatus,
  MemoryView,
  ProjectDashboard,
  ProjectMessage,
  ProjectSummary,
  ProviderStatus,
  SearchHit,
  SessionMessageView,
  SessionSummary,
} from '@agent-office/shared'
import { MEMORY_ALL, type ProjectScope } from './state-types.ts'
import type { HarnessDrag } from './harness-dnd.ts'
import {
  defaultImportSelection,
  defaultImportSteps,
  type CandidateEdits,
  type EditorTab,
  type ImportSelection,
  type ImportSteps,
  type StepForm,
} from './harness-vm.ts'
import type { ActivityFilter, MemoryFilterKey, WorkspaceView } from './types.ts'

export const ACTIVITY_CAP = 100
export const SESSION_ALL = 'all'

export interface PaletteState {
  open: boolean
  query: string
  hits: SearchHit[]
  selected: number
  searching: boolean
}
export interface HandoffState {
  open: boolean
  stage: 'compose' | 'review'
  sessionId: string | null
  projectId: string | null
  objective: string
  provider: string
  handoff: HandoffView | null
}
export interface NewProjectState {
  open: boolean
  name: string
  folders: { ref: string; label: string; hint: string }[]
}

export type HarnessPaneTab = 'library' | 'editor' | 'import' | 'coverage'
/** @deprecated the dialog became the `#ws-harness` pane; kept as an alias. */
export type HarnessDialogTab = HarnessPaneTab
export type HarnessConfirmKind = 'publish' | 'archive' | 'attach' | 'detach' | 'discard'
export interface HarnessConfirm {
  kind: HarnessConfirmKind
  harnessId: string
  /** Attach/detach target; defaults to the scope project. */
  projectId?: string
  /** Discard: where to go once the edits are dropped (leaving the pane). */
  next?: { view: WorkspaceView; projectId?: string | null }
}
/** The Harnesses pane (docs/harness.md §7): fetched data plus the pane's own view state. */
export interface HarnessState {
  tab: HarnessPaneTab
  editorTab: EditorTab
  /** The project the pane works for (Applied, attach, import, coverage); null = none. */
  projectId: string | null
  list: HarnessSummary[]
  listLoaded: boolean
  detail: HarnessDetail | null
  /** What each ready provider enforces for `projectId`. */
  coverage: EnforcementReportView[]
  sources: ImportSourceView[] | null
  preview: ImportPreview | null
  selection: ImportSelection
  /** The reviewer's edits to candidates, by temp id. */
  edits: CandidateEdits
  templates: HarnessTemplateView[]
  /** The pane's own error line (`#hb-error`). */
  error: string | null
  importName: string
  importAttach: boolean
  confirm: HarnessConfirm | null
  busy: boolean
  badges: HarnessBadge[]
  /** Latest inspection per agent (after Run validation or a push). */
  inspections: Record<string, HarnessInspection>
  /** The harness being dragged (from `dragstart`), cleared on `dragend`/`drop`. */
  drag: HarnessDrag | null
  /** The user's library order (`settings.layout.harnessOrder`). */
  order: string[]
  /** `#hb-search` filter. */
  query: string
  /** The selected library card. */
  selectedId: string | null
  /** Unsaved editor changes of `detail` (null = none). */
  draft: HarnessDraft | null
  /** "Saved" shows on the Save button for a moment after a save. */
  saved: boolean
  stepForm: StepForm | null
  /** The rule being edited in the rule form. */
  ruleEditId: string | null
  /** "Go to rule" from a conflict. */
  highlightRuleId: string | null
  /** The draft before the last rule/step removal ("Undo", 5 s). */
  undo: HarnessDraft | null
  /** Every version of the open harness (History), once loaded. */
  versions: HarnessDetail[] | null
  /** An older version shown read-only. */
  viewVersion: number | null
  /** `#hb-live` (polite announcements). */
  live: string
  /** A row the Applied column highlights after an attach. */
  justAttached: string | null
  /** A sidebar project that just received a drop (`.just-dropped`). */
  justDropped: string | null
  /** Detected sources the reviewer unticked (not previewed). */
  excluded: string[]
  importSteps: ImportSteps
  importFilter: RuleCategory | null
  /** One-line notice under the editor header (`done` after an import). */
  notice: string | null
  /** The editor's harness changed elsewhere while it had unsaved edits. */
  stale: boolean
  /** One-shot focus target (an element id) for the next render. */
  focus: string | null
}

export const initialHarness = (): HarnessState => ({
  tab: 'library',
  editorTab: 'overview',
  projectId: null,
  list: [],
  listLoaded: false,
  detail: null,
  coverage: [],
  sources: null,
  preview: null,
  selection: { selected: [], gates: [] },
  edits: {},
  templates: [],
  error: null,
  importName: '',
  importAttach: false,
  confirm: null,
  busy: false,
  badges: [],
  inspections: {},
  drag: null,
  order: [],
  query: '',
  selectedId: null,
  draft: null,
  saved: false,
  stepForm: null,
  ruleEditId: null,
  highlightRuleId: null,
  undo: null,
  versions: null,
  viewVersion: null,
  live: '',
  justAttached: null,
  justDropped: null,
  excluded: [],
  importSteps: { order: [], selected: [], checks: {} },
  importFilter: null,
  notice: null,
  stale: false,
  focus: null,
})

export interface WorkspaceState {
  harness: HarnessState
  view: WorkspaceView
  projectId: string | null
  projects: ProjectSummary[]
  projectsLoaded: boolean
  providers: ProviderStatus[]
  vault: 'encrypted' | 'memory-only' | 'unknown'
  overview: GlobalOverview | null
  dashboards: Record<string, ProjectDashboard>
  activity: Record<string, ActivityView[]>
  activityFilter: ActivityFilter
  sessions: SessionSummary[]
  sessionScope: string
  sessionQuery: string
  selectedSessionId: string | null
  messages: Record<string, { messages: SessionMessageView[]; more: boolean }>
  highlightMessageId: string | null
  memories: MemoryView[]
  memoryScope: ProjectScope
  memoryFilter: MemoryFilterKey
  memoryQuery: string
  selectedMemoryId: string | null
  checkedMemoryIds: string[]
  inspection: ContextInspection | null
  inspectAgentId: string | null
  agentProjects: Record<string, string | null>
  /** Titles of sessions that memory provenance points at (so ids never show). */
  sessionTitles: Record<string, { title: string; provider: string }>
  palette: PaletteState
  handoff: HandoffState
  newProject: NewProjectState
  loading: boolean
  error: string | null
  /** A one-line result shown in the Session Vault; cleared on navigation. */
  notice: string | null
  /** Automatic import status (null until loaded); feeds the Session Vault line. */
  importStatus: ImportStatus | null
  /** The "Remove imported memory" confirm is open (acts on the current memory scope). */
  removeImportedConfirm: boolean
}

export const initialState = (): WorkspaceState => ({
  harness: initialHarness(),
  view: 'office',
  projectId: null,
  projects: [],
  projectsLoaded: false,
  providers: [],
  vault: 'unknown',
  overview: null,
  dashboards: {},
  activity: {},
  activityFilter: 'all',
  sessions: [],
  sessionScope: SESSION_ALL,
  sessionQuery: '',
  selectedSessionId: null,
  messages: {},
  highlightMessageId: null,
  memories: [],
  memoryScope: MEMORY_ALL,
  memoryFilter: 'all',
  memoryQuery: '',
  selectedMemoryId: null,
  checkedMemoryIds: [],
  inspection: null,
  inspectAgentId: null,
  agentProjects: {},
  sessionTitles: {},
  palette: { open: false, query: '', hits: [], selected: 0, searching: false },
  handoff: {
    open: false,
    stage: 'compose',
    sessionId: null,
    projectId: null,
    objective: '',
    provider: '',
    handoff: null,
  },
  newProject: { open: false, name: '', folders: [] },
  loading: false,
  error: null,
  notice: null,
  importStatus: null,
  removeImportedConfirm: false,
})

export type WorkspaceEvent =
  | { type: 'push'; msg: ProjectMessage }
  | { type: 'navigate'; view: WorkspaceView; projectId?: string | null }
  | { type: 'loading'; on: boolean }
  | { type: 'error'; error: string | null }
  | { type: 'notice'; notice: string | null }
  | { type: 'import-status'; status: ImportStatus }
  | { type: 'remove-imported-confirm'; open: boolean }
  | { type: 'projects'; projects: ProjectSummary[] }
  | { type: 'providers'; providers: ProviderStatus[] }
  | { type: 'harness-ui'; patch: Partial<HarnessState> }
  | { type: 'harnesses'; list: HarnessSummary[] }
  | { type: 'harness-detail'; detail: HarnessDetail | null }
  | { type: 'import-sources'; sources: ImportSourceView[] | null }
  | { type: 'import-preview'; preview: ImportPreview | null }
  | { type: 'harness-inspection'; agentId: string; inspection: HarnessInspection }
  | { type: 'harness-badges'; badges: HarnessBadge[] }
  | { type: 'session-titles'; sessions: { id: string; title: string; provider: string }[] }
  | { type: 'overview'; overview: GlobalOverview }
  | { type: 'dashboard'; dashboard: ProjectDashboard }
  | { type: 'activity-filter'; filter: ActivityFilter }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'session-scope'; scope: string }
  | { type: 'session-query'; query: string }
  | { type: 'select-session'; sessionId: string | null; messageId?: string | null }
  | { type: 'messages'; sessionId: string; messages: SessionMessageView[]; more: boolean }
  | { type: 'memories'; memories: MemoryView[] }
  | { type: 'memory-scope'; scope: ProjectScope }
  | { type: 'memory-filter'; filter: MemoryFilterKey }
  | { type: 'memory-query'; query: string }
  | { type: 'select-memory'; memoryId: string | null }
  | { type: 'toggle-memory-check'; memoryId: string }
  | { type: 'memory-updated'; memory: MemoryView }
  | { type: 'inspection'; agentId: string; inspection: ContextInspection }
  | { type: 'palette-open' }
  | { type: 'palette-close' }
  | { type: 'palette-query'; query: string }
  | { type: 'palette-hits'; hits: SearchHit[] }
  | { type: 'palette-searching'; on: boolean }
  | { type: 'palette-move'; delta: number; count: number }
  | { type: 'new-project'; patch: Partial<NewProjectState> }
  | { type: 'handoff'; patch: Partial<HandoffState> }

const upsertBy = <T>(list: T[], item: T, id: (t: T) => string): T[] => {
  const key = id(item)
  const i = list.findIndex((x) => id(x) === key)
  if (i < 0) return [...list, item]
  const next = list.slice()
  next[i] = item
  return next
}

/** Whether a memory belongs in the list for a scope. */
export function memoryInScope(m: MemoryView, scope: ProjectScope): boolean {
  if (scope === MEMORY_ALL) return true
  if (scope === 'global') return m.projectId === null && m.scope === 'global'
  if (scope === 'unassigned') return m.projectId === null
  return m.projectId === scope
}

function applyPush(s: WorkspaceState, m: ProjectMessage): WorkspaceState {
  switch (m.type) {
    case 'harness': {
      // Harness data is refetched by the controller (docs/harness.md); the push drops what it
      // made stale so no view keeps showing an old inspection.
      if (!m.agentId || !(m.agentId in s.harness.inspections)) return s
      const { [m.agentId]: _stale, ...inspections } = s.harness.inspections
      return { ...s, harness: { ...s.harness, inspections } }
    }
    case 'projects':
      return { ...s, projects: m.projects, projectsLoaded: true }
    case 'session': {
      const sessions = upsertBy(s.sessions, m.session, (x) => x.id)
      const dashboards = { ...s.dashboards }
      for (const [id, d] of Object.entries(dashboards)) {
        if (d.sessions.some((x) => x.id === m.session.id)) {
          dashboards[id] = { ...d, sessions: upsertBy(d.sessions, m.session, (x) => x.id) }
        }
      }
      return { ...s, sessions, dashboards }
    }
    case 'memory': {
      const exists = s.memories.some((x) => x.id === m.memory.id)
      const memories =
        exists || memoryInScope(m.memory, s.memoryScope)
          ? upsertBy(s.memories, m.memory, (x) => x.id)
          : s.memories
      return { ...s, memories }
    }
    case 'activity': {
      const pid = m.event.projectId
      const list = upsertBy(s.activity[pid] ?? [], m.event, (x) => x.id)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, ACTIVITY_CAP)
      const d = s.dashboards[pid]
      const dashboards = d
        ? { ...s.dashboards, [pid]: { ...d, activity: upsertBy(d.activity, m.event, (x) => x.id) } }
        : s.dashboards
      return { ...s, activity: { ...s.activity, [pid]: list }, dashboards }
    }
    case 'retrieval': {
      const ins = s.inspection
      if (!ins || ins.agentId !== m.agentId) return s
      return {
        ...s,
        inspection: {
          ...ins,
          retrieved: [...ins.retrieved, { ts: 0, tool: 'memory', memoryIds: m.memoryIds }],
        },
      }
    }
    case 'agent-project':
      return { ...s, agentProjects: { ...s.agentProjects, [m.agentId]: m.projectId } }
    case 'vault':
      return { ...s, vault: m.status }
  }
}

export function reduce(s: WorkspaceState, e: WorkspaceEvent): WorkspaceState {
  switch (e.type) {
    case 'push':
      return applyPush(s, e.msg)
    case 'navigate': {
      const projectId =
        e.view === 'overview' ? null : e.projectId !== undefined ? e.projectId : s.projectId
      // The pane's scope: the current project, else the first one; never changes the workspace's.
      const harness =
        e.view === 'harness' && s.harness.projectId === null
          ? {
              ...s.harness,
              projectId: projectId ?? s.projects.find((p) => !p.archived)?.id ?? null,
            }
          : s.harness
      return {
        ...s,
        harness,
        view: e.view,
        projectId,
        error: null,
        notice: null,
        removeImportedConfirm: false,
        highlightMessageId: e.view === 'sessions' ? s.highlightMessageId : null,
        sessionScope: e.view === 'sessions' ? (projectId ?? SESSION_ALL) : s.sessionScope,
        memoryScope: e.view === 'memory' ? (projectId ?? MEMORY_ALL) : s.memoryScope,
        sessionQuery: e.view === 'sessions' ? '' : s.sessionQuery,
        memoryQuery: e.view === 'memory' ? '' : s.memoryQuery,
        memoryFilter: e.view === 'memory' ? 'all' : s.memoryFilter,
        checkedMemoryIds: e.view === 'memory' ? [] : s.checkedMemoryIds,
        activityFilter: e.view === 'project' ? 'all' : s.activityFilter,
      }
    }
    case 'loading':
      return { ...s, loading: e.on }
    case 'error':
      return { ...s, error: e.error, loading: false }
    case 'notice':
      return { ...s, notice: e.notice }
    case 'import-status':
      return { ...s, importStatus: e.status }
    case 'remove-imported-confirm':
      return { ...s, removeImportedConfirm: e.open }
    case 'projects':
      return { ...s, projects: e.projects, projectsLoaded: true }
    case 'session-titles':
      return {
        ...s,
        sessionTitles: {
          ...s.sessionTitles,
          ...Object.fromEntries(
            e.sessions.map((x) => [x.id, { title: x.title, provider: String(x.provider) }]),
          ),
        },
      }
    case 'providers':
      return { ...s, providers: e.providers }
    case 'harness-ui':
      return { ...s, harness: { ...s.harness, ...e.patch } }
    case 'harnesses':
      return { ...s, harness: { ...s.harness, list: e.list, listLoaded: true } }
    case 'harness-detail': {
      // A different harness (or none) drops the unsaved edits and the per-harness view state.
      const other = e.detail?.id !== s.harness.detail?.id
      return {
        ...s,
        harness: {
          ...s.harness,
          detail: e.detail,
          ...(other && {
            draft: null,
            stepForm: null,
            ruleEditId: null,
            highlightRuleId: null,
            undo: null,
            versions: null,
            viewVersion: null,
            stale: false,
          }),
        },
      }
    }
    case 'import-sources':
      return { ...s, harness: { ...s.harness, sources: e.sources } }
    case 'import-preview':
      return {
        ...s,
        harness: {
          ...s.harness,
          preview: e.preview,
          selection: e.preview ? defaultImportSelection(e.preview) : { selected: [], gates: [] },
          edits: {},
          importSteps: e.preview
            ? defaultImportSteps(e.preview)
            : { order: [], selected: [], checks: {} },
          importFilter: null,
        },
      }
    case 'harness-inspection':
      return {
        ...s,
        harness: {
          ...s.harness,
          inspections: { ...s.harness.inspections, [e.agentId]: e.inspection },
        },
      }
    case 'harness-badges':
      return { ...s, harness: { ...s.harness, badges: e.badges } }
    case 'overview':
      return { ...s, overview: e.overview, vault: e.overview.vault, loading: false }
    case 'dashboard':
      return {
        ...s,
        dashboards: { ...s.dashboards, [e.dashboard.project.id]: e.dashboard },
        activity: { ...s.activity, [e.dashboard.project.id]: e.dashboard.activity },
        loading: false,
      }
    case 'activity-filter':
      return { ...s, activityFilter: e.filter }
    case 'sessions': {
      const keep = e.sessions.some((x) => x.id === s.selectedSessionId)
      return {
        ...s,
        sessions: e.sessions,
        selectedSessionId: keep ? s.selectedSessionId : (e.sessions[0]?.id ?? null),
        loading: false,
      }
    }
    case 'session-scope':
      return { ...s, sessionScope: e.scope }
    case 'session-query':
      return { ...s, sessionQuery: e.query }
    case 'select-session':
      return { ...s, selectedSessionId: e.sessionId, highlightMessageId: e.messageId ?? null }
    case 'messages':
      return {
        ...s,
        messages: { ...s.messages, [e.sessionId]: { messages: e.messages, more: e.more } },
      }
    case 'memories': {
      const keep = e.memories.some((x) => x.id === s.selectedMemoryId)
      return {
        ...s,
        memories: e.memories,
        selectedMemoryId: keep ? s.selectedMemoryId : null,
        checkedMemoryIds: s.checkedMemoryIds.filter((id) => e.memories.some((m) => m.id === id)),
        loading: false,
      }
    }
    case 'memory-scope':
      return { ...s, memoryScope: e.scope, checkedMemoryIds: [] }
    case 'memory-filter':
      return { ...s, memoryFilter: e.filter }
    case 'memory-query':
      return { ...s, memoryQuery: e.query }
    case 'select-memory':
      return { ...s, selectedMemoryId: e.memoryId }
    case 'toggle-memory-check':
      return {
        ...s,
        checkedMemoryIds: s.checkedMemoryIds.includes(e.memoryId)
          ? s.checkedMemoryIds.filter((id) => id !== e.memoryId)
          : [...s.checkedMemoryIds, e.memoryId],
      }
    case 'memory-updated':
      return { ...s, memories: upsertBy(s.memories, e.memory, (x) => x.id) }
    case 'inspection':
      return { ...s, inspectAgentId: e.agentId, inspection: e.inspection, loading: false }
    case 'palette-open':
      return { ...s, palette: { open: true, query: '', hits: [], selected: 0, searching: false } }
    case 'palette-close':
      return { ...s, palette: { ...s.palette, open: false } }
    case 'palette-query':
      return { ...s, palette: { ...s.palette, query: e.query, selected: 0 } }
    case 'palette-hits':
      return { ...s, palette: { ...s.palette, hits: e.hits, searching: false } }
    case 'palette-searching':
      return { ...s, palette: { ...s.palette, searching: e.on } }
    case 'palette-move':
      return {
        ...s,
        palette: {
          ...s.palette,
          selected: Math.min(Math.max(0, e.count - 1), Math.max(0, s.palette.selected + e.delta)),
        },
      }
    case 'new-project':
      return { ...s, newProject: { ...s.newProject, ...e.patch } }
    case 'handoff':
      return { ...s, handoff: { ...s.handoff, ...e.patch } }
  }
}
