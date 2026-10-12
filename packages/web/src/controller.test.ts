import {
  DEFAULT_SETTINGS,
  type AgentOfficeApi,
  type Banner,
  type ConnectionInfo,
  type ContextRef,
  type GraphicsQuality,
  type HookStatus,
  type ModelOption,
  type NewSessionArgs,
  type PermissionMode,
  type StartResult,
  type ServerMessage,
  type Settings,
  type SettingsPatch,
  type TestEventResult,
  type UpdateState,
} from '@agent-office/shared'
import { byProviderAndTopic, type Agent } from '@agent-office/shared'
import { describe, expect, it, vi } from 'vitest'
import { fixtureManifest } from './app/__fixtures__/manifest.ts'
import { LEAVE_MS } from './app/behavior.ts'
import type { AgentPlan, BuildingLayout, Link } from './app/office-types.ts'
import type { HudVM, PanelVM, SettingsVM } from './app/view-models.ts'
import type { NewSessionVM, UseMenuVM } from './app/session-types.ts'
import {
  DEMO_START_TIMEOUT_MS,
  EMPTY_GRACE_MS,
  TEST_AGENT_ID,
  type ConnectTab,
  type ConnectVM,
  type EmptyStateVM,
} from './app/connect-types.ts'
import { createController, GFX_POLL_MS, LOSS_WINDOW_MS } from './controller.ts'
import { SESSION_COPY } from './app/session-copy.ts'
import { cap } from './app/__fixtures__/capabilities.ts'
import type { CapabilityPanelVM } from './app/capability-vm.ts'
import type { Effective, GraphicsStats, HardwareInfo } from './app/graphics-types.ts'
import { GFX_COPY } from './app/graphics-copy.ts'
import { LIB_COPY } from './app/library-copy.ts'
import type { LibraryVM, ViewEntry } from './app/library-types.ts'
import type {
  BannerView,
  LibraryView,
  TooltipView,
  ViewBarView,
  CapabilityPanelView,
  ConnectView,
  EmptyStateView,
  HudView,
  NewSessionView,
  PanelView,
  CapabilityRef,
  SceneSurfaces,
  SceneView,
  SettingsView,
  ToastView,
} from './ports.ts'

const agent = (id: string, over: Partial<Agent> = {}): Agent => ({
  id,
  name: id.toUpperCase(),
  provider: 'p',
  topic: 't',
  status: 'tool',
  source: 's',
  since: 0,
  lastSeen: 0,
  interactive: true,
  unread: 0,
  ...over,
})

const connInfo = (over: Partial<ConnectionInfo> = {}): ConnectionInfo => ({
  api: {
    host: '127.0.0.1',
    port: 4317,
    listening: true,
    portBusy: false,
    tokenFile: '~/.agent-office/token',
  },
  claude: {
    enabled: true,
    projectsDir: '~/.claude/projects',
    projectsDirFound: true,
    activeSessions: 0,
  },
  hook: 'not-installed',
  mock: { enabled: false },
  ...over,
})

function fakeGateway(
  initial: Settings = DEFAULT_SETTINGS,
  snapshotAgents: Agent[] = [agent('a', { name: 'Ada', status: 'idle' })],
) {
  let current = initial
  let hookState: HookStatus = 'not-installed'
  const listeners = {
    message: [] as ((m: ServerMessage) => void)[],
    select: [] as ((id: string) => void)[],
    banner: [] as ((b: Banner | null) => void)[],
    openSettings: [] as (() => void)[],
    update: [] as ((s: UpdateState) => void)[],
    conn: [] as ((i: ConnectionInfo) => void)[],
    openConnect: [] as (() => void)[],
    power: [] as ((s: { onBattery: boolean }) => void)[],
    windowVisible: [] as ((visible: boolean) => void)[],
  }
  const sub =
    <T>(list: T[]) =>
    (fn: T) => (list.push(fn), () => list.splice(list.indexOf(fn), 1))
  const api = {
    ready: vi.fn(async () => ({ agents: snapshotAgents, messages: [] })),
    onMessage: sub(listeners.message),
    onSelect: sub(listeners.select),
    sendMessage: vi.fn(async (agentId: string, text: string, _opts?: object) =>
      text === 'fail'
        ? { ok: false as const, error: 'too many messages' }
        : {
            ok: true as const,
            message: {
              id: 'm',
              agentId,
              from: 'user' as const,
              text,
              ts: 1,
              state: 'queued' as const,
            },
          },
    ),
    settings: {
      get: vi.fn(async () => current),
      set: vi.fn(async (p: SettingsPatch) => {
        current = { ...current, ...p }
        return { settings: current, restartRequired: 'port' in p }
      }),
    },
    hook: {
      status: vi.fn(async (): Promise<HookStatus> => hookState),
      install: vi.fn(async (): Promise<HookStatus> => (hookState = 'installed')),
      uninstall: vi.fn(async (): Promise<HookStatus> => (hookState = 'not-installed')),
    },
    context: {
      pick: vi.fn(async (kind: 'files' | 'folder'): Promise<ContextRef[]> =>
        kind === 'folder'
          ? [{ ref: 'ctx_folder000001', kind: 'folder', label: 'auth', hint: '~/code/auth' }]
          : [
              { ref: 'ctx_file00000001', kind: 'file', label: 'README.md', hint: '~/README.md' },
              { ref: 'ctx_file00000002', kind: 'file', label: 'a.ts', hint: '~/a.ts' },
            ],
      ),
    },
    sessions: {
      start: vi.fn(async (_a: NewSessionArgs): Promise<StartResult> => ({
        ok: true,
        agentId: 'cc:new',
      })),
      setMode: vi.fn(async (_id: string, _m: PermissionMode) => {}),
      setModel: vi.fn(async (_id: string, _m: string) => {}),
      models: vi.fn(async (_id?: string): Promise<ModelOption[]> => [
        { id: 'opus', label: 'Opus' },
        { id: 'sonnet', label: 'Sonnet' },
      ]),
      interrupt: vi.fn(async (_id: string) => {}),
      stop: vi.fn(async (_id: string) => {}),
      answer: vi.fn(async (_id: string, _r: string, _d: string) => {}),
    },
    app: {
      version: vi.fn(async () => '1.0.0'),
      onBanner: sub(listeners.banner),
      onOpenSettings: sub(listeners.openSettings),
      copyText: vi.fn(async (_text: string) => {}),
      onOpenConnect: sub(listeners.openConnect),
      onPower: sub(listeners.power),
      power: vi.fn(async () => ({ onBattery: false })),
      onWindowVisibility: sub(listeners.windowVisible),
    },
    connections: {
      info: vi.fn(async () => connInfo({ hook: hookState })),
      onChange: sub(listeners.conn),
      test: vi.fn(async (): Promise<TestEventResult> => ({ ok: true })),
    },
    updates: {
      check: vi.fn(async () => ({ policy: 'auto' as const, status: 'up-to-date' as const })),
      install: vi.fn(async () => {}),
      onState: sub(listeners.update),
    },
  } satisfies AgentOfficeApi
  return { api, listeners }
}

