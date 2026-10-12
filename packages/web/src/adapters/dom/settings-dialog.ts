import { GraphicsQualitySchema, type SettingsPatch } from '@agent-office/shared'
import { COPY } from '../../app/connect-copy.ts'
import { SESSION_COPY } from '../../app/session-copy.ts'
import type { SettingsVM } from '../../app/view-models.ts'
import type { SettingsView } from '../../ports.ts'
import { byId } from './el.ts'

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

  constructor() {
    this.bindAppearance()
    this.bindBypass()
    for (const key of CHECKBOXES) {
      byId<HTMLInputElement>(`s-${key}`).addEventListener(
        'change',
        (e) => void this.changeFn({ [key]: (e.target as HTMLInputElement).checked }),
      )
    }
    byId<HTMLSelectElement>('s-graphicsQuality').addEventListener('change', (e) => {
      const q = GraphicsQualitySchema.safeParse((e.target as HTMLSelectElement).value)
      if (q.success) void this.changeFn({ graphicsQuality: q.data })
    })
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

  /** Live readout under the quality select (only refreshed while the dialog is open). */
  showFrameRate(fps: number, preset: string): void {
    if (!this.dialog.open) return
    const name = preset.charAt(0).toUpperCase() + preset.slice(1)
    byId('s-fps').textContent = `${name} · ${Math.round(fps)} fps`
  }

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

  render(vm: AppearanceVM): void {
    this.selectTheme(vm.theme ?? 'system')
    if (!this.confirm.open)
      byId<HTMLInputElement>('s-allowBypassPermissions').checked =
        vm.allowBypassPermissions ?? false
    for (const key of CHECKBOXES) byId<HTMLInputElement>(`s-${key}`).checked = vm[key]
    const port = byId<HTMLInputElement>('s-port')
    if (document.activeElement !== port) port.value = String(vm.port)
    byId<HTMLSelectElement>('s-graphicsQuality').value = vm.graphicsQuality
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
