// Composition root: the only module (with the Electron entry index.ts) that knows concrete adapters.
// Everything it builds talks to the rest through core ports.
import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { abbreviateForSnippet, displayPathOf } from './display-path'
import {
  buildHttpApi,
  ClaudeCapabilityDiscovery,
  ClaudeSdkRunner,
  ClaudeCodeTailer,
  ClaudeConfigReader,
  ClaudeKnowledgeReader,
  ClaudeProbe,
  ClaudeSettingsFile,
  CodexProbe,
  CodexRunner,
  COPILOT_HOOK_FORMAT,
  CopilotAcpRunner,
  CopilotProbe,
  copilotHooksPath,
  CURSOR_HOOK_FORMAT,
  CursorAcpRunner,
  CursorProbe,
  cursorHooksPath,
  GEMINI_HOOK_FORMAT,
  GeminiAcpRunner,
  GeminiProbe,
  geminiSettingsPath,
  JsonConfigFile,
  createAuth,
  FsHookRunner,
  InMemoryAgentRepository,
  InMemoryCapabilityRepository,
  InMemoryEventBus,
  InMemoryMessageRepository,
  JsonFileSettingsRepository,
  loadOrCreateToken,
  MockAgents,
  NodeTranscriptFiles,
  RandomIds,
  resolveClaudeExecutable,
  ScriptedAgentRunner,
  startHttpServer,
  SystemClock,
  TimerScheduler,
  type EnvConfig,
  type RunningServer,
  type TailerStats,
} from '@agent-office/adapters'
import {
  createOffice,
  DEFAULT_SWEEP_POLICY,
  PortInUseError,
  type AgentRunner,
  type LoginItem,
  type Logger,
  type Notifier,
  type ProviderBinding,
  type ProviderHookTargets,
  type ProviderProbe,
  type PlatformInfo,
  type Scheduler,
  type TrayAction,
  type TrayView,
  type Updater,
  type WindowState,
} from '@agent-office/core'
import {
  DEFAULT_SETTINGS,
  IPC,
  type Banner,
  type ProviderId,
  type ConnectionInfo,
  type ContextRef,
  type HookStatus,
  type Settings,
  type TestEventResult,
} from '@agent-office/shared'
import {
  createIpcHandlers,
  createPushBridge,
  registerIpc,
  type ContextEntry,
  type ContextRegistry,
  type IpcRegistrar,
} from './ipc-api.ts'
import { createPowerBridge, type PowerMonitorLike } from './power.ts'
import { isTrustedSender } from './security.ts'

/** Electron-side adapters, built in index.ts (or faked in tests). */
export interface Shell {
  notifier: Notifier
  tray: TrayView
  loginItem: LoginItem
  updater: Updater
  platform: PlatformInfo
  window: WindowState & { show(): void; send(channel: string, payload: unknown): void }
  clipboard: { writeText(text: string): void }
  ipc: IpcRegistrar & { removeAll(): void }
  /** URL of the renderer document; IPC from anything else is refused. */
  rendererUrl: string
  /** Native file/folder picker (absolute paths; they never reach the renderer). */
  dialog?: { pick(kind: 'files' | 'folder'): Promise<string[]> }
  /** Electron's powerMonitor (battery preset); absent reads as on AC. */
  power?: PowerMonitorLike
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
  /** Tests inject a ManualScheduler; defaults to real timers. */
  scheduler?: Scheduler & { dispose?(): void }
  /** For '~' abbreviation of displayed paths; defaults to os.homedir(). */
  homeDir?: string
  /** Environment for managed Claude Code sessions and the runner choice; defaults to process.env. */
  processEnv?: Record<string, string | undefined>
  /** Tests inject a runner; otherwise AGENT_OFFICE_FAKE_RUNNER=1 picks the scripted one, else the SDK. */
  runner?: AgentRunner
  /** Tests inject a probe so no real CLI runs; defaults to `claude --version`. */
  claudeProbe?: ProviderProbe
  /** Tests inject Codex's probe and runtime so the real CLI never runs. */
  codexProbe?: ProviderProbe
  codexRunner?: AgentRunner
  /** Tests inject probes/runtimes for the ACP providers so their real CLIs never run. */
  providerOverrides?: Partial<
    Record<'cursor' | 'gemini' | 'copilot', { probe?: ProviderProbe; runner?: AgentRunner }>
  >
  /**
   * Dev-only directory holding fake provider CLIs (packages/adapters/test/fakes). Given only for
   * unpackaged builds; AGENT_OFFICE_FAKE_PROVIDERS=1 without it falls back to the real CLI.
   */
  fakesDir?: string
}

