// Types of the projects-first workspace: the view names, the actions a user can trigger and the
// view models each DOM view renders. Pure data; every string is drawn as plain text (textContent).
import type { ProjectScope } from './state-types.ts'

export type WorkspaceView =
  'overview' | 'office' | 'project' | 'sessions' | 'memory' | 'context' | 'harness'
export type SidebarTarget = 'overview' | 'office' | 'sessions' | 'memory' | 'harness'

/** Everything a card, button or palette entry can ask the controller to do. */
export type WorkspaceAction =
  | { type: 'open-overview' }
  | { type: 'open-office' }
  | { type: 'open-project'; projectId: string }
  | { type: 'new-project' }
  | { type: 'start-agent'; projectId?: string }
  | { type: 'continue-work'; projectId: string; sessionId?: string }
  | { type: 'prepare-handoff'; projectId: string; sessionId?: string }
  | { type: 'open-handoff'; handoffId: string }
  | { type: 'review-approvals'; projectId?: string }
  | { type: 'open-memory'; projectId?: string; memoryId?: string }
  | { type: 'open-sessions'; projectId?: string }
  | { type: 'open-session'; sessionId: string; messageId?: string }
  | { type: 'inspect-context'; agentId?: string; projectId?: string }
  | { type: 'search-history'; projectId?: string }
  /** `tab: 'harness'` opens Agent Details on its Harness tab (Overview approval "Open"). */
  | { type: 'focus-agent'; agentId: string; tab?: 'harness' }
  | { type: 'connect-provider' }
  | { type: 'switch-mode'; mode: '3d' | 'pixel' }
  /** Experimental: reads Claude Code's own history metadata (explicit user action). */
  | { type: 'import-history' }
  /** Rejects every auto-imported memory item (asks first). Palette + `#mem-remove-imported`. */
  | { type: 'remove-imported' }
  /** The Harnesses pane (docs/harness.md §7), scoped to a project when given. */
  | { type: 'open-harnesses'; projectId?: string }
  /** "New harness": creates a draft and opens it in the editor. */
  | { type: 'harness-new' }
  | { type: 'harness-edit'; harnessId: string }
  /** The import flow for a project's rule files (read-only; creates a draft). */
  | { type: 'harness-import'; projectId: string }
  | { type: 'harness-attach'; projectId: string; harnessId: string }
  // Flow steps (docs/harness.md §2a): user actions on a session's flow progress.
  | { type: 'flow-approve'; agentId: string; stepId: string; checkIndex: number }
  | { type: 'flow-mark-done'; agentId: string; stepId: string }
  | { type: 'flow-skip'; agentId: string; stepId: string; confirmed: boolean }
  | { type: 'flow-reopen'; agentId: string; stepId: string }
  /** Runs the agent's validation gates through the trusted runner. */
  | { type: 'run-gates'; agentId: string }

export type Tone = 'neutral' | 'good' | 'warn' | 'bad'
export interface ButtonVM {
  id: string
  label: string
  enabled: boolean
  /** Why it is disabled, or a caveat such as "experimental". */
  hint?: string
  action?: WorkspaceAction
}

// ── Shell ─────────────────────────────────────────────────────────────────────────────────────
export interface SidebarItemVM {
  id: SidebarTarget
  label: string
  active: boolean
  /** Attention count (waiting agents, pending approvals, unassigned sessions); 0 hides the badge. */
  count: number
}
export interface SidebarProjectVM {
  /** Rendered as `li[data-project-id]`. */
  projectId: string
  name: string
  color: string
  active: boolean
  /** Active agents (`.sb-count`). */
  count: number
  pending: number
  /** While a harness is dragged: whether this row accepts it (the adapter's dragover decision). */
  dropTarget?: 'ok' | 'reject'
  /** The dragged harness is over this row (`.drop-target` / `.drop-reject`). */
  dropHover?: boolean
  /** A harness was just dropped here (`.just-dropped`, 600 ms). */
  justDropped?: boolean
}
export interface ShellVM {
  view: WorkspaceView
  /** The 3D/2D stage is visible only in the Office. */
  stageVisible: boolean
  layout: { sidebarCollapsed: boolean }
  sidebar: SidebarItemVM[]
  projectsHeading: string
  projects: SidebarProjectVM[]
  projectsEmpty: string | null
  newProjectLabel: string
  topbar: {
    searchPlaceholder: string
    currentProject: { id: string; name: string; color: string } | null
    projectLabel: string
    newAgentLabel: string
    notifications: number
    notificationsLabel: string
    health: { tone: Tone; label: string; detail: string }
    vault: { status: 'encrypted' | 'memory-only' | 'unknown'; tone: Tone; label: string }
  }
}

