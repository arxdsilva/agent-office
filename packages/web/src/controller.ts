import {
  DEFAULT_SETTINGS,
  type ConnectionInfo,
  type ContextRef,
  type GraphicsQuality,
  type Grouping,
  type HookStatus,
  type ModelOption,
  type Settings,
  type SettingsPatch,
  type TestEventResult,
  type UpdateState,
} from '@agent-office/shared'
import { capabilityBubbles, capabilityPanelVM, surfacesVM, usedChips } from './app/capability-vm.ts'
import { createDirector, type Director } from './app/director.ts'
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
import type { Draft, NewSessionForm } from './app/session-types.ts'
import type {
  BannerView,
  CapabilityPanelView,
  CapabilityRef,
  ConnectView,
  EmptyStateView,
  HudView,
  NewSessionView,
  OfficeGateway,
  PanelView,
  SceneView,
  SettingsView,
  ToastView,
} from './ports.ts'

export interface ControllerDeps {
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
  /** `window.matchMedia`: the scene follows `prefers-color-scheme` (plan §5.6). */
  matchMedia?: (query: string) => ColorSchemeQuery
  grouping: Grouping
  clock: { now(): number }
  every: (ms: number, fn: () => void) => () => void
  /** One-shot timer (grace period, demo timeout); returns a cancel function. */
  after: (ms: number, fn: () => void) => () => void
  /** Windows: the curl snippet gets the PowerShell note. */
  isWindows?: boolean
  /** Snippet language remembered from last time (the DOM adapter keeps it). */
  snippetLang?: SnippetLang
}

/** The part of `MediaQueryList` the controller uses. */
export interface ColorSchemeQuery {
  matches: boolean
  addEventListener(type: 'change', fn: (e: { matches: boolean }) => void): void
  removeEventListener(type: 'change', fn: (e: { matches: boolean }) => void): void
}

const CLAUDE = 'claude-code'
const emptyDraft = (): Draft => ({ text: '', context: [], use: [] })
const emptyForm = (folder?: ContextRef): NewSessionForm => ({
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
  let quality: GraphicsQuality | null = null
  let allowBypass = false
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

  /** The scene applies presets live; forward only actual changes. */
  const applyQuality = (q: GraphicsQuality) => {
    if (q === quality) return
    quality = q
    d.scene.setQuality(q)
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
    const vm = capabilityPanelVM(c, d.clock.now(), nameOf, showLinks)
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
  }

  const pickCapability = (ref: CapabilityRef) => {
    if (!capabilityOf(ref.provider, ref.id)) return
    if (selected) select(null)
    openCapability = ref
    showLinks = false
    d.scene.highlightLinks(null)
    d.scene.focusCapability(ref)
    renderCapability(true)
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
    if (!selected) return d.panel.close()
    if (openCapability) {
      d.capabilityPanel.close()
      closeCapability()
    }
    const vm = vmFor(selected)
    shownActivity = vm.activity
    d.panel.open(vm)
    loadModels(selected)
  }

  const loadScene = async () => {
    try {
      const assets = await d.scene.load(MANIFEST_URL)
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
    applyQuality(settings.graphicsQuality)
    allowBypass = settings.allowBypassPermissions
    hook = await d.gateway.hook.status()
    renderPanel()
    const vm = settingsVM({ settings, hook, version, update, restartNote })
    if (open) d.settings.open(vm)
    else if (d.settings.isOpen()) d.settings.render(vm)
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
    return useMenuVM(caps, a.provider, drafts.get(a.id)?.use ?? [], a.managed?.chrome)
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
  d.panel.onSetMode((mode) => inSession((id) => d.gateway.sessions.setMode(id, mode))())
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
    newSessionVM(form, globalModels, allowBypass, runningCount(), {
      starting: nsStarting,
      ...(nsError && { error: nsError }),
      caps: state.capabilities.get(CLAUDE) ?? [],
    })
  const renderNewSession = () => d.newSession.render(nsVM())
  const pickFolder = async (): Promise<ContextRef | undefined> => {
    try {
      return (await d.gateway.context.pick('folder'))[0]
    } catch (err) {
      nsError = (err as Error).message
      return undefined
    }
  }
  const openNewSession = async () => {
    form = emptyForm(lastFolder)
    nsError = undefined
    nsStarting = false
    d.newSession.open(nsVM())
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
    useMenuVM(state.capabilities.get(CLAUDE) ?? [], CLAUDE, form.use, form.chrome),
  )
  d.newSession.onToggleUse((useId) => {
    const r = toggleUse(form.use, useId)
    form.use = r.use
    nsError = r.error
    renderNewSession()
  })
  d.newSession.onChange((patch) => {
    form = { ...form, ...patch }
    renderNewSession()
  })
  d.newSession.onStart(async () => {
    if (!nsVM().canStart || !form.folder) return
    nsStarting = true
    nsError = undefined
    renderNewSession()
    const name = form.name.trim()
    const args = {
      folder: form.folder.ref,
      ...(name && { name }),
      ...(form.model && { model: form.model }),
      mode: form.mode,
      extraFolders: form.extraFolders.map((f) => f.ref),
      chrome: form.chrome,
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
  d.settings.onChange(async (patch: SettingsPatch) => {
    await guarded(async () => {
      const r = await d.gateway.settings.set(patch)
      restartNote = restartNote || r.restartRequired
      await renderSettings(false, r.settings)
    })()
  })
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

  return {
    async start(): Promise<void> {
      followColorScheme()
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
        }),
        d.gateway.updates.onState((s) => {
          update = s
          void renderSettings(false)
        }),
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
      applyQuality(settings.graphicsQuality)
      allowBypass = settings.allowBypassPermissions
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
