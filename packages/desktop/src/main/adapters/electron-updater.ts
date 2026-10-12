import type { UpdateInfo, Updater } from '@agent-office/core'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

/** Updater port → electron-updater (GitHub Releases). Download is explicit; the core decides policy. */
export class ElectronUpdater implements Updater {
  constructor() {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = null
  }

  async check(): Promise<UpdateInfo | null> {
    const r = await autoUpdater.checkForUpdates()
    if (!r || !r.isUpdateAvailable) return null
    return { version: r.updateInfo.version }
  }

  async download(): Promise<void> {
    await autoUpdater.downloadUpdate()
  }

  restartToInstall(): void {
    autoUpdater.quitAndInstall()
  }
}
