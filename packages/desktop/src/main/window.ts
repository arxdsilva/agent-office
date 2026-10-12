import type { Settings } from '@agent-office/shared'
import { BrowserWindow, nativeTheme, shell } from 'electron'
import { isSafeExternalUrl, secureWebPreferences } from './security.ts'
import { windowBackground } from './theme.ts'

export interface MainWindowOptions {
  preload: string
  bounds: Settings['windowBounds']
  /** Called when the user closes the window; return true to hide instead (keep running in the tray). */
  onClose: (bounds: NonNullable<Settings['windowBounds']>) => boolean
}

export function createMainWindow(o: MainWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: o.bounds?.width ?? 1280,
    height: o.bounds?.height ?? 820,
    ...(o.bounds ? { x: o.bounds.x, y: o.bounds.y } : {}),
    minWidth: 480,
    minHeight: 360,
    show: false,
    title: 'agent-office',
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
    webPreferences: secureWebPreferences(o.preload),
  })
  win.once('ready-to-show', () => win.show())

  // Never navigate away from the app; open safe links in the browser instead.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.on('close', (e) => {
    if (o.onClose(win.getBounds())) {
      e.preventDefault()
      win.hide()
    }
  })
  return win
}
