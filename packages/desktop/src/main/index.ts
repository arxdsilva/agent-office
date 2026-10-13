// Electron entry (part of the composition root): lifecycle, native shell objects, then compose().
import { electronDialog } from './adapters/electron-dialog.ts'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConsoleLogger, loadEnv } from '@agent-office/adapters'
import type { Settings } from '@agent-office/shared'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  protocol,
  session,
} from 'electron'
import { ElectronKeyProvider } from './adapters/electron-safe-storage.ts'
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
import {
  afterHardwareChange,
  rendererQuery,
  savedHardwareAcceleration,
  startupFlags,
  watchHardwareAcceleration,
} from './startup-flags.ts'
import { bindTheme, createQuitGuard, QUIT_COPY } from './theme.ts'
import { createMainWindow } from './window.ts'
import { bindWindowVisibility } from './window-visibility.ts'

const here = dirname(fileURLToPath(import.meta.url))
const RELEASES = 'https://github.com/arxdsilva/agent-office/releases/latest'

// Tests and side-by-side dev instances use their own profile.
if (process.env.AGENT_OFFICE_USER_DATA) app.setPath('userData', process.env.AGENT_OFFICE_USER_DATA)
if (!app.requestSingleInstanceLock()) app.exit(0)
// The production renderer is served from app://renderer (a real origin for the CSP). Must precede `ready`.
protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES])

/** `hardwareAcceleration` as saved; read synchronously because GPU flags must precede `ready`. */
const hardwareAcceleration = savedHardwareAcceleration(
  (() => {
    try {
      return readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8')
    } catch {
      return undefined
    }
  })(),
)
const flags = startupFlags({ hardwareAcceleration }, process.env)
if (flags.disableHardwareAcceleration) app.disableHardwareAcceleration()
for (const [name, value] of flags.switches) app.commandLine.appendSwitch(name, value)

/** Paths differ between `electron-vite dev` (repo layout) and the packaged app (resources/). */
function resources() {
  return app.isPackaged
    ? {
        hookScript: join(process.resourcesPath, 'hooks', 'agent-office-hook.mjs'),
        mcpScript: join(process.resourcesPath, 'hooks', 'agent-office-mcp.mjs'),
        icons: join(process.resourcesPath, 'icons'),
      }
    : {
        hookScript: join(app.getAppPath(), '..', '..', 'hooks', 'agent-office-hook.mjs'),
        mcpScript: join(app.getAppPath(), '..', '..', 'hooks', 'agent-office-mcp.mjs'),
        icons: join(app.getAppPath(), 'build'),
        // Fake provider CLIs for E2E (AGENT_OFFICE_FAKE_PROVIDERS=1); never shipped.
        fakesDir: join(app.getAppPath(), '..', '..', 'packages', 'adapters', 'test', 'fakes'),
      }
}

let instance: App | undefined
let quitting = false

/** M1 adds these to the composed App; guarded so the entry runs before that lands. */
type ManagedSessions = { managedCount?: () => number; stopAll?: () => Promise<void> | void }
const managed = () => instance as (App & ManagedSessions) | undefined
const quitGuard = createQuitGuard({
  count: () => {
    const a = managed()
    return typeof a?.managedCount === 'function' ? a.managedCount() : 0
  },
  confirm: async (n) => {
    const win = BrowserWindow.getAllWindows()[0]
    const opts = {
      type: 'warning' as const,
      message: QUIT_COPY.confirm(n),
      buttons: [QUIT_COPY.quit, QUIT_COPY.cancel],
      defaultId: 1,
      cancelId: 1,
    }
    const { response } = win
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts)
    return response === 0
  },
  stopAll: () => {
    const a = managed()
    return typeof a?.stopAll === 'function' ? a.stopAll() : undefined
  },
})

/** The saved theme, read before compose() so the first paint matches (themeSource() sanitizes it). */
async function readSavedTheme(): Promise<Settings['theme'] | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(app.getPath('userData'), 'settings.json'), 'utf8'))
    return (raw as { theme?: Settings['theme'] } | null)?.theme
  } catch {
    return undefined
  }
}

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

  // Apply the saved theme before the window exists, so its first paint already matches.
  let winRef: BrowserWindow | undefined
  const theme = bindTheme({
    nativeTheme,
    setBackground: (c) => {
      if (winRef && !winRef.isDestroyed()) winRef.setBackgroundColor(c)
    },
  })
  theme.apply(await readSavedTheme())

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

  winRef = win
  // Power saver: the renderer pauses while the window is hidden or minimized.
  bindWindowVisibility(win, (channel, visible) => {
    if (!win.isDestroyed()) win.webContents.send(channel, visible)
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
      dialog: electronDialog(),
      ipc: electronIpc(),
      rendererUrl,
      power: powerMonitor,
      quit: () => app.quit(),
    },
    env: loadEnv(process.env, homedir()),
    userDataDir: app.getPath('userData'),
    hookScript: paths.hookScript,
    mcpScript: paths.mcpScript,
    // After app ready: safeStorage wraps the vault's data key (no keychain → memory-only + banner).
    keyProvider: new ElectronKeyProvider(),
    fakesDir: 'fakesDir' in paths ? paths.fakesDir : undefined,
    execPath: process.execPath,
    runAsNode: true,
    releaseUrl: RELEASES,
    logger,
  })
  await instance.start()
  // Settings → Appearance applies live (the renderer's prefers-color-scheme follows nativeTheme).
  instance.office.settings.onChange(({ settings }) => theme.apply(settings.theme))
  // The GPU switch only applies at launch: relaunch once the new value is saved.
  instance.office.settings.onChange(({ settings }) => onHardwareSetting(settings))
  theme.apply((await instance.office.settings.get()).theme)

  const saved = (await instance.office.settings.get()).windowBounds
  if (saved) win.setBounds(saved)
  // debug=1: capture scripts (screenshots.mjs, perf.mjs) get the renderer's camera/stats hook.
  // forceWebglFail=1: the G5 seam (the renderer's scene factory throws).
  await win.loadURL(`${rendererUrl}${rendererQuery(process.env)}`)
}

/** Stops the app (managed sessions included) and starts it again with the new GPU flags. */
const onHardwareSetting = watchHardwareAcceleration(hardwareAcceleration, () => {
  const relaunch = afterHardwareChange(process.env) === 'relaunch'
  quitting = true
  const stopping = instance
  instance = undefined
  void Promise.resolve(stopping?.stop()).finally(() => {
    if (relaunch) app.relaunch()
    app.exit(0)
  })
})

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
  e.preventDefault()
  // Managed sessions die with the app, so ask first (Cancel keeps everything running).
  void quitGuard.confirmQuit().then((ok) => {
    if (!ok || !instance) return
    quitting = true
    const stopping = instance
    instance = undefined
    void stopping.stop().finally(() => app.exit(0))
  })
})

app.whenReady().then(main, (err) => {
  console.error(err)
  app.exit(1)
})
