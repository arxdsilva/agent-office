import {
  DEFAULT_SETTINGS,
  type Capability,
  type ConnectionInfo,
  type ContextRef,
  type Grouping,
  type HookStatus,
  type ModelOption,
  type ProviderId,
  type Settings,
  type SettingsPatch,
  type TestEventResult,
  type UpdateState,
  type ViewMode,
} from '@agent-office/shared'
import { capabilityBubbles, capabilityPanelVM, surfacesVM, usedChips } from './app/capability-vm.ts'
import { createDirector, type Director } from './app/director.ts'
import { GFX_COPY } from './app/graphics-copy.ts'
import type { Effective, GraphicsStats, HardwareInfo, Tier } from './app/graphics-types.ts'
import type { LibraryMap } from './app/library.ts'
import { LIB_COPY } from './app/library-copy.ts'
import type { LibrarySort, LibraryTab, LibraryVM } from './app/library-types.ts'
import {
  libraryVM,
  moreTooltipText,
  overflowCount,
  parseMore,
  shelfSlot,
  tooltipText,
} from './app/library-vm.ts'
import { createGovernor, effectiveGraphics, type Governor } from './app/quality.ts'
import type { SlotMap } from './app/stations.ts'
import { assignLibrary } from './app/library.ts'
import { assignStations } from './app/stations.ts'
import { detectTier } from './app/tier.ts'
import type { AgentPlan, BuildingLayout } from './app/office-types.ts'
import { applyMessage, emptyState, type OfficeState } from './app/state.ts'
import { COPY } from './app/connect-copy.ts'
import { SESSION_COPY } from './app/session-copy.ts'
import {
  DEMO_START_TIMEOUT_MS,
  EMPTY_GRACE_MS,
  FLY_TO_IDLE_MS,
  TEST_AGENT_ID,
  type ConnectTab,
  type EmptyPhase,
  type SnippetLang,
} from './app/connect-types.ts'
import {
  FALLBACK_MODELS,
  addContext,
  connectVM,
  emptyPhase,
  emptyStateVM,
  hudVM,
  newSessionVM,
  panelVM,
  settingsVM,
  startErrorText,
  toggleUse,
  useMenuVM,
  type ActivityInfo,
  type DemoStart,
} from './app/view-models.ts'
import { CHROME_ID, type Draft, type NewSessionForm } from './app/session-types.ts'
import type { Manifest } from './app/manifest.ts'
import { libraryKind } from './app/library.ts'
import { dialogueVM, projectDialogue } from './app/pixel/dialogue-vm.ts'
import { interactionAction } from './app/interactions.ts'
import { labelsDefaultFor } from './app/horizon/flavor.ts'
import { directoryVM } from './app/pixel/directory-vm.ts'
import { pixelHudVM } from './app/pixel/hud-vm.ts'
import { minimapLabels, minimapVM } from './app/pixel/minimap.ts'
import { plansOf } from './app/pixel/map.ts'
import { pixelToWorld, projectionFor } from './app/pixel/project.ts'
import { placementAt, viewIdOf } from './app/pixel/rooms.ts'
import {
  TILE_PX,
  type DialogueAction,
  type DialogueVM,
  type InteractTarget,
  type MinimapVM,
  type TileRect,
} from './app/pixel/types.ts'

type MinimapLabels = NonNullable<MinimapVM['labels']>
import { PIXEL_COPY } from './app/pixel-copy.ts'
import type { ProjectDirectoryVM, WorkspaceAction } from './app/workspace/types.ts'
import type {
  BannerView,
  CapabilityPanelView,
  CapabilityRef,
  ConnectView,
  DialogueView,
  EmptyStateView,
  HudView,
  LibraryView,
  ModeToggleView,
  NewSessionView,
  OfficeGateway,
  PanelView,
  PixelHudView,
  SceneView,
  SettingsView,
  ToastView,
  TooltipView,
  ViewBarView,
} from './ports.ts'

/**
 * The projects-first workspace as the office sees it (docs/projects.md §10): the reception's Project
 * Directory and project actions run the workspace controller's shared commands.
 */
export interface WorkspaceBridge {
  projectDirectory(): ProjectDirectoryVM
  selectProject(projectId: string | null): void | Promise<void>
  perform(action: WorkspaceAction): void | Promise<void>
  /** The 3D reception: a project picker (the palette, filtered to projects). */
  openProjectPicker(): void
}

export interface ControllerDeps {
  /** Optional: the projects-first workspace (absent in older shells and most tests). */
  workspace?: WorkspaceBridge
  gateway: OfficeGateway
  scene: SceneView
  panel: PanelView
  hud: HudView
  settings: SettingsView
  banner: BannerView
  capabilityPanel: CapabilityPanelView
  connect: ConnectView
  empty: EmptyStateView
  toast: ToastView
  newSession: NewSessionView
  /** The Library browser drawer, the hover tooltip and the camera view bar (low-spec plan §B). */
  library: LibraryView
  tooltip: TooltipView
  viewBar: ViewBarView
  /** `document`: visibility (pause while hidden) and focus at start (low-spec plan §5.2). */
  doc?: PageVisibility
  /** `window`: focus/blur events (lower frame rate while unfocused). */
  win?: WindowFocus
  /** What the renderer learned about the GPU (Auto's hardware tier); null when unknown. */
  hardware?: () => HardwareInfo | null
  /** `window.devicePixelRatio` (read on every graphics update; default: the hardware's, else 1). */
  devicePixelRatio?: () => number
  /** `window.matchMedia`: the scene follows `prefers-color-scheme` (plan §5.6). */
  matchMedia?: (query: string) => ColorSchemeQuery
  grouping: Grouping
  clock: { now(): number }
  every: (ms: number, fn: () => void) => () => void
  /** One-shot timer (grace period, demo timeout); returns a cancel function. */
  after: (ms: number, fn: () => void) => () => void
  /** Windows: the curl snippet gets the PowerShell note. */
  isWindows?: boolean
  /** macOS: hides the hardware acceleration toggle (no software WebGL there). */
  isMac?: boolean
  /** Snippet language remembered from last time (the DOM adapter keeps it). */
  snippetLang?: SnippetLang
  // ── Optional 2D RPG mode (plan §2.5, §8, §9). Absent: the controller behaves as before. ──
  /** The RPG dialogue box (`#dialogue`). */
  dialogue?: DialogueView
  /** The 2D HUD: room, counts, alerts, minimap and directory. */
  pixelHud?: PixelHudView
  /** The `3D Office | 2D RPG` switch. */
  modeToggle?: ModeToggleView
  /** A `viewMode` settings change (main.ts wires it to the scene host's `switchTo`). */
  onViewMode?: (mode: ViewMode) => void
}

/** The part of `Document` the controller uses (visibility and focus). */
export interface PageVisibility {
  readonly hidden: boolean
  hasFocus(): boolean
  addEventListener(type: 'visibilitychange', fn: () => void): void
  removeEventListener(type: 'visibilitychange', fn: () => void): void
}

/** The part of `Window` the controller uses (focus and blur). */
export interface WindowFocus {
  addEventListener(type: 'focus' | 'blur', fn: () => void): void
  removeEventListener(type: 'focus' | 'blur', fn: () => void): void
}

