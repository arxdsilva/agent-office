import { GraphicsQualitySchema, type SettingsPatch } from '@agent-office/shared'
import type { SettingsVM } from '../../app/view-models.ts'
import type { SettingsView } from '../../ports.ts'
import { byId } from './el.ts'

const CHECKBOXES = ['notifications', 'launchAtLogin', 'claudeAdapter', 'autoUpdate'] as const

/** SettingsView port → the native <dialog> in index.html. */
export class DomSettings implements SettingsView {
  private dialog = byId<HTMLDialogElement>('settings')
  private changeFn: (patch: SettingsPatch) => void | Promise<void> = () => {}
  private hookFn: (a: 'install' | 'uninstall') => void | Promise<void> = () => {}
  private checkFn: () => void | Promise<void> = () => {}
  private installFn: () => void | Promise<void> = () => {}
  private hookAction: 'install' | 'uninstall' = 'install'
  private updateAction: SettingsVM['update']['action'] = null

  constructor() {
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

  render(vm: SettingsVM): void {
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
