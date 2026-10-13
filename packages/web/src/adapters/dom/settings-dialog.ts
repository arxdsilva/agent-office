import {
  BATTERY_PRESETS,
  GRAPHICS_QUALITIES,
  GraphicsAdvancedSchema,
  GraphicsQualitySchema,
  SettingsSchema,
  type GraphicsAdvanced,
  type SettingsPatch,
} from '@agent-office/shared'
import { COPY } from '../../app/connect-copy.ts'
import { GFX_COPY } from '../../app/graphics-copy.ts'
import {
  autoImportOutcome,
  autoImportToggled,
  type AutoImportChoice,
} from '../../app/auto-import-vm.ts'
import { SESSION_COPY } from '../../app/session-copy.ts'
import type { SettingsVM } from '../../app/view-models.ts'
import type { SettingsView } from '../../ports.ts'
import { byId, el } from './el.ts'

const CHECKBOXES = [
  'notifications',
  'launchAtLogin',
  'claudeAdapter',
  'discoverCapabilities',
  'autoUpdate',
] as const

const THEMES = ['system', 'light', 'dark'] as const
type Theme = (typeof THEMES)[number]
/** Fields W2 adds to SettingsVM; optional here so this adapter compiles on its own. */
type AppearanceVM = SettingsVM & Partial<{ theme: Theme; allowBypassPermissions: boolean }>

type AdvKey = keyof GraphicsAdvanced
type BatteryPreset = (typeof BATTERY_PRESETS)[number]
/**
 * Settings → Graphics as this adapter reads it (low-spec plan §2.1, §5.6). Every field is optional:
 * the stored values may arrive flat on SettingsVM, the derived texts under `graphics` (graphicsVM).
 */
interface GraphicsBlockVM {
  /** "Auto picked: Low (integrated GPU)"; null/absent hides the line (manual presets). */
  autoNote?: string | null
  /** "62 fps · Low · GPU memory ≈ 140 MB · 1280×720" */
  now?: string
  /** Any advanced override is set → "(custom)". */
  custom?: boolean
  /** The value 'auto' resolves to, per option: "Auto · 30". */
  autoHints?: Partial<Record<AdvKey, string>>
}
type GfxVM = AppearanceVM &
  Partial<{
    graphicsAdvanced: GraphicsAdvanced
    powerSaverBlur: boolean
    powerSaverHidden: boolean
    batteryPreset: BatteryPreset
    hardwareAcceleration: boolean
    graphics: GraphicsBlockVM
  }>

const V = GFX_COPY.values
/** Advanced options in display order: label, optional help, and the non-auto values with labels. */
const ADVANCED: { key: AdvKey; label: string; help?: string; values: [string, string][] }[] = [
  {
    key: 'resolution',
    label: GFX_COPY.options.resolution,
    values: [
      ['0.5', '50%'],
      ['0.67', '67%'],
      ['0.75', '75%'],
      ['1', '100%'],
    ],
  },
  {
    key: 'fps',
    label: GFX_COPY.options.fps,
    values: [
      ['30', '30'],
      ['60', '60'],
      ['unlimited', V.unlimited],
    ],
  },
  {
    key: 'shadows',
    label: GFX_COPY.options.shadows,
    values: [
      ['off', V.off],
      ['contact', V.contact],
      ['full', V.full],
    ],
  },
  {
    key: 'effects',
    label: GFX_COPY.options.effects,
    help: GFX_COPY.options.effectsHelp,
    values: [
      ['off', V.off],
      ['on', V.on],
    ],
  },
  {
    key: 'characters',
    label: GFX_COPY.options.characters,
    values: [
      ['low', V.low],
      ['medium', V.medium],
      ['high', V.high],
    ],
  },
  {
    key: 'labels',
    label: GFX_COPY.options.labels,
    values: [
      ['selected', V.selected],
      ['nearby', V.nearby],
      ['all', V.all],
    ],
  },
  {
    key: 'links',
    label: GFX_COPY.options.links,
    values: [
      ['off', V.off],
      ['static', V.static],
      ['animated', V.animated],
    ],
  },
  {
    key: 'building',
    label: GFX_COPY.options.building,
    help: GFX_COPY.options.buildingHelp,
    values: [
      ['low', V.low],
      ['medium', V.medium],
      ['high', V.high],
    ],
  },
]
const AUTO_ADVANCED: GraphicsAdvanced = GraphicsAdvancedSchema.parse({})