function fakeViews() {
  const handlers: Record<string, (...a: any[]) => void> = {}
  const on = (name: string) => (fn: (...a: any[]) => void) => void (handlers[name] = fn)
  const scene: SceneView & {
    loads: string[]
    wentTo: string[]
    idleMs: number
    fail: Error | null
    buildings: BuildingLayout[]
    directs: { plans: Map<string, AgentPlan>; departed: string[] }[]
    links: Link[][]
    surfaces: SceneSurfaces | null
    focused: CapabilityRef | null
    highlighted: string | null
    selected: string | null
    qualities: GraphicsQuality[]
    themes: ('light' | 'dark')[]
    graphics: Effective[]
    statsNow: GraphicsStats
    statsCalls: number
    last(): Map<string, AgentPlan>
  } = {
    graphics: [],
    statsNow: {
      fps: 60,
      drawCalls: 1,
      triangles: 1,
      textureMB: 100,
      geometryMB: 20,
      width: 800,
      height: 600,
    },
    statsCalls: 0,
    setGraphics(e) {
      this.graphics.push(e)
    },
    stats() {
      this.statsCalls++
      return this.statsNow
    },
    onContextLost: on('contextLost'),
    onContextRestored: on('contextRestored'),
    onHoverSurface: on('hover'),
    onViews: on('views'),
    themes: [],
    setTheme(t) {
      this.themes.push(t)
    },
    loads: [],
    fail: null,
    buildings: [],
    directs: [],
    links: [],
    surfaces: null,
    focused: null,
    highlighted: null,
    selected: null,
    qualities: [],
    async load(url) {
      this.loads.push(url)
      if (this.fail) throw this.fail
      return { manifest: fixtureManifest }
    },
    setBuilding(layout) {
      this.buildings.push(layout)
    },
    direct(plans, departed) {
      this.directs.push({ plans, departed })
    },
    last() {
      return this.directs.at(-1)?.plans ?? new Map()
    },
    setLinks(links) {
      this.links.push(links)
    },
    setSurfaces(s) {
      this.surfaces = s
    },
    onPickCapability: on('pickCapability'),
    focusCapability(ref) {
      this.focused = ref
    },
    highlightLinks(id) {
      this.highlighted = id
    },
    setQuality(q) {
      this.qualities.push(q)
    },
    select(id) {
      this.selected = id
    },
    onPick: on('pick'),
    wentTo: [] as string[],
    idleMs: Infinity,
    goTo(id) {
      this.wentTo.push(id)
    },
    cameraIdleMs() {
      return this.idleMs
    },
  }
  const panel: PanelView & { vm: PanelVM | null; error: string; cleared: number } = {
    vm: null,
    error: '',
    cleared: 0,
    open(vm) {
      this.vm = vm
    },
    render(vm) {
      this.vm = vm
    },
    close() {
      this.vm = null
    },
    showError(m) {
      this.error = m
    },
    clearInput() {
      this.cleared++
    },
    onSend: on('send'),
    onClose: on('close'),
    onSelectParent: on('parent'),
    onInstallHook: on('panelInstall'),
    onOpenConnect: on('panelConnect'),
    onSetMode: on('setMode'),
    onSetModel: on('setModel'),
    onInterrupt: on('interrupt'),
    onStop: on('stop'),
    onAnswer: on('answer'),
    onPickContext: on('pickContext'),
    onRemoveChip: on('removeChip'),
    onOpenUse: on('openUse') as unknown as PanelView['onOpenUse'],
    onToggleUse: on('toggleUse'),
    onDraft: on('draft'),
    onPickCapability: on('chip'),
  }
  const hud: HudView & { vm: HudVM | null; badge: boolean | null } = {
    vm: null,
    badge: null,
    render(vm) {
      this.vm = vm
    },
    onOpenSettings: on('openSettings'),
    onConnect: on('hudConnect'),
    onNewSession: on('newSession'),
    onLibrary: on('library'),
    setConnectBadge(on) {
      this.badge = on
    },
  }
  const newSession: NewSessionView & { vm: NewSessionVM | null; opens: number } = {
    vm: null,
    opens: 0,
    open(vm) {
      this.vm = vm
      this.opens++
    },
    render(vm) {
      if (this.vm) this.vm = vm
    },
    close() {
      this.vm = null
    },
    isOpen() {
      return this.vm !== null
    },
    onPickFolder: on('nsFolder'),
    onAddExtraFolder: on('nsExtra'),
    onRemoveExtraFolder: on('nsRemoveExtra'),
    onPickContext: on('nsPick'),
    onRemoveChip: on('nsRemoveChip'),
    onOpenUse: on('nsOpenUse') as unknown as NewSessionView['onOpenUse'],
    onToggleUse: on('nsToggleUse'),
    onChange: on('nsChange'),
    onStart: on('nsStart'),
    onClose: on('nsClose'),
  }
  const mql = {
    matches: false,
    listeners: [] as ((e: { matches: boolean }) => void)[],
    addEventListener(_t: 'change', fn: (e: { matches: boolean }) => void) {
      this.listeners.push(fn)
    },
    removeEventListener(_t: 'change', fn: (e: { matches: boolean }) => void) {
      this.listeners.splice(this.listeners.indexOf(fn), 1)
    },
    flip(dark: boolean) {
      this.matches = dark
      this.listeners.forEach((fn) => fn({ matches: dark }))
    },
  }
  const settings: SettingsView & { vm: SettingsVM | null; error: string } = {
    vm: null,
    error: '',
    open(vm) {
      this.vm = vm
    },
    render(vm) {
      this.vm = vm
    },
    close() {
      this.vm = null
    },
    isOpen() {
      return this.vm !== null
    },
    showError(m) {
      this.error = m
    },
    onChange: on('settingsChange'),
    onHookAction: on('hookAction'),
    onCheckUpdates: on('check'),
    onInstallUpdate: on('installUpdate'),
    onOpenConnect: on('settingsConnect'),
  }
  const capabilityPanel: CapabilityPanelView & { vm: CapabilityPanelVM | null } = {
    vm: null,
    open(vm) {
      this.vm = vm
    },
    render(vm) {
      this.vm = vm
    },
    close() {
      this.vm = null
    },
    onClose: on('capClose'),
    onSelectAgent: on('capSelectAgent'),
    onToggleLinks: on('capToggleLinks'),
  }
  const banner: BannerView & { shown: Banner | null } = {
    shown: null,
    show(b) {
      this.shown = b
    },
    onAction: on('bannerAction'),
  }
  const connect: ConnectView & {
    vm: ConnectVM | null
    opens: ConnectTab[]
    error: string | null
    flashed: string[]
  } = {
    vm: null,
    opens: [],
    error: null,
    flashed: [],
    open(vm) {
      this.vm = vm
      this.opens.push(vm.tab)
    },
    render(vm) {
      if (this.vm) this.vm = vm
    },
    close() {
      this.vm = null
    },
    isOpen() {
      return this.vm !== null
    },
    onClose: on('connectClose'),
    onTab: on('connectTab'),
    onToggle: on('connectToggle'),
    onHookAction: on('connectHook'),
    onPort: on('connectPort'),
    onSnippetLang: on('connectLang'),
    onCopy: on('connectCopy'),
    onTest: on('connectTest'),
    onGoToWing: on('connectGoTo'),
    showError(m) {
      this.error = m
    },
    flashCopied(t) {
      this.flashed.push(t)
    },
  }
  const empty: EmptyStateView & { vm: EmptyStateVM | null } = {
    vm: null,
    render(vm) {
      this.vm = vm
    },
    onTile: on('tile'),
    onDemo: on('demo'),
    onDismiss: on('dismiss'),
  }
  const toast: ToastView & { shown: { text: string; action?: { label: string; run(): void } }[] } =
    {
      shown: [],
      show(text, action) {
        this.shown.push({ text, ...(action && { action }) })
      },
    }
  const library: LibraryView & { vm: LibraryVM | null; opens: number } = {
    vm: null,
    opens: 0,
    open(vm) {
      this.vm = vm
      this.opens++
    },
    render(vm) {
      if (this.vm) this.vm = vm
    },
    close() {
      this.vm = null
    },
    isOpen() {
      return this.vm !== null
    },
    onClose: on('libClose'),
    onProvider: on('libProvider'),
    onTab: on('libTab'),
    onSearch: on('libSearch'),
    onSort: on('libSort'),
    onPick: on('libPick'),
  }
  const tooltip: TooltipView & { text: string | null; at: [number, number] | null } = {
    text: null,
    at: null,
    show(text, x, y) {
      this.text = text
      this.at = [x, y]
    },
    hide() {
      this.text = null
    },
  }
  const viewBar: ViewBarView & { views: ViewEntry[] | null } = {
    views: null,
    render(views) {
      this.views = views
    },
    onPick: on('viewPick'),
  }
  return {
    library,
    tooltip,
    viewBar,
    scene,
    panel,
    hud,
    settings,
    banner,
    capabilityPanel,
    connect,
    empty,
    toast,
    newSession,
    mql,
    handlers,
  }
}

async function setup(
  initial?: Settings,
  prepare?: (v: ReturnType<typeof fakeViews>, g: ReturnType<typeof fakeGateway>) => void,
  opts: {
    agents?: Agent[]
    isWindows?: boolean
    hardware?: HardwareInfo | null
    dpr?: number
  } = {},
) {
  const g = fakeGateway(initial, opts.agents)
  const v = fakeViews()
  const page = fakePage()
  prepare?.(v, g)
  const timers: { ms: number; fn: () => void }[] = []
  const timeouts: { ms: number; fn: () => void; live: boolean }[] = []
  let now = 0
  const { mql, ...views } = v
  const c = createController({
    gateway: g.api,
    ...views,
    matchMedia: () => mql,
    grouping: byProviderAndTopic,
    clock: { now: () => now },
    every: (ms, fn) => (timers.push({ ms, fn }), () => {}),
    after: (ms, fn) => {
      const t = { ms, fn, live: true }
      timeouts.push(t)
      return () => void (t.live = false)
    },
    ...(opts.isWindows !== undefined && { isWindows: opts.isWindows }),
    doc: page.doc,
    win: page.win,
    ...(opts.hardware !== undefined && { hardware: () => opts.hardware ?? null }),
    ...(opts.dpr !== undefined && { devicePixelRatio: () => opts.dpr! }),
  })
  await c.start()
  /** Fires every timer registered with this interval. */
  const tick = (ms: number) => timers.filter((t) => t.ms === ms).forEach((t) => t.fn())
  /** Fires (once) every pending one-shot timer registered with this delay. */
  const fire = (ms: number) =>
    timeouts
      .filter((t) => t.ms === ms && t.live)
      .forEach((t) => {
        t.live = false
        t.fn()
      })
  /** Pushes a server message (as the main process would). */
  const push = (m: ServerMessage) => g.listeners.message.forEach((fn) => fn(m))
  const flush = () => new Promise((r) => setTimeout(r, 0))
  /** Moves the clock forward in 4 Hz director ticks. */
  const advance = (ms: number) => {
    for (const end = now + ms; now < end;) {
      now = Math.min(end, now + 250)
      tick(250)
    }
  }
  /** Moves the clock without director ticks. */
  const setNow = (ms: number) => void (now = ms)
  return { ...g, ...v, page, c, tick, advance, timers, fire, push, flush, setNow }
}

/** `document` (visibility, focus) and `window` (focus/blur events) stand-ins. */
function fakePage() {
  const fns: Record<string, (() => void)[]> = {}
  const add = (t: string, fn: () => void) => void (fns[t] ??= []).push(fn)
  const remove = (t: string, fn: () => void) => void fns[t]?.splice(fns[t]!.indexOf(fn), 1)
  const emit = (t: string) => fns[t]?.forEach((fn) => fn())
  const doc = {
    hidden: false,
    focused: true,
    hasFocus() {
      return this.focused
    },
    addEventListener: add,
    removeEventListener: remove,
  }
  const win = { addEventListener: add, removeEventListener: remove }
  return {
    doc,
    win,
    fns,
    blur() {
      doc.focused = false
      emit('blur')
    },
    focus() {
      doc.focused = true
      emit('focus')
    },
    hide(hidden: boolean) {
      doc.hidden = hidden
      emit('visibilitychange')
    },
  }
}