/** Graphics sampling: the Auto governor and the Settings stats line (2 Hz). */
export const GFX_POLL_MS = 500
/** Context losses within this window count towards the "switch to Minimal?" prompt. */
export const LOSS_WINDOW_MS = 5 * 60_000
export const LOSSES_BEFORE_PROMPT = 3
/** Capability panel row for a capability without a surface slot. */
export const NOT_ON_SHELF_ROW: [string, string] = ['Where', LIB_COPY.notOnShelf]

/** The part of `MediaQueryList` the controller uses. */
export interface ColorSchemeQuery {
  matches: boolean
  addEventListener(type: 'change', fn: (e: { matches: boolean }) => void): void
  removeEventListener(type: 'change', fn: (e: { matches: boolean }) => void): void
}

const CLAUDE = 'claude-code'
const emptyDraft = (): Draft => ({ text: '', context: [], use: [] })
const emptyForm = (folder?: ContextRef, provider: ProviderId = CLAUDE): NewSessionForm => ({
  provider,
  ...(folder && { folder }),
  name: '',
  mode: 'default',
  extraFolders: [],
  chrome: false,
  text: '',
  context: [],
  use: [],
})

export const MANIFEST_URL = 'assets/manifest.json'
/** The director runs at 4 Hz (plan §4.3); messages also trigger an immediate update. */
export const DIRECT_MS = 250
/** The 2D HUD, minimap and directory refresh rate (2 Hz). */
export const PIXEL_HUD_MS = 500