/** What the Settings dialog needs from the rest of the app beyond `onChange`. */
export interface DomSettingsDeps {
  /** "Also remove imported memory" (`projects.removeImported()`, all projects). */
  removeImported?: () => Promise<unknown>
}

/** SettingsView port → the native <dialog> in index.html. */
export class DomSettings implements SettingsView {
  private dialog = byId<HTMLDialogElement>('settings')
  private changeFn: (patch: SettingsPatch) => void | Promise<void> = () => {}
  private hookFn: (a: 'install' | 'uninstall') => void | Promise<void> = () => {}
  private checkFn: () => void | Promise<void> = () => {}
  private installFn: () => void | Promise<void> = () => {}
  private connectFn: () => void = () => {}
  private hookAction: 'install' | 'uninstall' = 'install'
  private updateAction: SettingsVM['update']['action'] = null
  private confirm = byId<HTMLDialogElement>('s-confirm')
  private importOn = byId<HTMLDialogElement>('s-autoimport-confirm')
  private importOff = byId<HTMLDialogElement>('s-autoimport-off')

  constructor(private deps: DomSettingsDeps = {}) {
    this.bindAppearance()
    this.bindBypass()
    this.bindAutoImport()
    for (const key of CHECKBOXES) {
      byId<HTMLInputElement>(`s-${key}`).addEventListener(
        'change',
        (e) => void this.changeFn({ [key]: (e.target as HTMLInputElement).checked }),
      )
    }
    this.bindGraphics()
    byId<HTMLFormElement>('s-port-form').addEventListener('submit', (e) => {
      e.preventDefault()
      void this.changeFn({ port: Number(byId<HTMLInputElement>('s-port').value) })
    })
    byId('s-hook-btn').addEventListener('click', () => void this.hookFn(this.hookAction))
    byId('s-update-btn').addEventListener('click', () => {
      if (this.updateAction === 'check') void this.checkFn()
      if (this.updateAction === 'install') void this.installFn()
    })
    byId('s-close').addEventListener('click', () => this.close())
    byId('s-connect').textContent = COPY.settings.more
    byId('s-connect').addEventListener('click', () => this.connectFn())
  }