describe('controller', () => {
  it('loads the manifest after the snapshot, places the building and spawns present agents', async () => {
    const { scene, hud } = await setup()
    expect(scene.loads).toEqual(['assets/manifest.json'])
    expect(scene.buildings).toHaveLength(1)
    expect(scene.buildings[0]!.wingsByProvider.get('p')).toEqual(['wing:p:0'])
    expect(scene.last().get('a')).toMatchObject({ intent: { spawn: true } })
    expect(hud.vm?.count).toBe('1 agent')
  })

  it('runs the director at 4 Hz and re-sends the building only when it changes', async () => {
    const { scene, timers, advance, listeners } = await setup()
    expect(timers.map((t) => t.ms)).toContain(250)
    const before = scene.directs.length
    advance(1000)
    expect(scene.directs.length).toBe(before + 4)
    expect(scene.buildings).toHaveLength(1)
    // Steps go out only when an intent changes; steady ticks carry plans without steps.
    expect(scene.last().get('a')!.steps).toBeUndefined()

    // A new provider needs a new wing → one more setBuilding.
    listeners.message[0]!({ type: 'upsert', agent: agent('q', { provider: 'q' }) })
    expect(scene.buildings).toHaveLength(2)
    advance(500)
    expect(scene.buildings).toHaveLength(2)
  })

  it('applies pushed messages and directs newcomers right away (they arrive by elevator)', async () => {
    const { listeners, hud, scene, advance } = await setup()
    advance(1000)
    listeners.message[0]!({ type: 'upsert', agent: agent('b') })
    expect(hud.vm?.count).toBe('2 agents')
    expect(scene.last().get('b')).toMatchObject({ intent: { activity: 'arriving' } })
    expect(scene.last().get('b')!.steps![0]!.kind).toBe('teleport')
  })

  it('a burst of messages runs the director at most once per tick (150 busy agents)', async () => {
    const { listeners, scene, hud, advance } = await setup()
    advance(1000)
    const before = scene.directs.length
    for (let i = 0; i < 50; i++) listeners.message[0]!({ type: 'upsert', agent: agent(`n${i}`) })
    // The first message is directed at once; the rest wait for the next 4 Hz tick.
    expect(scene.directs.length).toBe(before + 1)
    expect(hud.vm?.count).toBe('51 agents')
    advance(250)
    expect(scene.directs.length).toBe(before + 2)
    expect(scene.last().size).toBe(51)
  })

  it('forwards links and capability surfaces with every director update', async () => {
    const { listeners, scene, advance } = await setup()
    listeners.message[0]!({
      type: 'capabilities',
      provider: 'p',
      capabilities: [cap('fs', { provider: 'p', label: 'Filesystem', active: ['a'] })],
    })
    advance(250)
    expect(scene.links.length).toBeGreaterThan(0)
    const s = scene.surfaces!.byProvider.get('p')!
    expect(s.stations[0]).toMatchObject({ id: 'fs', glow: 1, vm: { title: 'Filesystem' } })
  })

  it('a clicked station opens the Capability panel; "used by" selects the agent', async () => {
    const { listeners, handlers, capabilityPanel, panel, scene, advance } = await setup()
    listeners.message[0]!({
      type: 'capabilities',
      provider: 'p',
      capabilities: [cap('fs', { provider: 'p', label: 'Filesystem', active: ['a'] })],
    })
    advance(250)
    handlers.pick!('a')
    handlers.pickCapability!({ provider: 'p', id: 'fs' })
    // One side panel at a time: the agent's chat closes.
    expect(panel.vm).toBeNull()
    expect(capabilityPanel.vm).toMatchObject({
      title: 'Filesystem',
      usedBy: [{ id: 'a', name: 'Ada' }],
    })
    // It stays live while open.
    listeners.message[0]!({
      type: 'capabilities',
      provider: 'p',
      capabilities: [cap('fs', { provider: 'p', label: 'Filesystem', calls: 9 })],
    })
    advance(250)
    expect(capabilityPanel.vm?.meta[0]).toEqual(['Calls', '9'])
    handlers.capSelectAgent!('a')
    expect(capabilityPanel.vm).toBeNull()
    expect(panel.vm?.name).toBe('Ada')
    expect(scene.selected).toBe('a')
    // Overflow aggregates and unknown ids open nothing.
    handlers.pickCapability!({ provider: 'p', id: '+more' })
    handlers.pickCapability!({ provider: 'p', id: 'nope' })
    expect(capabilityPanel.vm).toBeNull()
  })

  it('a clicked capability brings the camera to it; "Show links" highlights only its links', async () => {
    const { listeners, handlers, scene, capabilityPanel, advance } = await setup()
    listeners.message[0]!({
      type: 'capabilities',
      provider: 'p',
      capabilities: [cap('fs', { provider: 'p', label: 'Filesystem', active: ['a'] })],
    })
    advance(250)
    handlers.pickCapability!({ provider: 'p', id: 'fs' })
    expect(scene.focused).toEqual({ provider: 'p', id: 'fs' })
    expect(capabilityPanel.vm?.showLinks).toBe(false)
    expect(scene.highlighted).toBeNull()

    handlers.capToggleLinks!(true)
    expect(scene.highlighted).toBe('fs')
    expect(capabilityPanel.vm?.showLinks).toBe(true)
    handlers.capToggleLinks!(false)
    expect(scene.highlighted).toBeNull()

    // Closing the panel (or selecting an agent) clears the highlight and the camera focus.
    handlers.capToggleLinks!(true)
    handlers.capClose!()
    expect(scene.highlighted).toBeNull()
    expect(scene.focused).toBeNull()
  })

  it("the agent panel lists the capabilities it used and says what it's calling", async () => {
    const { listeners, handlers, panel, advance } = await setup()
    listeners.message[0]!({
      type: 'upsert',
      agent: agent('a', { name: 'Ada', status: 'tool', tool: 'search' }),
    })
    const use = (active: string[]) =>
      listeners.message[0]!({
        type: 'capabilities',
        provider: 'p',
        capabilities: [cap('mcp:mail', { provider: 'p', label: 'Mail', active })],
      })
    use(['a'])
    advance(250)
    use([])
    advance(250)
    use(['a'])
    advance(250)
    handlers.pick!('a')
    expect(panel.vm?.used?.adapters).toEqual([
      { id: 'mcp:mail', label: 'Mail', count: 2, color: '#EC4899' },
    ])
    expect(panel.vm?.activity).toMatch(/^Calling Mail/)
  })

  it('walks removed agents out, then reports them departed', async () => {
    const { listeners, scene, advance } = await setup()
    listeners.message[0]!({ type: 'remove', id: 'a' })
    expect(scene.last().get('a')!.intent.activity).toBe('leaving')
    advance(LEAVE_MS)
    expect(scene.directs.flatMap((d) => d.departed)).toEqual(['a'])
    expect(scene.last().has('a')).toBe(false)
  })

  it('selection follows a walking agent: panel stays open and says where it is', async () => {
    const { listeners, handlers, scene, panel, advance } = await setup()
    listeners.message[0]!({ type: 'upsert', agent: agent('n', { name: 'Newton' }) })
    handlers.pick!('n')
    expect(scene.selected).toBe('n')
    expect(panel.vm).toMatchObject({ name: 'Newton', activity: 'Arriving' })
    advance(3000) // still walking from the elevator
    expect(scene.selected).toBe('n')
    expect(panel.vm?.activity).toBe('Arriving')
    advance(20_000) // at the desk now
    expect(scene.selected).toBe('n')
    expect(panel.vm?.activity).toMatch(/^Working at their desk in pod \d$/)
  })

  it('a parent with a subagent takes its team into a meeting room', async () => {
    const { listeners, handlers, panel, scene, advance } = await setup()
    listeners.message[0]!({ type: 'upsert', agent: agent('s', { parentId: 'a', name: 'Sub' }) })
    advance(30_000)
    expect(scene.last().get('a')!.intent.activity).toBe('meeting')
    handlers.pick!('a')
    expect(panel.vm?.activity).toMatch(/^In meeting room [AB] with 1 subagent$/)
    handlers.pick!('s')
    expect(panel.vm?.activity).toMatch(/^In meeting room [AB] with Ada's team$/)
  })

  it('keeps the HUD and panel working when the 3D assets fail to load', async () => {
    const { scene, banner, hud, handlers, panel } = await setup(undefined, (v) => {
      v.scene.fail = new Error('404 assets/manifest.json')
    })
    expect(banner.shown).toEqual({
      kind: 'error',
      text: 'Could not load the 3D office: 404 assets/manifest.json',
    })
    expect(scene.directs).toHaveLength(0)
    expect(hud.vm?.count).toBe('1 agent')
    handlers.pick!('a')
    expect(panel.vm?.name).toBe('Ada')
    expect(panel.vm?.activity).toBeUndefined()
  })

  it('selecting (pick, tray/notification, parent link) opens the panel; empty pick closes it', async () => {
    const { handlers, panel, scene, listeners } = await setup()
    handlers.pick!('a')
    expect(scene.selected).toBe('a')
    expect(panel.vm?.name).toBe('Ada')
    handlers.pick!(null)
    expect(panel.vm).toBeNull()
    listeners.select[0]!('a')
    expect(panel.vm?.id).toBe('a')
    handlers.close!()
    expect(scene.selected).toBeNull()
    handlers.parent!('a')
    expect(panel.vm?.id).toBe('a')
    handlers.pick!('unknown')
    expect(panel.vm).toBeNull()
  })

  it('sends messages for the selected agent and surfaces errors', async () => {
    const { handlers, panel, api } = await setup()
    handlers.pick!('a')
    await handlers.send!('hello')
    expect(api.sendMessage).toHaveBeenCalledWith('a', 'hello')
    expect(panel.cleared).toBe(1)
    await handlers.send!('fail')
    expect(panel.error).toBe('too many messages')
  })

  it('installs the hook from the panel hint', async () => {
    const { handlers, api } = await setup()
    await handlers.panelInstall!()
    expect(api.hook.install).toHaveBeenCalled()
  })

  it('refreshes "last seen" on ticks while the panel is open', async () => {
    const { handlers, panel, tick } = await setup()
    handlers.pick!('a')
    panel.vm = null
    tick(1000)
    expect(panel.vm).not.toBeNull()
  })

  it('shows banners from the main process', async () => {
    const { listeners, banner } = await setup()
    listeners.banner[0]!({ kind: 'error', text: 'Port busy' })
    expect(banner.shown?.text).toBe('Port busy')
  })

  it('settings: opens from HUD or tray, saves changes, flags restarts, runs hook and update actions', async () => {
    const { handlers, settings, listeners, api } = await setup()
    await handlers.openSettings!()
    expect(settings.vm).toMatchObject({ version: 'v1.0.0', hook: { action: 'install' } })
    settings.close()
    await listeners.openSettings[0]!()
    expect(settings.isOpen()).toBe(true)

    await handlers.settingsChange!({ notifications: false })
    expect(settings.vm?.notifications).toBe(false)
    await handlers.settingsChange!({ port: 5000 })
    expect(api.settings.set).toHaveBeenLastCalledWith({ port: 5000 })

    api.settings.set.mockRejectedValueOnce(new Error('invalid settings: port'))
    await handlers.settingsChange!({ port: 1 })
    expect(settings.error).toBe('invalid settings: port')

    await handlers.hookAction!('install')
    expect(api.hook.install).toHaveBeenCalled()
    await handlers.hookAction!('uninstall')
    expect(api.hook.uninstall).toHaveBeenCalled()

    await handlers.check!()
    expect(settings.vm?.update.label).toBe('Up to date')
    listeners.update[0]!({ policy: 'auto', status: 'ready', version: '2.0.0' })
    await new Promise((r) => setTimeout(r, 0)) // update pushes re-render asynchronously
    expect(settings.vm?.update.action).toBe('install')
    await handlers.installUpdate!()
    expect(api.updates.install).toHaveBeenCalled()
  })

  it('C-1: pushes the effective graphics to the scene on start, then on every settings change', async () => {
    const { scene, handlers } = await setup({ ...DEFAULT_SETTINGS, graphicsQuality: 'medium' })
    expect(scene.graphics.map((e) => e.preset)).toEqual(['medium'])
    // The old preset-only path is no longer used.
    expect(scene.qualities).toEqual([])

    // Changing the preset in Settings applies it live (no restart).
    await handlers.settingsChange!({ graphicsQuality: 'low' })
    expect(scene.graphics.at(-1)).toMatchObject({ preset: 'low', fpsLimit: 60, links: 'static' })

    // An advanced override applies on top of the preset.
    await handlers.settingsChange!({
      graphicsAdvanced: { ...DEFAULT_SETTINGS.graphicsAdvanced, fps: '30' },
    })
    expect(scene.graphics.at(-1)).toMatchObject({ preset: 'low', fpsLimit: 30 })

    // Unrelated changes and re-opening the dialog do not re-apply the same graphics.
    const n = scene.graphics.length
    await handlers.settingsChange!({ notifications: false })
    await handlers.openSettings!()
    expect(scene.graphics).toHaveLength(n)
  })

  it('falls back to auto quality when settings cannot be read at start', async () => {
    const g = fakeGateway()
    g.api.settings.get.mockRejectedValueOnce(new Error('ipc down'))
    const v = fakeViews()
    const { mql: _mql, ...views } = v
    const c = createController({
      gateway: g.api,
      ...views,
      grouping: byProviderAndTopic,
      clock: { now: () => 0 },
      every: () => () => {},
      after: () => () => {},
    })
    await c.start()
    // Auto without a known tier: High, as before.
    expect(v.scene.graphics.map((e) => e.preset)).toEqual(['high'])
    expect(v.scene.buildings).toHaveLength(1)
  })

  it('Auto starts at the detected tier and the governor steps it from scene stats', async () => {
    const hardware: HardwareInfo = {
      renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)',
      vendor: 'Google Inc.',
      maxTextureSize: 16384,
      dpr: 2,
      cores: 8,
      webgl2: true,
    }
    const t = await setup(undefined, undefined, { hardware })
    expect(t.scene.graphics.at(-1)).toMatchObject({ preset: 'low', pixelRatioCap: 1 })
    // 10 s above 58 fps (Low's 60 cap is not a "low cap"): steps up to the Medium ceiling.
    t.scene.statsNow = { ...t.scene.statsNow, fps: 60 }
    for (let i = 0; i < 20; i++) t.tick(GFX_POLL_MS)
    expect(t.scene.graphics.at(-1)!.preset).toBe('medium')
    for (let i = 0; i < 40; i++) t.tick(GFX_POLL_MS)
    expect(t.scene.graphics.at(-1)!.preset).toBe('medium')
    // Settings shows what Auto picked and why.
    await t.handlers.openSettings!()
    expect(t.settings.vm?.graphics.autoNote).toBe('Auto picked: Medium (integrated GPU)')
  })

  it('a manual preset ignores the governor and the stats are not polled while Settings is closed', async () => {
    const t = await setup({ ...DEFAULT_SETTINGS, graphicsQuality: 'high' })
    t.scene.statsNow = { ...t.scene.statsNow, fps: 10 }
    for (let i = 0; i < 20; i++) t.tick(GFX_POLL_MS)
    expect(t.scene.graphics.map((e) => e.preset)).toEqual(['high'])
    expect(t.scene.statsCalls).toBe(0)
  })

  it('J11: Settings → Graphics shows a live stats line at 2 Hz while open', async () => {
    const t = await setup({ ...DEFAULT_SETTINGS, graphicsQuality: 'low' })
    await t.handlers.openSettings!()
    expect(t.settings.vm?.graphics.now).toBe('60 fps · Low · GPU memory ≈ 120 MB · 800×600')
    t.scene.statsNow = { ...t.scene.statsNow, fps: 41.6 }
    t.tick(GFX_POLL_MS)
    expect(t.settings.vm?.graphics.now).toMatch(/^42 fps · Low/)
    // Closed: no more sampling.
    t.settings.close()
    const calls = t.scene.statsCalls
    t.tick(GFX_POLL_MS)
    expect(t.scene.statsCalls).toBe(calls)
  })

  it('C-2: a power push re-computes (battery preset while unplugged, with "(battery)")', async () => {
    const t = await setup({ ...DEFAULT_SETTINGS, graphicsQuality: 'high', batteryPreset: 'low' })
    expect(t.api.app.power).toHaveBeenCalled()
    expect(t.scene.graphics.at(-1)!.preset).toBe('high')
    await t.handlers.openSettings!()
    t.listeners.power.forEach((fn) => fn({ onBattery: true }))
    expect(t.scene.graphics.at(-1)!.preset).toBe('low')
    expect(t.settings.vm?.graphics.now).toContain('Low (battery)')
    t.listeners.power.forEach((fn) => fn({ onBattery: false }))
    expect(t.scene.graphics.at(-1)!.preset).toBe('high')
  })

  it('reads the initial power state (already on battery at start)', async () => {
    const t = await setup({ ...DEFAULT_SETTINGS, batteryPreset: 'minimal' }, (_v, g) => {
      g.api.app.power.mockResolvedValue({ onBattery: true })
    })
    await t.flush()
    expect(t.scene.graphics.at(-1)!.preset).toBe('minimal')
  })

  // Page visibility isn't reliable (Playwright pins it; some window managers don't report it), so
  // main also says when the window is hidden or minimized.
  it('pauses while main reports the window hidden or minimized, even if the page says visible', async () => {
    const t = await setup({ ...DEFAULT_SETTINGS, graphicsQuality: 'high' })
    expect(t.scene.graphics.at(-1)!.fpsLimit).toBeNull()
    t.listeners.windowVisible.forEach((fn) => fn(false))
    expect(t.scene.graphics.at(-1)!.fpsLimit).toBe(0)
    t.listeners.windowVisible.forEach((fn) => fn(true))
    expect(t.scene.graphics.at(-1)!.fpsLimit).toBeNull()
  })

  it('C-3: focus and visibility re-compute: 15 fps unfocused, paused while hidden', async () => {
    const t = await setup({ ...DEFAULT_SETTINGS, graphicsQuality: 'high' })
    expect(t.scene.graphics.at(-1)!.fpsLimit).toBeNull()
    t.page.blur()
    expect(t.scene.graphics.at(-1)!.fpsLimit).toBe(15)
    t.page.hide(true)
    expect(t.scene.graphics.at(-1)!.fpsLimit).toBe(0)
    // Paused: the governor gets no samples.
    t.page.hide(false)
    t.page.focus()
    expect(t.scene.graphics.at(-1)!.fpsLimit).toBeNull()
    // Saver off: no change when unfocused.
    await t.handlers.settingsChange!({ powerSaverBlur: false })
    t.page.blur()
    expect(t.scene.graphics.at(-1)!.fpsLimit).toBeNull()
    // stop() removes the listeners.
    t.c.stop()
    expect(Object.values(t.page.fns).every((l) => l.length === 0)).toBe(true)
  })

  it('starts hidden or unfocused when the page already is', async () => {
    const t = await setup(undefined, undefined, { dpr: 3 })
    expect(t.scene.graphics.at(-1)!.pixelRatioCap).toBe(2)
    const g = fakeGateway()
    const v = fakeViews()
    const page = fakePage()
    page.doc.hidden = true
    const { mql: _mql, ...views } = v
    await createController({
      gateway: g.api,
      ...views,
      grouping: byProviderAndTopic,
      clock: { now: () => 0 },
      every: () => () => {},
      after: () => () => {},
      doc: page.doc,
      win: page.win,
    }).start()
    expect(v.scene.graphics.at(-1)!.fpsLimit).toBe(0)
  })

  it('C-4: context loss shows a banner, restore re-applies; 3 losses in 5 min offer Minimal', async () => {
    const t = await setup({ ...DEFAULT_SETTINGS, graphicsQuality: 'high' })
    const n = t.scene.graphics.length
    t.handlers.contextLost!()
    expect(t.banner.shown).toEqual({ kind: 'info', text: GFX_COPY.recovering })
    t.handlers.contextRestored!()
    expect(t.banner.shown).toBeNull()
    expect(t.scene.graphics).toHaveLength(n + 1)
    t.setNow(60_000)
    t.handlers.contextLost!()
    t.handlers.contextRestored!()
    expect(t.toast.shown).toEqual([])
    t.setNow(120_000)
    t.handlers.contextLost!()
    const prompt = t.toast.shown.at(-1)!
    expect(prompt.text).toBe(GFX_COPY.keepFailing)
    expect(prompt.action?.label).toBe(GFX_COPY.switchMinimal)
    prompt.action!.run()
    await t.flush()
    expect(t.api.settings.set).toHaveBeenCalledWith({ graphicsQuality: 'minimal' })
    expect(t.scene.graphics.at(-1)!.preset).toBe('minimal')
    // Losses older than 5 minutes don't count.
    t.setNow(120_000 + LOSS_WINDOW_MS + 1)
    t.handlers.contextLost!()
    expect(t.toast.shown).toHaveLength(1)
    // A restore doesn't clear someone else's banner.
    t.handlers.contextRestored!()
    t.banner.show({ kind: 'error', text: 'Port busy' })
    t.handlers.contextRestored!()
    expect(t.banner.shown?.text).toBe('Port busy')
  })

  it('stop unsubscribes from the gateway', async () => {
    const { c, listeners } = await setup()
    c.stop()
    expect(listeners.message).toHaveLength(0)
  })
})

