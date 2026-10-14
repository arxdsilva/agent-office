// The projects-first workspace controller. Subscribes to project pushes, fetches data on
// navigation and routes every user intent (sidebar, palette, dashboard actions, memory review,
// session assignment, handoffs, new projects) to the gateway or the scene hooks. Views are ports;
// failures become an error string in the view models (nothing throws into the DOM).
import type {
  AgentOfficeApi,
  HandoffView as HandoffData,
  HarnessDraft,
  MemoryDraft,
  ProjectMessage,
  Settings,
} from '@agent-office/shared'
import { dashboardVM } from './app/workspace/dashboard-vm.ts'
import { libraryCounts } from './app/workspace/library-counts.ts'
import { projectLibraryVM } from './app/project-library.ts'
import { handoffProviders, handoffVM } from './app/workspace/handoff-vm.ts'
import { attachedIds, harnessBuilderVM } from './app/workspace/harness-builder-vm.ts'
import {
  LIVE,
  announce,
  dropIntent,
  moveId,
  sortLibrary,
  type DropTarget,
} from './app/workspace/harness-dnd.ts'
import {
  changedFields,
  draftFromDetail,
  importStepsArg,
  newStepForm,
  stepFormFrom,
  stepFromForm,
} from './app/workspace/harness-vm.ts'
import { startableProviders } from './app/view-models.ts'
import { inspectorVM } from './app/workspace/inspector-vm.ts'
import { memoryVM, removeImportedTarget } from './app/workspace/memory-vm.ts'
import { newProjectVM } from './app/workspace/new-project-vm.ts'
import { overviewVM } from './app/workspace/overview-vm.ts'
import { mergeHits, paletteItems, paletteVM } from './app/workspace/palette-vm.ts'
import { projectDirectoryVM } from './app/workspace/project-directory-vm.ts'
import { sessionsVM } from './app/workspace/sessions-vm.ts'
import { shellVM } from './app/workspace/shell-vm.ts'
import { startView } from './app/workspace/start-view.ts'
import { MEMORY_ALL } from './app/workspace/state-types.ts'
import {
  SESSION_ALL,
  initialState,
  reduce,
  type WorkspaceEvent,
  type WorkspaceState,
} from './app/workspace/state.ts'
import type {
  ProjectDirectoryVM,
  SidebarTarget,
  WorkspaceAction,
  WorkspaceView,
} from './app/workspace/types.ts'
import { WS_COPY, errorText } from './app/workspace/workspace-copy.ts'
import type { MemoryDraftFields, WorkspaceSceneHooks, WorkspaceViews } from './workspace-ports.ts'