  /** Settings → Appearance: a segmented radiogroup (click, or arrow keys like native radios). */
  private bindAppearance(): void {
    byId('s-appearance-h').textContent = SESSION_COPY.appearance.title
    const group = byId('s-theme')
    const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    const pick = (t: Theme, focus = false) => {
      this.selectTheme(t)
      if (focus) radios.find((r) => r.dataset.theme === t)?.focus()
      void this.changeFn({ theme: t })
    }
    for (const r of radios) {
      const t = THEMES.find((x) => x === r.dataset.theme)
      if (!t) continue
      r.textContent = SESSION_COPY.appearance[t]
      r.addEventListener('click', () => pick(t))
    }
    group.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
      if (!step) return
      e.preventDefault()
      const cur = THEMES.indexOf(this.currentTheme())
      pick(THEMES[(cur + step + THEMES.length) % THEMES.length]!, true)
    })
  }

  private currentTheme(): Theme {
    const on = byId('s-theme').querySelector<HTMLElement>('[aria-checked="true"]')
    return THEMES.find((t) => t === on?.dataset.theme) ?? 'system'
  }

  private selectTheme(t: Theme): void {
    for (const r of byId('s-theme').querySelectorAll<HTMLButtonElement>('[role="radio"]')) {
      const on = r.dataset.theme === t
      r.setAttribute('aria-checked', String(on))
      r.tabIndex = on ? 0 : -1
    }
  }

  /** Settings → Graphics (§2.1): preset, power saver, Advanced overrides, hardware acceleration. */
  private bindGraphics(): void {
    byId('s-gfx-h').textContent = GFX_COPY.title
    byId('s-gfx-quality-l').textContent = 'Quality'
    byId('s-gfx-now-l').textContent = 'Now'
    const quality = byId<HTMLSelectElement>('s-graphicsQuality')
    quality.replaceChildren(...GRAPHICS_QUALITIES.map((q) => option(q, GFX_COPY.presets[q])))
    quality.addEventListener('change', () => {
      const q = GraphicsQualitySchema.safeParse(quality.value)
      if (q.success) void this.changeFn({ graphicsQuality: q.data })
      this.renderPresetHelp(quality.value)
    })

    byId('s-saver-h').textContent = GFX_COPY.power.title
    byId('s-saver-blur-l').textContent = GFX_COPY.power.blur
    byId('s-saver-hidden-l').textContent = GFX_COPY.power.hidden
    const box = (id: string, key: 'powerSaverBlur' | 'powerSaverHidden' | 'hardwareAcceleration') =>
      byId<HTMLInputElement>(id).addEventListener(
        'change',
        (e) => void this.changeFn({ [key]: (e.target as HTMLInputElement).checked }),
      )
    box('s-saver-blur', 'powerSaverBlur')
    box('s-saver-hidden', 'powerSaverHidden')
    byId('s-battery-l').textContent = GFX_COPY.power.battery
    const battery = byId<HTMLSelectElement>('s-battery-preset')
    battery.replaceChildren(
      ...BATTERY_PRESETS.map((p) => option(p, p === 'off' ? V.off : GFX_COPY.presets[p])),
    )
    battery.addEventListener('change', () => {
      const b = SettingsSchema.shape.batteryPreset.safeParse(battery.value)
      if (b.success) void this.changeFn({ batteryPreset: b.data })
    })

    byId('s-adv-title').textContent = GFX_COPY.advanced.title
    byId('s-adv-custom').textContent = GFX_COPY.advanced.custom
    const grid = byId('s-adv-grid')
    for (const o of ADVANCED) {
      const id = `s-adv-${o.key}`
      const label = el('label', o.label)
      label.htmlFor = id
      if (o.help) label.append(el('span', ` (${o.help})`, 'muted small'))
      const select = el('select')
      select.id = id
      select.append(
        option('auto', GFX_COPY.presets.auto),
        ...o.values.map(([v, l]) => option(v, l)),
      )
      select.addEventListener('change', () => void this.sendAdvanced())
      grid.append(label, select)
    }
    const reset = byId('s-adv-reset')
    reset.textContent = GFX_COPY.advanced.reset
    reset.addEventListener('click', () => {
      for (const o of ADVANCED) byId<HTMLSelectElement>(`s-adv-${o.key}`).value = 'auto'
      void this.sendAdvanced()
    })

    byId('s-hw-accel-l').textContent = GFX_COPY.hardware.accel
    byId('s-hw-accel-note').textContent = GFX_COPY.hardware.restart
    box('s-hw-accel', 'hardwareAcceleration')
  }

  /** The whole `graphicsAdvanced` object from the selects (keeps the strict patch schema simple). */
  private sendAdvanced(): void | Promise<void> {
    const raw = Object.fromEntries(
      ADVANCED.map((o) => [o.key, byId<HTMLSelectElement>(`s-adv-${o.key}`).value]),
    )
    const adv = GraphicsAdvancedSchema.safeParse(raw)
    if (!adv.success) return
    this.renderCustom(adv.data)
    return this.changeFn({ graphicsAdvanced: adv.data })
  }

  private renderCustom(adv: GraphicsAdvanced, custom?: boolean): void {
    const on = custom ?? ADVANCED.some((o) => adv[o.key] !== 'auto')
    byId('s-adv-custom').hidden = !on
    byId<HTMLButtonElement>('s-adv-reset').disabled = !on
  }

  private renderPresetHelp(q: string): void {
    const help = GFX_COPY.presetHelp as Record<string, string | undefined>
    byId('s-gfx-help').textContent = help[q] ?? ''
  }

  private renderGraphics(vm: GfxVM): void {
    const g = vm.graphics ?? {}
    byId<HTMLSelectElement>('s-graphicsQuality').value = vm.graphicsQuality
    this.renderPresetHelp(vm.graphicsQuality)
    const note = byId('s-gfx-auto-note')
    note.hidden = vm.graphicsQuality !== 'auto' || !g.autoNote
    note.textContent = g.autoNote ?? ''
    if (g.now) byId('s-gfx-now').textContent = g.now
    byId<HTMLInputElement>('s-saver-blur').checked = vm.powerSaverBlur ?? true
    byId<HTMLInputElement>('s-saver-hidden').checked = vm.powerSaverHidden ?? true
    byId<HTMLSelectElement>('s-battery-preset').value = vm.batteryPreset ?? 'off'
    byId<HTMLInputElement>('s-hw-accel').checked = vm.hardwareAcceleration ?? true
    const hwRow = byId<HTMLInputElement>('s-hw-accel').closest('label') ?? byId('s-hw-accel')
    ;(hwRow as HTMLElement).hidden = vm.showHardwareAcceleration === false
    const adv = vm.graphicsAdvanced ?? AUTO_ADVANCED
    for (const o of ADVANCED) {
      const select = byId<HTMLSelectElement>(`s-adv-${o.key}`)
      if (document.activeElement !== select) select.value = adv[o.key]
      const hint = g.autoHints?.[o.key]
      select.options[0]!.textContent = hint ?? GFX_COPY.presets.auto
    }
    this.renderCustom(adv, g.custom)
  }

  /** Turning bypass on asks first, in our own <dialog> (never window.confirm); turning it off doesn't. */
  private bindBypass(): void {
    byId('s-bypass-label').textContent = SESSION_COPY.bypass.label
    byId('s-confirm-text').textContent = SESSION_COPY.bypass.confirm
    const box = byId<HTMLInputElement>('s-allowBypassPermissions')
    box.addEventListener('change', () => {
      if (!box.checked) return void this.changeFn({ allowBypassPermissions: false })
      box.checked = false
      this.confirm.showModal()
    })
    byId('s-confirm-cancel').addEventListener('click', () => this.confirm.close())
    byId('s-confirm-ok').addEventListener('click', () => {
      this.confirm.close()
      box.checked = true
      void this.changeFn({ allowBypassPermissions: true })
    })
  }

  /**
   * Automatic import (docs/projects.md §8b). Checking opens a confirm and only OK saves `true`;
   * unchecking asks whether to keep or also remove what was imported. The pure flow is in
   * `app/auto-import-vm.ts`. Both dialogs are our own <dialog>s (never window.confirm).
   */
  private bindAutoImport(): void {
    const C = SESSION_COPY.autoImport
    const box = byId<HTMLInputElement>('s-autoImportHistory')
    byId('s-autoimport-label').textContent = C.label
    byId('s-autoimport-exp').textContent = `(${C.experimental})`
    byId('s-autoimport-note').textContent = C.note
    byId('s-autoimport-confirm-text').textContent = C.onConfirm
    byId('s-autoimport-ok').textContent = C.turnOn
    byId('s-autoimport-cancel').textContent = C.cancel
    byId('s-autoimport-off-text').textContent = C.offConfirm
    byId('s-autoimport-keep').textContent = C.keep
    byId('s-autoimport-remove').textContent = C.remove

    const finish = (choice: AutoImportChoice): void => {
      this.importOn.close()
      this.importOff.close()
      const out = autoImportOutcome(choice)
      box.checked = out.checked
      void (async () => {
        if (out.patch) await this.changeFn(out.patch)
        if (out.removeImported) {
          try {
            await this.deps.removeImported?.()
          } catch {
            this.showError(C.removeFailed)
          }
        }
      })()
    }
    box.addEventListener('change', () => {
      const next = autoImportToggled(box.checked)
      box.checked = next.checked
      ;(next.dialog === 'confirm-on' ? this.importOn : this.importOff).showModal()
    })
    byId('s-autoimport-ok').addEventListener('click', () => finish('on-ok'))
    byId('s-autoimport-cancel').addEventListener('click', () => finish('on-cancel'))
    byId('s-autoimport-keep').addEventListener('click', () => finish('off-keep'))
    byId('s-autoimport-remove').addEventListener('click', () => finish('off-remove'))
    // Esc dismisses without choosing: the setting stays as it was.
    this.importOn.addEventListener(
      'cancel',
      () => (box.checked = autoImportOutcome('on-cancel').checked),
    )
    this.importOff.addEventListener(
      'cancel',
      () => (box.checked = autoImportOutcome('off-dismiss').checked),
    )
  }

  onOpenConnect(fn: () => void) {
    this.connectFn = fn
  }

  onChange(fn: (patch: SettingsPatch) => void | Promise<void>) {
    this.changeFn = fn
  }
  onHookAction(fn: (a: 'install' | 'uninstall') => void | Promise<void>) {
    this.hookFn = fn
  }
  onCheckUpdates(fn: () => void | Promise<void>) {
    this.checkFn = fn
  }
  onInstallUpdate(fn: () => void | Promise<void>) {
    this.installFn = fn
  }

  /**
   * Fallback live readout (fps and preset only) for when the VM carries no `graphics.now` line;
   * the controller's 2 Hz render of `graphics.now` wins once it arrives.
   */
  showFrameRate(fps: number, preset: string): void {
    if (!this.dialog.open || this.hasNowLine) return
    const name = preset.charAt(0).toUpperCase() + preset.slice(1)
    byId('s-gfx-now').textContent = `${Math.round(fps)} fps · ${name}`
  }
  private hasNowLine = false

  isOpen(): boolean {
    return this.dialog.open
  }

  open(vm: SettingsVM): void {
    this.render(vm)
    byId('s-error').textContent = ''
    if (!this.dialog.open) this.dialog.showModal()
  }

  close(): void {
    this.dialog.close()
  }

  showError(message: string): void {
    byId('s-error').textContent = message
  }

  render(vm: GfxVM): void {
    this.selectTheme(vm.theme ?? 'system')
    if (!this.confirm.open)
      byId<HTMLInputElement>('s-allowBypassPermissions').checked =
        vm.allowBypassPermissions ?? false
    for (const key of CHECKBOXES) byId<HTMLInputElement>(`s-${key}`).checked = vm[key]
    // The setting is only changed through its confirm dialogs: don't flip the box under them.
    if (!this.importOn.open && !this.importOff.open)
      byId<HTMLInputElement>('s-autoImportHistory').checked = vm.autoImportHistory
    const port = byId<HTMLInputElement>('s-port')
    if (document.activeElement !== port) port.value = String(vm.port)
    this.hasNowLine = !!vm.graphics?.now
    this.renderGraphics(vm)
    byId('s-restart').hidden = !vm.restartNote
    byId('s-hook-label').textContent = vm.hook.label
    this.hookAction = vm.hook.action
    byId('s-hook-btn').textContent =
      vm.hook.action === 'install' ? 'Install hook' : 'Uninstall hook'
    byId('s-version').textContent = vm.version
    byId('s-update-label').textContent = vm.update.label
    this.updateAction = vm.update.action
    const btn = byId<HTMLButtonElement>('s-update-btn')
    const link = byId<HTMLAnchorElement>('s-update-link')
    btn.hidden = vm.update.action !== 'check' && vm.update.action !== 'install'
    btn.textContent = vm.update.action === 'install' ? 'Restart to update' : 'Check for updates'
    link.hidden = vm.update.action !== 'download'
    if (vm.update.url) link.href = vm.update.url
  }
}

function option(value: string, label: string): HTMLOptionElement {
  const o = el('option', label)
  o.value = value
  return o
}
