// Types of the projects-first workspace: the view names, the actions a user can trigger and the
// view models each DOM view renders. Pure data; every string is drawn as plain text (textContent).
import type { ProjectScope } from './state-types.ts'

export type WorkspaceView = 'overview' | 'office' | 'project' | 'sessions' | 'memory' | 'context'
export type SidebarTarget = 'overview' | 'office' | 'sessions' | 'memory'

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
  | { type: 'focus-agent'; agentId: string }
  | { type: 'connect-provider' }
  | { type: 'switch-mode'; mode: '3d' | 'pixel' }
  /** Experimental: reads Claude Code's own history metadata (explicit user action). */
  | { type: 'import-history' }

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
  id: 'active' | 'activity' | 'completed' | 'tasks' | 'knowledge'
  /** The question this section answers. */
  heading: string
  rows: DashboardRowVM[]
  empty: string
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
  /** A one-line result ("Saved as memory", "Imported 3 sessions"); null hides it. */
  notice: string | null
}

// ── Memory ────────────────────────────────────────────────────────────────────────────────────
export type MemoryFilterKey = 'all' | 'pending' | 'approved' | 'rejected' | 'superseded'
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