describe('controller: connecting agents (Connect panel, empty state, first arrival)', () => {
  /** An empty office: nothing in the snapshot. */
  const empty = (prepare?: Parameters<typeof setup>[1], opts: { isWindows?: boolean } = {}) =>
    setup(undefined, prepare, { agents: [], ...opts })

  it('shows the empty card after the grace period (or the first push), with the 🔌 badge', async () => {
    const t = await empty()
    expect(t.api.connections.info).toHaveBeenCalled()
    // No flash during the grace period while the tailer reads existing sessions.
    expect(t.empty.vm).toBeNull()
    expect(t.hud.badge).toBe(true)
    t.fire(EMPTY_GRACE_MS)
    expect(t.empty.vm?.tiles.map((x) => x.id)).toEqual(['claude', 'http', 'demo'])

    // A push before the grace ends shows it too.
    const u = await empty()
    u.listeners.conn[0]!(connInfo({ hook: 'installed' }))
    expect(u.empty.vm).not.toBeNull()
  })

  it('hides the card on the first agent and never brings it back (HUD link instead)', async () => {
    const t = await empty()
    t.fire(EMPTY_GRACE_MS)
    t.push({ type: 'upsert', agent: agent('x', { provider: 'langgraph', source: 'http' }) })
    expect(t.empty.vm).toBeNull()
    expect(t.hud.badge).toBe(false)
    expect(t.hud.vm?.hint.action).toBeUndefined()
    t.push({ type: 'remove', id: 'x' })
    expect(t.empty.vm).toBeNull()
    expect(t.hud.vm?.hint).toEqual({ text: 'No agents right now ·', action: 'connect' })
  })

  it('✕ dismisses the card; the badge stays until an agent is seen', async () => {
    const t = await empty()
    t.fire(EMPTY_GRACE_MS)
    t.handlers.dismiss!()
    expect(t.empty.vm).toBeNull()
    expect(t.hud.badge).toBe(true)
    expect(t.hud.vm?.hint.action).toBe('connect')
  })

  it('every entry point opens the right tab', async () => {
    const t = await empty()
    const last = () => t.connect.opens.at(-1)
    await t.handlers.hudConnect!()
    expect(last()).toBe('claude') // nothing seen yet
    for (const tile of ['claude', 'http', 'demo'] as const) {
      await t.handlers.tile!(tile)
      expect(last()).toBe(tile)
    }
    await t.handlers.bannerAction!('open-connect')
    expect(last()).toBe('http')
    await t.handlers.panelConnect!()
    expect(last()).toBe('http')
    t.settings.open({} as SettingsVM)
    await t.handlers.settingsConnect!()
    expect(last()).toBe('claude')
    expect(t.settings.isOpen()).toBe(false)
    // Tray → main → app:open-connect; once something was seen, it opens on Connected.
    t.push({ type: 'upsert', agent: agent('x') })
    await t.listeners.openConnect[0]!()
    expect(last()).toBe('connected')
    expect(t.connect.vm?.connected.rows).toHaveLength(1)
  })

  it('tabs and snippet languages re-render; Windows adds the PowerShell note', async () => {
    const t = await empty(undefined, { isWindows: true })
    await t.handlers.hudConnect!()
    t.handlers.connectTab!('http')
    expect(t.connect.vm?.tab).toBe('http')
    expect(t.connect.vm?.http.snippetNote).toMatch(/PowerShell/)
    t.handlers.connectLang!('js')
    expect(t.connect.vm?.http.lang).toBe('js')
    expect(t.connect.vm?.http.snippet).toContain('homedir()')
  })

  it('a connection push re-renders an open panel', async () => {
    const t = await empty()
    await t.handlers.tile!('http')
    t.listeners.conn[0]!(
      connInfo({ api: { ...connInfo().api, listening: false, portBusy: true, port: 4317 } }),
    )
    expect(t.connect.vm?.http.pill.text).toBe('✗ Port 4317 busy')
  })

  it('copy goes through the main process clipboard, then flashes "Copied"', async () => {
    const t = await empty()
    await t.handlers.tile!('http')
    await t.handlers.connectCopy!('http://127.0.0.1:4317/api/events', 'endpoint')
    expect(t.api.app.copyText).toHaveBeenCalledWith('http://127.0.0.1:4317/api/events')
    expect(t.connect.flashed).toEqual(['endpoint'])
    t.api.app.copyText.mockRejectedValueOnce(new Error('invalid text'))
    await t.handlers.connectCopy!('x', 'snippet')
    expect(t.connect.error).toBe('invalid text')
  })

  it('"Send a test agent" shows the result; it never toasts or counts as a provider', async () => {
    const t = await empty()
    await t.handlers.tile!('http')
    await t.handlers.connectTest!()
    expect(t.connect.vm?.http.live.text).toBe('✓ Test agent received')
    t.api.connections.test.mockResolvedValueOnce({ ok: false, error: 'API not listening' })
    await t.handlers.connectTest!()
    expect(t.connect.vm?.http.live.text).toBe('✗ Test failed: API not listening')
    t.api.connections.test.mockRejectedValueOnce(new Error('ipc down'))
    await t.handlers.connectTest!()
    expect(t.connect.vm?.http.live.text).toBe('✗ Test failed: ipc down')

    t.fire(EMPTY_GRACE_MS)
    t.push({
      type: 'upsert',
      agent: agent(TEST_AGENT_ID, { provider: TEST_AGENT_ID, source: 'http' }),
    })
    expect(t.empty.vm).toBeNull() // it does count as "seen" for the card
    expect(t.toast.shown).toEqual([])
    expect(t.scene.wentTo).toEqual([])
  })

  it('the live line follows the newest HTTP provider', async () => {
    const t = await empty()
    await t.handlers.tile!('http')
    expect(t.connect.vm?.http.live.text).toBe('◌ Waiting for the first event…')
    t.push({ type: 'upsert', agent: agent('x', { provider: 'langgraph', source: 'http' }) })
    expect(t.connect.vm?.http.live.text).toBe('✓ Received from langgraph · 0s ago')
    t.push({ type: 'remove', id: 'x' })
    expect(t.connect.vm?.http.live.text).toMatch(/Received from langgraph/)
  })

  it('Try the demo: turns mock on, says "Starting demo…" until a demo agent arrives', async () => {
    const t = await empty()
    t.fire(EMPTY_GRACE_MS)
    await t.handlers.demo!()
    expect(t.api.settings.set).toHaveBeenCalledWith({ mock: true })
    expect(t.empty.vm?.tiles[2]).toMatchObject({ button: 'Starting demo…', busy: true })
    t.push({ type: 'upsert', agent: agent('m', { source: 'mock', provider: 'langgraph' }) })
    t.fire(DEMO_START_TIMEOUT_MS)
    t.push({ type: 'remove', id: 'm' })
    expect(t.connect.error).toBeNull()
  })

  it('the demo gives up after 8 s and says so', async () => {
    const t = await empty()
    t.fire(EMPTY_GRACE_MS)
    await t.handlers.tile!('demo')
    await t.handlers.connectToggle!('mock', true)
    expect(t.api.settings.set).toHaveBeenCalledWith({ mock: true })
    t.fire(DEMO_START_TIMEOUT_MS)
    expect(t.empty.vm?.tiles[2]!.pill.text).toBe("Demo didn't start: check the logs.")
    expect(t.connect.error).toBe("Demo didn't start: check the logs.")
  })

  it('toggles, hook actions and the port refresh the connection info; errors show inline', async () => {
    const t = await empty()
    await t.handlers.tile!('claude')
    const calls = () => t.api.connections.info.mock.calls.length
    const before = calls()
    await t.handlers.connectToggle!('claudeAdapter', false)
    expect(t.api.settings.set).toHaveBeenLastCalledWith({ claudeAdapter: false })
    await t.handlers.connectToggle!('mock', false)
    expect(t.api.settings.set).toHaveBeenLastCalledWith({ mock: false })
    t.api.connections.info.mockResolvedValueOnce(connInfo({ hook: 'installed' }))
    await t.handlers.connectHook!('install')
    expect(t.api.hook.install).toHaveBeenCalled()
    expect(t.connect.vm?.claude.hook.button).toBe('Uninstall')
    await t.handlers.connectHook!('uninstall')
    expect(t.api.hook.uninstall).toHaveBeenCalled()
    await t.handlers.connectPort!(4320)
    expect(t.api.settings.set).toHaveBeenLastCalledWith({ port: 4320 })
    expect(calls()).toBeGreaterThanOrEqual(before + 5)

    t.api.settings.set.mockRejectedValueOnce(new Error('invalid settings: port'))
    await t.handlers.connectPort!(1)
    expect(t.connect.error).toBe('invalid settings: port')
    t.handlers.connectClose!()
    expect(t.connect.error).toBeNull()
  })

  it('first arrival of a provider: a toast, and the camera flies to its wing', async () => {
    const t = await empty()
    t.fire(EMPTY_GRACE_MS)
    t.push({ type: 'upsert', agent: agent('x', { provider: 'langgraph', source: 'http' }) })
    t.advance(250)
    expect(t.toast.shown.map((s) => s.text)).toEqual(['langgraph connected'])
    expect(t.scene.wentTo).toEqual(['wing:langgraph:0'])

    // Later providers fly only if the user left the camera alone for 10 s.
    t.scene.idleMs = 2_000
    t.push({ type: 'upsert', agent: agent('y', { provider: 'crewai', source: 'http' }) })
    t.advance(250)
    expect(t.toast.shown).toHaveLength(2)
    expect(t.scene.wentTo).toEqual(['wing:langgraph:0'])
    t.scene.idleMs = 11_000
    t.push({ type: 'upsert', agent: agent('z', { provider: 'autogen', source: 'http' }) })
    t.advance(250)
    expect(t.scene.wentTo).toEqual(['wing:langgraph:0', 'wing:autogen:0'])

    // A second agent of a known provider is not news.
    t.push({ type: 'upsert', agent: agent('x2', { provider: 'langgraph', source: 'http' }) })
    expect(t.toast.shown).toHaveLength(3)
  })

  // Managed sessions get messages directly from agent-office; the hook doesn't matter for them.
  it('a managed Claude Code session arriving first: no "install the hook" hint', async () => {
    const t = await empty()
    t.fire(EMPTY_GRACE_MS)
    t.push({
      type: 'upsert',
      agent: agent('cc:m', {
        provider: 'claude-code',
        source: 'managed',
        managed: { chrome: false, pending: 0, phase: 'running' },
      }),
    })
    t.advance(250)
    expect(t.toast.shown.map((s) => s.text)).toEqual(['claude-code connected'])
    expect(t.toast.shown[0]?.action).toBeUndefined()
  })

  // The session's first update can carry source 'managed' before the `managed` field is set.
  it('a managed session known only by its source: no "install the hook" hint either', async () => {
    const t = await empty()
    t.fire(EMPTY_GRACE_MS)
    t.push({ type: 'upsert', agent: agent('cc:m', { provider: 'claude-code', source: 'managed' }) })
    t.advance(250)
    expect(t.toast.shown.map((s) => s.text)).toEqual(['claude-code connected'])
  })

  it('Claude Code without the hook: the toast offers Connect', async () => {
    const t = await empty()
    t.fire(EMPTY_GRACE_MS)
    t.push({
      type: 'upsert',
      agent: agent('c', { provider: 'claude-code', source: 'claude-code' }),
    })
    const shown = t.toast.shown[0]!
    expect(shown.text).toBe('claude-code connected · install the hook to chat →')
    shown.action!.run()
    await t.flush()
    expect(t.connect.opens.at(-1)).toBe('claude')
  })

  it('agents already there at start (or during the grace) are not announced', async () => {
    const t = await setup()
    t.push({ type: 'upsert', agent: agent('b', { provider: 'q' }) })
    expect(t.toast.shown).toEqual([])
    expect(t.hud.badge).toBe(false)
  })

  it('Go to wing closes the panel and moves the camera', async () => {
    const t = await setup()
    await t.handlers.hudConnect!()
    expect(t.connect.opens).toEqual(['connected'])
    t.handlers.connectGoTo!('p')
    expect(t.connect.isOpen()).toBe(false)
    expect(t.scene.wentTo.at(-1)).toBe('wing:p:0')
  })

  it('keeps working when connection info is unavailable (older main process)', async () => {
    const t = await empty((_v, g) => {
      g.api.connections.info.mockRejectedValue(new Error('no handler'))
    })
    t.fire(EMPTY_GRACE_MS)
    expect(t.empty.vm).toBeNull()
    await t.handlers.hudConnect!()
    expect(t.connect.isOpen()).toBe(false)
    expect(t.banner.shown).toBeNull()
  })
})