const SWEEP_MS = 2000
const CONN_PUSH_MS = 1000
/** Same id as the renderer's TEST_AGENT_ID (web/src/app/connect-types.ts). */
const TEST_AGENT_ID = 'agent-office-test'
const TEST_AGENT_TTL_MS = 20_000
const TEST_EVENT = {
  agentId: TEST_AGENT_ID,
  provider: TEST_AGENT_ID,
  topic: 'Connection test',
  name: 'Test agent',
  status: 'thinking',
} as const
const NO_STATS: TailerStats = { projectsDirFound: false, activeSessions: 0 }

const MAX_PICK = 10

/**
 * Opaque `ctx_` refs for picked paths, de-duplicated by path. Paths stay in main; the renderer
 * gets the basename and a '~' hint. Never logged.
 */
function createContextRegistry(o: { dialog?: Shell['dialog']; home: string }): ContextRegistry {
  const byRef = new Map<string, ContextEntry>()
  const byPath = new Map<string, string>()
  const newRef = () => {
    let id = ''
    while (id.length < 12) id += BigInt('0x' + randomBytes(8).toString('hex')).toString(36)
    return `ctx_${id.slice(0, 12)}`
  }
  const register = (path: string, kind: 'file' | 'folder'): ContextRef => {
    let ref = byPath.get(`${kind}:${path}`)
    if (!ref) {
      ref = newRef()
      byPath.set(`${kind}:${path}`, ref)
      byRef.set(ref, {
        path,
        kind,
        label: basename(path) || path,
        hint: displayPathOf(path, o.home),
      })
    }
    const { label, hint } = byRef.get(ref)!
    return { ref, kind, label, hint }
  }
  return {
    async pick(kind) {
      const paths = (await o.dialog?.pick(kind)) ?? []
      const k = kind === 'folder' ? 'folder' : 'file'
      return paths.slice(0, kind === 'folder' ? 1 : MAX_PICK).map((p) => register(p, k))
    },
    resolve: (ref) => byRef.get(ref),
    exists: (path) => {
      try {
        return statSync(path).isDirectory()
      } catch {
        return false
      }
    },
  }
}

/** Loopback host the hook should call: the bind host when it is loopback, else 127.0.0.1. */
function hookHost(host: string): string {
  if (host === 'localhost' || host === '127.0.0.1') return host
  return host === '::1' ? '[::1]' : '127.0.0.1'
}

/** Maps a failed self-test to a short, path-free message. */
function testError(err: unknown): string {
  const code = (err as { cause?: { code?: string } }).cause?.code
  if (code === 'ECONNREFUSED') return 'API not listening'
  return 'no response'
}

/** Codex probe + runtime: injected (tests), the fake app-server (dev, flag), or the real CLI. */
function buildCodex(
  o: ComposeOptions,
  processEnv: Record<string, string | undefined>,
): { probe: ProviderProbe; runner: AgentRunner } {
  const probe = o.codexProbe
  const runner = o.codexRunner
  if (probe && runner) return { probe, runner }
  if (processEnv.AGENT_OFFICE_FAKE_PROVIDERS === '1') {
    if (o.fakesDir) {
      return {
        probe: probe ?? {
          provider: 'codex',
          detect: async () => ({ installed: true, version: 'fake', flagsOk: true, auth: 'ok' }),
        },
        runner:
          runner ??
          new CodexRunner({
            bin: process.execPath,
            args: [join(o.fakesDir, 'fake-codex-app-server.mjs')],
            env: { ELECTRON_RUN_AS_NODE: '1' },
          }),
      }
    }
    o.logger.warn('AGENT_OFFICE_FAKE_PROVIDERS ignored: fake providers are not available here')
  }
  return { probe: probe ?? new CodexProbe({}), runner: runner ?? new CodexRunner({}) }
}

