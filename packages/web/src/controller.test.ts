import {
  DEFAULT_SETTINGS,
  type AgentOfficeApi,
  type Banner,
  type ConnectionInfo,
  type GraphicsQuality,
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
import {
  DEMO_START_TIMEOUT_MS,
  EMPTY_GRACE_MS,
  TEST_AGENT_ID,
  type ConnectTab,
  type ConnectVM,
  type EmptyStateVM,
} from './app/connect-types.ts'
import { createController } from './controller.ts'
import { cap } from './app/__fixtures__/capabilities.ts'
import type { CapabilityPanelVM } from './app/capability-vm.ts'
import type {
  BannerView,
  CapabilityPanelView,
  ConnectView,
  EmptyStateView,
  HudView,
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
  const listeners = {
    message: [] as ((m: ServerMessage) => void)[],
    select: [] as ((id: string) => void)[],
    banner: [] as ((b: Banner | null) => void)[],
    openSettings: [] as (() => void)[],
    update: [] as ((s: UpdateState) => void)[],
    conn: [] as ((i: ConnectionInfo) => void)[],
    openConnect: [] as (() => void)[],
  }
  const sub =
    <T>(list: T[]) =>
    (fn: T) => (list.push(fn), () => list.splice(list.indexOf(fn), 1))
  const api = {
    ready: vi.fn(async () => ({ agents: snapshotAgents, messages: [] })),
    onMessage: sub(listeners.message),
    onSelect: sub(listeners.select),
    sendMessage: vi.fn(async (agentId: string, text: string) =>
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
      status: vi.fn(async () => 'not-installed' as const),
      install: vi.fn(async () => 'installed' as const),
      uninstall: vi.fn(async () => 'not-installed' as const),
    },
    app: {
      version: vi.fn(async () => '1.0.0'),
      onBanner: sub(listeners.banner),
      onOpenSettings: sub(listeners.openSettings),
      copyText: vi.fn(async (_text: string) => {}),
      onOpenConnect: sub(listeners.openConnect),
    },
    connections: {
      info: vi.fn(async () => connInfo()),
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
    last(): Map<string, AgentPlan>
  } = {
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
  }
  const hud: HudView & { vm: HudVM | null; badge: boolean | null } = {
    vm: null,
    badge: null,
    render(vm) {
      this.vm = vm
    },
    onOpenSettings: on('openSettings'),
    onConnect: on('hudConnect'),
    setConnectBadge(on) {
      this.badge = on
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
  return { scene, panel, hud, settings, banner, capabilityPanel, connect, empty, toast, handlers }
}

async function setup(
  initial?: Settings,
  prepare?: (v: ReturnType<typeof fakeViews>, g: ReturnType<typeof fakeGateway>) => void,
  opts: { agents?: Agent[]; isWindows?: boolean } = {},
) {
  const g = fakeGateway(initial, opts.agents)
  const v = fakeViews()
  prepare?.(v, g)
  const timers: { ms: number; fn: () => void }[] = []
  const timeouts: { ms: number; fn: () => void; live: boolean }[] = []
  let now = 0
  const c = createController({
    gateway: g.api,
    ...v,
    grouping: byProviderAndTopic,
    clock: { now: () => now },
    every: (ms, fn) => (timers.push({ ms, fn }), () => {}),
    after: (ms, fn) => {
      const t = { ms, fn, live: true }
      timeouts.push(t)
      return () => void (t.live = false)
    },
    ...(opts.isWindows !== undefined && { isWindows: opts.isWindows }),
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
  return { ...g, ...v, c, tick, advance, timers, fire, push, flush }
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

  it('forwards the saved graphics quality to the scene on start, then on every change', async () => {
    const { scene, handlers } = await setup({ ...DEFAULT_SETTINGS, graphicsQuality: 'medium' })
    expect(scene.qualities).toEqual(['medium'])

    // Changing the preset in Settings applies it live (no restart).
    await handlers.settingsChange!({ graphicsQuality: 'low' })
    expect(scene.qualities).toEqual(['medium', 'low'])

    // Unrelated changes and re-opening the dialog do not re-apply the same preset.
    await handlers.settingsChange!({ notifications: false })
    await handlers.openSettings!()
    expect(scene.qualities).toEqual(['medium', 'low'])
  })

  it('falls back to auto quality when settings cannot be read at start', async () => {
    const g = fakeGateway()
    g.api.settings.get.mockRejectedValueOnce(new Error('ipc down'))
    const v = fakeViews()
    const c = createController({
      gateway: g.api,
      ...v,
      grouping: byProviderAndTopic,
      clock: { now: () => 0 },
      every: () => () => {},
      after: () => () => {},
    })
    await c.start()
    expect(v.scene.qualities).toEqual(['auto'])
    expect(v.scene.buildings).toHaveLength(1)
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
