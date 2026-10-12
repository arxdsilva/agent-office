// Composition root: the only module (with the Electron entry index.ts) that knows concrete adapters.
// Everything it builds talks to the rest through core ports.
import { join } from 'node:path'
import {
  buildHttpApi,
  ClaudeCodeTailer,
  ClaudeSettingsFile,
  createAuth,
  FsHookRunner,
  InMemoryAgentRepository,
  InMemoryEventBus,
  InMemoryMessageRepository,
  JsonFileSettingsRepository,
  loadOrCreateToken,
  MockAgents,
  NodeTranscriptFiles,
  RandomIds,
  startHttpServer,
  SystemClock,
  TimerScheduler,
  type EnvConfig,
  type RunningServer,
} from '@agent-office/adapters'
import {
  createOffice,
  DEFAULT_SWEEP_POLICY,
  PortInUseError,
  type LoginItem,
  type Logger,
  type Notifier,
  type PlatformInfo,
  type TrayAction,
  type TrayView,
  type Updater,
  type WindowState,
} from '@agent-office/core'
import { IPC, type Banner, type Settings } from '@agent-office/shared'
import { createIpcHandlers, createPushBridge, registerIpc, type IpcRegistrar } from './ipc-api.ts'
import { isTrustedSender } from './security.ts'

/** Electron-side adapters, built in index.ts (or faked in tests). */
export interface Shell {
  notifier: Notifier
  tray: TrayView
  loginItem: LoginItem
  updater: Updater
  platform: PlatformInfo
  window: WindowState & { show(): void; send(channel: string, payload: unknown): void }
  ipc: IpcRegistrar & { removeAll(): void }
  /** URL of the renderer document; IPC from anything else is refused. */
  rendererUrl: string
  quit(): void
}

export interface ComposeOptions {
  shell: Shell
  env: EnvConfig
  userDataDir: string
  /** Absolute path of hooks/agent-office-hook.mjs. */
  hookScript: string
  /** Binary Claude Code should run for the hook (the app itself when packaged). */
  execPath: string
  runAsNode: boolean
  releaseUrl: string
  logger: Logger
}

const SWEEP_MS = 2000