describe('controller: hook status in the agent panel (the reported bug)', () => {
  const claude = (over: Partial<Agent> = {}) =>
    agent('cc:1', { provider: 'claude-code', interactive: false, status: 'idle', ...over })

  it('uses the installed hook from the connection info, not "not installed"', async () => {
    const t = await setup(
      undefined,
      (_v, g) => {
        g.api.connections.info.mockResolvedValue(connInfo({ hook: 'installed' }))
      },
      { agents: [claude()] },
    )
    t.handlers.pick!('cc:1')
    expect(t.panel.vm?.hint).toEqual({ text: SESSION_COPY.hint.waitingCheckIn })
  })

  it('re-renders the open panel after install from the hint and on connection pushes', async () => {
    const t = await setup(undefined, undefined, { agents: [claude()] })
    t.handlers.pick!('cc:1')
    expect(t.panel.vm?.hint?.action).toBe('install-hook')
    await t.handlers.panelInstall!()
    expect(t.panel.vm?.hint?.text).toBe(SESSION_COPY.hint.waitingCheckIn)
    t.listeners.conn[0]!(connInfo({ hook: 'outdated' }))
    expect(t.panel.vm?.hint?.label).toBe(SESSION_COPY.hint.repair)
    await t.handlers.hookAction!('uninstall')
    expect(t.panel.vm?.hint?.text).toBe(SESSION_COPY.hint.notInstalled)
    await t.handlers.connectHook!('install')
    expect(t.panel.vm?.hint?.text).toBe(SESSION_COPY.hint.waitingCheckIn)
  })

  it('C-sub: a subagent points at its parent, its composer is disabled; Open parent selects it', async () => {
    const t = await setup(undefined, undefined, {
      agents: [claude(), claude({ id: 'cc:sub', parentId: 'cc:1' })],
    })
    t.handlers.pick!('cc:sub')
    expect(t.panel.vm?.hint?.action).toBe('open-parent')
    expect(t.panel.vm?.composer).toMatchObject({
      disabled: true,
      placeholder: SESSION_COPY.composer.subagent,
    })
    t.handlers.parent!('cc:1')
    expect(t.panel.vm?.id).toBe('cc:1')
  })
})

