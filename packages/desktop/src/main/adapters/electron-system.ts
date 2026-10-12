import type { LoginItem, PlatformInfo } from '@agent-office/core'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, clipboard, ipcMain } from 'electron'
import type { IpcRegistrar } from '../ipc-api.ts'

/** Baked in at build time: true when the release was code-signed (CSC_LINK set). */
declare const __SIGNED__: boolean

export class ElectronLoginItem implements LoginItem {
  setOpenAtLogin(enabled: boolean): void {
    app.setLoginItemSettings({ openAtLogin: enabled })
  }
}

export function electronPlatform(): PlatformInfo {
  return {
    platform: process.platform,
    // Builds without update metadata (e.g. `electron-builder --dir`) can't self-update: treat them like dev.
    packaged: app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml')),
    signed: typeof __SIGNED__ !== 'undefined' && __SIGNED__,
    linuxAppImage: !!process.env.APPIMAGE,
    version: app.getVersion(),
  }
}

/** IpcRegistrar over ipcMain; passes the calling frame's URL so handlers can check the sender. */
export function electronIpc(): IpcRegistrar & { removeAll(): void } {
  const channels = new Set<string>()
  return {
    handle(channel, fn) {
      channels.add(channel)
      ipcMain.handle(channel, (event, ...args) => fn(event.senderFrame?.url, ...args))
    },
    removeAll() {
      for (const c of channels) ipcMain.removeHandler(c)
      channels.clear()
    },
  }
}

/** Main-process clipboard (the renderer's clipboard permission stays denied). */
export function electronClipboard(): { writeText(text: string): void } {
  return { writeText: (text) => clipboard.writeText(text) }
}
