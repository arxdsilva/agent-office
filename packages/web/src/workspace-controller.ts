// The projects-first workspace controller. Subscribes to project pushes, fetches data on
// navigation and routes every user intent (sidebar, palette, dashboard actions, memory review,
// session assignment, handoffs, new projects) to the gateway or the scene hooks. Views are ports;
// failures become an error string in the view models (nothing throws into the DOM).
import type {
  AgentOfficeApi,
  HandoffView as HandoffData,
  MemoryDraft,
  ProjectMessage,
  Settings,
} from '@agent-office/shared'
import { dashboardVM } from './app/workspace/dashboard-vm.ts'
import { libraryCounts } from './app/workspace/library-counts.ts'
import { projectLibraryVM } from './app/project-library.ts'
import { handoffProviders, handoffVM } from './app/workspace/handoff-vm.ts'
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
  const offs: (() => void)[] = []

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
  ): Promise<void> {
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
        if (state.projectId) await loadDashboard(state.projectId)
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
      case 'focus-agent':
        await go('office')
        scene.select(a.agentId)
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
    dispatch({ type: 'push', msg })
    // The sidebar counts (unassigned sessions, pending approvals) come from the overview.
    if (msg.type === 'projects' || msg.type === 'session' || msg.type === 'memory')
      void refreshOverview()
    if (msg.type === 'projects' || msg.type === 'session' || msg.type === 'memory')
      void refreshLibrary()
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
    void guard(() => gateway.settings.set({ layout: { sidebarCollapsed: next } }))
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

  const ctl: WorkspaceController = {
    async start() {
      offs.push(api.onPush(onPush))
      // Enabling or disabling a provider changes the connection info: recompute the health pill.
      if (gateway.connections?.onChange)
        offs.push(gateway.connections.onChange(() => void loadProviders()))
      await Promise.all([loadProjects(), loadProviders(), loadOverview()])
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
