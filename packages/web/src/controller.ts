import {
  DEFAULT_SETTINGS,
  type GraphicsQuality,
  type Grouping,
  type HookStatus,
  type Settings,
  type SettingsPatch,
  type UpdateState,
} from '@agent-office/shared'
import { layoutOffice, type LayoutState } from './app/layout.ts'
import { applyMessage, emptyState, type OfficeState } from './app/state.ts'
import { hudVM, panelVM, settingsVM } from './app/view-models.ts'
import type {
  BannerView,
  HudView,
  OfficeGateway,
  PanelView,
  SceneView,
  SettingsView,
} from './ports.ts'

export interface ControllerDeps {
  gateway: OfficeGateway
  scene: SceneView
  panel: PanelView
  hud: HudView
  settings: SettingsView
  banner: BannerView
  grouping: Grouping
  clock: { now(): number }
  every: (ms: number, fn: () => void) => () => void
}

/** Renderer use cases: state → layout → views, and user intents → gateway calls. */
export function createController(d: ControllerDeps) {
  let state: OfficeState = emptyState()
  let layoutState: LayoutState = new Map()
  let selected: string | null = null
  let update: UpdateState = { policy: 'off', status: 'idle' }
  let hook: HookStatus = 'not-installed'
  let restartNote = false
  let quality: GraphicsQuality | null = null
  const stops: (() => void)[] = []

  /** The scene applies presets live; forward only actual changes. */
  const applyQuality = (q: GraphicsQuality) => {
    if (q === quality) return
    quality = q
    d.scene.setQuality(q)
  }

  const render = () => {
    const agents = [...state.agents.values()]
    const layout = layoutOffice(agents, d.grouping, layoutState)
    layoutState = layout.state
    d.scene.sync(agents, layout)
    d.hud.render(hudVM(state))
    if (selected) d.panel.render(panelVM(state, selected, d.clock.now()))
  }

  const select = (id: string | null) => {
    selected = id && state.agents.has(id) ? id : null
    d.scene.select(selected)
    if (selected) d.panel.open(panelVM(state, selected, d.clock.now()))
    else d.panel.close()
  }

  const renderSettings = async (open: boolean, known?: Settings) => {
    const [settings, version] = await Promise.all([
      known ?? d.gateway.settings.get(),
      d.gateway.app.version(),
    ])
    applyQuality(settings.graphicsQuality)
    hook = await d.gateway.hook.status()
    const vm = settingsVM({ settings, hook, version, update, restartNote })
    if (open) d.settings.open(vm)
    else if (d.settings.isOpen()) d.settings.render(vm)
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
  d.panel.onClose(() => select(null))
  d.panel.onSelectParent(select)
  d.panel.onSend(async (text) => {
    if (!selected) return
    const r = await d.gateway.sendMessage(selected, text)
    if (r.ok) d.panel.clearInput()
    else d.panel.showError(r.error)
  })
  d.panel.onInstallHook(async () => {
    hook = await d.gateway.hook.install()
    await renderSettings(false)
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

  return {
    async start(): Promise<void> {
      stops.push(
        d.gateway.onMessage((m) => {
          state = applyMessage(state, m)
          render()
        }),
        d.gateway.onSelect(select),
        d.gateway.app.onBanner((b) => d.banner.show(b)),
        d.gateway.app.onOpenSettings(() => renderSettings(true)),
        d.gateway.updates.onState((s) => {
          update = s
          void renderSettings(false)
        }),
        d.every(1000, () => selected && d.panel.render(panelVM(state, selected, d.clock.now()))),
      )
      const [snapshot, settings] = await Promise.all([
        d.gateway.ready(),
        d.gateway.settings.get().catch(() => DEFAULT_SETTINGS),
      ])
      applyQuality(settings.graphicsQuality)
      state = applyMessage(state, { type: 'snapshot', ...snapshot })
      render()
    },

    stop(): void {
      for (const s of stops.splice(0)) s()
    },

    select,
  }
}