type AcpId = 'cursor' | 'gemini' | 'copilot'
const ACP = {
  cursor: { Runner: CursorAcpRunner, Probe: CursorProbe },
  gemini: { Runner: GeminiAcpRunner, Probe: GeminiProbe },
  copilot: { Runner: CopilotAcpRunner, Probe: CopilotProbe },
} as const

/** An ACP provider's probe + runtime: injected (tests), the fake ACP agent (dev, flag), or the real CLI. */
function buildAcp(
  id: AcpId,
  o: ComposeOptions,
  processEnv: Record<string, string | undefined>,
): { probe: ProviderProbe; runner: AgentRunner } {
  const given = o.providerOverrides?.[id] ?? {}
  const { Runner, Probe } = ACP[id]
  if (processEnv.AGENT_OFFICE_FAKE_PROVIDERS === '1' && o.fakesDir) {
    return {
      probe: given.probe ?? {
        provider: id,
        detect: async () => ({ installed: true, version: 'fake', flagsOk: true, auth: 'ok' }),
      },
      runner:
        given.runner ??
        new Runner({
          bin: process.execPath,
          args: [join(o.fakesDir, 'fake-acp-agent.mjs'), '--profile', id],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        }),
    }
  }
  return { probe: given.probe ?? new Probe({}), runner: given.runner ?? new Runner({}) }
}

/** Observation hooks: each provider's own config file + a wrapper running agent-office-observe.mjs. */
function buildHookTargets(
  o: ComposeOptions,
  processEnv: Record<string, string | undefined>,
  home: string,
  url: () => string,
): ProviderHookTargets {
  const script = join(dirname(o.hookScript), 'agent-office-observe.mjs')
  const runner = (provider: AcpId) =>
    new FsHookRunner({
      dir: join(o.userDataDir, 'hook'),
      execPath: o.execPath,
      script,
      platform: o.shell.platform.platform,
      runAsNode: o.runAsNode,
      url,
      name: `agent-office-observe-${provider}`,
      args: { provider },
    })
  return {
    cursor: {
      format: CURSOR_HOOK_FORMAT,
      store: new JsonConfigFile(cursorHooksPath(processEnv, home)),
      runner: runner('cursor'),
    },
    gemini: {
      format: GEMINI_HOOK_FORMAT,
      store: new JsonConfigFile(geminiSettingsPath(processEnv, home)),
      runner: runner('gemini'),
    },
    copilot: {
      format: COPILOT_HOOK_FORMAT,
      store: new JsonConfigFile(copilotHooksPath(processEnv, home)),
      runner: runner('copilot'),
    },
  }
}

