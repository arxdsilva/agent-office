import {
  DEFAULT_SETTINGS,
  type AgentOfficeApi,
  type Banner,
  type GraphicsQuality,
  type ServerMessage,
  type Settings,
  type SettingsPatch,
  type UpdateState,
} from '@agent-office/shared'
import { byProviderAndTopic, type Agent } from '@agent-office/shared'
import { describe, expect, it, vi } from 'vitest'
import { fixtureManifest } from './app/__fixtures__/manifest.ts'
import { LEAVE_MS } from './app/behavior.ts'
import type { AgentPlan, BuildingLayout } from './app/office-types.ts'
import type { HudVM, PanelVM, SettingsVM } from './app/view-models.ts'
import { createController } from './controller.ts'
import type { BannerView, HudView, PanelView, SceneView, SettingsView } from './ports.ts'

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

function fakeGateway(initial: Settings = DEFAULT_SETTINGS) {
  let current = initial
  const listeners = {
    message: [] as ((m: ServerMessage) => void)[],
    select: [] as ((id: string) => void)[],
    banner: [] as ((b: Banner | null) => void)[],
    openSettings: [] as (() => void)[],
    update: [] as ((s: UpdateState) => void)[],
  }
  const sub =
    <T>(list: T[]) =>
    (fn: T) => (list.push(fn), () => list.splice(list.indexOf(fn), 1))
  const api = {
    ready: vi.fn(async () => ({
      agents: [
        {
          id: 'a',
          name: 'Ada',
          provider: 'p',
          topic: 't',
          status: 'idle' as const,
          source: 's',
          since: 0,
          lastSeen: 0,
          interactive: true,
          unread: 0,
        },
      ],
      messages: [],
    })),
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
    fail: Error | null
    buildings: BuildingLayout[]
    directs: { plans: Map<string, AgentPlan>; departed: string[] }[]
    selected: string | null
    qualities: GraphicsQuality[]
    last(): Map<string, AgentPlan>
  } = {
    loads: [],
    fail: null,
    buildings: [],
    directs: [],
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
    setQuality(q) {
      this.qualities.push(q)
    },
    select(id) {
      this.selected = id
    },
    onPick: on('pick'),
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
  }
  const hud: HudView & { vm: HudVM | null } = {
    vm: null,
    render(vm) {
      this.vm = vm
    },
    onOpenSettings: on('openSettings'),
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
  }
  const banner: BannerView & { shown: Banner | null } = {
    shown: null,
    show(b) {
      this.shown = b
    },
  }
  return { scene, panel, hud, settings, banner, handlers }
}

async function setup(initial?: Settings, prepare?: (v: ReturnType<typeof fakeViews>) => void) {
  const g = fakeGateway(initial)
  const v = fakeViews()
  prepare?.(v)
  const timers: { ms: number; fn: () => void }[] = []
  let now = 0
  const c = createController({
    gateway: g.api,
    ...v,
    grouping: byProviderAndTopic,
    clock: { now: () => now },
    every: (ms, fn) => (timers.push({ ms, fn }), () => {}),
  })
  await c.start()
  /** Fires every timer registered with this interval. */
  const tick = (ms: number) => timers.filter((t) => t.ms === ms).forEach((t) => t.fn())
  /** Moves the clock forward in 4 Hz director ticks. */
  const advance = (ms: number) => {
    for (const end = now + ms; now < end;) {
      now = Math.min(end, now + 250)
      tick(250)
    }
  }
  return { ...g, ...v, c, tick, advance, timers }
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
    const { listeners, hud, scene } = await setup()
    listeners.message[0]!({ type: 'upsert', agent: agent('b') })
    expect(hud.vm?.count).toBe('2 agents')
    expect(scene.last().get('b')).toMatchObject({ intent: { activity: 'arriving' } })
    expect(scene.last().get('b')!.steps![0]!.kind).toBe('teleport')
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