export function compose(o: ComposeOptions) {
  const { shell, env, logger } = o
  const scheduler = new TimerScheduler()
  const bus = new InMemoryEventBus(logger)
  const settingsRepo = new JsonFileSettingsRepository(join(o.userDataDir, 'settings.json'), logger)
  const sweepPolicy = { ...DEFAULT_SWEEP_POLICY, ...env.sweep }
  const office = createOffice({
    agents: new InMemoryAgentRepository(),
    messages: new InMemoryMessageRepository(),
    bus,
    clock: new SystemClock(),
    ids: new RandomIds(),
    scheduler,
    settingsRepo,
    loginItem: shell.loginItem,
    claudeSettings: new ClaudeSettingsFile(env.claudeSettingsFile),
    hookRunner: new FsHookRunner({
      dir: join(o.userDataDir, 'hook'),
      execPath: o.execPath,
      script: o.hookScript,
      platform: shell.platform.platform,
      runAsNode: o.runAsNode,
    }),
    notifier: shell.notifier,
    tray: shell.tray,
    window: shell.window,
    updater: shell.updater,
    platform: shell.platform,
    releaseUrl: o.releaseUrl,
    policy: sweepPolicy,
  })

  /** Env overrides (dev/test) win over saved settings for this run only. */
  const effective = (s: Settings): Settings => ({ ...s, ...env.overrides })

  let backend: { server?: RunningServer; stops: (() => void)[] } | undefined
  let banner: Banner | null = null
  const stops: (() => void)[] = []
  let started = false

  const setBanner = (b: Banner | null) => {
    banner = b
    shell.window.send(IPC.banner, b)
  }

  const refreshHookStatus = async () => {
    try {
      office.attention.setHookInstalled((await office.hooks.status()) === 'installed')
    } catch (err) {
      logger.warn(`hook status unavailable: ${(err as Error).message}`)
    }
  }

  async function startBackend(s: Settings): Promise<void> {
    const b: NonNullable<typeof backend> = { stops: [] }
    backend = b
    let mock: MockAgents | undefined
    if (s.mock) {
      mock = new MockAgents({ activity: office.activity, inbox: office.inbox, query: office.query, events: bus, scheduler })
      mock.seed()
      mock.start()
      b.stops.push(() => mock!.stop())
    }
    if (s.claudeAdapter) {
      const tailer = new ClaudeCodeTailer({
        dir: env.claudeProjectsDir,
        files: new NodeTranscriptFiles(),
        activity: office.activity,
        clock: new SystemClock(),
        scheduler,
        expireAfterMs: sweepPolicy.expireAfterMs,
        log: logger,
      })
      tailer.start()
      b.stops.push(() => tailer.stop())
    }
    b.stops.push(scheduler.every(SWEEP_MS, () => office.activity.sweep()))

    const token = loadOrCreateToken(env.home)
    let listening = s.port
    const api = buildHttpApi(
      { activity: office.activity, inbox: office.inbox, chat: office.chat, query: office.query, ...(mock ? { mock } : {}) },
      // Port getter: with port 0 (tests) the Host allowlist must follow the real port.
      createAuth({ token, port: () => listening, allowedHosts: env.allowedHosts }),
    )
    try {
      b.server = await startHttpServer(api, { host: env.host, port: s.port })
      listening = b.server.port
      if (banner) setBanner(null)
      logger.info(`API listening on http://${env.host}:${b.server.port}`)
    } catch (err) {
      if (!(err instanceof PortInUseError)) throw err
      setBanner({ kind: 'error', text: `Port ${s.port} is busy — change it in Settings.` })
    }
  }

  async function stopBackend(): Promise<void> {
    const b = backend
    backend = undefined
    if (!b) return
    for (const s of b.stops.splice(0)) s()
    await b.server?.close()
  }

  async function restartBackend(): Promise<void> {
    await stopBackend()
    await startBackend(effective(await office.settings.get()))
  }

  return {
    office,

    async start(): Promise<void> {
      if (started) return
      started = true
      const settings = effective(await office.settings.get())
      office.attention.setNotificationsEnabled(settings.notifications)
      office.updates.setEnabled(settings.autoUpdate)
      await office.hooks.heal().catch((err: Error) => logger.warn(`hook heal failed: ${err.message}`))
      await refreshHookStatus()

      registerIpc(
        shell.ipc,
        createIpcHandlers({
          query: office.query,
          chat: office.chat,
          settings: office.settings,
          hooks: office.hooks,
          updates: office.updates,
          version: shell.platform.version,
          onHookChanged: () => void refreshHookStatus(),
          onReady: () => {
            scheduler.after(0, () => {
              shell.window.send(IPC.banner, banner)
              shell.window.send(IPC.updateState, office.updates.state())
            })
          },
        }),
        (url) => isTrustedSender(url, shell.rendererUrl),
      )
      stops.push(
        createPushBridge(office.query, (channel, payload) => shell.window.send(channel, payload), scheduler),
        office.updates.onChange((s) => shell.window.send(IPC.updateState, s)),
        office.settings.onChange(({ settings: s, restartRequired }) => {
          office.attention.setNotificationsEnabled(s.notifications)
          office.updates.setEnabled(s.autoUpdate)
          if (restartRequired) void restartBackend()
        }),
      )

      await startBackend(settings)
      office.attention.start()
      void office.updates.start()
    },

    async stop(): Promise<void> {
      if (!started) return
      started = false
      for (const s of stops.splice(0)) s()
      office.attention.stop()
      office.updates.stop()
      await stopBackend()
      shell.ipc.removeAll()
      scheduler.dispose()
    },

    restartBackend,

    async onTrayAction(a: TrayAction): Promise<void> {
      switch (a.type) {
        case 'open':
          return shell.window.show()
        case 'select':
          shell.window.show()
          return shell.window.send(IPC.select, a.agentId)
        case 'settings':
          shell.window.show()
          return shell.window.send(IPC.openSettings, null)
        case 'install-hook':
          await office.hooks.install()
          return refreshHookStatus()
        case 'quit':
          return shell.quit()
      }
    },

    notificationClicked(agentId: string): void {
      shell.window.show()
      shell.window.send(IPC.select, agentId)
    },

    apiPort: (): number | undefined => backend?.server?.port,
    banner: (): Banner | null => banner,
  }
}

export type App = ReturnType<typeof compose>