/** Renderer use cases: state → director (building, behavior) → views, and user intents → gateway calls. */
export function createController(d: ControllerDeps) {
  let state: OfficeState = emptyState()
  let director: Director | null = null
  let layout: BuildingLayout | undefined
  let plans = new Map<string, AgentPlan>()
  let shownActivity: string | undefined
  let selected: string | null = null
  /** Capability shown in the Capability panel (one side panel at a time). */
  let openCapability: CapabilityRef | null = null
  let showLinks = false
  /** agent id → capability id → uses this session (counted when the agent becomes active on it). */
  const used = new Map<string, Map<string, number>>()
  let activeUses = new Set<string>()
  let update: UpdateState = { policy: 'off', status: 'idle' }
  let hook: HookStatus = 'not-installed'
  let restartNote = false
  let allowBypass = false
  /** Last settings and version seen (the 2 Hz Settings refresh renders from these, no IPC). */
  let settingsNow: Settings | undefined
  let versionNow = ''

  // Graphics (low-spec plan §5): settings ⊕ hardware tier ⊕ power and focus → Effective.
  let tier: Tier | undefined
  let governor: Governor = createGovernor()
  let effective: Effective | undefined
  let effectiveKey = ''
  let lastStats: GraphicsStats | undefined
  let focused = d.doc?.hasFocus() ?? true
  let hidden = d.doc?.hidden ?? false
  /** Main's view of the window (hidden/minimized → false); page visibility alone isn't reliable. */
  let windowVisible = true
  /** False while the workspace shows a non-Office view (stage hidden: no rendering, no input). */
  let officeVisible = true
  let onBattery = false
  let losses: number[] = []
  let recovering = false

  // Library browser (Part B)
  let libProvider: string | undefined
  let libTab: LibraryTab = 'skills'
  let libQuery = ''
  let libSort: LibrarySort = 'recent'
  let libFocus: LibraryVM['focus']
  let lastLibrary: Map<string, LibraryMap> | undefined
  let lastStations: Map<string, SlotMap> | undefined
  const stops: (() => void)[] = []

  // Managed sessions and the composer (plan §2.1–2.4)
  /** Composer contents per agent, kept while switching agents, cleared on send. */
  const drafts = new Map<string, Draft>()
  /** `supportedModels()` per managed session (fetched once per selection). */
  const modelsCache = new Map<string, ModelOption[]>()
  const modelsLoading = new Set<string>()
  /** Models for the new-session dialog (from any running session, or the fallback). */
  let globalModels: ModelOption[] | undefined
  let form: NewSessionForm = emptyForm()
  let lastFolder: ContextRef | undefined
  /** Models per non-Claude provider (fetched once per provider). */
  const providerModels = new Map<ProviderId, ModelOption[]>()
  /** The provider the last new session used (the picker's next default). */
  let lastProvider: ProviderId = CLAUDE
  let nsStarting = false
  let nsError: string | undefined
  /** Agent a successful start created: selected as soon as it shows up. */
  let pendingSelect: string | null = null

  // Connecting agents (plan §2): live facts from main, the empty card's phase, first arrivals.
  let connInfo: ConnectionInfo | undefined
  let ready = false
  let pushReceived = false
  let graceElapsed = false
  let phase: EmptyPhase = 'loading'
  let dismissed = false
  let seenAny = false
  /** provider → when its first agent arrived this session (the test agent excluded). */
  const firstSeen = new Map<string, number>()
  let announcedAny = false
  let pendingGoTo: string | null = null
  let lastHttp: { provider: string; ts: number } | undefined
  let connectTab: ConnectTab = 'claude'
  let snippetLang: SnippetLang = d.snippetLang ?? 'curl'
  let lastTest: TestEventResult | undefined
  let demo: DemoStart = 'idle'
  let cancelDemoTimer = () => {}

  // 2D RPG mode (plan §8, §9): inert unless its deps are wired.
  const pixelDeps = !!(d.dialogue || d.pixelHud || d.modeToggle || d.onViewMode)
  let viewMode: ViewMode | undefined
  let manifest: Manifest | undefined
  let room = ''
  /** 2D: the player's world position (minimap marker). */
  let playerPos: { x: number; z: number } | undefined
  /** 2D: the camera's visible tiles (minimap viewport). */
  let cameraView: TileRect | undefined
  /** 2D: minimap labels, recomputed when the layout or manifest changes. */
  let mapLabels: { key: string; manifest: Manifest; labels: MinimapLabels } | undefined
  let dirQuery = ''
  /** `projectId`: the directory's follow-up dialogue for the picked project. */
  let dialogueAt: { target: InteractTarget; vm: DialogueVM; projectId?: string } | null = null
  let suspended = false

  /** Recomputes the effective graphics and forwards actual changes (or all, with `force`). */
  const applyGraphics = (force = false) => {
    const s = settingsNow ?? DEFAULT_SETTINGS
    const e = effectiveGraphics({
      preset: s.graphicsQuality === 'auto' ? governor.preset : s.graphicsQuality,
      advanced: s.graphicsAdvanced,
      dpr: d.devicePixelRatio?.() ?? d.hardware?.()?.dpr ?? 1,
      power: { focused, hidden: hidden || !windowVisible || !officeVisible, onBattery },
      saver: { blur: s.powerSaverBlur, hidden: s.powerSaverHidden, battery: s.batteryPreset },
      // Horizon's calm default (nearby name tags) while the user's Advanced labels is Auto.
      ...(labelsDefaultFor(viewMode) && { labelsDefault: labelsDefaultFor(viewMode) }),
    })
    const key = JSON.stringify(e)
    if (!force && key === effectiveKey) return
    effectiveKey = key
    effective = e
    d.scene.setGraphics(e)
  }

  /** New settings: a switch back to Auto restarts the governor at the hardware tier. */
  const applySettings = (s: Settings) => {
    if (s.graphicsQuality === 'auto' && settingsNow && settingsNow.graphicsQuality !== 'auto')
      governor.reset()
    settingsNow = s
    allowBypass = s.allowBypassPermissions
    applyGraphics()
    const walls = s.wallMode ?? 'cutaway'
    d.scene.setWallMode?.(walls)
    d.hud.renderWallMode?.(walls)
    if (pixelDeps) applyViewMode(s.viewMode ?? '3d')
  }

  /** The first mode only renders (main built that scene); later changes switch the scene host. */
  function applyViewMode(mode: ViewMode) {
    if (mode === viewMode) return
    const first = viewMode === undefined
    viewMode = mode
    d.modeToggle?.render(mode)
    d.pixelHud?.show(mode === 'pixel')
    if (mode !== 'pixel') {
      // Classic 3D and Horizon (the Classic office with a light flavor) have no dialogue box.
      closeDialogue()
      d.pixelHud?.renderMinimap(null)
      d.pixelHud?.renderDirectory(null)
    }
    if (!first) d.onViewMode?.(mode)
    if (mode === 'pixel') renderPixel()
    // The view's label default (Horizon: nearby) may change the effective graphics.
    applyGraphics()
  }

  const graphicsFacts = () => ({
    ...(tier && { tier }),
    autoPreset: governor.preset,
    ...(lastStats && { stats: lastStats }),
    ...(effective && { effective }),
    onBattery,
  })

  /** 2 Hz: feeds the Auto governor and refreshes the Settings stats line while it is open. */
  const pollGraphics = () => {
    const settingsOpen = d.settings.isOpen()
    const auto =
      settingsNow?.graphicsQuality === 'auto' &&
      !!effective &&
      effective.fpsLimit !== 0 &&
      effective.preset === governor.preset
    if (!settingsOpen && !auto) return
    lastStats = d.scene.stats()
    if (auto && governor.sample(lastStats.fps, GFX_POLL_MS / 1000, effective!.fpsLimit))
      applyGraphics()
    if (settingsOpen) showSettings(false)
  }

  const onPower = (s: { onBattery: boolean }) => {
    onBattery = s.onBattery
    applyGraphics()
    if (d.settings.isOpen()) showSettings(false)
  }

  const contextLost = () => {
    const now = d.clock.now()
    losses = [...losses.filter((t) => now - t <= LOSS_WINDOW_MS), now]
    recovering = true
    d.banner.show({ kind: 'info', text: GFX_COPY.recovering })
    if (losses.length >= LOSSES_BEFORE_PROMPT)
      d.toast.show(GFX_COPY.keepFailing, {
        label: GFX_COPY.switchMinimal,
        run: () => void changeSettings({ graphicsQuality: 'minimal' }),
      })
  }

  const contextRestored = () => {
    if (recovering) d.banner.show(null)
    recovering = false
    applyGraphics(true)
  }

  /** Where the director has an agent right now, for the panel's "Now" line. */
  const activityOf = (id: string): ActivityInfo | undefined => {
    const plan = plans.get(id)
    if (!plan) return undefined
    const info: ActivityInfo = { activity: plan.intent.activity }
    const room = layout?.anchors.get(plan.intent.target)?.room
    if (room) info.room = room
    const capId = plan.intent.capability
    const c = capId ? capabilityOf(plan.agent.provider, capId) : undefined
    if (c) {
      info.capability = { label: c.label, category: c.category }
      if (info.activity === 'connection-call' && plan.agent.tool)
        info.capability.tool = plan.agent.tool
    }
    if (info.activity === 'meeting') {
      const parent = plan.agent.parentId
      if (parent) info.with = (state.agents.get(parent) ?? plans.get(parent)?.agent)?.name ?? parent
      else
        info.subagents = [...plans.values()].filter(
          (p) => p.agent.parentId === id && p.intent.activity === 'meeting',
        ).length
    }
    return info
  }
  const capabilityOf = (provider: string, id: string) =>
    state.capabilities.get(provider)?.find((c) => c.id === id)
  const nameOf = (id: string) => state.agents.get(id)?.name ?? plans.get(id)?.agent.name ?? id
  const vmFor = (id: string) => {
    const provider = (state.agents.get(id) ?? plans.get(id)?.agent)?.provider
    const caps = provider ? (state.capabilities.get(provider) ?? []) : []
    const models = modelsCache.get(id)
    return panelVM(
      state,
      id,
      d.clock.now(),
      activityOf(id),
      usedChips(caps, used.get(id) ?? new Map()),
      {
        hook,
        allowBypass,
        ...(connInfo?.providers && { providers: connInfo.providers }),
        ...(models && { models }),
        ...(drafts.has(id) && { draft: drafts.get(id)! }),
      },
    )
  }

  /** A managed session's model list, fetched once; the alias fallback when it can't be listed. */
  const loadModels = (id: string) => {
    if (!state.agents.get(id)?.managed || modelsCache.has(id) || modelsLoading.has(id)) return
    modelsLoading.add(id)
    d.gateway.sessions
      .models(id)
      .catch(() => FALLBACK_MODELS)
      .then((list) => {
        modelsCache.set(id, list.length ? list : FALLBACK_MODELS)
        if (list.length) globalModels = list
        modelsLoading.delete(id)
        renderPanel()
      })
  }

  const draftOf = (id: string) => {
    let dr = drafts.get(id)
    if (!dr) drafts.set(id, (dr = emptyDraft()))
    return dr
  }

  /** Counts a use each time an agent starts using a capability (it shows up in `active`). */
  const trackUses = () => {
    const now = new Set<string>()
    for (const caps of state.capabilities.values())
      for (const c of caps)
        for (const agentId of c.active) {
          const key = `${agentId} ${c.id}`
          now.add(key)
          if (activeUses.has(key)) continue
          const m = used.get(agentId) ?? new Map<string, number>()
          m.set(c.id, (m.get(c.id) ?? 0) + 1)
          used.set(agentId, m)
        }
    activeUses = now
  }

  const renderCapability = (open = false) => {
    if (!openCapability) return
    const c = capabilityOf(openCapability.provider, openCapability.id)
    if (!c) return
    const base = capabilityPanelVM(c, d.clock.now(), nameOf, showLinks)
    const vm = slotOf(c) === undefined ? { ...base, meta: [...base.meta, NOT_ON_SHELF_ROW] } : base
    if (open) d.capabilityPanel.open(vm)
    else d.capabilityPanel.render(vm)
  }

  /** Panel closed: links back to normal, the camera stops tracking the capability. */
  function closeCapability() {
    if (!openCapability) return
    openCapability = null
    showLinks = false
    d.scene.highlightLinks(null)
    d.scene.focusCapability(null)
    updateSuspension()
  }

  /** The capability's own surface slot in its provider's wings (undefined: overflow). */
  const slotOf = (c: Capability) =>
    shelfSlot(
      c,
      lastLibrary?.get(c.provider),
      lastStations?.get(c.provider),
      state.capabilities.get(c.provider),
    )

  /** Opens the Capability panel; the camera flies there only when it has a surface. */
  const pickCapability = (ref: CapabilityRef) => {
    const more = parseMore(ref.id)
    if (more)
      return openLibrary({ provider: ref.provider, tab: more.tab ?? libTab, focus: 'overflow' })
    const c = capabilityOf(ref.provider, ref.id)
    if (!c) return
    if (selected) select(null)
    openCapability = ref
    showLinks = false
    d.scene.highlightLinks(null)
    if (slotOf(c) !== undefined) d.scene.focusCapability(ref)
    else d.scene.focusCapability(null)
    renderCapability(true)
    updateSuspension()
  }

  const selectedProvider = () =>
    selected ? (state.agents.get(selected) ?? plans.get(selected)?.agent)?.provider : undefined

  const libraryVMNow = () => {
    const sp = selectedProvider()
    return libraryVM({
      capabilities: state.capabilities,
      ...(libProvider && { provider: libProvider }),
      ...(sp && { selectedProvider: sp }),
      tab: libTab,
      query: libQuery,
      sort: libSort,
      ...(lastLibrary && { library: lastLibrary }),
      ...(lastStations && { stations: lastStations }),
      now: d.clock.now(),
      nameOf,
      ...(libFocus && { focus: libFocus }),
    })
  }
  const renderLibrary = () => {
    if (d.library.isOpen()) d.library.render(libraryVMNow())
  }
  function openLibrary(
    o: { provider?: string; tab?: LibraryTab; focus?: LibraryVM['focus'] } = {},
  ) {
    libProvider = o.provider
    libTab = o.tab ?? 'skills'
    libFocus = o.focus
    const vm = libraryVMNow()
    libProvider = vm.provider || undefined
    d.library.open(vm)
  }

  /** Tooltip text for a hovered surface (null: nothing to say). */
  const hoverText = (ref: CapabilityRef): string | null => {
    const more = parseMore(ref.id)
    if (more) {
      const caps = state.capabilities.get(ref.provider) ?? []
      const lib = lastLibrary?.get(ref.provider) ?? assignLibrary(caps)
      const st = lastStations?.get(ref.provider) ?? assignStations(caps)
      return moreTooltipText(overflowCount(more.tab ?? 'skills', lib, st))
    }
    const c = capabilityOf(ref.provider, ref.id)
    return c ? tooltipText(c) : null
  }

  const renderPanel = () => {
    if (!selected) return
    const vm = vmFor(selected)
    shownActivity = vm.activity
    d.panel.render(vm)
    // A new session can become `managed` after it was selected; loadModels is idempotent.
    loadModels(selected)
  }

  /** One director step: building only when it changed, then every agent's plan. */
  /** A message already triggered a director run since the last tick. */
  let messageDirected = false
  const direct = () => {
    if (!director) return
    const u = director.update(state, d.clock.now())
    layout = u.layout
    plans = u.plans
    lastLibrary = u.library
    lastStations = u.stations
    if (u.layoutChanged) d.scene.setBuilding(u.layout)
    d.scene.direct(u.plans, u.departed)
    d.scene.setLinks(u.links)
    d.scene.setSurfaces({
      byProvider: surfacesVM(state.capabilities, u.stations, u.library, d.clock.now(), nameOf),
      bubbles: capabilityBubbles(u.plans, state.capabilities),
    })
    trackUses()
    if (pendingGoTo) {
      // After the director placed the new wing, so its bookmark exists.
      d.scene.goTo(pendingGoTo)
      pendingGoTo = null
    }
    renderCapability()
    renderLibrary()
    if (selected && vmFor(selected).activity !== shownActivity) renderPanel()
  }

  const render = () => {
    // Messages arrive in bursts with many busy agents: the first one after a tick is directed at
    // once, the rest wait for the next 4 Hz tick (at most one extra director run per tick).
    if (!messageDirected) {
      messageDirected = true
      direct()
    }
    refreshConnect()
    renderPanel()
  }

  const select = (id: string | null) => {
    // Agents walking out (removed from state, still planned) stay selectable while they leave.
    selected = id && (state.agents.has(id) || plans.has(id)) ? id : null
    d.scene.select(selected)
    if (!selected) {
      d.panel.close()
      return updateSuspension()
    }
    if (openCapability) {
      d.capabilityPanel.close()
      closeCapability()
    }
    const vm = vmFor(selected)
    shownActivity = vm.activity
    d.panel.open(vm)
    loadModels(selected)
    updateSuspension()
  }

  /**
   * 2D: player input pauses only for modal UI (the dialogue box, Settings, Connect, New session).
   * Selected agents, the agent and capability panels and the Library drawer leave the player
   * walking; typing in a field never moves the player (PixelInput ignores those keys).
   */
  function updateSuspension() {
    if (!pixelDeps && officeVisible) return
    const on =
      !officeVisible ||
      dialogueAt !== null ||
      d.settings.isOpen() ||
      d.connect.isOpen() ||
      d.newSession.isOpen()
    if (on === suspended) return
    suspended = on
    d.scene.setInputSuspended?.(on)
  }

  const dialogueContext = () => ({
    state,
    plans,
    activityOf,
    ...(d.workspace && { projectDirectory: d.workspace.projectDirectory() }),
  })

  /** E (or a click) on something in 2D: the dialogue box. */
  function openDialogue(target: InteractTarget) {
    if (!d.dialogue) return
    const vm = dialogueVM(target, dialogueContext())
    if (!vm) return
    dialogueAt = { target, vm }
    d.dialogue.open(vm)
    updateSuspension()
  }

  function closeDialogue() {
    if (!dialogueAt) return
    dialogueAt = null
    if (d.dialogue?.isOpen()) d.dialogue.close()
    updateSuspension()
  }

  /** The picked project's own dialogue (null once it is gone from the directory). */
  function projectDialogueFor(projectId: string): DialogueVM | null {
    const entry = d.workspace?.projectDirectory().entries.find((e) => e.projectId === projectId)
    return entry ? projectDialogue(entry) : null
  }

  /** Keeps an open dialogue current; one whose agent left closes with a toast. */
  function refreshDialogue() {
    if (!dialogueAt || !d.dialogue) return
    const pid = dialogueAt.projectId
    const vm = pid ? projectDialogueFor(pid) : dialogueVM(dialogueAt.target, dialogueContext())
    if (vm) {
      dialogueAt.vm = vm
      return d.dialogue.render(vm)
    }
    const name = dialogueAt.vm.title
    const wasAgent = dialogueAt.target.kind === 'agent'
    closeDialogue()
    if (wasAgent) d.toast.show(PIXEL_COPY.dialogue.left(name))
  }

  function onDialogueAction(a: DialogueAction, o?: { projectId?: string }) {
    const at = dialogueAt
    if (!at) return
    const { agentId, parentId, ref } = at.vm
    closeDialogue()
    const ws = d.workspace
    const projectId = o?.projectId
    switch (a) {
      case 'project-select': {
        if (!ws || !projectId || !d.dialogue) return
        void Promise.resolve(ws.selectProject(projectId)).then(() => {
          const vm = projectDialogueFor(projectId)
          if (!vm || !d.dialogue || dialogueAt) return
          dialogueAt = { target: at.target, vm, projectId }
          d.dialogue.open(vm)
          updateSuspension()
        })
        return
      }
      case 'project-all':
        if (ws) void ws.selectProject(null)
        return
      case 'project-dashboard':
        if (ws && projectId) void ws.perform({ type: 'open-project', projectId })
        return
      case 'project-memory':
        if (ws) void ws.perform({ type: 'open-memory', ...(projectId && { projectId }) })
        return
      case 'project-sessions':
        if (ws) void ws.perform({ type: 'open-sessions', ...(projectId && { projectId }) })
        return
      case 'context':
        if (ws) void ws.perform({ type: 'inspect-context', ...(projectId && { projectId }) })
        return
      case 'start-agent':
        if (ws) void ws.perform({ type: 'start-agent', ...(projectId && { projectId }) })
        return
      case 'talk':
      case 'details':
      case 'review':
        // The existing panel; a pending permission shows on its card.
        if (agentId) select(agentId)
        return
      case 'follow':
        if (!agentId) return
        d.scene.follow?.(agentId)
        d.toast.show(PIXEL_COPY.following(at.vm.title))
        return
      case 'open':
        if (ref) pickCapability(ref)
        return
      case 'open-library': {
        if (!ref) return
        const c = capabilityOf(ref.provider, ref.id)
        const kind = c && libraryKind(c)
        const tab = kind === 'rule' ? 'rules' : kind === 'memory' ? 'memory' : 'skills'
        openLibrary({ provider: ref.provider, tab, focus: ref.id })
        updateSuspension()
        return
      }
      case 'go-parent':
        if (!parentId) return
        d.scene.travelTo?.({ agentId: parentId })
        openDialogue({ kind: 'agent', id: parentId })
        return
    }
  }

  /** 2 Hz while 2D is active: HUD, minimap, directory and an open dialogue. */
  function renderPixel() {
    if (viewMode !== 'pixel') return
    d.pixelHud?.render(pixelHudVM({ state, room, selected }))
    if (layout) {
      const proj = projectionFor(layout.bounds)
      const now = d.clock.now()
      const dots: Parameters<typeof minimapVM>[1][number][] = []
      for (const [id, p] of plans) {
        const pose = director?.pose(id, now)
        if (pose?.visible) dots.push({ id, pos: pose.pos, status: p.agent.status })
      }
      if (manifest && (mapLabels?.key !== layout.key || mapLabels.manifest !== manifest))
        mapLabels = {
          key: layout.key,
          manifest,
          labels: minimapLabels(layout, plansOf(manifest), proj),
        }
      d.pixelHud?.renderMinimap(
        minimapVM(proj, dots, playerPos, {
          flags: true,
          ...(mapLabels && { labels: mapLabels.labels }),
          ...(cameraView && { viewport: cameraView }),
        }),
      )
    }
    d.pixelHud?.renderDirectory(directoryVM(state, layout, d.grouping, dirQuery))
    refreshDialogue()
    updateSuspension()
  }

  const loadScene = async () => {
    try {
      const assets = await d.scene.load(MANIFEST_URL)
      manifest = assets.manifest
      const opts: Parameters<typeof createDirector>[1] = { grouping: d.grouping }
      if (assets.clipDurations) opts.clipDurations = assets.clipDurations
      director = createDirector(assets.manifest, opts)
    } catch (err) {
      d.banner.show({
        kind: 'error',
        text: `Could not load the 3D office: ${(err as Error).message}`,
      })
    }
  }

  const renderSettings = async (open: boolean, known?: Settings) => {
    const [settings, version] = await Promise.all([
      known ?? d.gateway.settings.get(),
      d.gateway.app.version(),
    ])
    applySettings(settings)
    versionNow = version
    hook = await d.gateway.hook.status()
    renderPanel()
    if (open) lastStats = d.scene.stats()
    showSettings(open)
  }

  /** Renders Settings from the last known facts (the 2 Hz refresh uses this, no IPC). */
  function showSettings(open: boolean) {
    if (!settingsNow) return
    const vm = settingsVM({
      settings: settingsNow,
      hook,
      version: versionNow,
      update,
      restartNote,
      graphics: graphicsFacts(),
      ...(d.isMac && { isMac: true }),
    })
    if (open) d.settings.open(vm)
    else if (d.settings.isOpen()) d.settings.render(vm)
  }

  /** A settings patch from any entry point; errors show in Settings. */
  async function changeSettings(patch: SettingsPatch) {
    await guarded(async () => {
      const r = await d.gateway.settings.set(patch)
      restartNote = restartNote || r.restartRequired
      await renderSettings(false, r.settings)
    })()
  }

  const connectVMNow = (info: ConnectionInfo) =>
    connectVM({
      info,
      state,
      tab: connectTab,
      lang: snippetLang,
      now: d.clock.now(),
      ...(lastHttp && { lastHttp }),
      ...(lastTest && { test: lastTest }),
      ...(d.isWindows && { isWindows: true }),
    })

  /** Empty card, HUD (hint + badge) and an open Connect panel, from the current facts. */
  function refreshConnect() {
    phase = emptyPhase({
      prev: phase,
      ready,
      infoReceived: pushReceived,
      graceElapsed,
      agents: state.agents.size,
      dismissed,
    })
    d.empty.render(phase === 'first-run' && connInfo ? emptyStateVM(connInfo, demo) : null)
    d.hud.render(hudVM(state, phase))
    d.hud.setConnectBadge(!seenAny)
    if (connInfo && d.connect.isOpen()) d.connect.render(connectVMNow(connInfo))
  }

  /** Before rendering a state change: who is new, and does anyone deserve a toast. */
  const noteArrivals = () => {
    if (state.agents.size) seenAny = true
    // Sessions read during the grace period (or before the first push) were already there.
    const announce = ready && (pushReceived || graceElapsed)
    for (const a of state.agents.values()) {
      if (a.source === 'mock' && demo === 'starting') {
        demo = 'idle'
        cancelDemoTimer()
      }
      if (a.provider === TEST_AGENT_ID) continue
      if (
        a.source === 'http' &&
        (!lastHttp || a.lastSeen > lastHttp.ts || lastHttp.provider === a.provider)
      )
        lastHttp = { provider: a.provider, ts: Math.max(a.lastSeen, d.clock.now()) }
      if (firstSeen.has(a.provider)) continue
      firstSeen.set(a.provider, d.clock.now())
      if (announce) arrived(a.provider, !!a.managed || a.source === 'managed')
    }
  }

  const arrived = (provider: string, managed: boolean) => {
    const hook = connInfo?.hook ?? hookStatusNow()
    // Managed sessions get messages directly; only terminal sessions need the hook.
    if (provider === 'claude-code' && !managed && hook !== 'installed')
      d.toast.show(COPY.toast.connected(provider) + COPY.toast.hookHint, {
        label: COPY.hud.connect,
        run: () => void openConnect('claude'),
      })
    else d.toast.show(COPY.toast.connected(provider))
    if (!announcedAny || d.scene.cameraIdleMs() > FLY_TO_IDLE_MS) pendingGoTo = `wing:${provider}:0`
    announcedAny = true
  }
  const hookStatusNow = () => hook

  const loadInfo = async (): Promise<ConnectionInfo | undefined> => {
    try {
      connInfo = await d.gateway.connections.info()
      hook = connInfo.hook
    } catch {
      // Older or failing main process: the panel and the card simply stay unavailable.
    }
    return connInfo
  }

  async function openConnect(tab?: ConnectTab) {
    connectTab = tab ?? (seenAny ? 'connected' : 'claude')
    const info = connInfo ?? (await loadInfo())
    if (!info) return
    d.connect.showError(null)
    d.connect.open(connectVMNow(info))
    // Detection runs when the panel opens (never starts a session); the cards update when done.
    void inConnect(() => d.gateway.providers.refresh())
  }

  /** Runs a Connect action, refreshes the facts, re-renders; errors show inside the panel. */
  const inConnect = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      await loadInfo()
    } catch (err) {
      d.connect.showError((err as Error).message)
    }
    refreshConnect()
  }

  const startDemo = () => {
    demo = 'starting'
    cancelDemoTimer()
    cancelDemoTimer = d.after(DEMO_START_TIMEOUT_MS, () => {
      if (demo !== 'starting') return
      demo = 'failed'
      d.connect.showError(COPY.empty.demo.failed)
      refreshConnect()
    })
    refreshConnect()
  }

  const guarded = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn()
    } catch (err) {
      d.settings.showError((err as Error).message)
    }
  }

  // View intents
  d.scene.onPick(select)
  d.scene.onContextLost(contextLost)
  d.scene.onContextRestored(contextRestored)
  d.scene.onViews((views) => d.viewBar.render(views))
  d.viewBar.onPick((id) => d.scene.goTo(id))
  d.scene.onHoverSurface((ref, x, y) => {
    const text = ref && hoverText(ref)
    if (text) d.tooltip.show(text, x, y)
    else d.tooltip.hide()
  })

  // Library browser (low-spec plan §B2)
  d.hud.onLibrary(() => openLibrary())
  d.hud.onWallMode?.((m) => changeSettings({ wallMode: m }))
  d.library.onProvider((p) => {
    libProvider = p
    libFocus = undefined
    renderLibrary()
  })
  d.library.onTab((t) => {
    libTab = t
    libFocus = undefined
    renderLibrary()
  })
  d.library.onSearch((q) => {
    libQuery = q
    renderLibrary()
  })
  d.library.onSort((srt) => {
    libSort = srt
    renderLibrary()
  })
  d.library.onClose(() => {
    libFocus = undefined
    updateSuspension()
  })
  d.library.onPick(pickCapability)
  // Agent panel chips: the same as a drawer pick; an empty provider means the selected agent's.
  d.panel.onPickCapability((ref) => {
    const provider = ref.provider || selectedProvider()
    if (provider) pickCapability({ provider, id: ref.id })
  })
  d.scene.onPickCapability(pickCapability)
  d.capabilityPanel.onClose(closeCapability)
  d.capabilityPanel.onToggleLinks((on) => {
    if (!openCapability) return
    showLinks = on
    d.scene.highlightLinks(on ? openCapability.id : null)
    renderCapability()
  })
  d.capabilityPanel.onSelectAgent(select)
  d.panel.onClose(() => select(null))
  d.panel.onSelectParent(select)
  d.panel.onSend(async (text) => {
    if (!selected) return
    const id = selected
    const dr = drafts.get(id)
    const opts = {
      ...(dr?.context.length && { context: dr.context.map((c) => c.ref) }),
      ...(dr?.use.length && { use: [...dr.use] }),
    }
    const r = Object.keys(opts).length
      ? await d.gateway.sendMessage(id, text, opts)
      : await d.gateway.sendMessage(id, text)
    if (r.ok) {
      drafts.delete(id)
      d.panel.clearInput()
      renderPanel()
    } else d.panel.showError(r.error)
  })
  d.panel.onInstallHook(async () => {
    hook = await d.gateway.hook.install()
    renderPanel()
    await renderSettings(false)
  })

  // Composer: drafts, + Context, Use… (plan §2.2)
  d.panel.onDraft((text) => {
    if (selected) draftOf(selected).text = text
  })
  d.panel.onPickContext(async (kind) => {
    if (!selected) return
    const id = selected
    try {
      const picked = await d.gateway.context.pick(kind)
      const dr = draftOf(id)
      const r = addContext(dr.context, picked)
      dr.context = r.context
      renderPanel()
      if (r.error) d.panel.showError(r.error)
    } catch (err) {
      d.panel.showError((err as Error).message)
    }
  })
  d.panel.onRemoveChip((key) => {
    if (!selected) return
    const dr = draftOf(selected)
    dr.context = dr.context.filter((c) => c.ref !== key)
    dr.use = dr.use.filter((u) => u !== key)
    renderPanel()
  })
  d.panel.onOpenUse(() => {
    const a = selected ? state.agents.get(selected) : undefined
    if (!a) return { groups: [] }
    const caps = state.capabilities.get(a.provider) ?? []
    return useMenuVM(caps, a.provider, drafts.get(a.id)?.use ?? [], a.managed?.chrome, a.caps)
  })
  d.panel.onToggleUse((useId) => {
    if (!selected) return
    const dr = draftOf(selected)
    const r = toggleUse(dr.use, useId)
    dr.use = r.use
    renderPanel()
    if (r.error) d.panel.showError(r.error)
  })

  // Managed session controls (plan §2.1, §2.3): errors show in the panel.
  const inSession = (fn: (id: string) => Promise<unknown>) => async () => {
    if (!selected) return
    try {
      await fn(selected)
    } catch (err) {
      d.panel.showError((err as Error).message)
    }
  }
  d.panel.onSetMode((mode) =>
    inSession((id) =>
      // Providers with their own modes (Codex presets, ACP modes) use the mode id.
      state.agents.get(id)?.managed?.modes
        ? d.gateway.sessions.setModeId(id, mode)
        : d.gateway.sessions.setMode(id, mode),
    )(),
  )
  d.panel.onSetModel((model) => inSession((id) => d.gateway.sessions.setModel(id, model))())
  d.panel.onInterrupt(inSession((id) => d.gateway.sessions.interrupt(id)))
  d.panel.onStop(inSession((id) => d.gateway.sessions.stop(id)))
  d.panel.onAnswer((requestId, decision) =>
    inSession((id) => d.gateway.sessions.answer(id, requestId, decision))(),
  )

  // New session dialog (plan §2.4)
  const runningCount = () =>
    [...state.agents.values()].filter((a) => a.managed && a.managed.phase !== 'ended').length
  const nsVM = () =>
    newSessionVM(
      form,
      form.provider === CLAUDE ? globalModels : providerModels.get(form.provider),
      allowBypass,
      runningCount(),
      {
        starting: nsStarting,
        ...(nsError && { error: nsError }),
        caps: state.capabilities.get(form.provider) ?? [],
        ...(connInfo?.providers && { providers: connInfo.providers }),
        ...(d.workspace && {
          projects: d.workspace
            .projectDirectory()
            .entries.map((e) => ({ id: e.projectId, name: e.name })),
        }),
      },
    )
  /** A provider's models for the dialog, fetched once; the list stays empty when it fails. */
  const loadProviderModels = async (id: ProviderId) => {
    if (id === CLAUDE || providerModels.has(id)) return
    try {
      providerModels.set(id, await d.gateway.providers.models(id))
    } catch {
      providerModels.set(id, [])
    }
    renderNewSession()
  }
  const renderNewSession = () => d.newSession.render(nsVM())
  const pickFolder = async (): Promise<ContextRef | undefined> => {
    try {
      return (await d.gateway.context.pick('folder'))[0]
    } catch (err) {
      nsError = (err as Error).message
      return undefined
    }
  }
  const openNewSession = async (provider?: ProviderId) => {
    form = emptyForm(lastFolder, provider ?? lastProvider)
    nsError = undefined
    nsStarting = false
    d.newSession.open(nsVM())
    void loadProviderModels(form.provider)
    try {
      const list = await d.gateway.sessions.models()
      if (list.length) globalModels = list
    } catch {
      // Keep the fallback aliases.
    }
    renderNewSession()
  }
  d.hud.onNewSession(() => void openNewSession())
  d.newSession.onClose(() => {
    nsError = undefined
  })
  d.newSession.onPickFolder(async () => {
    const f = await pickFolder()
    if (f) form.folder = lastFolder = f
    renderNewSession()
  })
  d.newSession.onAddExtraFolder(async () => {
    const f = await pickFolder()
    if (f && form.extraFolders.length < 5 && !form.extraFolders.some((x) => x.ref === f.ref))
      form.extraFolders = [...form.extraFolders, f]
    renderNewSession()
  })
  d.newSession.onRemoveExtraFolder((key) => {
    form.extraFolders = form.extraFolders.filter((f) => f.ref !== key)
    renderNewSession()
  })
  d.newSession.onPickContext(async (kind) => {
    try {
      const r = addContext(form.context, await d.gateway.context.pick(kind))
      form.context = r.context
      nsError = r.error
    } catch (err) {
      nsError = (err as Error).message
    }
    renderNewSession()
  })
  d.newSession.onRemoveChip((key) => {
    form.context = form.context.filter((c) => c.ref !== key)
    form.use = form.use.filter((u) => u !== key)
    renderNewSession()
  })
  d.newSession.onOpenUse(() =>
    useMenuVM(
      state.capabilities.get(form.provider) ?? [],
      form.provider,
      form.use,
      form.chrome,
      connInfo?.providers?.find((p) => p.id === form.provider)?.managedCaps,
    ),
  )
  d.newSession.onToggleUse((useId) => {
    const r = toggleUse(form.use, useId)
    form.use = r.use
    nsError = r.error
    renderNewSession()
  })
  d.newSession.onChange((patch) => {
    const switched = patch.provider !== undefined && patch.provider !== form.provider
    form = { ...form, ...patch }
    if (patch.projectId === '') delete form.projectId
    if (switched) {
      // Models, modes and Chrome belong to the provider: start from its defaults.
      lastProvider = form.provider
      delete form.model
      delete form.modeId
      form.chrome = false
      form.use = form.use.filter((u) => u !== CHROME_ID)
      void loadProviderModels(form.provider)
    }
    renderNewSession()
  })
  d.newSession.onStart(async () => {
    if (!nsVM().canStart || !form.folder) return
    nsStarting = true
    nsError = undefined
    renderNewSession()
    const name = form.name.trim()
    const other = form.provider !== CLAUDE
    const modeId = nsVM().modes.find((m) => m.checked)?.id
    const args = {
      ...(other && { provider: form.provider }),
      ...(other && modeId && { modeId }),
      folder: form.folder.ref,
      ...(form.projectId && { projectId: form.projectId }),
      ...(name && { name }),
      ...(form.model && { model: form.model }),
      mode: form.mode,
      extraFolders: form.extraFolders.map((f) => f.ref),
      chrome: form.chrome && !other,
      text: form.text.trim(),
      ...(form.context.length && { context: form.context.map((c) => c.ref) }),
      ...(form.use.length && { use: [...form.use] }),
    }
    try {
      const r = await d.gateway.sessions.start(args)
      nsStarting = false
      if (r.ok) {
        d.newSession.close()
        if (state.agents.has(r.agentId)) select(r.agentId)
        else pendingSelect = r.agentId
        return
      }
      nsError = startErrorText(r, runningCount())
    } catch (err) {
      nsStarting = false
      nsError = SESSION_COPY.newSession.errors.generic((err as Error).message)
    }
    renderNewSession()
  })
  d.hud.onOpenSettings(() => renderSettings(true))
  d.settings.onChange(changeSettings)
  d.settings.onHookAction(async (action) => {
    await guarded(async () => {
      hook =
        action === 'install' ? await d.gateway.hook.install() : await d.gateway.hook.uninstall()
      renderPanel()
      await renderSettings(false)
    })()
  })
  d.settings.onCheckUpdates(async () => {
    await guarded(async () => {
      update = await d.gateway.updates.check()
      await renderSettings(false)
    })()
  })
  d.settings.onInstallUpdate(() => d.gateway.updates.install())
  d.settings.onOpenConnect(() => {
    d.settings.close()
    void openConnect('claude')
  })

  // Connect entry points (plan §2.2)
  d.hud.onConnect(() => void openConnect())
  d.panel.onOpenConnect(() => void openConnect('http'))
  d.banner.onAction((a) => {
    if (a === 'open-connect') void openConnect('http')
  })
  d.empty.onTile((t) => void openConnect(t))
  d.empty.onDismiss(() => {
    dismissed = true
    refreshConnect()
  })
  d.empty.onDemo(async () => {
    startDemo()
    await inConnect(() => d.gateway.settings.set({ mock: true }))
  })

  // Connect panel
  d.connect.onClose(() => d.connect.showError(null))
  d.connect.onTab((t) => {
    connectTab = t
    refreshConnect()
  })
  d.connect.onSnippetLang((l) => {
    snippetLang = l
    refreshConnect()
  })
  d.connect.onToggle(async (key, on) => {
    if (key === 'mock' && on) startDemo()
    await inConnect(() => d.gateway.settings.set({ [key]: on }))
  })
  d.connect.onHookAction(async (action) => {
    await inConnect(async () => {
      hook =
        action === 'install' ? await d.gateway.hook.install() : await d.gateway.hook.uninstall()
    })
    renderPanel()
    if (d.settings.isOpen()) await renderSettings(false)
  })
  d.connect.onProviderAction?.(async (a) => {
    switch (a.kind) {
      case 'toggle':
        return inConnect(() => d.gateway.providers.setEnabled(a.id, a.on))
      case 'refresh':
        return inConnect(() => d.gateway.providers.refresh(a.id))
      case 'hooks':
        return inConnect(() =>
          a.action === 'uninstall'
            ? d.gateway.providers.removeHooks(a.id)
            : d.gateway.providers.installHooks(a.id),
        )
      case 'start':
        d.connect.close()
        return openNewSession(a.id)
    }
  })
  d.connect.onPort(async (port) => {
    // Same path as the Settings port form.
    await inConnect(async () => {
      const r = await d.gateway.settings.set({ port })
      restartNote = restartNote || r.restartRequired
    })
  })
  d.connect.onCopy(async (text, target) => {
    try {
      await d.gateway.app.copyText(text)
      d.connect.flashCopied(target)
    } catch (err) {
      d.connect.showError((err as Error).message)
    }
  })
  d.connect.onTest(async () => {
    try {
      lastTest = await d.gateway.connections.test()
    } catch (err) {
      lastTest = { ok: false, error: (err as Error).message }
    }
    refreshConnect()
  })
  d.connect.onGoToWing((provider) => {
    d.connect.close()
    d.scene.goTo(`wing:${provider}:0`)
  })

  /** The scene follows the effective color scheme (Settings → Appearance sets it in main). */
  const followColorScheme = () => {
    const mql = d.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mql) return
    d.scene.setTheme(mql.matches ? 'dark' : 'light')
    const onChange = (e: { matches: boolean }) => d.scene.setTheme(e.matches ? 'dark' : 'light')
    mql.addEventListener('change', onChange)
    stops.push(() => mql.removeEventListener('change', onChange))
  }

  /** Window focus and page visibility drive the power saver (low-spec plan §5.2). */
  const followPage = () => {
    const onFocus = () => ((focused = true), applyGraphics())
    const onBlur = () => ((focused = false), applyGraphics())
    const onVisibility = () => {
      hidden = d.doc!.hidden
      applyGraphics()
    }
    if (d.win) {
      const win = d.win
      win.addEventListener('focus', onFocus)
      win.addEventListener('blur', onBlur)
      stops.push(() => {
        win.removeEventListener('focus', onFocus)
        win.removeEventListener('blur', onBlur)
      })
    }
    if (d.doc) {
      const doc = d.doc
      doc.addEventListener('visibilitychange', onVisibility)
      stops.push(() => doc.removeEventListener('visibilitychange', onVisibility))
    }
  }

  // 2D RPG mode wiring (optional deps; the 3D scene doesn't implement the optional events).
  if (pixelDeps) {
    d.scene.onInteract?.(openDialogue)
    d.scene.onRoom?.((name) => void (room = name))
    d.scene.onPlayerMove?.((pos) => void (playerPos = pos))
    d.scene.onCamera?.((v) => void (cameraView = v))
    // Zoom (− ⌂ +) and the run toggle: the HUD control drives the scene; the scene's state shows in the HUD.
    let zoomState = { level: 0, levels: 1, atDefault: true }
    let running = false
    const showZoom = () => d.pixelHud?.renderZoom?.({ ...zoomState, run: running })
    d.pixelHud?.onZoom?.((delta) => d.scene.zoomBy?.(delta))
    d.scene.onZoom?.((z) => {
      zoomState = z
      showZoom()
    })
    d.scene.onRun?.((on) => {
      running = on
      showZoom()
    })
    d.dialogue?.onAction(onDialogueAction)
    // The 3D reception's Project Directory (2D uses the reception-desk interact → dialogue).
    d.scene.onPickFixture?.(() => d.workspace?.openProjectPicker())
    // Semantic world objects (any scene that reports them): the same commands as the desktop UI.
    d.scene.onPickInteraction?.((hit) => {
      const projectId = d.workspace?.projectDirectory().entries.find((e) => e.selected)?.projectId
      const cmd = interactionAction(hit, { projectId: projectId ?? null })
      if (!cmd) return
      if (cmd.kind === 'workspace') void d.workspace?.perform(cmd.action)
      else if (cmd.kind === 'dialogue') openDialogue(cmd.target)
      else if (cmd.panel === 'agent') select(cmd.id ?? null)
      else if (cmd.panel === 'connect') void openConnect('providers')
      else if (cmd.id && cmd.provider) pickCapability({ provider: cmd.provider, id: cmd.id })
    })
    d.dialogue?.onClose(() => {
      dialogueAt = null
      updateSuspension()
    })
    d.modeToggle?.onChange((mode) => void changeSettings({ viewMode: mode }))
    d.pixelHud?.onAlert((agentId) => select(agentId))
    d.pixelHud?.onDirectory((pick) => {
      if (pick.travel) {
        const { travel: _, ...target } = pick
        d.scene.travelTo?.(target)
      } else if (pick.agentId) select(pick.agentId)
      else if (pick.viewId) d.scene.goTo(pick.viewId)
    })
    d.pixelHud?.onDirectorySearch((q) => {
      dirQuery = q
      d.pixelHud?.renderDirectory(directoryVM(state, layout, d.grouping, dirQuery))
    })
    d.pixelHud?.onMinimapPick((tx, ty, opts) => {
      if (!layout) return
      const proj = projectionFor(layout.bounds)
      const pos = pixelToWorld((tx + 0.5) * TILE_PX, (ty + 0.5) * TILE_PX, proj)
      // Shift-click fast-travels the player; a click pans the camera to the exact point.
      if (opts?.travel && d.scene.travelTo) return d.scene.travelTo({ pos })
      if (d.scene.panTo) return d.scene.panTo(pos)
      if (!manifest) return
      const p = placementAt(layout, manifest, pos)
      d.scene.goTo(p ? viewIdOf(p) : 'overview')
    })
    stops.push(d.every(PIXEL_HUD_MS, renderPixel))
  }

  return {
    /** New Agent prefilled from the workspace (project first; provider and objective optional). */
    openNewSessionFor(prefill: { projectId?: string; provider?: ProviderId; objective?: string }) {
      void openNewSession(prefill.provider).then(() => {
        if (prefill.objective) form.text = prefill.objective
        if (prefill.projectId) form.projectId = prefill.projectId
        renderNewSession()
      })
    },
    openConnect() {
      void openConnect()
    },
    /** The agent selected in the Office (the Context Inspector defaults to it). */
    selectedAgentId(): string | null {
      return selected
    },
    /** The workspace hides the Office stage for other views: pause rendering and input there. */
    setOfficeVisible(on: boolean) {
      if (on === officeVisible) return
      officeVisible = on
      applyGraphics()
      updateSuspension()
    },
    /** The last plans with each agent's remaining steps now (the scene host replays them). */
    resync() {
      return director?.resync(d.clock.now()) ?? new Map<string, AgentPlan>()
    },

    async start(): Promise<void> {
      followColorScheme()
      followPage()
      stops.push(
        d.gateway.onMessage((m) => {
          state = applyMessage(state, m)
          noteArrivals()
          render()
          if (pendingSelect && state.agents.has(pendingSelect)) {
            const id = pendingSelect
            pendingSelect = null
            select(id)
          }
        }),
        d.gateway.onSelect(select),
        d.gateway.app.onBanner((b) => d.banner.show(b)),
        d.gateway.app.onOpenSettings(() => renderSettings(true)),
        d.gateway.app.onOpenConnect(() => void openConnect()),
        d.gateway.connections.onChange((i) => {
          connInfo = i
          hook = i.hook
          pushReceived = true
          refreshConnect()
          renderPanel()
          if (d.newSession.isOpen()) renderNewSession()
        }),
        d.gateway.updates.onState((s) => {
          update = s
          void renderSettings(false)
        }),
        d.gateway.app.onPower(onPower),
        d.gateway.app.onWindowVisibility((visible) => {
          windowVisible = visible
          applyGraphics()
        }),
        d.every(GFX_POLL_MS, pollGraphics),
        d.every(1000, renderPanel),
        d.every(DIRECT_MS, () => {
          messageDirected = false
          direct()
        }),
      )
      const [snapshot, settings] = await Promise.all([
        d.gateway.ready(),
        d.gateway.settings.get().catch(() => DEFAULT_SETTINGS),
      ])
      const hw = d.hardware?.()
      if (hw) {
        tier = detectTier(hw)
        governor = createGovernor(tier)
      }
      applySettings(settings)
      void d.gateway.app
        .power()
        .then(onPower)
        .catch(() => {})
      state = applyMessage(state, { type: 'snapshot', ...snapshot })
      noteArrivals()
      ready = true
      stops.push(
        d.after(EMPTY_GRACE_MS, () => {
          graceElapsed = true
          refreshConnect()
        }),
      )
      await loadInfo()
      await loadScene()
      direct()
      refreshConnect()
      renderPanel()
    },

    stop(): void {
      for (const s of stops.splice(0)) s()
    },

    select,
  }
}
