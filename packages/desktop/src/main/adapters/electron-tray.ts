import type { TrayAction, TrayModel, TrayView } from '@agent-office/core'
import { Menu, Tray, type MenuItemConstructorOptions, type NativeImage } from 'electron'

/** TrayView port → native tray/menu-bar icon. The menu comes entirely from the core's TrayModel. */
export class ElectronTray implements TrayView {
  private tray: Tray

  constructor(
    icon: NativeImage,
    private onAction: (a: TrayAction) => void,
  ) {
    this.tray = new Tray(icon)
    // Windows/Linux: left click opens the window; macOS shows the menu.
    if (process.platform !== 'darwin') this.tray.on('click', () => onAction({ type: 'open' }))
  }

  render(model: TrayModel): void {
    this.tray.setToolTip(model.tooltip)
    if (process.platform === 'darwin') this.tray.setTitle(model.title)
    const template: MenuItemConstructorOptions[] = model.items.map((item) =>
      item === 'separator'
        ? { type: 'separator' }
        : {
            label: item.label,
            enabled: item.enabled ?? !!item.action,
            ...(item.action ? { click: () => this.onAction(item.action!) } : {}),
          },
    )
    this.tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  destroy(): void {
    this.tray.destroy()
  }
}