export interface WorkspaceControllerDeps {
  gateway: AgentOfficeApi
  views: WorkspaceViews
  scene: WorkspaceSceneHooks
  settings: () => Settings
  clock: { now(): number }
  /** Debounce timer for the palette's deep search; defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void
}

/** The palette waits this long after the last keystroke before the deep (transcript) search. */
export const DEEP_SEARCH_DELAY_MS = 300
export const DEEP_SEARCH_MIN_CHARS = 3
const MESSAGE_PAGES_MAX = 5

export interface WorkspaceController {
  /** Boot: loads projects, picks the start view. */
  start(): Promise<void>
  dispose(): void
  getState(): WorkspaceState
  navigate(view: WorkspaceView, projectId?: string | null): Promise<void>
  /** Runs any card, button or palette action. */
  perform(action: WorkspaceAction): Promise<void>
  /** Ctrl/Cmd+K. */
  togglePalette(): void
  openPalette(): void
  closePalette(): void
  /** Esc: closes the topmost dialog; true when it did something. */
  escape(): boolean
  paletteMove(delta: number): void
  paletteChoose(itemId?: string): Promise<void>
  /** The reception directory of the 3D/2D office. */
  projectDirectory(): ProjectDirectoryVM
  /** A project picked in the directory: focuses its agents and makes it current. */
  selectDirectoryProject(projectId: string | null): Promise<void>
}

export function createWorkspaceController(d: WorkspaceControllerDeps): WorkspaceController {
  const { gateway, views, scene } = d
  const api = gateway.projects
  let state = initialState()
  let disposed = false
  let navSeq = 0
  let searchSeq = 0
  let pendingNote: string | null = null
  let collapsed = d.settings().layout?.sidebarCollapsed ?? false
  /** The Harness library order; sent back whole with every layout patch (layout is replaced as one object). */
  let harnessOrder: string[] = d.settings().layout?.harnessOrder ?? []
  const offs: (() => void)[] = []
  state = { ...state, harness: { ...state.harness, order: harnessOrder } }

  const now = (): number => d.clock.now()
  const schedule =
    d.schedule ??
    ((fn: () => void, ms: number): (() => void) => {
      const t = setTimeout(fn, ms)
      return () => clearTimeout(t)
    })
  let cancelDeep: (() => void) | null = null
  let libSeq = 0

  function render(): void {
    if (disposed) return
    views.shell.render(shellVM(state, { sidebarCollapsed: collapsed }))
    views.overview.render(overviewVM(state, now()))
    views.dashboard.render(
      state.view === 'project' && state.projectId
        ? dashboardVM(state, state.projectId, now())
        : null,
    )
    views.sessions.render(sessionsVM(state, now()))
    views.memory.render(memoryVM(state, now()))
    views.inspector.render(inspectorVM(state, now()))
    views.palette.render(paletteVM(state))
    views.newProject.render(newProjectVM(state))
    views.handoff.render(handoffVM(state))
    views.harness.render(harnessBuilderVM(state))
    // Focus is a one-shot request: drawn once, then forgotten without another render.
    if (state.harness.focus) state = { ...state, harness: { ...state.harness, focus: null } }
  }

  function dispatch(e: WorkspaceEvent): void {
    state = reduce(state, e)
    render()
  }

  /** Runs a gateway call; a failure becomes the error string. */
  async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn()
    } catch (e) {
      dispatch({ type: 'error', error: errorText(e) })
      return undefined
    }
  }

  // ── Harnesses pane (docs/harness.md §7) ────────────────────────────────────────────────────
  const hui = (patch: Partial<WorkspaceState['harness']>): void =>
    dispatch({ type: 'harness-ui', patch })
  const later = (ms: number, fn: () => void): void => {
    schedule(() => {
      if (!disposed) fn()
    }, ms)
  }
  const harnessName = (id: string): string =>
    state.harness.list.find((x) => x.id === id)?.name ?? ''
  const projectName = (id: string | null | undefined): string =>
    (id && state.projects.find((p) => p.id === id)?.name) || WS_COPY.harness.confirm.thisProject
  const HL = WS_COPY.harness.live

  /** A harness call from the pane: a failure becomes the pane's error line (and is announced). */
  async function hguard<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn()
    } catch (e) {
      const error = errorText(e)
      hui({ error, busy: false, live: error })
      return undefined
    }
  }
  /** The library (also the sidebar's draft badge); quiet unless the pane is showing. */
  async function loadHarnesses(): Promise<void> {
    const h = api.harness
    if (!h) return
    if (state.view === 'harness') {
      const list = await hguard(() => h.list())
      if (list && !disposed) dispatch({ type: 'harnesses', list })
      return
    }
    try {
      const list = await h.list()
      if (!disposed) dispatch({ type: 'harnesses', list })
    } catch {
      // keep whatever is shown
    }
  }
  async function loadTemplates(): Promise<void> {
    const h = api.harness
    const templates = h ? await hguard(() => h.templates()) : undefined
    if (templates && !disposed) hui({ templates })
  }
  async function reloadHarnessDetail(): Promise<void> {
    const h = api.harness
    const id = state.harness.detail?.id
    if (!h || !id) return
    const detail = await hguard(() => h.get(id))
    if (detail && !disposed) dispatch({ type: 'harness-detail', detail })
    if (state.harness.versions) void loadVersions()
  }
  async function loadVersions(): Promise<void> {
    const h = api.harness
    const id = state.harness.detail?.id
    if (!h?.versions || !id) return
    const versions = await hguard(() => h.versions(id))
    if (versions && !disposed && state.harness.detail?.id === id) hui({ versions })
  }
  /** What each ready provider would enforce on the pane's scope project. */
  async function loadCoverage(): Promise<void> {
    const h = api.harness
    const pid = state.harness.projectId
    if (!h || !pid) {
      if (state.harness.coverage.length) hui({ coverage: [] })
      return
    }
    if (!state.providers.length) await loadProviders()
    const ids = startableProviders(state.providers).map((p) => p.id)
    const results = await hguard(() => Promise.all(ids.map((id) => h.coverage(pid, id))))
    if (results && !disposed && state.harness.projectId === pid)
      hui({ coverage: results.map((r) => r.report) })
  }
  /** The editor's draft: unsaved edits, else the stored harness. */
  const currentDraft = (): HarnessDraft | null =>
    state.harness.draft ?? (state.harness.detail ? draftFromDetail(state.harness.detail) : null)
  const editorDirty = (): boolean => {
    const h = state.harness
    return !!h.draft && !!h.detail && changedFields(h.draft, draftFromDetail(h.detail)).length > 0
  }

  async function openHarnessEditor(harnessId: string): Promise<void> {
    const h = api.harness
    if (!h) return
    if (state.view !== 'harness') await go('harness')
    hui({ tab: 'editor', editorTab: 'overview', selectedId: harnessId, error: null })
    const detail = await hguard(() => h.get(harnessId))
    if (detail) dispatch({ type: 'harness-detail', detail })
    void loadCoverage()
  }

  async function detectSources(): Promise<void> {
    const h = api.harness
    const pid = state.harness.projectId
    if (!h || !pid) return
    hui({ busy: true, error: null })
    const sources = await hguard(() => h.importDetect(pid))
    hui({ busy: false })
    if (sources) {
      dispatch({ type: 'import-sources', sources })
      hui({ excluded: [] })
    }
  }
  async function previewImport(): Promise<void> {
    const h = api.harness
    const pid = state.harness.projectId
    if (!h || !pid) return
    const excluded = new Set(state.harness.excluded)
    const paths = (state.harness.sources ?? []).map((x) => x.path).filter((p) => !excluded.has(p))
    hui({ busy: true, error: null })
    const preview = await hguard(() =>
      h.importPreview({ projectId: pid as never, ...(excluded.size && { paths }) }),
    )
    hui({ busy: false })
    if (preview) dispatch({ type: 'import-preview', preview })
  }
  async function commitImport(): Promise<void> {
    const h = api.harness
    const hs = state.harness
    const preview = hs.preview
    if (!h || !preview) return
    const pname = hs.projectId ? state.projects.find((p) => p.id === hs.projectId)?.name : null
    const fallback = pname
      ? WS_COPY.harness.import.standards(pname)
      : WS_COPY.harness.import.defaultName
    const name = (hs.importName || fallback).trim()
    if (!name) {
      hui({ error: WS_COPY.harness.import.needName })
      return
    }
    const chosen = new Set(hs.selection.selected)
    const edits = Object.entries(hs.edits)
      .filter(([id]) => chosen.has(id))
      .map(([tempId, e]) => ({ tempId, ...e }))
    const steps = importStepsArg(hs.importSteps)
    hui({ busy: true, error: null })
    const detail = await hguard(() =>
      h.importCommit({
        previewId: preview.previewId,
        name,
        selected: hs.selection.selected as never,
        ...(edits.length && { edits: edits as never }),
        gates: hs.selection.gates as never,
        ...(steps.length && { steps: steps as never }),
        attach: hs.importAttach,
      }),
    )
    hui({ busy: false })
    if (!detail) return
    dispatch({ type: 'import-preview', preview: null })
    dispatch({ type: 'import-sources', sources: null })
    dispatch({ type: 'harness-detail', detail })
    hui({
      tab: 'editor',
      editorTab: 'overview',
      importName: '',
      importAttach: false,
      selectedId: detail.id,
      notice: WS_COPY.harness.import.done,
      live: WS_COPY.harness.import.done,
      focus: 'hb-f-name',
    })
    await loadHarnesses()
    if (hs.importAttach) await loadProjects()
  }

  async function runConfirm(): Promise<void> {
    const h = api.harness
    const c = state.harness.confirm
    if (!c) return
    if (c.kind === 'discard') {
      hui({ confirm: null, draft: null, stepForm: null, ruleEditId: null, stale: false })
      if (c.next) await go(c.next.view, c.next.projectId, [], true)
      return
    }
    const pid = c.projectId ?? state.harness.projectId
    if (!h) return
    hui({ confirm: null, busy: true, error: null })
    const name = harnessName(c.harnessId)
    const ok = await hguard(async () => {
      if (c.kind === 'publish') {
        const d = await h.publish(c.harnessId)
        return HL.published(name || d.name, d.version)
      }
      if (c.kind === 'archive') {
        await h.archive(c.harnessId)
        return HL.archived(name)
      }
      if (!pid) throw new Error(WS_COPY.harness.library.hints.attachNeedsProject)
      if (c.kind === 'attach') {
        await h.attach(pid, c.harnessId)
        return HL.attached(name, projectName(pid))
      }
      await h.detach(pid, c.harnessId)
      return HL.detached(name, projectName(pid))
    })
    hui({ busy: false })
    if (!ok) return
    hui({
      live: ok,
      error: null,
      ...(c.kind === 'attach' && { justAttached: c.harnessId }),
    })
    if (c.kind === 'attach') later(300, () => hui({ justAttached: null }))
    await loadHarnesses()
    if (c.kind === 'attach' || c.kind === 'detach') await loadProjects()
    if (state.harness.detail?.id === c.harnessId) await reloadHarnessDetail()
  }

  /** Attach by drop (Applied column or a sidebar project); `ids` = the Applied order wanted. */
  async function attachTo(
    harnessId: string,
    projectId: string,
    ids?: string[],
    fromSidebar = false,
  ): Promise<void> {
    const h = api.harness
    if (!h || state.harness.busy) return
    hui({ busy: true, error: null, drag: null })
    const ok = await hguard(async () => {
      const list = await h.attach(projectId, harnessId)
      const now = list.map((x) => x.id)
      if (ids && now.length === ids.length && now.some((x, i) => x !== ids[i]))
        await h.reorder(projectId, ids)
      return true
    })
    hui({ busy: false })
    if (!ok) return
    hui({
      live: HL.attached(harnessName(harnessId), projectName(projectId)),
      ...(fromSidebar
        ? { justDropped: projectId }
        : projectId === state.harness.projectId
          ? { justAttached: harnessId }
          : {}),
    })
    later(fromSidebar ? 600 : 300, () => hui({ justDropped: null, justAttached: null }))
    await Promise.all([loadHarnesses(), loadProjects()])
  }

  const withHarnessIds = (projectId: string, ids: string[]) =>
    state.projects.map((p) => (p.id === projectId ? { ...p, harnessIds: ids } : p))

  /** The one id a single move displaced (for the announcement). */
  function movedId(before: string[], after: string[]): string | undefined {
    const i = before.findIndex((x, k) => x !== after[k])
    if (i < 0) return undefined
    const up = after[i]!
    const rest = (xs: string[], id: string) => xs.filter((x) => x !== id)
    return rest(before, up).every((x, k) => x === rest(after, up)[k]) ? up : before[i]
  }

  /** Optimistic Applied reorder: shown at once, rolled back if main refuses it. */
  async function reorderApplied(projectId: string, ids: string[]): Promise<void> {
    const h = api.harness
    if (!h || state.harness.busy) return
    const before = attachedIds(state, projectId)
    const moved = movedId(before, ids)
    dispatch({ type: 'projects', projects: withHarnessIds(projectId, ids) })
    hui({ busy: true, error: null, drag: null })
    const ok = await hguard(() => h.reorder(projectId, ids))
    if (!ok) {
      dispatch({ type: 'projects', projects: withHarnessIds(projectId, before) })
      return
    }
    hui({
      busy: false,
      ...(moved && { live: LIVE.moved(harnessName(moved), ids.indexOf(moved) + 1) }),
    })
  }

  /** The library order (cosmetic), saved with the whole layout (layout is replaced as one object). */
  function reorderLibrary(ids: string[]): void {
    const rest = sortLibrary(state.harness.list, state.harness.order)
      .map((x) => x.id)
      .filter((id) => !ids.includes(id))
    harnessOrder = [...ids, ...rest].slice(0, 200)
    hui({ order: harnessOrder, drag: null })
    void guard(() =>
      gateway.settings.set({ layout: { sidebarCollapsed: collapsed, harnessOrder } }),
    )
  }

  /** Drag-over feedback: highlight from the VM, and a live sentence for projects and rejections. */
  function dragOver(target: DropTarget | null): void {
    const d = state.harness.drag
    if (!d) return
    if (JSON.stringify(d.over ?? null) === JSON.stringify(target)) return
    let live = state.harness.live
    if (target) {
      const intent = dropIntent(d, target, {
        scopeProjectId: state.harness.projectId,
        applied: state.harness.projectId ? attachedIds(state, state.harness.projectId) : [],
        library: [],
        attached: (pid) => attachedIds(state, pid),
      })
      const pid = target.kind === 'project' ? target.projectId : state.harness.projectId
      const names = { harness: harnessName(d.harnessId), project: projectName(pid) }
      if (intent.kind === 'reject') live = announce(intent, names)
      else if (intent.kind === 'attach' && target.kind === 'project')
        live = LIVE.hover(names.harness, names.project)
    }
    hui({ drag: { ...d, ...(target ? { over: target } : { over: undefined }) }, live })
  }

  async function saveHarness(harnessId: string, draft: HarnessDraft): Promise<void> {
    const h = api.harness
    if (!h) return
    hui({ busy: true, error: null })
    const detail = await hguard(() => h.update({ harnessId: harnessId as never, draft }))
    hui({ busy: false })
    if (!detail) return
    dispatch({ type: 'harness-detail', detail })
    hui({ draft: null, saved: true, stale: false, live: HL.saved(detail.name) })
    later(1500, () => hui({ saved: false }))
    await loadHarnesses()
  }
  async function createHarness(templateId?: string): Promise<void> {
    const h = api.harness
    if (!h) return
    hui({ busy: true, error: null })
    const detail = await hguard(() =>
      templateId
        ? h.createFromTemplate(templateId)
        : h.create({ name: WS_COPY.harness.library.create }),
    )
    hui({ busy: false })
    if (!detail) return
    dispatch({ type: 'harness-detail', detail })
    hui({
      tab: 'editor',
      editorTab: 'overview',
      selectedId: detail.id,
      focus: 'hb-f-name',
      live: HL.created(detail.name),
    })
    await loadHarnesses()
  }
  async function runGates(agentId: string): Promise<void> {
    const h = api.harness
    if (!h) return
    const ran = await guard(() => h.runGates({ agentId }))
    if (!ran) return
    const inspection = await guard(() => h.inspect(agentId))
    if (inspection) dispatch({ type: 'harness-inspection', agentId, inspection })
  }
  /** A user action on a session's flow (Inspector, Overview, palette). */
  async function flowAction(run: () => Promise<unknown>, agentId: string): Promise<void> {
    const ok = await guard(async () => (await run(), true))
    if (!ok) return
    void refreshOverview()
    const h = api.harness
    if (h && agentId in state.harness.inspections) {
      const ins = await guard(() => h.inspect(agentId))
      if (ins) dispatch({ type: 'harness-inspection', agentId, inspection: ins })
    }
  }

  /** Removes a rule or step from the draft, keeping the previous draft for Undo (5 s). */
  function removeWithUndo(next: HarnessDraft, live: string): void {
    const before = currentDraft()
    hui({ draft: next, undo: before, live })
    const mark = before
    later(5000, () => {
      if (state.harness.undo === mark) hui({ undo: null })
    })
  }

  // ── Data loading ────────────────────────────────────────────────────────────────────────────
  async function loadProjects(): Promise<void> {
    const list = await guard(() => api.list())
    if (list) dispatch({ type: 'projects', projects: list })
  }
  async function loadProviders(): Promise<void> {
    const list = await guard(() => gateway.providers.list())
    if (list) dispatch({ type: 'providers', providers: list })
  }
  async function loadOverview(): Promise<void> {
    const o = await guard(() => api.overview())
    if (o) dispatch({ type: 'overview', overview: o })
  }
  let overviewBusy = false
  let overviewAgain = false
  /** Coalesces bursts of pushes into at most one request in flight plus one trailing refresh. */
  async function refreshOverview(): Promise<void> {
    if (overviewBusy) {
      overviewAgain = true
      return
    }
    overviewBusy = true
    try {
      do {
        overviewAgain = false
        await loadOverview()
      } while (overviewAgain && !disposed)
    } finally {
      overviewBusy = false
    }
  }
  async function loadDashboard(projectId: string): Promise<void> {
    const dash = await guard(() => api.dashboard(projectId))
    if (dash) dispatch({ type: 'dashboard', dashboard: dash })
  }
  async function loadSessions(): Promise<void> {
    const scope = state.sessionScope === SESSION_ALL ? undefined : state.sessionScope
    const query = state.sessionQuery.trim() || undefined
    const list = await guard(() => api.sessions({ scope: scope as never, query }))
    if (!list) return
    dispatch({ type: 'sessions', sessions: list })
    if (state.selectedSessionId) await loadMessages(state.selectedSessionId, false)
  }
  async function loadMessages(sessionId: string, wide: boolean): Promise<void> {
    if (!wide && state.messages[sessionId]) return
    const r = await guard(() => api.messages({ sessionId, limit: wide ? 200 : 50 }))
    if (r) dispatch({ type: 'messages', sessionId, messages: r.messages, more: r.more })
  }
  async function loadMemories(): Promise<void> {
    const scope = state.memoryScope
    const scopes =
      scope === MEMORY_ALL ? [...state.projects.map((p) => p.id), 'global', 'unassigned'] : [scope]
    const lists = await guard(() =>
      Promise.all(scopes.map((s) => api.memories({ scope: s as never }))),
    )
    if (!lists) return
    const seen = new Set<string>()
    const all = lists.flat().filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
    dispatch({ type: 'memories', memories: all })
    await resolveSessionTitles(all)
  }
  /** The automatic-import line of the Session Vault; a failure just hides it (not an error). */
  async function loadImportStatus(): Promise<void> {
    try {
      const status = await api.importStatus()
      if (!disposed) dispatch({ type: 'import-status', status })
    } catch {
      // keep whatever is shown; the line is decoration, not an error
    }
  }
  /** Provenance names its session by title; fetch the ones not loaded yet (ids are never shown). */
  async function resolveSessionTitles(
    mems: { provenance: { sessionId?: string } }[],
  ): Promise<void> {
    const known = (id: string): boolean =>
      state.sessions.some((x) => x.id === id) || id in state.sessionTitles
    if (!mems.some((m) => m.provenance.sessionId && !known(m.provenance.sessionId))) return
    const list = await guard(() => api.sessions({}))
    if (list) dispatch({ type: 'session-titles', sessions: list })
  }
  /** A deep hit can be older than the newest 200 messages: page backwards until it shows up. */
  async function seekMessage(sessionId: string, messageId: string): Promise<void> {
    for (let page = 0; page < MESSAGE_PAGES_MAX; page++) {
      const cur = state.messages[sessionId]
      if (!cur || !cur.more || cur.messages.some((m) => m.id === messageId)) return
      const before = cur.messages[0]?.id
      if (!before) return
      const r = await guard(() => api.messages({ sessionId, before, limit: 200 }))
      if (!r || disposed) return
      dispatch({
        type: 'messages',
        sessionId,
        messages: [...r.messages, ...cur.messages],
        more: r.more,
      })
    }
  }
  async function loadInspection(agentId: string): Promise<void> {
    const ins = await guard(() => api.inspect(agentId))
    if (ins) dispatch({ type: 'inspection', agentId, inspection: ins })
  }

  /** Pushes the selected project's Library collections to the scene (counts only), or clears them. */
  async function refreshLibrary(): Promise<void> {
    if (!scene.setProjectLibrary) return
    const seq = ++libSeq
    const pid = state.view === 'overview' ? null : state.projectId
    const project = pid ? state.projects.find((p) => p.id === pid) : undefined
    if (!pid || !project) {
      scene.setProjectLibrary(null)
      return
    }
    let mems = state.memories
    try {
      mems = await api.memories({ scope: pid as never })
    } catch {
      // keep whatever is already loaded; the Library is decoration, not an error
    }
    if (seq !== libSeq || disposed) return
    const sessions =
      state.dashboards[pid]?.sessions ?? state.sessions.filter((x) => x.projectId === pid)
    scene.setProjectLibrary(
      projectLibraryVM(
        project,
        libraryCounts(mems, state.overview?.unfinishedHandoffs ?? [], pid),
        sessions,
        now(),
      ),
    )
  }

  // ── Navigation ──────────────────────────────────────────────────────────────────────────────
  async function go(
    view: WorkspaceView,
    projectId?: string | null,
    pre: WorkspaceEvent[] = [],
    force = false,
  ): Promise<void> {
    // Leaving the Harnesses pane with unsaved editor changes asks first.
    if (!force && state.view === 'harness' && view !== 'harness' && editorDirty()) {
      const id = state.harness.detail!.id
      hui({ confirm: { kind: 'discard', harnessId: id, next: { view, projectId } } })
      return
    }
    const seq = ++navSeq
    state = reduce(state, { type: 'navigate', view, projectId })
    for (const e of pre) state = reduce(state, e)
    scene.setOfficeVisible(view === 'office')
    if (view !== 'office') scene.focusAgents?.(null)
    if (view !== 'office' && view !== 'overview')
      state = reduce(state, { type: 'loading', on: true })
    render()
    const stale = (): boolean => seq !== navSeq || disposed
    switch (view) {
      case 'overview':
        await Promise.all([loadProjects(), loadProviders(), loadOverview()])
        break
      case 'project':
        if (state.projectId) await Promise.all([loadDashboard(state.projectId), loadHarnesses()])
        break
      case 'sessions':
        await Promise.all([loadSessions(), loadImportStatus()])
        break
      case 'memory':
        await loadMemories()
        break
      case 'context':
        if (state.inspectAgentId) await loadInspection(state.inspectAgentId)
        else dispatch({ type: 'loading', on: false })
        break
      case 'harness':
        await Promise.all([loadHarnesses(), loadTemplates(), loadCoverage()])
        break
      case 'office':
        break
    }
    if (!stale() && state.loading) dispatch({ type: 'loading', on: false })
    if (!stale()) void refreshLibrary()
  }

  const sidebarTarget = (t: SidebarTarget): Promise<void> => {
    if (t === 'overview') return go('overview')
    if (t === 'office') return go('office')
    return go(t, state.projectId)
  }

  // ── Handoffs ────────────────────────────────────────────────────────────────────────────────
  async function openHandoff(projectId: string, sessionId?: string): Promise<void> {
    let sessions = state.sessions.filter((x) => x.projectId === projectId)
    if (!sessionId && !sessions.length) {
      const list = await guard(() => api.sessions({ scope: projectId as never }))
      sessions = list ?? []
      if (list) dispatch({ type: 'sessions', sessions: [...state.sessions, ...list] })
    }
    const sid =
      sessionId ?? [...sessions].sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0]?.id ?? null
    // Always refresh: a provider enabled since the last open must show up in the picker.
    await loadProviders()
    const src = state.sessions.find((x) => x.id === sid)
    const options = handoffProviders(state.providers)
    const provider = options.find((o) => o.id !== String(src?.provider))?.id ?? options[0]?.id ?? ''
    pendingNote = null
    dispatch({
      type: 'handoff',
      patch: {
        open: true,
        stage: 'compose',
        sessionId: sid,
        projectId,
        objective: '',
        provider,
        handoff: null,
      },
    })
    if (!sid) dispatch({ type: 'error', error: WS_COPY.dashboard.noSessionToContinue })
  }

  function closeHandoff(): void {
    pendingNote = null
    dispatch({
      type: 'handoff',
      patch: { open: false, stage: 'compose', sessionId: null, handoff: null, objective: '' },
    })
    dispatch({ type: 'error', error: null })
  }

  async function previewHandoff(): Promise<void> {
    const h = state.handoff
    if (!h.sessionId || !h.provider || !h.objective.trim()) return
    const view = await guard(() =>
      api.prepareHandoff({
        sessionId: h.sessionId as string,
        toProvider: h.provider as never,
        objective: h.objective.trim(),
      }),
    )
    if (view) dispatch({ type: 'handoff', patch: { handoff: view, stage: 'review' } })
  }

  async function toggleHandoffItem(itemId: string, included: boolean): Promise<void> {
    const hv = state.handoff.handoff
    if (!hv || hv.state !== 'draft') return
    const ids = new Set(
      hv.bundle.items.filter((i) => i.included && i.ref.kind === 'memory').map((i) => i.ref.id),
    )
    if (included) ids.add(itemId)
    else ids.delete(itemId)
    const next = await guard(() =>
      api.updateHandoff({ handoffId: hv.id, include: [...ids] as never }),
    )
    if (next) dispatch({ type: 'handoff', patch: { handoff: next } })
  }

  async function launchHandoff(): Promise<void> {
    let hv: HandoffData | null = state.handoff.handoff
    if (!hv || hv.state !== 'draft') return
    const id = hv.id
    if (pendingNote !== null && pendingNote !== hv.note) {
      const note = pendingNote
      const upd = await guard(() => api.updateHandoff({ handoffId: id, note }))
      if (!upd) return
      hv = upd
      dispatch({ type: 'handoff', patch: { handoff: upd } })
    }
    const r = await guard(() => api.launchHandoff(id))
    if (!r) return
    if (!r.ok) {
      dispatch({ type: 'error', error: WS_COPY.errors.start(r.error) })
      return
    }
    closeHandoff()
    await go('office')
    scene.select(r.agentId)
  }

  // ── Memory ──────────────────────────────────────────────────────────────────────────────────
  const draftFrom = (
    projectId: string | null,
    f: MemoryDraftFields,
    from?: MemoryDraft['from'],
  ): MemoryDraft => ({ projectId: projectId as never, ...f, from })

  async function reviewMemory(id: string, action: 'approve' | 'reject'): Promise<void> {
    const m = await guard(() => api.reviewMemory(id, action))
    if (m) dispatch({ type: 'memory-updated', memory: m })
  }

  async function saveMessageAsMemory(
    sessionId: string,
    messageId: string,
    fields: { title: string; kind: MemoryDraftFields['kind'] },
  ): Promise<void> {
    const msg = state.messages[sessionId]?.messages.find((m) => m.id === messageId)
    const title = fields.title.trim().slice(0, 120)
    if (!msg || !title || !msg.text.trim()) return
    const projectId = state.sessions.find((x) => x.id === sessionId)?.projectId ?? null
    const m = await guard(() =>
      api.createMemory(
        draftFrom(
          projectId,
          { title, body: msg.text, kind: fields.kind, scope: projectId ? 'project' : 'global' },
          { sessionId: sessionId as never, messageId },
        ),
      ),
    )
    if (!m) return
    dispatch({ type: 'memory-updated', memory: m })
    dispatch({ type: 'notice', notice: WS_COPY.sessions.savedAsMemory })
  }

  async function resumeSession(sessionId: string): Promise<void> {
    if (!state.sessions.find((x) => x.id === sessionId)?.canResume) return
    const r = await guard(() => api.resumeSession(sessionId))
    if (!r) return
    if (!r.ok) {
      dispatch({ type: 'error', error: WS_COPY.errors.start(r.error) })
      return
    }
    await go('office')
    scene.select(r.agentId)
  }

  async function importHistory(): Promise<void> {
    if (state.view !== 'sessions') await go('sessions', null)
    const r = await guard(() => api.importHistory())
    if (!r) return
    await loadSessions()
    dispatch({ type: 'notice', notice: WS_COPY.sessions.imported(r.imported, r.skipped) })
  }

  // ── Remove imported memory ─────────────────────────────────────────────────────────────────
  /** Opens the confirm, or says why there is nothing to remove in the current scope. */
  function askRemoveImported(): void {
    const btn = memoryVM(state, now()).removeImported
    if (btn.enabled) dispatch({ type: 'remove-imported-confirm', open: true })
    else dispatch({ type: 'notice', notice: btn.hint ?? null })
  }

  async function removeImported(): Promise<void> {
    const target = removeImportedTarget(state)
    dispatch({ type: 'remove-imported-confirm', open: false })
    if (!target) return
    const r = await guard(() => api.removeImported(target.projectId))
    if (!r) return
    await loadMemories()
    void refreshOverview()
    void refreshLibrary()
    dispatch({ type: 'notice', notice: WS_COPY.memory.removed(r.removed) })
  }

  // ── Tasks ───────────────────────────────────────────────────────────────────────────────────
  /** Runs a task write, then refreshes the dashboard so tasks, metrics and evidence agree. */
  async function changeTask(projectId: string, write: () => Promise<unknown>): Promise<void> {
    const ok = await guard(async () => (await write(), true))
    if (ok) await loadDashboard(projectId)
  }

  // ── New project ─────────────────────────────────────────────────────────────────────────────
  async function createProject(): Promise<void> {
    const np = state.newProject
    const name = np.name.trim()
    if (!name) return
    const created = await guard(() => api.create({ name, folders: np.folders.map((f) => f.ref) }))
    if (!created) return
    dispatch({ type: 'new-project', patch: { open: false, name: '', folders: [] } })
    dispatch({
      type: 'projects',
      projects: [...state.projects.filter((p) => p.id !== created.id), created],
    })
    await go('project', created.id)
  }

  async function addFolder(): Promise<void> {
    const picked = await guard(() => gateway.context.pick('folder'))
    if (!picked) return
    const have = new Set(state.newProject.folders.map((f) => f.ref))
    const folders = [
      ...state.newProject.folders,
      ...picked
        .filter((p) => p.kind === 'folder' && !have.has(p.ref))
        .map((p) => ({ ref: p.ref, label: p.label, hint: p.hint })),
    ].slice(0, 8)
    dispatch({ type: 'new-project', patch: { folders } })
  }

  // ── Palette ─────────────────────────────────────────────────────────────────────────────────
  function stopDeepSearch(): void {
    cancelDeep?.()
    cancelDeep = null
  }

  /** The fast shallow search now; for 3+ chars a debounced deep search merges its hits in later. */
  async function runSearch(query: string): Promise<void> {
    const q = query.trim()
    const seq = ++searchSeq
    stopDeepSearch()
    if (!q) {
      dispatch({ type: 'palette-hits', hits: [] })
      return
    }
    const projectId = (state.projectId ?? undefined) as never
    dispatch({ type: 'palette-searching', on: true })
    const hits = await guard(() => api.search({ query: q, projectId, deep: false }))
    if (seq !== searchSeq) return
    dispatch({ type: 'palette-hits', hits: hits ?? [] })
    if (q.length < DEEP_SEARCH_MIN_CHARS) return
    dispatch({ type: 'palette-searching', on: true })
    cancelDeep = schedule(() => {
      cancelDeep = null
      void (async () => {
        let deep: Awaited<ReturnType<typeof api.search>> | undefined
        try {
          deep = await api.search({ query: q, projectId, deep: true })
        } catch {
          deep = undefined // the shallow hits stay; a failed deep search is not an error banner
        }
        if (seq !== searchSeq || disposed) return
        dispatch({ type: 'palette-hits', hits: mergeHits(state.palette.hits, deep ?? []) })
      })()
    }, DEEP_SEARCH_DELAY_MS)
  }

  async function focusProject(projectId: string | null): Promise<void> {
    if (!projectId) {
      scene.focusAgents?.(null)
      return
    }
    if (!state.dashboards[projectId]) await loadDashboard(projectId)
    const dash = state.dashboards[projectId]
    scene.focusAgents?.(dash ? dash.active.map((a) => a.agentId) : null)
  }

  // ── Actions ─────────────────────────────────────────────────────────────────────────────────
  async function perform(a: WorkspaceAction): Promise<void> {
    switch (a.type) {
      case 'open-overview':
        return go('overview')
      case 'open-office':
        return go('office')
      case 'open-project':
        return go('project', a.projectId)
      case 'new-project':
        dispatch({ type: 'error', error: null })
        dispatch({ type: 'new-project', patch: { open: true, name: '', folders: [] } })
        return
      case 'start-agent':
        scene.openNewSession({ projectId: a.projectId ?? state.projectId ?? undefined })
        return
      case 'continue-work':
      case 'prepare-handoff':
        return openHandoff(a.projectId, a.sessionId)
      case 'open-handoff': {
        const hv = state.overview?.unfinishedHandoffs.find((h) => h.id === a.handoffId)
        if (!hv) return
        pendingNote = null
        dispatch({
          type: 'handoff',
          patch: {
            open: true,
            stage: 'review',
            sessionId: hv.from.sessionId,
            projectId: hv.projectId,
            objective: hv.objective,
            provider: hv.toProvider,
            handoff: hv,
          },
        })
        return
      }
      case 'review-approvals':
        return go('memory', a.projectId ?? null, [{ type: 'memory-filter', filter: 'pending' }])
      case 'open-memory':
        await go('memory', a.projectId ?? null)
        if (a.memoryId) dispatch({ type: 'select-memory', memoryId: a.memoryId })
        return
      case 'open-sessions':
        return go('sessions', a.projectId ?? null)
      case 'search-history':
        return go('sessions', a.projectId ?? null)
      case 'open-session':
        await go('sessions', null)
        dispatch({ type: 'select-session', sessionId: a.sessionId, messageId: a.messageId })
        await loadMessages(a.sessionId, !!a.messageId)
        if (a.messageId) await seekMessage(a.sessionId, a.messageId)
        return
      case 'import-history':
        return importHistory()
      case 'remove-imported':
        if (state.view !== 'memory') await go('memory', state.projectId)
        askRemoveImported()
        return
      case 'inspect-context': {
        const pid = a.projectId ?? state.projectId
        let agentId = a.agentId
        if (!agentId && pid) {
          if (!state.dashboards[pid]) await loadDashboard(pid)
          // Default: the agent selected in the Office if it works on this project, else the first.
          const active = state.dashboards[pid]?.active ?? []
          const picked = scene.selectedAgentId?.()
          agentId = active.find((x) => x.agentId === picked)?.agentId ?? active[0]?.agentId
        }
        state = reduce(state, { type: 'error', error: null })
        if (agentId) state = { ...state, inspectAgentId: agentId }
        return go('context', pid ?? null)
      }
      case 'open-harnesses': {
        const pid = a.projectId ?? state.projectId
        return go('harness', pid, [
          {
            type: 'harness-ui',
            patch: { tab: 'library', ...(pid && { projectId: pid }) },
          },
        ])
      }
      case 'harness-new':
        if (state.view !== 'harness') await go('harness')
        return createHarness()
      case 'harness-edit':
        return openHarnessEditor(a.harnessId)
      case 'harness-import':
        await go('harness', a.projectId, [
          {
            type: 'harness-ui',
            patch: {
              tab: 'import',
              projectId: a.projectId,
              sources: null,
              preview: null,
              edits: {},
              excluded: [],
              importName: '',
              importAttach: false,
            },
          },
        ])
        return detectSources()
      case 'harness-attach':
        return go('harness', a.projectId, [
          {
            type: 'harness-ui',
            patch: {
              tab: 'library',
              projectId: a.projectId,
              confirm: { kind: 'attach', harnessId: a.harnessId, projectId: a.projectId },
            },
          },
        ])
      case 'flow-approve': {
        const h = api.harness
        if (!h) return
        return flowAction(
          () => h.flowApprove({ agentId: a.agentId, stepId: a.stepId, checkIndex: a.checkIndex }),
          a.agentId,
        )
      }
      case 'flow-mark-done': {
        const h = api.harness
        if (!h) return
        return flowAction(() => h.flowMarkDone({ agentId: a.agentId, stepId: a.stepId }), a.agentId)
      }
      case 'flow-skip': {
        const h = api.harness
        if (!h) return
        return flowAction(
          () => h.flowSkip({ agentId: a.agentId, stepId: a.stepId, confirmed: a.confirmed }),
          a.agentId,
        )
      }
      case 'flow-reopen': {
        const h = api.harness
        if (!h) return
        return flowAction(() => h.flowReopen({ agentId: a.agentId, stepId: a.stepId }), a.agentId)
      }
      case 'run-gates':
        return runGates(a.agentId)
      case 'focus-agent':
        await go('office')
        if (a.tab) scene.select(a.agentId, a.tab)
        else scene.select(a.agentId)
        return
      case 'connect-provider':
        scene.openConnect()
        return
      case 'switch-mode':
        scene.switchMode(a.mode)
        return go('office')
    }
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────────────────────
  function onPush(msg: ProjectMessage): void {
    const hadInspection =
      msg.type === 'harness' && !!msg.agentId && msg.agentId in state.harness.inspections
    dispatch({ type: 'push', msg })
    // The sidebar counts (unassigned sessions, pending approvals) come from the overview.
    if (msg.type === 'projects' || msg.type === 'session' || msg.type === 'memory')
      void refreshOverview()
    if (msg.type === 'projects' || msg.type === 'session' || msg.type === 'memory')
      void refreshLibrary()
    if (msg.type === 'harness') {
      // The library feeds the sidebar badge, the dashboard and the pane: always refresh it.
      void loadHarnesses()
      const open = state.harness.detail?.id
      if (open && (!msg.harnessId || msg.harnessId === open)) {
        // Unsaved edits are never overwritten by a push: offer Reload / Keep my edits instead.
        if (editorDirty()) hui({ stale: true })
        else void reloadHarnessDetail()
      }
      // The reducer dropped the stale inspection of that agent: fetch the new one.
      const h = api.harness
      if (hadInspection && msg.agentId && h) {
        const agentId = msg.agentId
        void guard(() => h.inspect(agentId)).then((ins) => {
          if (ins && !disposed) dispatch({ type: 'harness-inspection', agentId, inspection: ins })
        })
      }
    }
    // Automatic import adds sessions and memory in the background: keep its status line current.
    if ((msg.type === 'session' || msg.type === 'memory') && state.view === 'sessions')
      void loadImportStatus()
  }

  const v = views
  v.shell.onNavigate((t) => void sidebarTarget(t))
  v.shell.onSelectProject((id) => void go('project', id))
  v.shell.onNewProject(() => void perform({ type: 'new-project' }))
  v.shell.onOpenPalette(() => ctl.openPalette())
  v.shell.onNewAgent(() => void perform({ type: 'start-agent' }))
  v.shell.onNotifications(() => void go('overview'))
  v.shell.onHealth(() => scene.openConnect())

  v.shell.onCollapse((next) => {
    collapsed = next
    render()
    void guard(() => gateway.settings.set({ layout: { sidebarCollapsed: next, harnessOrder } }))
  })

  v.overview.onAction((a) => void perform(a))
  v.dashboard.onAction((a) => void perform(a))
  v.dashboard.onActivityFilter((filter) => dispatch({ type: 'activity-filter', filter }))
  v.dashboard.onTaskAdd((projectId, title) => {
    const t = title.trim()
    if (t) void changeTask(projectId, () => api.createTask({ projectId, title: t }))
  })
  v.dashboard.onTaskState((taskId, taskState) => {
    const pid = state.projectId
    if (pid) void changeTask(pid, () => api.updateTask({ taskId, state: taskState }))
  })
  v.dashboard.onTaskConfirm((taskId) => {
    const pid = state.projectId
    if (pid) void changeTask(pid, () => api.updateTask({ taskId, confirm: true }))
  })

  v.sessions.onSearch((query) => {
    dispatch({ type: 'session-query', query })
    void loadSessions()
  })
  v.sessions.onScope((scope) => {
    dispatch({ type: 'session-scope', scope })
    void loadSessions()
  })
  v.sessions.onSelect((id) => {
    dispatch({ type: 'select-session', sessionId: id })
    void loadMessages(id, false)
  })
  v.sessions.onAssign(
    (sessionId, projectId) =>
      void (async () => {
        const s = await guard(() => api.assign(sessionId, projectId))
        if (s) dispatch({ type: 'push', msg: { type: 'session', session: s } })
      })(),
  )
  v.sessions.onContinue((sessionId) => {
    const s = state.sessions.find((x) => x.id === sessionId)
    if (s?.projectId) void openHandoff(s.projectId, sessionId)
  })
  v.sessions.onResume((sessionId) => void resumeSession(sessionId))
  v.sessions.onSaveMemory(
    (sessionId, messageId, fields) => void saveMessageAsMemory(sessionId, messageId, fields),
  )
  v.sessions.onImport(() => void importHistory())
  v.sessions.onLoadMore((id) => void loadMessages(id, true))

  v.memory.onSelect((id) => dispatch({ type: 'select-memory', memoryId: id }))
  v.memory.onScope((scope) => {
    dispatch({ type: 'memory-scope', scope })
    void loadMemories()
  })
  v.memory.onFilter((filter) => dispatch({ type: 'memory-filter', filter }))
  v.memory.onSearch((query) => dispatch({ type: 'memory-query', query }))
  v.memory.onRemoveImported(() => askRemoveImported())
  v.memory.onRemoveImportedConfirm(() => removeImported())
  v.memory.onRemoveImportedCancel(() => dispatch({ type: 'remove-imported-confirm', open: false }))
  v.memory.onToggleCheck((id) => dispatch({ type: 'toggle-memory-check', memoryId: id }))
  v.memory.onApprove((id) => void reviewMemory(id, 'approve'))
  v.memory.onReject((id) => void reviewMemory(id, 'reject'))
  v.memory.onEdit(
    (id, patch) =>
      void (async () => {
        const m = await guard(() => api.editMemory({ memoryId: id as never, ...patch }))
        if (m) dispatch({ type: 'memory-updated', memory: m })
      })(),
  )
  v.memory.onSupersede(
    (id, repl) =>
      void (async () => {
        const old = state.memories.find((m) => m.id === id)
        if (!old) return
        const m = await guard(() => api.supersedeMemory(id, draftFrom(old.projectId, repl)))
        if (!m) return
        await loadMemories()
        dispatch({ type: 'select-memory', memoryId: m.id })
      })(),
  )
  v.memory.onMerge(
    (into) =>
      void (async () => {
        const ids = state.checkedMemoryIds.filter(
          (id) => state.memories.find((m) => m.id === id)?.state === 'approved',
        )
        if (ids.length < 2) return
        const first = state.memories.find((m) => m.id === ids[0])
        const m = await guard(() =>
          api.mergeMemories(ids, draftFrom(first?.projectId ?? null, into)),
        )
        if (!m) return
        dispatch({ type: 'memory-scope', scope: state.memoryScope })
        await loadMemories()
        dispatch({ type: 'select-memory', memoryId: m.id })
      })(),
  )

  v.inspector.onAgent((agentId) => {
    state = { ...state, inspectAgentId: agentId }
    void loadInspection(agentId)
  })
  v.inspector.onRefresh(() => {
    if (state.inspectAgentId) void loadInspection(state.inspectAgentId)
  })

  v.palette.onQuery((q) => {
    dispatch({ type: 'palette-query', query: q })
    void runSearch(q)
  })
  v.palette.onMove((delta) => ctl.paletteMove(delta))
  v.palette.onChoose((id) => void ctl.paletteChoose(id))
  v.palette.onClose(() => ctl.closePalette())

  v.newProject.onName((name) => dispatch({ type: 'new-project', patch: { name } }))
  v.newProject.onAddFolder(() => void addFolder())
  v.newProject.onRemoveFolder((ref) =>
    dispatch({
      type: 'new-project',
      patch: { folders: state.newProject.folders.filter((f) => f.ref !== ref) },
    }),
  )
  v.newProject.onCreate(() => void createProject())
  v.newProject.onCancel(() => {
    dispatch({ type: 'new-project', patch: { open: false, name: '', folders: [] } })
    dispatch({ type: 'error', error: null })
  })

  v.handoff.onObjective((objective) => dispatch({ type: 'handoff', patch: { objective } }))
  v.handoff.onProvider((provider) => dispatch({ type: 'handoff', patch: { provider } }))
  v.handoff.onPreview(() => void previewHandoff())
  v.handoff.onToggleItem((id, included) => void toggleHandoffItem(id, included))
  v.handoff.onNote((note) => {
    pendingNote = note
  })
  v.handoff.onLaunch(() => void launchHandoff())
  v.handoff.onCancel(() => closeHandoff())

  // Sidebar drops: a harness card dropped on a project attaches it there (scope unchanged).
  v.shell.onDropHarness((projectId, harnessId) => {
    void attachTo(harnessId, projectId, undefined, true)
  })
  v.shell.onDragOverProject((projectId) =>
    dragOver(projectId ? { kind: 'project', projectId } : null),
  )

  const hv = v.harness
  if (hv) {
    hv.onTab((tab) => {
      hui({ tab, error: null })
      if (tab === 'coverage') void loadCoverage()
    })
    hv.onEditorTab((editorTab) => {
      hui({ editorTab, highlightRuleId: null })
      if (editorTab === 'providers') void loadCoverage()
      if (editorTab === 'history' && !state.harness.versions) void loadVersions()
    })
    hv.onCreate(() => void createHarness())
    hv.onTemplate((id) => void createHarness(id))
    hv.onCard((harnessId, action) => {
      if (action === 'edit') void openHarnessEditor(harnessId)
      else if (action === 'select')
        hui({ selectedId: state.harness.selectedId === harnessId ? null : harnessId })
      else
        hui({
          confirm: {
            kind: action,
            harnessId,
            ...(state.harness.projectId && { projectId: state.harness.projectId }),
          },
        })
    })
    hv.onConfirm(() => void runConfirm())
    hv.onConfirmCancel(() => hui({ confirm: null }))
    hv.onSave((id, draft) => void saveHarness(id, draft))
    hv.onDraft((draft) => hui({ draft, saved: false }))
    hv.onDiscard(() => {
      const h = state.harness
      if (!h.detail || !h.draft) return
      if (changedFields(h.draft, draftFromDetail(h.detail)).length > 1)
        hui({ confirm: { kind: 'discard', harnessId: h.detail.id } })
      else hui({ draft: null, stepForm: null, ruleEditId: null })
    })
    hv.onStale((choice) => {
      if (choice === 'keep') return hui({ stale: false })
      hui({ draft: null, stale: false, stepForm: null })
      void reloadHarnessDetail()
    })
    hv.onVersion((version) => hui({ viewVersion: version }))
    hv.onScope((projectId) => {
      hui({
        projectId,
        coverage: [],
        sources: null,
        preview: null,
        excluded: [],
        importName: '',
        live: projectId ? WS_COPY.harness.live.showing(projectName(projectId)) : '',
      })
      void loadCoverage()
      if (projectId && state.harness.tab === 'import') void detectSources()
    })
    hv.onSearch((query) => {
      hui({ query })
      const n = harnessBuilderVM(state).library.items.length
      hui({ live: query.trim() ? WS_COPY.harness.library.results(n) : '' })
    })
    // Drag and drop (docs/harness.md §7): the adapter reports, the pure module decides.
    hv.onDrag((d) => {
      if (!d) {
        if (state.harness.drag) hui({ drag: null })
        return
      }
      hui({ drag: { harnessId: d.harnessId, source: d.source, status: d.status }, live: '' })
    })
    hv.onDragOver((target) => dragOver(target))
    hv.onAttachTo((harnessId, projectId, ids) => void attachTo(harnessId, projectId, ids))
    hv.onReorderApplied((projectId, ids) => void reorderApplied(projectId, ids))
    hv.onMoveApplied((projectId, harnessId, dir) => {
      const cur = attachedIds(state, projectId)
      const i = cur.indexOf(harnessId)
      if (i < 0) return
      const ids = moveId(cur, harnessId, dir === 'up' ? i - 1 : i + 1)
      if (ids.some((x, k) => x !== cur[k])) void reorderApplied(projectId, ids)
    })
    hv.onReorderLibrary((ids) => reorderLibrary(ids))
    // The Flow tab's step form lives in state so a push never wipes it.
    hv.onStepEdit((index) => {
      const d = currentDraft()
      const step = index === null ? undefined : d?.steps?.[index]
      hui({
        stepForm: step && index !== null ? stepFormFrom(step, index) : newStepForm(),
        focus: 'hb-s-name',
      })
    })
    hv.onStepForm((patch) => {
      if (!patch) return hui({ stepForm: null })
      hui({ stepForm: { ...(state.harness.stepForm ?? newStepForm()), ...patch } })
    })
    hv.onStepSubmit(() => {
      const form = state.harness.stepForm
      const d = currentDraft()
      if (!form || !d) return
      const steps = [...(d.steps ?? [])]
      const keep = form.index !== null ? steps[form.index]?.id : undefined
      const gateIds = (d.gates ?? []).flatMap((g) => (g.id ? [g.id] : []))
      const r = stepFromForm(form, gateIds, keep)
      if (!r.ok) return hui({ stepForm: r.form })
      if (form.index !== null && form.index < steps.length) steps[form.index] = r.step
      else steps.push(r.step)
      hui({ draft: { ...d, steps }, stepForm: null, saved: false })
    })
    hv.onStepRemove((index) => {
      const d = currentDraft()
      const step = d?.steps?.[index]
      if (!d || !step) return
      removeWithUndo(
        { ...d, steps: (d.steps ?? []).filter((_, i) => i !== index) },
        WS_COPY.harness.live.stepRemoved(step.name),
      )
    })
    hv.onStepMove((index, toIndex) => {
      const d = currentDraft()
      const steps = d?.steps ?? []
      if (!d || index < 0 || index >= steps.length) return
      const keys = steps.map((_, i) => String(i))
      const order = moveId(keys, String(index), toIndex).map(Number)
      if (order.every((x, k) => x === k)) return
      hui({ draft: { ...d, steps: order.map((i) => steps[i]!) }, saved: false })
    })
    hv.onRuleEdit((ruleId) => hui({ ruleEditId: ruleId }))
    hv.onRuleRemove((index) => {
      const d = currentDraft()
      const rule = d?.rules?.[index]
      if (!d || !rule) return
      removeWithUndo(
        { ...d, rules: (d.rules ?? []).filter((_, i) => i !== index) },
        WS_COPY.harness.live.ruleRemoved(rule.name),
      )
    })
    hv.onUndo(() => {
      const prev = state.harness.undo
      if (prev) hui({ draft: prev, undo: null, live: WS_COPY.harness.live.restored })
    })
    hv.onGoToRule((ruleId) => hui({ editorTab: 'rules', highlightRuleId: ruleId }))
    hv.onStartSession((provider) =>
      scene.openNewSession({ projectId: state.harness.projectId ?? undefined, provider }),
    )
    hv.onImportStart(() => {
      const pid = state.harness.projectId
      if (pid) void perform({ type: 'harness-import', projectId: pid })
      else hui({ tab: 'import', error: null })
    })
    hv.onDetect(() => void detectSources())
    hv.onPreview(() => void previewImport())
    hv.onToggleSource((path, on) => {
      const cur = state.harness.excluded
      hui({ excluded: on ? cur.filter((x) => x !== path) : [...new Set([...cur, path])] })
    })
    hv.onToggleCandidate((tempId, on) => {
      const cur = state.harness.selection
      const selected = on
        ? [...new Set([...cur.selected, tempId])]
        : cur.selected.filter((x) => x !== tempId)
      hui({ selection: { ...cur, selected } })
    })
    hv.onSelectGroup((sourcePath, on) => {
      const p = state.harness.preview
      if (!p) return
      const f = state.harness.importFilter
      const ids = p.candidates
        .filter(
          (c) =>
            c.source.path === sourcePath &&
            (!f || (state.harness.edits[c.tempId]?.category ?? c.category) === f),
        )
        .map((c) => c.tempId)
      const cur = state.harness.selection
      const selected = on
        ? [...new Set([...cur.selected, ...ids])]
        : cur.selected.filter((x) => !ids.includes(x))
      hui({ selection: { ...cur, selected } })
    })
    hv.onImportFilter((category) => hui({ importFilter: category }))
    hv.onToggleGate((tempId, on) => {
      const cur = state.harness.selection
      const gates = on
        ? [...new Set([...cur.gates, tempId])]
        : cur.gates.filter((x) => x !== tempId)
      hui({ selection: { ...cur, gates } })
    })
    hv.onToggleStep((tempId, on) => {
      const cur = state.harness.importSteps
      const selected = on
        ? [...new Set([...cur.selected, tempId])]
        : cur.selected.filter((x) => x !== tempId)
      hui({ importSteps: { ...cur, selected } })
    })
    hv.onStepCheck((tempId, kind) => {
      const cur = state.harness.importSteps
      hui({ importSteps: { ...cur, checks: { ...cur.checks, [tempId]: kind } } })
    })
    hv.onMoveImportStep((tempId, toIndex) => {
      const cur = state.harness.importSteps
      hui({ importSteps: { ...cur, order: moveId(cur.order, tempId, toIndex) } })
    })
    hv.onEditCandidate((tempId, patch) =>
      hui({
        edits: { ...state.harness.edits, [tempId]: { ...state.harness.edits[tempId], ...patch } },
      }),
    )
    hv.onImportName((importName) => hui({ importName }))
    hv.onImportAttach((importAttach) => hui({ importAttach }))
    hv.onCommit(() => void commitImport())
  }

  const ctl: WorkspaceController = {
    async start() {
      offs.push(api.onPush(onPush))
      // Enabling or disabling a provider changes the connection info: recompute the health pill.
      if (gateway.connections?.onChange)
        offs.push(gateway.connections.onChange(() => void loadProviders()))
      await Promise.all([loadProjects(), loadProviders(), loadOverview(), loadHarnesses()])
      const first = startView(d.settings().startView, state.projects.length)
      const bootError = state.error
      await go(first)
      if (bootError) dispatch({ type: 'error', error: bootError })
    },
    dispose() {
      disposed = true
      stopDeepSearch()
      for (const off of offs.splice(0)) off()
    },
    getState: () => state,
    navigate: (view, projectId) => go(view, projectId),
    perform,
    togglePalette() {
      if (state.palette.open) ctl.closePalette()
      else ctl.openPalette()
    },
    openPalette() {
      searchSeq++
      stopDeepSearch()
      dispatch({ type: 'palette-open' })
    },
    closePalette() {
      searchSeq++
      stopDeepSearch()
      dispatch({ type: 'palette-close' })
    },
    escape() {
      if (state.palette.open) {
        ctl.closePalette()
        return true
      }
      if (state.harness.confirm) {
        hui({ confirm: null })
        return true
      }
      if (state.removeImportedConfirm) {
        dispatch({ type: 'remove-imported-confirm', open: false })
        return true
      }
      if (state.handoff.open) {
        closeHandoff()
        return true
      }
      if (state.newProject.open) {
        dispatch({ type: 'new-project', patch: { open: false, name: '', folders: [] } })
        dispatch({ type: 'error', error: null })
        return true
      }
      return false
    },
    paletteMove(delta) {
      dispatch({ type: 'palette-move', delta, count: paletteItems(state).length })
    },
    async paletteChoose(itemId) {
      const items = paletteVM(state).items
      const it = itemId ? items.find((x) => x.id === itemId) : items.find((x) => x.selected)
      if (!it) return
      ctl.closePalette()
      await perform(it.action)
    },
    projectDirectory: () => projectDirectoryVM(state.projects, state.projectId),
    async selectDirectoryProject(projectId) {
      dispatch({ type: 'navigate', view: 'office', projectId })
      void refreshLibrary()
      await focusProject(projectId)
    },
  }
  render()
  return ctl
}