export function compose(o: ComposeOptions) {
  const { shell, env, logger } = o
  const scheduler = o.scheduler ?? new TimerScheduler()
  const home = o.homeDir ?? homedir()
  let backend: { server?: RunningServer; stops: (() => void)[] } | undefined
  let lastPort = env.overrides.port ?? DEFAULT_SETTINGS.port
  const bus = new InMemoryEventBus(logger)
  const settingsRepo = new JsonFileSettingsRepository(join(o.userDataDir, 'settings.json'), logger)
  const sweepPolicy = { ...DEFAULT_SWEEP_POLICY, ...env.sweep }
  const processEnv = o.processEnv ?? process.env
  const runner: AgentRunner =
    o.runner ??
    (processEnv.AGENT_OFFICE_FAKE_RUNNER === '1'
      ? new ScriptedAgentRunner()
      : new ClaudeSdkRunner({
          env: processEnv,
          log: logger,
          claudeHome: env.claudeHome,
          projectsDir: env.claudeProjectsDir,
          // Packaged builds ship without the SDK's bundled binary: use the installed CLI.
          executable: resolveClaudeExecutable({
            env: processEnv,
            home,
            platform: shell.platform.platform,
            exists: existsSync,
          }),
        }))
  const claudeProbe: ProviderProbe =
    o.claudeProbe ??
    new ClaudeProbe({
      resolve: () =>
        resolveClaudeExecutable({
          env: processEnv,
          home,
          platform: shell.platform.platform,
          exists: existsSync,
        }),
    })
  const codex = buildCodex(o, processEnv)
  const acp = {
    cursor: buildAcp('cursor', o, processEnv),
    gemini: buildAcp('gemini', o, processEnv),
    copilot: buildAcp('copilot', o, processEnv),
  }
  const hookUrl = () => `http://${hookHost(env.host)}:${backend?.server?.port ?? lastPort}`
  // One binding per provider (ChatGPT has none: its card is informational only).
  const providers: ProviderBinding[] = [
    { provider: 'claude-code', probe: claudeProbe, runner },
    { provider: 'codex', probe: codex.probe, runner: codex.runner },
    { provider: 'cursor', ...acp.cursor },
    { provider: 'gemini', ...acp.gemini },
    { provider: 'copilot', ...acp.copilot },
  ]
  const context = createContextRegistry({ dialog: shell.dialog, home })
  const office = createOffice({
    agents: new InMemoryAgentRepository(),
    capabilities: new InMemoryCapabilityRepository(),
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
      url: hookUrl,
    }),
    notifier: shell.notifier,
    tray: shell.tray,
    window: shell.window,
    updater: shell.updater,
    platform: shell.platform,
    releaseUrl: o.releaseUrl,
    policy: sweepPolicy,
    runner,
    providers,
    runtimes: new Map<ProviderId, AgentRunner>([
      ['claude-code', runner],
      ['codex', codex.runner],
      ['cursor', acp.cursor.runner],
      ['gemini', acp.gemini.runner],
      ['copilot', acp.copilot.runner],
    ]),
    providerHookTargets: buildHookTargets(o, processEnv, home, hookUrl),
    displayPath: (p) => displayPathOf(p, home),
  })
  const sessions = office.sessions!

  /** Env overrides (dev/test) win over saved settings for this run only. */
  const effective = (s: Settings): Settings => ({ ...s, ...env.overrides })

  let banner: Banner | null = null
  let stats: TailerStats = NO_STATS
  let portBusy = false
  let currentToken: string | undefined
  let cancelTestAgent: (() => void) | undefined
  let cancelPush: (() => void) | undefined
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
    pushConnections()
  }

  /** Connection facts for the renderer. Never includes the token itself. */
  async function connectionInfo(): Promise<ConnectionInfo> {
    const s = effective(await office.settings.get())
    const over = env.overrides
    const hook: HookStatus = await office.hooks.status().catch(() => 'not-installed' as const)
    const providerList = await office.providers.list().catch((err: Error) => {
      logger.warn(`provider status unavailable: ${err.message}`)
      return []
    })
    return {
      api: {
        host: env.host,
        port: backend?.server?.port ?? s.port,
        listening: !!backend?.server,
        portBusy,
        tokenFile: abbreviateForSnippet(join(env.home, 'token'), home),
      },
      claude: {
        enabled: s.claudeAdapter,
        ...(over.claudeAdapter !== undefined && {
          override: over.claudeAdapter ? ('on' as const) : ('off' as const),
        }),
        projectsDir: abbreviateForSnippet(env.claudeProjectsDir, home),
        ...stats,
      },
      hook,
      mock: {
        enabled: s.mock,
        ...(over.mock !== undefined && {
          override: over.mock ? ('on' as const) : ('off' as const),
        }),
      },
      providers: providerList,
    }
  }

  /** Trailing throttle: at most one conn:changed push per CONN_PUSH_MS, with the latest facts. */
  function pushConnections(): void {
    cancelPush ??= scheduler.after(CONN_PUSH_MS, () => {
      cancelPush = undefined
      connectionInfo().then(
        (info) => shell.window.send(IPC.connChanged, info),
        (err: Error) => logger.warn(`connection info unavailable: ${err.message}`),
      )
    })
  }

  /** Posts a fixed test agent to our own API, exactly as an external agent would. */
  async function testEvent(): Promise<TestEventResult> {
    const port = backend?.server?.port
    if (port === undefined || !currentToken) return { ok: false, error: 'API not listening' }
    const host = hookHost(env.host)
    try {
      const res = await fetch(`http://${host}:${port}/api/events`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${currentToken}`,
          'content-type': 'application/json',
          host: `${host}:${port}`,
        },
        body: JSON.stringify(TEST_EVENT),
        signal: AbortSignal.timeout(1500),
      })
      if (res.status === 401) return { ok: false, error: 'token mismatch' }
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    } catch (err) {
      return { ok: false, error: testError(err) }
    }
    // A repeat click refreshes the same agent; only the latest goodbye stays scheduled.
    cancelTestAgent?.()
    cancelTestAgent = scheduler.after(TEST_AGENT_TTL_MS, () => {
      cancelTestAgent = undefined
      office.activity.report([{ agentId: TEST_AGENT_ID, status: 'done' }])
    })
    return { ok: true }
  }

  async function startBackend(s: Settings): Promise<void> {
    const b: NonNullable<typeof backend> = { stops: [] }
    backend = b
    let mock: MockAgents | undefined
    if (s.mock) {
      mock = new MockAgents({
        activity: office.activity,
        inbox: office.inbox,
        query: office.query,
        capabilities: office.capabilities,
        events: bus,
        scheduler,
      })
      mock.seed()
      mock.start()
      b.stops.push(() => mock!.stop())
    }
    if (s.claudeAdapter) {
      // Discovery (MCP server names, skills, rules, memory titles) is opt-out via discoverCapabilities.
      let discovery: ClaudeCapabilityDiscovery | undefined
      const tailer = new ClaudeCodeTailer({
        dir: env.claudeProjectsDir,
        claudeHome: env.claudeHome,
        files: new NodeTranscriptFiles(),
        activity: office.activity,
        clock: new SystemClock(),
        scheduler,
        expireAfterMs: sweepPolicy.expireAfterMs,
        log: logger,
        // Managed sessions report through their runner; their transcripts would double-count.
        skip: (sid) => sessions.isManagedSession(sid),
        onNewCwd: () => discovery?.refresh(),
        onStats: (next) => {
          if (backend !== b) return // a late tick from a stopped backend
          stats = next
          pushConnections()
        },
      })
      if (s.discoverCapabilities) {
        discovery = new ClaudeCapabilityDiscovery({
          capabilities: office.capabilities,
          config: new ClaudeConfigReader(env.claudeConfigFile),
          knowledge: new ClaudeKnowledgeReader({
            claudeHome: env.claudeHome,
            projectsDir: env.claudeProjectsDir,
          }),
          cwds: () => tailer.activeCwds(),
          scheduler,
          log: logger,
        })
        discovery.start()
        b.stops.push(() => discovery!.stop())
      }
      tailer.start()
      b.stops.push(() => {
        tailer.stop()
        stats = NO_STATS
      })
    }
    b.stops.push(scheduler.every(SWEEP_MS, () => office.activity.sweep()))

    const token = loadOrCreateToken(env.home)
    currentToken = token
    lastPort = s.port
    let listening = s.port
    const api = buildHttpApi(
      {
        activity: office.activity,
        inbox: office.inbox,
        chat: office.chat,
        query: office.query,
        capabilities: office.capabilities,
        ...(mock ? { mock } : {}),
      },
      // Port getter: with port 0 (tests) the Host allowlist must follow the real port.
      createAuth({ token, port: () => listening, allowedHosts: env.allowedHosts }),
    )
    try {
      b.server = await startHttpServer(api, { host: env.host, port: s.port })
      listening = b.server.port
      portBusy = false
      if (banner) setBanner(null)
      logger.info(`API listening on http://${env.host}:${b.server.port}`)
    } catch (err) {
      if (!(err instanceof PortInUseError)) throw err
      portBusy = true
      setBanner({ kind: 'error', text: `Port ${s.port} is busy.`, action: 'open-connect' })
    }
    pushConnections()
  }

  async function stopBackend(): Promise<void> {
    const b = backend
    backend = undefined
    if (!b) return
    for (const s of b.stops.splice(0)) s()
    await b.server?.close()
    pushConnections()
  }

  async function restartBackend(): Promise<void> {
    const before = lastPort
    await stopBackend()
    await startBackend(effective(await office.settings.get()))
    // The hook wrapper carries the API url: rewrite it (only if installed) when the port moved.
    if (lastPort !== before) {
      await office.hooks
        .heal()
        .catch((err: Error) => logger.warn(`hook heal failed: ${err.message}`))
      // Observation hooks (Cursor, Gemini, Copilot) carry the same URL: refresh installed ones only.
      await office.providerHooks
        ?.heal()
        .catch((err: Error) => logger.warn(`provider hook heal failed: ${err.message}`))
      await refreshHookStatus()
    }
  }

  return {
    office,

    async start(): Promise<void> {
      if (started) return
      started = true
      const settings = effective(await office.settings.get())
      office.attention.setNotificationsEnabled(settings.notifications)
      office.updates.setEnabled(settings.autoUpdate)
      const power = shell.power
        ? createPowerBridge(shell.power, (channel, payload) => shell.window.send(channel, payload))
        : undefined
      if (power) stops.push(power.stop)

      registerIpc(
        shell.ipc,
        createIpcHandlers({
          query: office.query,
          chat: office.chat,
          compose: office.compose,
          sessions,
          context,
          settings: office.settings,
          hooks: office.hooks,
          providers: office.providers,
          ...(office.providerHooks ? { providerHooks: office.providerHooks } : {}),
          onProvidersChanged: pushConnections,
          updates: office.updates,
          version: shell.platform.version,
          connections: { info: connectionInfo, test: testEvent },
          copyText: (text) => shell.clipboard.writeText(text),
          ...(power ? { power } : {}),
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
        createPushBridge(
          office.query,
          (channel, payload) => shell.window.send(channel, payload),
          scheduler,
        ),
        office.updates.onChange((s) => shell.window.send(IPC.updateState, s)),
        office.settings.onChange(({ settings: s, restartRequired }) => {
          office.attention.setNotificationsEnabled(s.notifications)
          office.updates.setEnabled(s.autoUpdate)
          if (restartRequired) void restartBackend()
          pushConnections()
        }),
      )

      await startBackend(settings)
      // After the backend is up, so the wrapper is written with the port the API really listens on.
      await office.hooks
        .heal()
        .catch((err: Error) => logger.warn(`hook heal failed: ${err.message}`))
      // Observation hooks (Cursor, Gemini, Copilot) carry the same URL: refresh installed ones only.
      await office.providerHooks
        ?.heal()
        .catch((err: Error) => logger.warn(`provider hook heal failed: ${err.message}`))
      await refreshHookStatus()
      office.attention.start()
      void office.updates.start()
    },

    async stop(): Promise<void> {
      if (!started) return
      started = false
      await sessions.stopAll()
      for (const s of stops.splice(0)) s()
      cancelTestAgent?.()
      office.attention.stop()
      office.updates.stop()
      office.capabilities.stop()
      await stopBackend()
      shell.ipc.removeAll()
      cancelPush?.()
      cancelPush = undefined
      scheduler.dispose?.()
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
        case 'connect':
          shell.window.show()
          return shell.window.send(IPC.openConnect, null)
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

    /** Managed sessions running now (the quit confirm asks before stopping them). */
    managedCount: (): number => sessions.count(),
    /** Stops every managed session (quit, after the confirm). */
    stopAll: (): Promise<void> => sessions.stopAll(),

    apiPort: (): number | undefined => backend?.server?.port,
    banner: (): Banner | null => banner,
  }
}

export type App = ReturnType<typeof compose>
