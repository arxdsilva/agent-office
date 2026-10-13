// View ports of the projects-first workspace (implemented by DOM adapters, faked in tests).
// Each view renders a pure view model and reports user intent through callbacks; the workspace
// controller owns every decision. The lead folds this file into ports.ts later.
import type { ProjectLibraryVM } from './app/project-library.ts'
import type { MemoryKind, MemoryScope, TaskView } from '@agent-office/shared'

export type TaskState = TaskView['state']
import type {
  ActivityFilter,
  DashboardVM,
  HandoffVM,
  InspectorVM,
  MemoryFilterKey,
  MemoryVM,
  NewProjectVM,
  OverviewVM,
  PaletteVM,
  SessionsVM,
  ShellVM,
  SidebarTarget,
  WorkspaceAction,
} from './app/workspace/types.ts'

type Off = void

/** Sidebar, top bar and which pane is visible (`ShellVM.view`, `ShellVM.stageVisible`). */
export interface ShellView {
  render(vm: ShellVM): void
  onNavigate(fn: (target: SidebarTarget) => void): Off
  onSelectProject(fn: (projectId: string) => void): Off
  onNewProject(fn: () => void): Off
  /** The top-bar search box was activated (opens the palette). */
  onOpenPalette(fn: () => void): Off
  onNewAgent(fn: () => void): Off
  /** The notification bell: goes to the Overview. */
  onNotifications(fn: () => void): Off
  /** The provider health pill: opens the Connect panel. */
  onHealth(fn: () => void): Off
  /** The sidebar collapse toggle; the controller persists it. */
  onCollapse(fn: (collapsed: boolean) => void): Off
}

export interface OverviewView {
  render(vm: OverviewVM): void
  onAction(fn: (a: WorkspaceAction) => void): Off
}

export interface DashboardView {
  /** `null` hides the dashboard (unknown project). */
  render(vm: DashboardVM | null): void
  onAction(fn: (a: WorkspaceAction) => void): Off
  onActivityFilter(fn: (f: ActivityFilter) => void): Off
  /** A task was typed into `#pd-task-input` and added. */
  onTaskAdd(fn: (projectId: string, title: string) => void): Off
  onTaskState(fn: (taskId: string, state: TaskState) => void): Off
  /** The Confirm button: adds `user-confirmed` evidence. */
  onTaskConfirm(fn: (taskId: string) => void): Off
}

export interface SessionVaultView {
  render(vm: SessionsVM): void
  onSearch(fn: (query: string) => void): Off
  onScope(fn: (scope: string) => void): Off
  onSelect(fn: (sessionId: string) => void): Off
  /** The user pressed an Assign button (a suggestion or the manual picker). */
  onAssign(fn: (sessionId: string, projectId: string | null) => void): Off
  /** "Continue with…" (handoff). */
  onContinue(fn: (sessionId: string) => void): Off
  /** "Resume" (experimental, normally disabled). */
  onResume(fn: (sessionId: string) => void): Off
  onLoadMore(fn: (sessionId: string) => void): Off
  /** "Save as memory" on a message (`.msg-save`): the title and kind come from the small form. */
  onSaveMemory(
    fn: (sessionId: string, messageId: string, fields: { title: string; kind: MemoryKind }) => void,
  ): Off
  /** "Import Claude history" (`#sv-import`, experimental). */
  onImport(fn: () => void): Off
}

export interface MemoryDraftFields {
  title: string
  body: string
  kind: MemoryKind
  scope: MemoryScope
}
export interface MemoryView {
  render(vm: MemoryVM): void
  onSelect(fn: (memoryId: string) => void): Off
  onScope(fn: (scope: string) => void): Off
  onFilter(fn: (filter: MemoryFilterKey) => void): Off
  onSearch(fn: (query: string) => void): Off
  onToggleCheck(fn: (memoryId: string) => void): Off
  onApprove(fn: (memoryId: string) => void): Off
  onReject(fn: (memoryId: string) => void): Off
  onEdit(fn: (memoryId: string, patch: Partial<MemoryDraftFields>) => void): Off
  onSupersede(fn: (memoryId: string, replacement: MemoryDraftFields) => void): Off
  /** Merges the checked approved items into one new item. */
  onMerge(fn: (into: MemoryDraftFields) => void): Off
  /** `#mem-remove-imported`: asks to remove the auto-imported items of the current scope. */
  onRemoveImported(fn: () => void): Off
  /** OK in `#mem-remove-confirm`. */
  onRemoveImportedConfirm(fn: () => void): Off
  /** Cancel (or Esc) in `#mem-remove-confirm`. */
  onRemoveImportedCancel(fn: () => void): Off
}

export interface InspectorView {
  render(vm: InspectorVM): void
  onRefresh(fn: () => void): Off
  /** The `#ci-agent` picker changed. */
  onAgent(fn: (agentId: string) => void): Off
}

export interface PaletteView {
  render(vm: PaletteVM): void
  onQuery(fn: (query: string) => void): Off
  /** Arrow keys. */
  onMove(fn: (delta: number) => void): Off
  /** Enter (no id) or a click (item id). */
  onChoose(fn: (itemId?: string) => void): Off
  onClose(fn: () => void): Off
}

export interface NewProjectView {
  render(vm: NewProjectVM): void
  onName(fn: (name: string) => void): Off
  onAddFolder(fn: () => void): Off
  onRemoveFolder(fn: (ref: string) => void): Off
  onCreate(fn: () => void): Off
  onCancel(fn: () => void): Off
}

export interface HandoffView {
  render(vm: HandoffVM): void
  onObjective(fn: (text: string) => void): Off
  onProvider(fn: (providerId: string) => void): Off
  /** "Preview context": prepares the handoff. */
  onPreview(fn: () => void): Off
  onToggleItem(fn: (itemId: string, included: boolean) => void): Off
  onNote(fn: (note: string) => void): Off
  onLaunch(fn: () => void): Off
  onCancel(fn: () => void): Off
}

/** What the workspace asks of the office scene and the rest of the app. */
export interface WorkspaceSceneHooks {
  select(agentId: string): void
  /** Dims every agent outside the list; `null` clears the focus. */
  focusAgents?(ids: string[] | null): void
  /** Shows or hides the stage; hidden also pauses rendering. */
  setOfficeVisible(on: boolean): void
  openNewSession(prefill: { projectId?: string; provider?: string; objective?: string }): void
  switchMode(mode: '3d' | 'pixel'): void
  openConnect(): void
  /** The selected project's Library collections for the scene; `null` clears them. */
  /** The agent selected in the Office, if any (default for the Context Inspector). */
  selectedAgentId?(): string | null
  setProjectLibrary?(vm: ProjectLibraryVM | null): void
}

export interface WorkspaceViews {
  shell: ShellView
  overview: OverviewView
  dashboard: DashboardView
  sessions: SessionVaultView
  memory: MemoryView
  inspector: InspectorView
  palette: PaletteView
  newProject: NewProjectView
  handoff: HandoffView
}