describe('controller: composer (context, Use…, drafts)', () => {
  const ada = agent('a', { name: 'Ada', status: 'idle', provider: 'claude-code' })
  const bob = agent('b', { provider: 'claude-code' })

  it('C-pick: picking adds chips; removing drops one; send passes refs and tools, then clears', async () => {
    const t = await setup(undefined, undefined, { agents: [ada] })
    t.handlers.pick!('a')
    await t.handlers.pickContext!('folder')
    await t.handlers.pickContext!('files')
    await t.handlers.pickContext!('folder') // same ref again: no duplicate
    expect(t.panel.vm?.composer.chips.map((c) => c.label)).toEqual(['auth', 'README.md', 'a.ts'])
    t.handlers.removeChip!('ctx_file00000002')
    t.handlers.toggleUse!('mcp:claude-in-chrome')
    expect(t.panel.vm?.composer.chips.map((c) => c.key)).toEqual([
      'ctx_folder000001',
      'ctx_file00000001',
      'mcp:claude-in-chrome',
    ])
    await t.handlers.send!('review these')
    expect(t.api.sendMessage).toHaveBeenLastCalledWith('a', 'review these', {
      context: ['ctx_folder000001', 'ctx_file00000001'],
      use: ['mcp:claude-in-chrome'],
    })
    expect(t.panel.cleared).toBe(1)
    expect(t.panel.vm?.composer.chips).toEqual([])
    // Without chips the call stays the old two-argument shape.
    await t.handlers.send!('plain')
    expect(t.api.sendMessage).toHaveBeenLastCalledWith('a', 'plain')
  })

  it('a failed send keeps the draft; a picker error shows inline', async () => {
    const t = await setup(undefined, undefined, { agents: [ada] })
    t.handlers.pick!('a')
    await t.handlers.pickContext!('folder')
    await t.handlers.send!('fail')
    expect(t.panel.error).toBe('too many messages')
    expect(t.panel.vm?.composer.chips).toHaveLength(1)
    t.api.context.pick.mockRejectedValueOnce(new Error('dialog failed'))
    await t.handlers.pickContext!('files')
    expect(t.panel.error).toBe('dialog failed')
    t.api.context.pick.mockResolvedValueOnce(
      Array.from({ length: 12 }, (_, i) => ({
        ref: `ctx_many${String(i).padStart(8, '0')}`,
        kind: 'file' as const,
        label: `f${i}`,
        hint: `~/f${i}`,
      })),
    )
    await t.handlers.pickContext!('files')
    expect(t.panel.vm?.composer.chips).toHaveLength(10)
    expect(t.panel.error).toBe(SESSION_COPY.composer.maxContext)
  })

  it('the Use… menu lists the provider capabilities; a 6th tool is refused', async () => {
    const t = await setup(undefined, undefined, { agents: [ada] })
    t.push({ type: 'capabilities', provider: 'claude-code', capabilities: [cap('mcp:github')] })
    t.handlers.pick!('a')
    const menu = t.handlers.openUse!() as unknown as UseMenuVM
    expect(menu.groups.map((g) => g.id)).toEqual(['browser', 'mcp', 'builtin'])
    for (const id of ['shell', 'web', 'subagents', 'mcp:github', 'mcp:claude-in-chrome'])
      t.handlers.toggleUse!(id)
    t.handlers.toggleUse!('mcp:other')
    expect(t.panel.error).toBe(SESSION_COPY.composer.maxUse)
    expect((t.handlers.openUse!() as unknown as UseMenuVM).groups[0]!.entries[0]!.selected).toBe(
      true,
    )
    t.handlers.toggleUse!('shell')
    t.handlers.removeChip!('web')
    expect(t.panel.vm?.composer.chips.map((c) => c.key)).toEqual([
      'subagents',
      'mcp:github',
      'mcp:claude-in-chrome',
    ])
  })

  it('drafts are kept per agent while switching', async () => {
    const t = await setup(undefined, undefined, { agents: [ada, bob] })
    t.handlers.pick!('a')
    t.handlers.draft!('half a thought')
    await t.handlers.pickContext!('folder')
    t.handlers.pick!('b')
    expect(t.panel.vm).toMatchObject({ draftText: '', composer: { chips: [] } })
    t.handlers.pick!('a')
    expect(t.panel.vm?.draftText).toBe('half a thought')
    expect(t.panel.vm?.composer.chips).toHaveLength(1)
  })

  it('composer handlers do nothing without a selection', async () => {
    const t = await setup()
    await t.handlers.pickContext!('folder')
    t.handlers.toggleUse!('shell')
    t.handlers.removeChip!('shell')
    t.handlers.draft!('x')
    expect((t.handlers.openUse!() as unknown as UseMenuVM).groups).toEqual([])
    await t.handlers.setMode!('plan')
    await t.handlers.interrupt!()
    expect(t.api.context.pick).not.toHaveBeenCalled()
    expect(t.api.sessions.setMode).not.toHaveBeenCalled()
  })
})

describe('controller: managed sessions', () => {
  const managed = agent('cc:m', {
    provider: 'claude-code',
    status: 'thinking',
    permissionMode: 'plan',
    managed: { chrome: false, pending: 0, phase: 'running', modelId: 'sonnet' },
  })

  it('loads the session models once; pills show them', async () => {
    const t = await setup(undefined, undefined, { agents: [managed] })
    t.handlers.pick!('cc:m')
    await t.flush()
    expect(t.api.sessions.models).toHaveBeenCalledWith('cc:m')
    expect(t.panel.vm?.session).toMatchObject({
      managed: true,
      mode: { text: '◐ Plan' },
      model: { text: '✦ Sonnet' },
    })
    t.handlers.pick!(null)
    t.handlers.pick!('cc:m')
    await t.flush()
    expect(t.api.sessions.models).toHaveBeenCalledTimes(1)
  })

  // A new session's first upsert can arrive before `managed` is set; the model list must still load.
  it('loads the models once the selected agent becomes managed', async () => {
    const plain = agent('cc:m', { provider: 'claude-code', status: 'thinking' })
    const t = await setup(undefined, undefined, { agents: [plain] })
    t.handlers.pick!('cc:m')
    await t.flush()
    expect(t.api.sessions.models).not.toHaveBeenCalled()
    t.push({ type: 'upsert', agent: managed })
    await t.flush()
    expect(t.api.sessions.models).toHaveBeenCalledWith('cc:m')
  })

  it('falls back to the alias models when the session cannot list them', async () => {
    const t = await setup(
      undefined,
      (_v, g) => g.api.sessions.models.mockRejectedValue(new Error('nope')),
      { agents: [managed] },
    )
    t.handlers.pick!('cc:m')
    await t.flush()
    expect(t.panel.vm?.session?.models.map((m) => m.id)).toEqual(['opus', 'sonnet', 'haiku'])
  })

  it('C-mode: mode and model changes go to the gateway; errors show in the panel', async () => {
    const t = await setup(undefined, undefined, { agents: [managed] })
    t.handlers.pick!('cc:m')
    await t.handlers.setMode!('acceptEdits')
    expect(t.api.sessions.setMode).toHaveBeenCalledWith('cc:m', 'acceptEdits')
    await t.handlers.setModel!('opus')
    expect(t.api.sessions.setModel).toHaveBeenCalledWith('cc:m', 'opus')
    t.api.sessions.setModel.mockRejectedValueOnce(new Error('unknown model'))
    await t.handlers.setModel!('nope')
    expect(t.panel.error).toBe('unknown model')
  })

  it('bypass shows up in the mode menu only when allowed in Settings', async () => {
    const t = await setup(undefined, undefined, { agents: [managed] })
    t.handlers.pick!('cc:m')
    expect(t.panel.vm?.session?.modes.map((m) => m.id)).not.toContain('bypassPermissions')
    await t.handlers.settingsChange!({ allowBypassPermissions: true })
    expect(t.panel.vm?.session?.modes.map((m) => m.id)).toContain('bypassPermissions')
  })

  it('C-answer: interrupt, stop and permission answers go to the gateway', async () => {
    const t = await setup(undefined, undefined, { agents: [managed] })
    t.handlers.pick!('cc:m')
    t.push({
      type: 'permission',
      agentId: 'cc:m',
      requests: [{ id: 'perm_0123456789', tool: 'Bash', summary: 'pnpm test' }],
    })
    expect(t.panel.vm?.permission?.request.summary).toBe('pnpm test')
    await t.handlers.answer!('perm_0123456789', 'allow')
    expect(t.api.sessions.answer).toHaveBeenCalledWith('cc:m', 'perm_0123456789', 'allow')
    await t.handlers.interrupt!()
    expect(t.api.sessions.interrupt).toHaveBeenCalledWith('cc:m')
    await t.handlers.stop!()
    expect(t.api.sessions.stop).toHaveBeenCalledWith('cc:m')
    t.api.sessions.stop.mockRejectedValueOnce(new Error('already gone'))
    await t.handlers.stop!()
    expect(t.panel.error).toBe('already gone')
  })
})

describe('controller: theme', () => {
  it('C-theme: applies the OS scheme at start, then follows matchMedia changes', async () => {
    const t = await setup()
    expect(t.scene.themes).toEqual(['light'])
    // Settings → Dark: main flips nativeTheme, Chromium fires the media query change.
    await t.handlers.settingsChange!({ theme: 'dark' })
    t.mql.flip(true)
    expect(t.scene.themes).toEqual(['light', 'dark'])
    t.c.stop()
    t.mql.flip(false)
    expect(t.scene.themes).toEqual(['light', 'dark'])
  })
})

describe('controller: new session dialog', () => {
  it('C-new: opens from the HUD with the fallback models; Start stays disabled until ready', async () => {
    const t = await setup()
    await t.handlers.newSession!()
    expect(t.newSession.vm).toMatchObject({ canStart: false, name: '' })
    expect(t.api.sessions.models).toHaveBeenCalledWith()
    expect(t.newSession.vm?.models.map((m) => m.id)).toEqual(['', 'opus', 'sonnet'])
    await t.handlers.nsFolder!()
    expect(t.api.context.pick).toHaveBeenCalledWith('folder')
    expect(t.newSession.vm?.folder).toEqual({ label: 'auth', hint: '~/code/auth' })
    t.handlers.nsChange!({ text: 'Plan the logout flow', mode: 'plan', model: 'sonnet' })
    expect(t.newSession.vm?.canStart).toBe(true)
  })

  it('C-new: start success closes the dialog and selects the new agent when it arrives', async () => {
    const t = await setup()
    await t.handlers.newSession!()
    await t.handlers.nsFolder!()
    await t.handlers.nsExtra!()
    t.handlers.nsChange!({ text: 'Plan it', name: 'shop', chrome: true })
    await t.handlers.nsPick!('files')
    t.handlers.nsToggleUse!('mcp:claude-in-chrome')
    await t.handlers.nsStart!()
    expect(t.api.sessions.start).toHaveBeenCalledWith({
      folder: 'ctx_folder000001',
      name: 'shop',
      mode: 'default',
      extraFolders: ['ctx_folder000001'],
      chrome: true,
      text: 'Plan it',
      context: ['ctx_file00000001', 'ctx_file00000002'],
      use: ['mcp:claude-in-chrome'],
    })
    expect(t.newSession.isOpen()).toBe(false)
    t.push({ type: 'upsert', agent: agent('cc:new', { provider: 'claude-code' }) })
    expect(t.panel.vm?.id).toBe('cc:new')
  })

  it('C-new: an error shows inline and keeps the dialog open; the folder is remembered', async () => {
    const t = await setup()
    t.api.sessions.start.mockResolvedValueOnce({ ok: false, code: 'auth', error: 'login' })
    await t.handlers.newSession!()
    await t.handlers.nsFolder!()
    t.handlers.nsChange!({ text: 'go' })
    await t.handlers.nsStart!()
    expect(t.newSession.vm).toMatchObject({
      error: SESSION_COPY.newSession.errors.auth,
      starting: false,
    })
    t.api.sessions.start.mockRejectedValueOnce(new Error('ipc down'))
    await t.handlers.nsStart!()
    expect(t.newSession.vm?.error).toBe("Couldn't start: ipc down")
    t.handlers.nsClose!()
    await t.handlers.newSession!()
    expect(t.newSession.vm?.folder?.label).toBe('auth')
    expect(t.newSession.vm?.error).toBeUndefined()
  })

  it('chips and extra folders can be removed; the menu is the claude-code one', async () => {
    const t = await setup()
    await t.handlers.newSession!()
    await t.handlers.nsExtra!()
    t.handlers.nsRemoveExtra!('ctx_folder000001')
    expect(t.newSession.vm?.extraFolders).toEqual([])
    await t.handlers.nsPick!('folder')
    t.handlers.nsToggleUse!('shell')
    t.handlers.nsRemoveChip!('ctx_folder000001')
    t.handlers.nsRemoveChip!('shell')
    expect(t.newSession.vm?.composer.chips).toEqual([])
    const menu = t.handlers.nsOpenUse!() as unknown as UseMenuVM
    expect(menu.groups[0]!.id).toBe('browser')
    // Start without a folder does nothing.
    await t.handlers.nsStart!()
    expect(t.api.sessions.start).not.toHaveBeenCalled()
  })

  it('shows the limit with 6 sessions running', async () => {
    const agents = Array.from({ length: 6 }, (_, i) =>
      agent(`cc:${i}`, {
        provider: 'claude-code',
        managed: { chrome: false, pending: 0, phase: 'running' },
      }),
    )
    const t = await setup(undefined, undefined, { agents })
    await t.handlers.newSession!()
    expect(t.newSession.vm?.limit).toBe('Stop a session first (6 running)')
  })
})

