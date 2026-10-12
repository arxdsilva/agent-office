// Electron entry (part of the composition root): lifecycle, native shell objects, then compose().
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConsoleLogger, loadEnv } from '@agent-office/adapters'
import { app, BrowserWindow, Menu, nativeImage, Notification, protocol, session } from 'electron'
import { ElectronNotifier } from './adapters/electron-notifier.ts'
import { ElectronTray } from './adapters/electron-tray.ts'
import { ElectronUpdater } from './adapters/electron-updater.ts'
import {
  electronClipboard,
  electronIpc,
  ElectronLoginItem,
  electronPlatform,
} from './adapters/electron-system.ts'
import { compose, type App } from './composition.ts'
import {
  APP_SCHEME,
  APP_SCHEME_PRIVILEGES,
  createRendererHandler,
  RENDERER_URL,
} from './renderer-protocol.ts'
import { contentSecurityPolicy, isAllowedPermission } from './security.ts'
import { createMainWindow } from './window.ts'

const here = dirname(fileURLToPath(import.meta.url))
const RELEASES = 'https://github.com/arxdsilva/agent-office/releases/latest'

// Tests and side-by-side dev instances use their own profile.
if (process.env.AGENT_OFFICE_USER_DATA) app.setPath('userData', process.env.AGENT_OFFICE_USER_DATA)
if (!app.requestSingleInstanceLock()) app.exit(0)
// The production renderer is served from app://renderer (a real origin for the CSP). Must precede `ready`.
protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES])

/** Paths differ between `electron-vite dev` (repo layout) and the packaged app (resources/). */
function resources() {
  return app.isPackaged
    ? {
        hookScript: join(process.resourcesPath, 'hooks', 'agent-office-hook.mjs'),
        icons: join(process.resourcesPath, 'icons'),
      }
    : {
        hookScript: join(app.getAppPath(), '..', '..', 'hooks', 'agent-office-hook.mjs'),
        icons: join(app.getAppPath(), 'build'),
      }
}

let instance: App | undefined
let quitting = false

async function main(): Promise<void> {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  const rendererRoot = join(here, '..', 'renderer')
  const rendererUrl = devServerUrl ?? RENDERER_URL
  const paths = resources()

  // Deny every permission except the ones the office needs (walk mode, notifications).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(isAllowedPermission(permission)),
  )
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    isAllowedPermission(permission),
  )
  if (!devServerUrl) {
    // Read-only, GET/HEAD, contained in out/renderer (path traversal is refused with 403).
    protocol.handle(
      APP_SCHEME,
      createRendererHandler({ root: rendererRoot, readFile, csp: contentSecurityPolicy() }),
    )
  } else {
    // Production CSP is a <meta> tag in the built index.html (plus a header from the app:// handler);
    // dev responses get it as a header.
    session.defaultSession.webRequest.onHeadersReceived((details, cb) =>
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [contentSecurityPolicy(devServerUrl)],
        },
      }),
    )
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  )

  const logger = new ConsoleLogger()
  const platform = electronPlatform()
  let hiddenHintShown = false
  const win: BrowserWindow = createMainWindow({
    preload: join(here, '..', 'preload', 'index.cjs'),
    bounds: undefined,
    onClose: (bounds) => {
      if (quitting) return false
      void instance?.office.settings.update({ windowBounds: bounds }).catch(() => {})
      if (!hiddenHintShown && Notification.isSupported()) {
        hiddenHintShown = true
        new Notification({
          title: 'agent-office is still running',
          body: 'It lives in the tray. Quit from the tray menu.',
        }).show()
      }
      return true
    },
  })

  const trayIcon = nativeImage.createFromPath(
    join(paths.icons, process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'),
  )
  if (process.platform === 'darwin') trayIcon.setTemplateImage(true)

  instance = compose({
    shell: {
      notifier: new ElectronNotifier((id) => instance?.notificationClicked(id)),
      tray: new ElectronTray(trayIcon, (a) => void instance?.onTrayAction(a)),
      loginItem: new ElectronLoginItem(),
      updater: new ElectronUpdater(),
      platform,
      window: {
        isFocused: () => win.isFocused(),
        show: () => {
          win.show()
          win.focus()
        },
        send: (channel, payload) => {
          if (!win.isDestroyed()) win.webContents.send(channel, payload)
        },
      },
      clipboard: electronClipboard(),
      ipc: electronIpc(),
      rendererUrl,
      quit: () => app.quit(),
    },
    env: loadEnv(process.env, homedir()),
    userDataDir: app.getPath('userData'),
    hookScript: paths.hookScript,
    execPath: process.execPath,
    runAsNode: true,
    releaseUrl: RELEASES,
    logger,
  })
  await instance.start()

  const saved = (await instance.office.settings.get()).windowBounds
  if (saved) win.setBounds(saved)
  // Capture scripts only (scripts/screenshots.mjs, perf.mjs): exposes the renderer's camera/stats hook.
  await win.loadURL(process.env.AGENT_OFFICE_DEBUG === '1' ? `${rendererUrl}?debug=1` : rendererUrl)
}

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  win?.show()
  win?.focus()
})
app.on('activate', () => BrowserWindow.getAllWindows()[0]?.show())
// A tray app: closing the last window does not quit.
app.on('window-all-closed', () => {})
app.on('before-quit', (e) => {
  if (!instance) return
  quitting = true
  e.preventDefault()
  const stopping = instance
  instance = undefined
  void stopping.stop().finally(() => app.exit(0))
})

app.whenReady().then(main, (err) => {
  console.error(err)
  app.exit(1)
})