// ── Overview ──────────────────────────────────────────────────────────────────────────────────
export interface OverviewCardVM {
  id: string
  title: string
  detail: string
  tone: Tone
  action?: WorkspaceAction
  actionLabel?: string
}
export interface OverviewSectionVM {
  id:
    'attention' | 'projects' | 'completions' | 'decisions' | 'approvals' | 'handoffs' | 'providers'
  heading: string
  items: OverviewCardVM[]
  empty: string
}
export interface OverviewVM {
  heading: string
  loading: boolean
  error: string | null
  sections: OverviewSectionVM[]
  /** True when there is no project yet: the DOM shows the create-first-project card. */
  noProjects: boolean
  noProjectsText: string
  createProject: ButtonVM
}

// ── Dashboard ─────────────────────────────────────────────────────────────────────────────────
export type ActivityFilter = 'all' | 'sessions' | 'memory' | 'handoffs' | 'problems'
export interface DashboardRowVM {
  id: string
  title: string
  detail: string
  /** e.g. "Agent reported (unverified)". */
  badge?: string
  tone: Tone
  action?: WorkspaceAction
  /** Activity rows only: timestamp and calendar day relative to the injected clock. */
  ts?: number
  day?: 'today' | 'yesterday' | string
  /** Task rows only: the state select and the Confirm button. */
  task?: {
    taskId: string
    state: 'open' | 'doing' | 'done' | 'dropped'
    stateOptions: { value: 'open' | 'doing' | 'done' | 'dropped'; label: string }[]
    confirm: ButtonVM
  }
}
export interface DashboardSectionVM {
  id: 'active' | 'activity' | 'completed' | 'tasks' | 'knowledge' | 'harness'
  /** The question this section answers. */
  heading: string
  rows: DashboardRowVM[]
  empty: string
  /** A section-level button ("Manage harnesses"). */
  action?: ButtonVM
}
export interface DashboardMetrics {
  activeAgents: number
  waiting: number
  sessions: number
  approvedMemories: number
  pendingMemories: number
  openTasks: number
}
export interface DashboardVM {
  /** The Harness section (`#pd-harness`); absent until the dashboard is loaded. */
  harness?: DashboardSectionVM
  projectId: string
  name: string
  color: string
  subtitle: string
  repos: string[]
  metrics: DashboardMetrics
  providers: { id: string; label: string }[]
  knowledge: { approved: number; pending: number }
  error: string | null
  loading: boolean
  sections: DashboardSectionVM[]
  activityFilters: { id: ActivityFilter; label: string; active: boolean }[]
  actions: ButtonVM[]
  /** The "add a task" form (`#pd-task-input`, `#pd-task-add`). */
  taskForm: { placeholder: string; addLabel: string }
}

// ── Session Vault ─────────────────────────────────────────────────────────────────────────────
export interface SessionRowVM {
  id: string
  title: string
  provider: string
  stateLabel: string
  originLabel: string
  when: string
  selected: boolean
  unassigned: boolean
}
export interface SessionGroupVM {
  /** Project id or 'unassigned'. */
  key: string
  heading: string
  rows: SessionRowVM[]
}
export interface SessionMessageVM {
  /** Rendered as `[data-msg-id]`. */
  id: string
  role: 'user' | 'agent' | 'system'
  roleLabel: string
  text: string
  when: string
  tools: string[]
  /** "agent-office chat" or "Provider transcript". */
  sourceBadge: string
  highlighted: boolean
  /** "Save as memory": the button label and the title the form starts with (first 80 chars). */
  save: { label: string; defaultTitle: string }
}
export interface SessionSuggestionVM {
  projectId: string
  name: string
  rule: string
  confidence: 'high' | 'low'
  /** Never applied automatically: the user presses it. */
  assign: ButtonVM
}
export interface SessionDetailVM {
  id: string
  title: string
  provider: string
  projectName: string | null
  assignedByLabel: string | null
  summary: { text: string; sourceLabel: string } | null
  continuedFrom: string | null
  messages: SessionMessageVM[]
  moreMessages: boolean
  messagesEmpty: string
  suggestions: SessionSuggestionVM[]
  /** Native resume: enabled only when the session says `canResume`; always marked experimental. */
  resume: ButtonVM
  /** Handoff to another provider ("Continue with…"). */
  continueWith: ButtonVM
  assignOptions: { projectId: string | null; name: string; current: boolean }[]
}
export interface SessionsVM {
  heading: string
  searchPlaceholder: string
  query: string
  error: string | null
  loading: boolean
  scopes: { key: string; label: string; active: boolean }[]
  groups: SessionGroupVM[]
  empty: string
  detail: SessionDetailVM | null
  detailEmpty: string
  /** Experimental: imports past Claude Code sessions (`#sv-import`). */
  importHistory: ButtonVM
  /** `#sv-import-status` while automatic import is on: "Last run 5m ago: 4 sessions, 3 summaries". */
  importStatus: string | null
  /** A one-line result ("Saved as memory", "Imported 3 sessions"); null hides it. */
  notice: string | null
}