describe('controller: Library browser, views and hover (Part B)', () => {
  const skills = (provider: string, n: number) =>
    Array.from({ length: n }, (_, i) =>
      cap(`skill:s${String(i).padStart(2, '0')}`, { provider, scope: 'plugin' }),
    )
  async function withLibrary() {
    const t = await setup(undefined, undefined, {
      agents: [agent('a', { name: 'Ada', provider: 'langgraph' })],
    })
    t.push({
      type: 'capabilities',
      provider: 'claude-code',
      capabilities: [...skills('claude-code', 30), cap('rule:project:CLAUDE.md')],
    })
    t.push({
      type: 'capabilities',
      provider: 'langgraph',
      capabilities: [cap('skill:plan', { provider: 'langgraph', active: ['a'] })],
    })
    t.advance(250)
    return t
  }

  it('C-lib-1: 📚 opens the drawer on the default provider; tabs, search, sort and provider re-render', async () => {
    const t = await withLibrary()
    t.handlers.library!()
    expect(t.library.vm).toMatchObject({
      provider: 'claude-code',
      providers: ['claude-code', 'langgraph'],
      tab: 'skills',
      sort: 'recent',
    })
    expect(t.library.vm!.overflowLabel).toBe('Not on a shelf (7)')
    t.handlers.libTab!('rules')
    expect(t.library.vm!.rows.map((r) => r.label)).toEqual(['CLAUDE.md'])
    t.handlers.libTab!('skills')
    t.handlers.libSearch!('s2')
    expect(t.library.vm!.rows.map((r) => r.label)).toEqual(['s20', 's21', 's22'])
    t.handlers.libSort!('az')
    expect(t.library.vm!.sort).toBe('az')
    t.handlers.libProvider!('langgraph')
    t.handlers.libSearch!('')
    expect(t.library.vm!.rows.map((r) => r.label)).toEqual(['plan'])
    // Live while open: the director tick re-renders.
    t.push({
      type: 'capabilities',
      provider: 'langgraph',
      capabilities: [cap('skill:plan', { provider: 'langgraph' })],
    })
    t.advance(250)
    expect(t.library.vm!.rows[0]!.inUse).toBe(false)
    // Re-opening starts on the selected agent's provider.
    t.handlers.libClose!()
    t.library.close()
    t.handlers.pick!('a')
    t.handlers.library!()
    expect(t.library.vm!.provider).toBe('langgraph')
  })

  it('C-lib-2: picking a row flies the camera to it and opens the Capability panel; the drawer stays', async () => {
    const t = await withLibrary()
    t.handlers.library!()
    t.handlers.libPick!({ provider: 'claude-code', id: 'skill:s01' })
    expect(t.scene.focused).toEqual({ provider: 'claude-code', id: 'skill:s01' })
    expect(t.capabilityPanel.vm?.title).toBe('s01')
    expect(t.capabilityPanel.vm?.meta.some(([, v]) => v === LIB_COPY.notOnShelf)).toBe(false)
    expect(t.library.isOpen()).toBe(true)
    // Unknown ids do nothing.
    t.handlers.libPick!({ provider: 'claude-code', id: 'nope' })
    expect(t.capabilityPanel.vm?.title).toBe('s01')
  })

  it('C-lib-3: an overflow row opens the panel with "Not on a shelf", without moving the camera', async () => {
    const t = await withLibrary()
    t.handlers.library!()
    const overflow = t.library.vm!.overflow[0]!.ref
    t.handlers.libPick!(overflow)
    expect(t.scene.focused).toBeNull()
    expect(t.capabilityPanel.vm?.title).toBe(overflow.id.replace('skill:', ''))
    expect(t.capabilityPanel.vm?.meta).toContainEqual(['Where', LIB_COPY.notOnShelf])
    // Stays on re-render.
    t.advance(250)
    expect(t.capabilityPanel.vm?.meta).toContainEqual(['Where', LIB_COPY.notOnShelf])
  })

  it('C-lib-4: a "+N more" pick in the scene opens the drawer on that tab’s overflow group', async () => {
    const t = await withLibrary()
    t.handlers.pickCapability!({ provider: 'claude-code', id: '+more' })
    expect(t.library.vm).toMatchObject({
      provider: 'claude-code',
      tab: 'skills',
      focus: 'overflow',
    })
    expect(t.capabilityPanel.vm).toBeNull()
    t.handlers.pickCapability!({ provider: 'claude-code', id: '+more:rules' })
    expect(t.library.vm).toMatchObject({ tab: 'rules', focus: 'overflow' })
    // Switching tabs drops the focus.
    t.handlers.libTab!('memory')
    expect(t.library.vm!.focus).toBeUndefined()
  })

  it('C-chip: an agent panel chip opens the capability like a drawer pick (provider filled in)', async () => {
    const t = await withLibrary()
    t.handlers.pick!('a')
    t.handlers.chip!({ provider: '', id: 'skill:plan' })
    expect(t.scene.focused).toEqual({ provider: 'langgraph', id: 'skill:plan' })
    expect(t.capabilityPanel.vm?.title).toBe('plan')
    t.handlers.chip!({ provider: 'claude-code', id: 'skill:s00' })
    expect(t.capabilityPanel.vm?.title).toBe('s00')
    // No provider and no selection: ignored.
    t.handlers.chip!({ provider: '', id: 'skill:s01' })
    expect(t.capabilityPanel.vm?.title).toBe('s00')
  })

  it('views: the scene’s views go to the view bar; a pick moves the camera', async () => {
    const t = await setup()
    const views = [{ id: 'atrium', label: 'Atrium' }]
    t.handlers.views!(views)
    expect(t.viewBar.views).toEqual(views)
    t.handlers.viewPick!('library:p:0')
    expect(t.scene.wentTo).toContain('library:p:0')
  })

  it('TT: hovering a surface shows its tooltip near the cursor; leaving hides it', async () => {
    const t = await withLibrary()
    t.handlers.hover!({ provider: 'claude-code', id: 'rule:project:CLAUDE.md' }, 10, 20)
    expect(t.tooltip.text).toBe('📜 CLAUDE.md · rule (project) · click to open')
    expect(t.tooltip.at).toEqual([10, 20])
    t.handlers.hover!({ provider: 'claude-code', id: '+more' }, 5, 5)
    expect(t.tooltip.text).toBe('📚 +7 more · Not on a shelf (overflow) · click to open')
    t.handlers.hover!({ provider: 'claude-code', id: 'gone' }, 5, 5)
    expect(t.tooltip.text).toBeNull()
    t.handlers.hover!({ provider: 'claude-code', id: 'skill:s00' }, 1, 1)
    t.handlers.hover!(null, 0, 0)
    expect(t.tooltip.text).toBeNull()
  })
})

// ── Optional 2D RPG mode (plan §2.5, §8, §9): C-mode-*. The deps are optional; without them the
// controller behaves exactly as above (the existing cases run without them).
import type { DialogueView, ModeToggleView, PixelHudView } from './ports.ts'
import type {
  DialogueAction,
  DialogueVM,
  DirectoryVM,
  InteractTarget,
  MinimapVM,
  PixelHudVM,
} from './app/pixel/types.ts'
import type { ViewMode } from '@agent-office/shared'
import { PIXEL_COPY } from './app/pixel-copy.ts'

function fakePixel(handlers: Record<string, (...a: any[]) => void> = {}) {
  const on = (name: string) => (fn: (...a: any[]) => void) => void (handlers[name] = fn)
  const dialogue: DialogueView & { vm: DialogueVM | null; opens: DialogueVM[] } = {
    vm: null,
    opens: [],
    open(vm) {
      this.vm = vm
      this.opens.push(vm)
    },
    render(vm) {
      this.vm = vm
    },
    close() {
      this.vm = null
    },
    isOpen() {
      return this.vm !== null
    },
    onAction: on('action'),
    onClose: on('dialogueClose'),
  }
  const pixelHud: PixelHudView & {
    shown: boolean[]
    vm: PixelHudVM | null
    minimap: MinimapVM | null
    directory: DirectoryVM | null
  } = {
    shown: [],
    vm: null,
    minimap: null,
    directory: null,
    show(on) {
      this.shown.push(on)
    },
    render(vm) {
      this.vm = vm
    },
    renderMinimap(vm) {
      this.minimap = vm
    },
    renderDirectory(vm) {
      this.directory = vm
    },
    onAlert: on('alert'),
    onMinimapPick: on('minimapPick'),
    onDirectory: on('directory'),
    onDirectorySearch: on('directorySearch'),
  }
  const modeToggle: ModeToggleView & { modes: ViewMode[] } = {
    modes: [],
    render(m) {
      this.modes.push(m)
    },
    onChange: on('modeChange'),
  }
  const viewModes: ViewMode[] = []
  return { dialogue, pixelHud, modeToggle, viewModes, handlers }
}

/** The 2D scene's optional methods on the fake scene. */
function pixelScene(v: ReturnType<typeof fakeViews>) {
  const s = v.scene as typeof v.scene & {
    suspended: boolean[]
    followed: (string | null)[]
    travels: { agentId?: string; viewId?: string }[]
  }
  s.suspended = []
  s.followed = []
  s.travels = []
  s.onInteract = (fn) => void (v.handlers.interact = fn)
  s.onRoom = (fn) => void (v.handlers.room = fn)
  s.onPlayerMove = (fn) => void ((v.handlers as Record<string, unknown>).playerMove = fn)
  s.setInputSuspended = (on) => void s.suspended.push(on)
  s.follow = (id) => void s.followed.push(id)
  s.travelTo = (t) => void s.travels.push(t)
  return s
}

async function setupPixel(
  initial: Settings = DEFAULT_SETTINGS,
  agents: Agent[] = [agent('a', { name: 'Ada', status: 'idle' })],
) {
  const g = fakeGateway(initial, agents)
  const v = fakeViews()
  const scene = pixelScene(v)
  const px = fakePixel(v.handlers)
  const timers: { ms: number; fn: () => void }[] = []
  let now = 0
  const { mql, handlers: _h, ...views } = v
  const c = createController({
    gateway: g.api,
    ...views,
    matchMedia: () => mql,
    grouping: byProviderAndTopic,
    clock: { now: () => now },
    every: (ms, fn) => (timers.push({ ms, fn }), () => {}),
    after: () => () => {},
    dialogue: px.dialogue,
    pixelHud: px.pixelHud,
    modeToggle: px.modeToggle,
    onViewMode: (m) => void px.viewModes.push(m),
  })
  await c.start()
  const tick = (ms: number) => timers.filter((t) => t.ms === ms).forEach((t) => t.fn())
  const push = (m: ServerMessage) => g.listeners.message.forEach((fn) => fn(m))
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const advance = (ms: number) => {
    for (const end = now + ms; now < end;) {
      now = Math.min(end, now + 250)
      tick(250)
    }
  }
  const act = (a: DialogueAction) => px.handlers.action!(a)
  const interact = (t: InteractTarget) => v.handlers.interact!(t)
  return { ...g, ...v, ...px, scene, c, tick, push, flush, advance, act, interact, timers }
}

describe('controller: 2D RPG mode (C-mode)', () => {
  // C-mode-1: the toggle shows the mode; a viewMode settings change switches the scene host.
  it('renders the mode and calls onViewMode when viewMode changes', async () => {
    const t = await setupPixel()
    expect(t.modeToggle.modes.at(-1)).toBe('3d')
    expect(t.pixelHud.shown.at(-1)).toBe(false)
    expect(t.viewModes).toEqual([])
    // The toggle writes the setting; the settings round trip switches the mode.
    t.handlers.modeChange!('pixel')
    await t.flush()
    await t.flush()
    expect(t.api.settings.set).toHaveBeenCalledWith({ viewMode: 'pixel' })
    expect(t.viewModes).toEqual(['pixel'])
    expect(t.modeToggle.modes.at(-1)).toBe('pixel')
    expect(t.pixelHud.shown.at(-1)).toBe(true)
    // The same mode again doesn't switch twice.
    t.handlers.settingsChange!({ viewMode: 'pixel' })
    await t.flush()
    await t.flush()
    expect(t.viewModes).toEqual(['pixel'])
    t.handlers.settingsChange!({ viewMode: '3d' })
    await t.flush()
    await t.flush()
    expect(t.viewModes).toEqual(['pixel', '3d'])
    expect(t.pixelHud.minimap).toBeNull()
  })

  it('starts in 2D without switching (main already built the 2D scene)', async () => {
    const t = await setupPixel({ ...DEFAULT_SETTINGS, viewMode: 'pixel' })
    expect(t.viewModes).toEqual([])
    expect(t.pixelHud.shown).toEqual([true])
    expect(t.modeToggle.modes).toEqual(['pixel'])
  })

  // C-mode-2: E on an agent opens the dialogue; Talk opens the existing panel on it.
  it('opens the dialogue on interact and Talk selects the agent', async () => {
    const t = await setupPixel()
    t.interact({ kind: 'agent', id: 'a' })
    expect(t.dialogue.vm?.title).toBe('Ada')
    expect(t.dialogue.vm?.actions.map((a) => a.id)).toEqual(['talk', 'details', 'follow'])
    expect(t.scene.suspended.at(-1)).toBe(true)
    t.act('talk')
    expect(t.dialogue.vm).toBeNull()
    expect(t.panel.vm?.id).toBe('a')
    expect(t.scene.selected).toBe('a')
    // Still suspended while the panel is open; closing it gives control back.
    expect(t.scene.suspended.at(-1)).toBe(true)
    t.handlers.close!()
    expect(t.scene.suspended.at(-1)).toBe(false)
    // Unknown agents open nothing.
    t.interact({ kind: 'agent', id: 'nobody' })
    expect(t.dialogue.vm).toBeNull()
  })

  // C-mode-3: Review and Details go to the same panel; Follow follows; Esc gives input back.
  it('routes Review, Details and Follow', async () => {
    const t = await setupPixel(DEFAULT_SETTINGS, [
      agent('a', {
        name: 'Ada',
        status: 'waiting',
        managed: { chrome: false, pending: 1, phase: 'running' },
      }),
    ])
    t.push({
      type: 'permission',
      agentId: 'a',
      requests: [{ id: 'perm_1', tool: 'Bash', summary: 'ls' }],
    })
    t.interact({ kind: 'agent', id: 'a' })
    expect(t.dialogue.vm?.actions.map((a) => a.id)).toEqual(['review', 'details', 'follow'])
    t.act('review')
    expect(t.panel.vm?.id).toBe('a')
    expect(t.panel.vm?.permission).toBeTruthy()
    t.handlers.close!()
    t.interact({ kind: 'agent', id: 'a' })
    t.act('details')
    expect(t.panel.vm?.id).toBe('a')
    t.handlers.close!()
    t.interact({ kind: 'agent', id: 'a' })
    t.act('follow')
    expect(t.scene.followed).toEqual(['a'])
    expect(t.toast.shown.at(-1)!.text).toBe(PIXEL_COPY.following('Ada'))
    t.interact({ kind: 'agent', id: 'a' })
    t.handlers.dialogueClose!()
    expect(t.scene.suspended.at(-1)).toBe(false)
  })

  it('opens capabilities, the Library and the parent from the dialogue', async () => {
    const t = await setupPixel(DEFAULT_SETTINGS, [
      agent('a', { name: 'Ada', status: 'idle', provider: 'claude-code' }),
      agent('s', { name: 'Sub', status: 'thinking', provider: 'claude-code', parentId: 'a' }),
    ])
    t.push({
      type: 'capabilities',
      provider: 'claude-code',
      capabilities: [cap('fs'), cap('skill:pdf')],
    })
    t.interact({ kind: 'capability', ref: { provider: 'claude-code', id: 'fs' } })
    t.act('open')
    expect(t.capabilityPanel.vm).not.toBeNull()
    t.interact({ kind: 'capability', ref: { provider: 'claude-code', id: 'skill:pdf' } })
    t.act('open-library')
    expect(t.library.vm?.provider).toBe('claude-code')
    expect(t.library.vm?.tab).toBe('skills')
    t.interact({ kind: 'agent', id: 's' })
    expect(t.dialogue.vm?.actions.map((a) => a.id)).toContain('go-parent')
    t.act('go-parent')
    expect(t.scene.travels).toEqual([{ agentId: 'a' }])
    expect(t.dialogue.vm?.title).toBe('Ada')
    // Objects: the stats board.
    t.interact({ kind: 'object', object: 'stats-board' })
    expect(t.dialogue.vm?.title).toBe(PIXEL_COPY.dialogue.statsBoard)
  })

  // HUD, minimap and directory refresh at 2 Hz while 2D is active.
  // The minimap marks where the player stands (the scene reports it in world metres).
  it('shows the player on the minimap', async () => {
    const t = await setupPixel({ ...DEFAULT_SETTINGS, viewMode: 'pixel' })
    const move = (t.handlers as Record<string, unknown>).playerMove as (p: {
      x: number
      z: number
    }) => void
    move({ x: 0, z: 0 })
    t.tick(500)
    expect(t.pixelHud.minimap?.player).toBeDefined()
  })

  it('renders the HUD, minimap and directory at 2 Hz in 2D', async () => {
    const t = await setupPixel({ ...DEFAULT_SETTINGS, viewMode: 'pixel' }, [
      agent('a', { name: 'Ada', status: 'waiting' }),
      agent('b', { name: 'Bo', status: 'error' }),
    ])
    t.handlers.room!('p · Pod 2')
    t.tick(500)
    expect(t.pixelHud.vm?.room).toBe('p · Pod 2')
    expect(t.pixelHud.vm?.counts).toEqual({ agents: 2, waiting: 1, errors: 1 })
    expect(t.pixelHud.vm?.alerts.map((a) => a.agentId)).toEqual(['a', 'b'])
    expect(t.pixelHud.minimap?.dots.map((d) => d.id)).toEqual(['a', 'b'])
    expect(t.pixelHud.directory?.wings[0]?.viewId).toBe('wing:p:0')
    t.handlers.directorySearch!('bo')
    expect(t.pixelHud.directory?.wings[0]?.topics[0]?.agents.map((a) => a.id)).toEqual(['b'])
    // Alert → the panel on that agent.
    t.handlers.alert!('a', false)
    expect(t.panel.vm?.id).toBe('a')
    // Directory: pan (select / goTo) or fast-travel.
    t.handlers.directory!({ viewId: 'wing:p:0', travel: false })
    expect(t.scene.wentTo.at(-1)).toBe('wing:p:0')
    t.handlers.directory!({ agentId: 'b', travel: true })
    expect(t.scene.travels.at(-1)).toEqual({ agentId: 'b' })
    t.handlers.directory!({ agentId: 'b', travel: false })
    expect(t.panel.vm?.id).toBe('b')
    // Minimap click → the view of the module under it.
    const m = t.pixelHud.minimap!
    t.handlers.minimapPick!(Math.floor(m.widthTiles / 2), 2)
    expect(t.scene.wentTo.at(-1)).toBe('atrium')
  })

  it('stays quiet in 3D and closes a dialogue whose agent left', async () => {
    const quiet = await setupPixel()
    quiet.tick(500)
    expect(quiet.pixelHud.vm).toBeNull()
    const t = await setupPixel({ ...DEFAULT_SETTINGS, viewMode: 'pixel' })
    t.interact({ kind: 'agent', id: 'a' })
    t.push({ type: 'remove', id: 'a' })
    t.advance(30_000)
    t.tick(500)
    expect(t.dialogue.vm).toBeNull()
    expect(t.toast.shown.some((x) => x.text === PIXEL_COPY.dialogue.left('Ada'))).toBe(true)
  })

  // Resync for a new scene (plan §2.3): the plans with their remaining steps.
  it('exposes resync() for the scene host', async () => {
    const t = await setupPixel()
    const plans = t.c.resync()
    expect(plans.get('a')?.steps?.length).toBeGreaterThan(0)
  })

  it('without the 2D deps, never touches the optional scene methods', async () => {
    const s = await setup(undefined, (v) => {
      pixelScene(v)
    })
    const scene = s.scene as typeof s.scene & { suspended: boolean[] }
    s.c.select('a')
    s.handlers.close!()
    expect(scene.suspended).toEqual([])
    expect(s.handlers.interact).toBeUndefined()
    expect(s.c.resync().size).toBe(1)
  })
})