// ── Memory ────────────────────────────────────────────────────────────────────────────────────
export type MemoryFilterKey =
  | 'all'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'superseded'
  /** Approved items taken from sessions automatically (`provenance.origin === 'session-import'`). */
  | 'auto-imported'
export interface BadgeVM {
  label: string
  tone: Tone
}
export interface MemoryRowVM {
  id: string
  title: string
  kindLabel: string
  scopeLabel: string
  badges: BadgeVM[]
  selected: boolean
  checked: boolean
}
export interface MemoryDetailVM {
  id: string
  title: string
  body: string
  kind: string
  scope: string
  badges: BadgeVM[]
  provenance: string[]
  actions: {
    approve: ButtonVM
    reject: ButtonVM
    edit: ButtonVM
    supersede: ButtonVM
    merge: ButtonVM
    scope: ButtonVM
  }
  scopeOptions: { scope: string; label: string; current: boolean }[]
}
export interface MemoryVM {
  heading: string
  searchPlaceholder: string
  query: string
  error: string | null
  loading: boolean
  scopeLabel: string
  scopes: { key: ProjectScope; label: string; active: boolean }[]
  filters: { key: MemoryFilterKey; label: string; count: number; active: boolean }[]
  rows: MemoryRowVM[]
  empty: string
  detail: MemoryDetailVM | null
  detailEmpty: string
  /** `#mem-remove-imported`: acts on the current project, or on all memory. */
  removeImported: ButtonVM
  /** `#mem-remove-confirm`; shown while `open`. */
  removeConfirm: { open: boolean; title: string; body: string; ok: string; cancel: string }
  /** A one-line result ("Removed 3 imported items"); null hides it. */
  notice: string | null
}

// ── Context Inspector ─────────────────────────────────────────────────────────────────────────
export interface InspectorEntryVM {
  id: string
  title: string
  detail: string
}
export interface InspectorVM {
  heading: string
  note: string
  error: string | null
  loading: boolean
  agentId: string | null
  /** The project's active agents for `#ci-agent`; hidden when empty. */
  agents: { id: string; label: string; selected: boolean }[]
  agentLabel: string
  projectName: string | null
  available: { heading: string; summary: string }
  retrieved: { heading: string; entries: InspectorEntryVM[]; empty: string }
  delivered: { heading: string; entries: InspectorEntryVM[]; empty: string }
}

// ── Palette ───────────────────────────────────────────────────────────────────────────────────
export interface PaletteItemVM {
  id: string
  group: 'command' | 'project' | 'session' | 'message' | 'memory' | 'handoff' | 'agent'
  label: string
  detail: string
  action: WorkspaceAction
  selected: boolean
}
export interface PaletteVM {
  open: boolean
  placeholder: string
  query: string
  items: PaletteItemVM[]
  empty: string
  searching: boolean
}

// ── New project, handoff ──────────────────────────────────────────────────────────────────────
export interface NewProjectVM {
  open: boolean
  heading: string
  name: string
  namePlaceholder: string
  folders: { ref: string; label: string; hint: string }[]
  addFolder: ButtonVM
  create: ButtonVM
  error: string | null
}
export interface HandoffItemVM {
  /** Memory id (or summary/instruction ref id). */
  id: string
  title: string
  excerpt: string
  reasons: string[]
  included: boolean
  /** Only memory items can be unchecked. */
  toggleable: boolean
  excludedReason?: string
}
export interface HandoffVM {
  open: boolean
  stage: 'compose' | 'review'
  heading: string
  fromLabel: string
  objective: string
  provider: string
  providerOptions: { id: string; label: string }[]
  preview: ButtonVM
  items: HandoffItemVM[]
  itemsEmpty: string
  note: string
  tokens: { used: number; budgetChars: number; usedChars: number; label: string }
  launch: ButtonVM
  error: string | null
}

// ── Project directory (3D / 2D reception) ────────────────────────────────────────────────────
export interface ProjectDirectoryEntryVM {
  projectId: string
  name: string
  color: string
  selected: boolean
  counts: { agents: number; sessions: number; memories: number; pending: number; tasks: number }
  countsLabel: string
  actions: ButtonVM[]
}
export interface ProjectDirectoryVM {
  heading: string
  entries: ProjectDirectoryEntryVM[]
  empty: string
  createProject: ButtonVM
}
