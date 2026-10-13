import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEnv, MemoryRecordLog } from '@agent-office/adapters'
import {
  FakeAgentRunner,
  FakeWindow,
  fakePlatform,
  ManualScheduler,
  RecordingLoginItem,
  RecordingNotifier,
  RecordingTray,
  ScriptedUpdater,
} from '@agent-office/core/testing'
import {
  PROVIDER_IDS,
  IPC,
  type ConnectionInfo,
  type ContextRef,
  type ProviderId,
  type SendResult,
  type ServerMessage,
  type StartResult,
} from '@agent-office/shared'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROVIDER_DECLS,
  type AgentRunner,
  type ProviderProbe,
  type RunnerDecl,
  type StartSession,
} from '@agent-office/core'
import {
  compose,
  VAULT_MEMORY_ONLY_BANNER,
  type ComposeOptions,
  type Shell,
} from './composition.ts'

class FakeShellWindow extends FakeWindow {
  shown = 0
  sent: [string, unknown][] = []
  show() {
    this.shown++
  }
  send(channel: string, payload: unknown) {
    this.sent.push([channel, payload])
  }
}

/** Electron's powerMonitor stand-in: `emit` flips the source and notifies listeners. */
function fakePowerMonitor() {
  const listeners = new Map<string, Set<() => void>>()
  const m = {
    onBattery: false,
    isOnBatteryPower: () => m.onBattery,
    on: (event: string, fn: () => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(fn)
      return m
    },
    removeListener: (event: string, fn: () => void) => {
      listeners.get(event)?.delete(fn)
      return m
    },
    emit: (event: 'on-battery' | 'on-ac') => {
      m.onBattery = event === 'on-battery'
      for (const fn of listeners.get(event) ?? []) fn()
    },
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  }
  return m
}

function fakeShell() {
  const power = fakePowerMonitor()
  const handlers = new Map<string, (senderUrl: string | undefined, ...args: unknown[]) => unknown>()
  let quit = 0
  const copied: string[] = []
  const picked: { kind?: string; paths: string[] } = { paths: [] }
  const shell: Shell = {
    dialog: {
      pick: async (kind) => {
        picked.kind = kind
        return picked.paths
      },
    },
    clipboard: { writeText: (t) => copied.push(t) },
    notifier: new RecordingNotifier(),
    tray: new RecordingTray(),
    loginItem: new RecordingLoginItem(),
    updater: new ScriptedUpdater(),
    platform: fakePlatform({ packaged: false, platform: 'darwin' }),
    window: new FakeShellWindow(),
    ipc: { handle: (c, fn) => handlers.set(c, fn), removeAll: () => handlers.clear() },
    rendererUrl: 'app://renderer/index.html',
    power,
    quit: () => quit++,
  }
  const call = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)!('app://renderer/index.html', ...args)
  return {
    shell,
    handlers,
    call,
    window: shell.window as FakeShellWindow,
    tray: shell.tray as RecordingTray,
    quits: () => quit,
    copied,
    picked,
    power,
  }
}

const apps: { stop(): Promise<void> }[] = []
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop()
})

const notInstalled = (provider: ProviderId): ProviderProbe => ({
  provider,
  detect: async () => ({ installed: false, flagsOk: false, auth: 'unknown' }),
})

const OSS_ACP = ['opencode', 'goose', 'kilo', 'qwen', 'cline', 'openhands'] as const

/** Not-installed probes for every ACP provider, so no real CLI runs; `over` replaces entries. */
function noRealClis(
  over: ComposeOptions['providerOverrides'] = {},
): NonNullable<ComposeOptions['providerOverrides']> {
  const out: NonNullable<ComposeOptions['providerOverrides']> = {}
  for (const id of ['cursor', 'gemini', 'copilot', ...OSS_ACP] as const)
    out[id] = { probe: notInstalled(id) }
  return { ...out, ...over }
}

function setup(
  envVars: Record<string, string | undefined> = {},
  opts: {
    scheduler?: ManualScheduler
    homeDir?: string
    runner?: FakeAgentRunner
    claudeProbe?: ProviderProbe
    codexProbe?: ProviderProbe
    codexRunner?: AgentRunner
    providerOverrides?: ComposeOptions['providerOverrides']
    gooseCli?: ComposeOptions['gooseCli']
    fakesDir?: string
    processEnv?: Record<string, string | undefined>
    vault?: MemoryRecordLog
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'ao-comp-'))
  const env = loadEnv(
    {
      AGENT_OFFICE_HOME: join(dir, 'home'),
      CLAUDE_SETTINGS_FILE: join(dir, 'claude', 'settings.json'),
      CLAUDE_PROJECTS_DIR: join(dir, 'projects'),
      PORT: '0',
      AGENT_OFFICE_CLAUDE: '0',
      ...envVars,
    },
    dir,
  )
  const fake = fakeShell()
  const app = compose({
    shell: fake.shell,
    env,
    userDataDir: join(dir, 'userData'),
    hookScript: '/app/hooks/agent-office-hook.mjs',
    execPath: '/app/agent-office',
    runAsNode: true,
    releaseUrl: 'https://example.invalid/releases',
    logger: { info: () => {}, warn: () => {} },
    // Never run the real `claude --version` in unit tests.
    claudeProbe: {
      provider: 'claude-code',
      detect: async () => ({ installed: false, flagsOk: false, auth: 'unknown' }),
    },
    // Never run the real `codex --version` either.
    codexProbe: {
      provider: 'codex',
      detect: async () => ({ installed: false, flagsOk: false, auth: 'unknown' }),
    },
    // …nor the real Cursor, Gemini, Copilot, OpenCode, goose, Kilo, Qwen, Cline or OpenHands CLIs.
    providerOverrides: noRealClis(),
    // …nor `goose session list` for the history import.
    gooseCli: async () => '[]',
    ...opts,
  })
  apps.push(app)
  return { app, dir, ...fake }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('compose', () => {
  it('starts the API, registers IPC, renders the tray and streams changes to the window', async () => {
    const { app, call, handlers, tray, window } = setup({ AGENT_OFFICE_MOCK: '1' })
    await app.start()
    // The local HTTP API is up for the hook and external agents.
    const health = await fetch(`http://127.0.0.1:${app.apiPort()}/api/health`, {
      headers: { host: `localhost:${app.apiPort()}` },
    })
    expect(await health.json()).toMatchObject({ ok: true })
    expect([...handlers.keys()]).toEqual(
      expect.arrayContaining([IPC.ready, IPC.send, IPC.settingsSet, IPC.hookInstall]),
    )
    expect(tray.models.length).toBeGreaterThan(0)
    // The renderer asks for the snapshot; mock agents are there.
    const snap = (await call(IPC.ready)) as { agents: unknown[] }
    expect(snap.agents.length).toBeGreaterThan(5)
    // A change is pushed to the window, batched.
    app.office.activity.report([{ agentId: 'x', provider: 'custom' }])
    await wait(40)
    const pushes = window.sent
      .filter(([c]) => c === IPC.push)
      .flatMap(([, p]) => p as ServerMessage[])
    expect(pushes.some((m) => m.type === 'upsert' && m.agent.id === 'x')).toBe(true)
  })

  it('discovers Claude Code capabilities when claudeAdapter and discoverCapabilities are on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ao-caps-'))
    // An isolated Claude home: one user skill and a config with one MCP server (secret env must not leak).
    mkdirSync(join(dir, 'claude', 'skills', 'run-office'), { recursive: true })
    writeFileSync(
      join(dir, 'claude', 'skills', 'run-office', 'SKILL.md'),
      '---\nname: run-office\ndescription: Launch it.\n---\n',
    )
    writeFileSync(
      join(dir, 'claude.json'),
      JSON.stringify({ mcpServers: { github: { env: { TOKEN: 'ghp_secret' } } } }),
    )
    const vars = {
      AGENT_OFFICE_CLAUDE: '1',
      CLAUDE_PROJECTS_DIR: join(dir, 'claude', 'projects'),
      CLAUDE_CONFIG_FILE: join(dir, 'claude.json'),
    }
    const { app, call } = setup(vars)
    await app.start()
    await wait(50)
    const snap = (await call(IPC.ready)) as { capabilities?: { id: string; provider: string }[] }
    const ids = (snap.capabilities ?? [])
      .filter((c) => c.provider === 'claude-code')
      .map((c) => c.id)
    expect(ids).toEqual(
      expect.arrayContaining(['fs', 'shell', 'web', 'subagents', 'mcp:github', 'skill:run-office']),
    )
    expect(JSON.stringify(snap)).not.toContain('ghp_secret')
    // The capabilities endpoint is part of the HTTP API.
    const res = await fetch(`http://127.0.0.1:${app.apiPort()}/api/providers/x/capabilities`, {
      method: 'POST',
      headers: { host: `localhost:${app.apiPort()}`, 'content-type': 'application/json' },
      body: '[]',
    })
    expect(res.status).toBe(401)
  })

  it('does not discover capabilities when discoverCapabilities is off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ao-caps-'))
    mkdirSync(join(dir, 'claude', 'skills', 'run-office'), { recursive: true })
    writeFileSync(join(dir, 'claude', 'skills', 'run-office', 'SKILL.md'), '# x\n')
    const { app, call } = setup({
      AGENT_OFFICE_CLAUDE: '1',
      CLAUDE_PROJECTS_DIR: join(dir, 'claude', 'projects'),
    })
    await app.office.settings.update({ discoverCapabilities: false })
    await app.start()
    await wait(50)
    const snap = (await call(IPC.ready)) as { capabilities?: unknown[] }
    expect(snap.capabilities).toEqual([])
  })

  it('keeps running with a banner when the port is busy', async () => {
    const blocker = createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
    const port = String((blocker.address() as { port: number }).port)
    const { app, window, call } = setup({ PORT: port })
    await app.start()
    expect(app.apiPort()).toBeUndefined()
    expect(app.banner()).toEqual({
      kind: 'error',
      text: `Port ${port} is busy.`,
      action: 'open-connect',
    })
    // The Connect panel learns the port is busy and the API is not listening.
    const info = (await call(IPC.connInfo)) as ConnectionInfo
    expect(info.api).toMatchObject({ port: Number(port), listening: false, portBusy: true })
    // The self-test reports it plainly.
    expect(await call(IPC.connTest)).toEqual({ ok: false, error: 'API not listening' })
    // A renderer that loads later still gets the banner.
    window.sent = []
    await call(IPC.ready)
    await wait(10)
    expect(window.sent).toContainEqual([IPC.banner, app.banner()])
    blocker.close()
  })

  it('restarts the backend when a restart-relevant setting changes', async () => {
    const { app, call } = setup()
    await app.start()
    expect(app.office.query.agents()).toHaveLength(0)
    const result = (await call(IPC.settingsSet, { mock: true })) as { restartRequired: boolean }
    expect(result.restartRequired).toBe(true)
    await wait(20)
    expect(app.office.query.agents().length).toBeGreaterThan(5)
    expect(app.apiPort()).toBeGreaterThan(0)
  })

  it('handles tray actions and notification clicks', async () => {
    const { app, window, tray, dir, quits } = setup()
    await app.start()
    await app.onTrayAction({ type: 'select', agentId: 'a' })
    expect(window.sent).toContainEqual([IPC.select, 'a'])
    await app.onTrayAction({ type: 'settings' })
    expect(window.sent).toContainEqual([IPC.openSettings, null])
    await app.onTrayAction({ type: 'open' })
    app.notificationClicked('b')
    expect(window.sent).toContainEqual([IPC.select, 'b'])
    expect(window.shown).toBe(4)
    // Installing from the tray writes the wrapper + Claude settings and refreshes the tray.
    await app.onTrayAction({ type: 'install-hook' })
    const claude = JSON.parse(readFileSync(join(dir, 'claude', 'settings.json'), 'utf8'))
    expect(claude.hooks.Stop[0].hooks[0].command).toContain(
      join(dir, 'userData', 'hook', 'agent-office-hook.sh'),
    )
    expect(existsSync(join(dir, 'userData', 'hook', 'agent-office-hook.sh'))).toBe(true)
    await wait(1100)
    expect(tray.last?.items).toContainEqual({
      label: 'Claude Code hook: installed ✓',
      enabled: false,
    })
    await app.onTrayAction({ type: 'quit' })
    expect(quits()).toBe(1)
  })

  it('describes connections with abbreviated paths, overrides and never the token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ao-conn-'))
    const { app, call } = setup(
      {
        AGENT_OFFICE_HOME: join(dir, '.agent-office'),
        CLAUDE_PROJECTS_DIR: join(dir, '.claude', 'projects'),
        AGENT_OFFICE_MOCK: '1',
      },
      { homeDir: dir },
    )
    await app.start()
    const info = (await call(IPC.connInfo)) as ConnectionInfo
    // `providers` is additive (multi-provider plan); its own tests cover it. Everything else is unchanged.
    const { providers, ...legacy } = info
    expect(providers?.map((p) => p.id)).toContain('claude-code')
    expect(JSON.stringify(providers)).not.toMatch(/\/(Users|home)\//)
    expect(legacy).toEqual({
      api: {
        host: '127.0.0.1',
        port: app.apiPort(),
        listening: true,
        portBusy: false,
        tokenFile: join('~', '.agent-office', 'token'),
      },
      claude: {
        enabled: false,
        override: 'off',
        projectsDir: join('~', '.claude', 'projects'),
        projectsDirFound: false,
        activeSessions: 0,
      },
      hook: 'not-installed',
      mock: { enabled: true, override: 'on' },
    })
    const token = readFileSync(join(dir, '.agent-office', 'token'), 'utf8').trim()
    expect(JSON.stringify(info)).not.toContain(token)
  })

  // A data folder outside home (AGENT_OFFICE_HOME) keeps its full path: the snippets `cat` it, so a
  // basename would produce a command that cannot work. It is the user's own configured location.
  it('keeps the full path of folders outside home, omits absent overrides, and survives a hook error', async () => {
    const { app, call, dir } = setup(
      { AGENT_OFFICE_CLAUDE: undefined },
      { homeDir: '/nowhere-home' },
    )
    mkdirSync(join(dir, 'claude'), { recursive: true })
    writeFileSync(join(dir, 'claude', 'settings.json'), '{not json')
    await app.start()
    const info = (await call(IPC.connInfo)) as ConnectionInfo
    expect(info.api.tokenFile).toBe(join(dir, 'home', 'token'))
    expect(info.claude.projectsDir).toBe(join(dir, 'projects'))
    expect(info.claude).not.toHaveProperty('override')
    expect(info.mock).not.toHaveProperty('override')
    expect(info.hook).toBe('not-installed')
  })

  it('reports Claude Code session counts from the tailer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ao-conn-cc-'))
    mkdirSync(join(dir, 'projects', 'p'), { recursive: true })
    writeFileSync(join(dir, 'projects', 'p', 's.jsonl'), '\n')
    const { app, call, window } = setup({
      AGENT_OFFICE_CLAUDE: '1',
      CLAUDE_PROJECTS_DIR: join(dir, 'projects'),
    })
    await app.office.settings.update({ discoverCapabilities: false })
    await app.start()
    await wait(1200)
    const info = (await call(IPC.connInfo)) as ConnectionInfo
    expect(info.claude).toMatchObject({ enabled: true, projectsDirFound: true, activeSessions: 1 })
    // The session count change was pushed to the window.
    const pushed = window.sent.filter(([c]) => c === IPC.connChanged).map(([, p]) => p)
    expect(pushed.at(-1)).toMatchObject({ claude: { activeSessions: 1 } })
  })

  it('pushes connection changes at most once per throttle window', async () => {
    const scheduler = new ManualScheduler()
    const { app, call, window } = setup({}, { scheduler })
    await app.start()
    scheduler.fireTimers()
    await wait(20)
    window.sent = []
    // Three quick settings changes collapse into one push.
    await call(IPC.settingsSet, { notifications: false })
    await call(IPC.settingsSet, { notifications: true })
    await call(IPC.settingsSet, { notifications: false })
    expect(scheduler.timers.filter((t) => t.ms === 1000 && !t.cancelled)).toHaveLength(1)
    scheduler.fireTimers()
    await wait(20)
    expect(window.sent.filter(([c]) => c === IPC.connChanged)).toHaveLength(1)
  })

  it('rewrites the hook wrapper with the new port when the port changes', async () => {
    const free = async () => {
      const s = createServer()
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
      const port = (s.address() as { port: number }).port
      await new Promise((r) => s.close(r))
      return port
    }
    const [p1, p2] = [await free(), await free()]
    const { app, call, dir } = setup({ PORT: '' })
    await app.office.settings.update({ port: p1 })
    await app.start()
    await app.onTrayAction({ type: 'install-hook' })
    const wrapper = join(dir, 'userData', 'hook', 'agent-office-hook.sh')
    expect(readFileSync(wrapper, 'utf8')).toContain(`http://127.0.0.1:${p1}}`)
    // The user picks another port: the backend restarts there and the wrapper follows.
    await call(IPC.settingsSet, { port: p2 })
    for (let i = 0; i < 50 && !readFileSync(wrapper, 'utf8').includes(`:${p2}}`); i++)
      await wait(20)
    expect(readFileSync(wrapper, 'utf8')).toContain(`http://127.0.0.1:${p2}}`)
    expect(app.apiPort()).toBe(p2)
  })

  it('tray "Connect agents…" shows the window and opens the Connect panel', async () => {
    const { app, window } = setup()
    await app.start()
    await app.onTrayAction({ type: 'connect' })
    expect(window.shown).toBe(1)
    expect(window.sent).toContainEqual([IPC.openConnect, null])
  })

  it('copies validated text to the clipboard through the shell', async () => {
    const { app, call, copied } = setup()
    await app.start()
    await call(IPC.copyText, 'curl …')
    await expect(call(IPC.copyText, '')).rejects.toThrow('invalid text')
    expect(copied).toEqual(['curl …'])
  })

  it('the test event posts a test agent through the API, refreshes on repeat and leaves after 20 s', async () => {
    const scheduler = new ManualScheduler()
    const { app, call } = setup({}, { scheduler })
    await app.start()
    // A click sends a fixed test agent through the authenticated HTTP route.
    expect(await call(IPC.connTest)).toEqual({ ok: true })
    expect(app.office.query.agent('agent-office-test')).toMatchObject({
      provider: 'agent-office-test',
      topic: 'Connection test',
      name: 'Test agent',
      status: 'thinking',
    })
    // A second click refreshes the same agent and only one goodbye stays scheduled.
    expect(await call(IPC.connTest)).toEqual({ ok: true })
    expect(app.office.query.agents().filter((a) => a.id === 'agent-office-test')).toHaveLength(1)
    expect(scheduler.timers.filter((t) => t.ms === 20_000 && !t.cancelled)).toHaveLength(1)
    // 20 s later it is marked done.
    scheduler.fireTimers()
    expect(app.office.query.agent('agent-office-test')?.status).toBe('done')
  })

  it('PW-1 pushes power changes to the window and answers app:power-get; stop unsubscribes', async () => {
    const { app, call, window, power } = setup()
    await app.start()
    expect(await call(IPC.appPowerGet)).toEqual({ onBattery: false })
    // Unplugging pushes the new state; the battery preset (renderer) reacts to it.
    power.emit('on-battery')
    expect(window.sent).toContainEqual([IPC.appPower, { onBattery: true }])
    expect(await call(IPC.appPowerGet)).toEqual({ onBattery: true })
    await app.stop()
    expect(power.listenerCount()).toBe(0)
  })

  it('stop closes the API and unregisters IPC', async () => {
    const { app, handlers } = setup()
    await app.start()
    const port = app.apiPort()
    await app.stop()
    expect(handlers.size).toBe(0)
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow()
    await app.stop()
  })

  describe('managed sessions', () => {
    const START = { mode: 'plan', text: 'Plan the logout flow' }

    it('ctx:pick registers picked paths as opaque refs with a ~ hint, de-duplicated', async () => {
      const home = mkdtempSync(join(tmpdir(), 'ao-home-'))
      const folder = join(home, 'code', 'shop-api')
      mkdirSync(folder, { recursive: true })
      const { app, call, picked } = setup({}, { homeDir: home, runner: new FakeAgentRunner() })
      await app.start()
      picked.paths = [folder]
      const [ref] = (await call(IPC.ctxPick, 'folder')) as ContextRef[]
      expect(picked.kind).toBe('folder')
      expect(ref).toEqual({
        ref: expect.stringMatching(/^ctx_[a-z0-9]{12}$/),
        kind: 'folder',
        label: 'shop-api',
        hint: '~/code/shop-api',
      })
      expect(JSON.stringify(ref)).not.toContain(home)
      // Same path again → same ref.
      const [again] = (await call(IPC.ctxPick, 'folder')) as ContextRef[]
      expect(again!.ref).toBe(ref!.ref)
      // Files: up to 10 per pick.
      picked.paths = Array.from({ length: 12 }, (_, i) => join(folder, `f${i}.md`))
      const files = (await call(IPC.ctxPick, 'files')) as ContextRef[]
      expect(files).toHaveLength(10)
      expect(files[0]).toMatchObject({ kind: 'file', label: 'f0.md' })
      // A cancelled dialog returns nothing.
      picked.paths = []
      expect(await call(IPC.ctxPick, 'files')).toEqual([])
    })

    it('starts, messages and stops a session through IPC; exposes managedCount/stopAll', async () => {
      const home = mkdtempSync(join(tmpdir(), 'ao-home-'))
      const folder = join(home, 'shop-api')
      mkdirSync(folder)
      const runner = new FakeAgentRunner()
      const { app, call, picked } = setup({}, { homeDir: home, runner })
      await app.start()
      picked.paths = [folder]
      const [ref] = (await call(IPC.ctxPick, 'folder')) as ContextRef[]
      const started = (await call(IPC.sessStart, { ...START, folder: ref!.ref })) as StartResult
      expect(started).toEqual({ ok: true, agentId: 'cc:sess-1' })
      expect(runner.last().options).toMatchObject({ cwd: folder, mode: 'plan' })
      expect(app.managedCount()).toBe(1)
      // A follow-up with the folder attached: the runner receives the absolute path.
      const sent = (await call(IPC.send, {
        agentId: 'cc:sess-1',
        text: 'look here',
        context: [ref!.ref],
      })) as SendResult
      expect(sent).toMatchObject({ ok: true, message: { state: 'delivered' } })
      expect(runner.last().prompts.at(-1)).toContain(`- folder: ${folder}`)
      // Permission cards carry a ~-abbreviated location.
      void runner.last().ask('Bash', { command: 'ls' })
      expect(app.office.sessions!.pending('cc:sess-1')[0]?.where).toBe('~/shop-api')
      await app.stopAll()
      expect(app.managedCount()).toBe(0)
      expect(runner.last().closed).toBe(true)
    })

    it('stopping the app stops managed sessions', async () => {
      const home = mkdtempSync(join(tmpdir(), 'ao-home-'))
      const runner = new FakeAgentRunner()
      const { app, call, picked } = setup({}, { homeDir: home, runner })
      await app.start()
      picked.paths = [home]
      const [ref] = (await call(IPC.ctxPick, 'folder')) as ContextRef[]
      await call(IPC.sessStart, { ...START, folder: ref!.ref })
      await app.stop()
      expect(runner.last().closed).toBe(true)
    })

    it('the transcript tailer skips managed sessions', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ao-skip-'))
      const projects = join(dir, 'projects')
      mkdirSync(join(projects, 'p'), { recursive: true })
      const line = (sid: string) =>
        JSON.stringify({
          type: 'user',
          sessionId: sid,
          timestamp: new Date(Date.now() + 60_000).toISOString(), // newer than the managed agent
          cwd: '/w/from-transcript',
          message: { content: 'x' },
        }) + '\n'
      writeFileSync(join(projects, 'p', 'sess-1.jsonl'), line('sess-1'))
      writeFileSync(join(projects, 'p', 'other.jsonl'), line('other'))
      const runner = new FakeAgentRunner()
      runner.autoInit = true
      const { app } = setup(
        { AGENT_OFFICE_CLAUDE: '1', CLAUDE_PROJECTS_DIR: projects },
        { homeDir: dir, runner },
      )
      await app.office.settings.update({ discoverCapabilities: false })
      // Start the session before the backend's first tailer tick.
      await app.office.sessions!.start({
        cwd: dir,
        name: 'shop',
        mode: 'default',
        extraDirs: [],
        chrome: false,
        first: { text: 'hi', context: [], use: [] },
      })
      await app.start()
      await wait(80)
      expect(app.office.query.agent('cc:other')?.source).toBe('claude-code')
      // Unskipped, the transcript line would rename the agent after its cwd.
      expect(app.office.query.agent('cc:sess-1')?.name).toBe('shop')
    })

    it('AGENT_OFFICE_FAKE_RUNNER=1 selects the scripted runner (replies "ok")', async () => {
      const home = mkdtempSync(join(tmpdir(), 'ao-home-'))
      const { app, call, picked } = setup(
        {},
        { homeDir: home, processEnv: { AGENT_OFFICE_FAKE_RUNNER: '1' } },
      )
      await app.start()
      picked.paths = [home]
      const [ref] = (await call(IPC.ctxPick, 'folder')) as ContextRef[]
      const r = (await call(IPC.sessStart, { ...START, folder: ref!.ref })) as StartResult
      expect(r.ok).toBe(true)
      const agentId = (r as { agentId: string }).agentId
      expect(agentId).toMatch(/^cc:fake-/)
      await wait(500)
      expect(app.office.chat.history(agentId).map((m) => m.text)).toContain('ok')
    })

    it('without the fake flag the SDK runner is wired (not started until a session starts)', async () => {
      const { app } = setup({}, { processEnv: { PATH: '' } })
      await app.start()
      expect(app.office.sessions).toBeDefined()
      expect(app.managedCount()).toBe(0)
    })
  })
})

describe('compose: providers', () => {
  const probe: ProviderProbe = {
    provider: 'claude-code',
    detect: async () => ({ installed: true, version: '2.1.270', flagsOk: true, auth: 'unknown' }),
  }

  it('lists claude-code in connection info and over prov:list', async () => {
    const { app, call } = setup({}, { claudeProbe: probe })
    await app.start()
    const info = (await call(IPC.connInfo)) as ConnectionInfo
    expect(info.providers?.map((p) => p.id)).toContain('claude-code')
    const claude = info.providers!.find((p) => p.id === 'claude-code')!
    expect(claude.version).toBe('2.1.270')
    const listed = (await call(IPC.provList)) as { id: string }[]
    expect(listed.map((p) => p.id)).toContain('claude-code')
  })

  it('pushes connection info after a provider action', async () => {
    const scheduler = new ManualScheduler()
    const { app, call, window } = setup({}, { claudeProbe: probe, scheduler })
    await app.start()
    scheduler.fireTimers()
    await wait(20)
    window.sent = []
    await call(IPC.provRefresh, {})
    scheduler.fireTimers()
    await wait(20)
    expect(window.sent.some(([c]) => c === IPC.connChanged)).toBe(true)
  })
})

describe('compose: codex', () => {
  const START: StartSession = {
    provider: 'codex',
    modeId: 'ask',
    cwd: tmpdir(),
    name: 'cx',
    mode: 'default',
    extraDirs: [],
    chrome: false,
    first: { text: 'hi', context: [], use: [] },
  }
  const codexDecl: RunnerDecl = { provider: 'codex', prefix: 'cx:', caps: ['send-message'] }

  it('lists codex disabled by default', async () => {
    const { app, call } = setup()
    await app.start()
    const info = (await call(IPC.connInfo)) as ConnectionInfo
    expect(info.providers?.find((p) => p.id === 'codex')).toMatchObject({ enabled: false })
    expect(app.managedCount()).toBe(0)
  })

  it('routes a codex session to the codex runtime, not the claude one', async () => {
    const codexRunner = new FakeAgentRunner(codexDecl)
    const claude = new FakeAgentRunner()
    const { app } = setup({}, { runner: claude, codexRunner })
    await app.start()
    await app.office.providers.setEnabled('codex', true)
    const id = await app.office.sessions!.start({ ...START })
    expect(id).toMatch(/^cx:/)
    expect(codexRunner.sessions).toHaveLength(1)
    expect(claude.sessions).toHaveLength(0)
    // The quit guard sees it: stopAll ends codex sessions too.
    expect(app.managedCount()).toBe(1)
    await app.stopAll()
    expect(codexRunner.last().closed).toBe(true)
  })

  it('AGENT_OFFICE_FAKE_PROVIDERS=1 with a fakes dir runs the fake app-server as codex', async () => {
    const fakesDir = join(import.meta.dirname, '..', '..', '..', 'adapters', 'test', 'fakes')
    const { app } = setup(
      {},
      { fakesDir, codexProbe: undefined, processEnv: { AGENT_OFFICE_FAKE_PROVIDERS: '1' } },
    )
    await app.start()
    const info = (await app.office.providers.list()).find((p) => p.id === 'codex')
    expect(info?.enabled).toBe(false)
    await app.office.providers.setEnabled('codex', true)
    const status = (await app.office.providers.list()).find((p) => p.id === 'codex')
    expect(status).toMatchObject({ state: 'managed-available' })
    const id = await app.office.sessions!.start({ ...START })
    expect(id).toMatch(/^cx:/)
    await app.stopAll()
  })

  it('warns and uses the real CLI when fake providers are requested without a fakes dir (packaged)', async () => {
    const warnings: string[] = []
    const dir = mkdtempSync(join(tmpdir(), 'ao-comp-'))
    const fake = fakeShell()
    const app = compose({
      shell: fake.shell,
      env: loadEnv({ AGENT_OFFICE_HOME: join(dir, 'h'), PORT: '0', AGENT_OFFICE_CLAUDE: '0' }, dir),
      userDataDir: join(dir, 'u'),
      hookScript: '/x',
      execPath: '/x',
      runAsNode: true,
      releaseUrl: 'https://example.invalid',
      logger: { info: () => {}, warn: (m: string) => warnings.push(m) },
      processEnv: { AGENT_OFFICE_FAKE_PROVIDERS: '1' },
      claudeProbe: {
        provider: 'claude-code',
        detect: async () => ({ installed: false, flagsOk: false, auth: 'unknown' }),
      },
    })
    apps.push(app)
    expect(warnings.join()).toContain('AGENT_OFFICE_FAKE_PROVIDERS')
  })
})

// Multi-provider plan §5: Cursor, Gemini CLI and Copilot CLI join through ACP runtimes and
// observation hooks; every hook path points at temp files (never the user's real configs).
describe('compose: acp providers and observation hooks', () => {
  const START: StartSession = {
    provider: 'cursor',
    modeId: 'agent',
    cwd: tmpdir(),
    name: 'cu',
    mode: 'default',
    extraDirs: [],
    chrome: false,
    first: { text: 'hi', context: [], use: [] },
  }

  it('lists all six providers, the new ones disabled by default', async () => {
    const { app } = setup()
    await app.start()
    const ids = (await app.office.providers.list()).map((p) => p.id)
    expect(ids).toEqual([...PROVIDER_IDS])
    const cursor = (await app.office.providers.list()).find((p) => p.id === 'cursor')
    expect(cursor).toMatchObject({ enabled: false })
  })

  it('routes a cursor session to the cursor runtime', async () => {
    const cursorRunner = new FakeAgentRunner({
      provider: 'cursor',
      prefix: 'cu:',
      caps: ['send-message'],
    })
    const { app } = setup(
      {},
      {
        providerOverrides: noRealClis({
          cursor: { probe: notInstalled('cursor'), runner: cursorRunner },
        }),
      },
    )
    await app.start()
    await app.office.providers.setEnabled('cursor', true)
    expect(await app.office.sessions!.start({ ...START })).toMatch(/^cu:/)
    expect(cursorRunner.sessions).toHaveLength(1)
    await app.stopAll()
  })

  it('AGENT_OFFICE_FAKE_PROVIDERS=1 runs the fake ACP agent as cursor', async () => {
    const fakesDir = join(import.meta.dirname, '..', '..', '..', 'adapters', 'test', 'fakes')
    const { app } = setup(
      {},
      {
        fakesDir,
        providerOverrides: {},
        processEnv: { AGENT_OFFICE_FAKE_PROVIDERS: '1' },
      },
    )
    await app.start()
    await app.office.providers.setEnabled('cursor', true)
    expect((await app.office.providers.list()).find((p) => p.id === 'cursor')).toMatchObject({
      state: 'managed-available',
    })
    expect(await app.office.sessions!.start({ ...START })).toMatch(/^cu:/)
    await app.stopAll()
  })

  describe.each(OSS_ACP.map((id) => [id, PROVIDER_DECLS[id].prefix] as const))(
    'open-source runtime %s',
    (id, prefix) => {
      const start = { ...START, provider: id, modeId: undefined } as StartSession

      it('routes a session to its own runtime', async () => {
        const runner = new FakeAgentRunner({ provider: id, prefix, caps: ['send-message'] })
        const { app } = setup(
          {},
          { providerOverrides: noRealClis({ [id]: { probe: notInstalled(id), runner } }) },
        )
        await app.start()
        await app.office.providers.setEnabled(id, true)
        expect(await app.office.sessions!.start(start)).toMatch(new RegExp(`^${prefix}`))
        expect(runner.sessions).toHaveLength(1)
        await app.stopAll()
      })

      it('runs the fake ACP agent with AGENT_OFFICE_FAKE_PROVIDERS=1', async () => {
        const fakesDir = join(import.meta.dirname, '..', '..', '..', 'adapters', 'test', 'fakes')
        const { app } = setup(
          {},
          {
            fakesDir,
            providerOverrides: {},
            processEnv: { AGENT_OFFICE_FAKE_PROVIDERS: '1' },
          },
        )
        await app.start()
        await app.office.providers.setEnabled(id, true)
        expect((await app.office.providers.list()).find((p) => p.id === id)).toMatchObject({
          state: 'managed-available',
        })
        expect(await app.office.sessions!.start(start)).toMatch(new RegExp(`^${prefix}`))
        await app.stopAll()
      })

      it('is disabled by default and has no hook installer', async () => {
        const { app } = setup()
        await app.start()
        expect((await app.office.providers.list()).find((p) => p.id === id)).toMatchObject({
          enabled: false,
        })
      })
    },
  )

  it('installs cursor observation hooks into the configured file, keeping foreign hooks', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ao-hooks-'))
    const file = join(tmp, 'hooks.json')
    writeFileSync(
      file,
      JSON.stringify({ version: 1, hooks: { stop: [{ command: 'my-own-hook' }] } }),
    )
    const { app, call } = setup({}, { processEnv: { CURSOR_HOOKS_FILE: file } })
    await app.start()
    expect(await call(IPC.provHooksInstall, { provider: 'cursor' })).toBe('installed')
    const json = JSON.parse(readFileSync(file, 'utf8')) as {
      hooks: Record<string, { command: string }[]>
    }
    expect(json.hooks.stop!.map((h) => h.command)).toContain('my-own-hook')
    expect(json.hooks.stop!.some((h) => h.command.includes('agent-office-observe'))).toBe(true)
    expect(json.hooks.preToolUse).toBeUndefined()
    expect(await call(IPC.provHooksRemove, { provider: 'cursor' })).toBe('not-installed')
    const after = JSON.parse(readFileSync(file, 'utf8')) as typeof json
    expect(after.hooks.stop!.map((h) => h.command)).toEqual(['my-own-hook'])
  })
})

describe('compose with a projects vault', () => {
  const KEY = 'wk_' + 'c'.repeat(32)

  it('loads the vault before serving IPC, warns when it is memory-only, and exposes prj:*', async () => {
    const { app, call, handlers, window } = setup({}, { vault: new MemoryRecordLog() })
    await app.start()
    expect([...handlers.keys()]).toEqual(expect.arrayContaining([IPC.prjList, IPC.prjCreate]))
    const created = (await call(IPC.prjCreate, { name: 'Shop', folders: [] })) as { id: string }
    expect(((await call(IPC.prjList)) as { id: string }[]).map((p) => p.id)).toEqual([created.id])
    // The memory-only vault shows the banner (alongside the port banner mechanism).
    expect(app.banner()).toEqual(VAULT_MEMORY_ONLY_BANNER)
    await call(IPC.ready)
    await wait(10)
    expect(window.sent.filter(([c]) => c === IPC.banner).at(-1)![1]).toEqual(
      VAULT_MEMORY_ONLY_BANNER,
    )
  })

  it('exposes the harness channels with a vault and none without', async () => {
    const withVault = setup({}, { vault: new MemoryRecordLog() })
    await withVault.app.start()
    expect([...withVault.handlers.keys()]).toEqual(
      expect.arrayContaining([IPC.hrnList, IPC.hrnImportDetect, IPC.hrnRunGates, IPC.hrnBadges]),
    )
    // A fresh vault holds no harnesses yet; the call goes through the real core service.
    expect(await withVault.call(IPC.hrnList)).toEqual([])
    const bare = setup()
    await bare.app.start()
    expect([...bare.handlers.keys()]).not.toContain(IPC.hrnList)
  })

  it('imports goose history when goose is on, and reads its transcript through the router', async () => {
    const gooseCli = async (args: string[]) =>
      args[1] === 'list'
        ? JSON.stringify([
            {
              id: '20260101_1',
              working_dir: '/work/shop',
              name: 'Invented goose task',
              created_at: '2026-01-01T10:00:00Z',
              last_message_at: '2026-01-01T10:04:00Z',
            },
          ])
        : JSON.stringify({
            conversation: [
              {
                id: 'm1',
                role: 'user',
                created: 1,
                content: [{ type: 'text', text: 'Invented question' }],
              },
            ],
          })
    const { app } = setup({}, { vault: new MemoryRecordLog(), gooseCli })
    await app.start()
    const projects = app.office.projects!
    // goose is off: nothing of it is listed (Claude's folder is empty too).
    expect(await projects.history.importHistory({ limit: 10 })).toEqual({ imported: 0, skipped: 0 })
    await app.office.providers.setEnabled('goose', true)
    expect(await projects.history.importHistory({ limit: 10 })).toEqual({ imported: 1, skipped: 0 })
    const [rec] = projects.sessions.list({})
    expect(rec).toMatchObject({ provider: 'goose', origin: 'imported', hasTranscript: true })
    const page = await projects.sessions.messages({ sessionId: rec!.id, limit: 10 })
    expect(page.messages.map((m) => m.text)).toEqual(['Invented question'])
    await app.stopAll()
  })

  it('imports OpenCode history through the fake server and observes a user-run server when opted in', async () => {
    const fakesDir = join(import.meta.dirname, '..', '..', '..', 'adapters', 'test', 'fakes')
    const fixDir = mkdtempSync(join(tmpdir(), 'ao-comp-oc-'))
    const fixture = join(fixDir, 'fixture.json')
    writeFileSync(
      fixture,
      JSON.stringify({
        sessions: [
          {
            id: 'ses_inv1',
            title: 'Invented OpenCode task',
            directory: '/work/shop',
            time: { created: 1, updated: 2 },
          },
        ],
        messages: {
          ses_inv1: [
            {
              info: { id: 'msg_1', role: 'user', time: { created: 1 } },
              parts: [{ type: 'text', text: 'Invented question' }],
            },
          ],
        },
        events: [],
      }),
    )
    const { app } = setup(
      {},
      {
        vault: new MemoryRecordLog(),
        fakesDir,
        processEnv: { AGENT_OFFICE_FAKE_PROVIDERS: '1', FAKE_OC_FIXTURE: fixture },
      },
    )
    await app.start()
    const projects = app.office.projects!
    // OpenCode is off: nothing is listed and no server is started.
    expect(await projects.history.importHistory({ limit: 10 })).toEqual({ imported: 0, skipped: 0 })
    await app.office.providers.setEnabled('opencode', true)
    expect(await projects.history.importHistory({ limit: 10 })).toEqual({ imported: 1, skipped: 0 })
    const rec = projects.sessions.list({}).find((r) => r.provider === 'opencode')!
    expect(rec).toMatchObject({ origin: 'imported', hasTranscript: true })
    const page = await projects.sessions.messages({ sessionId: rec.id, limit: 10 })
    expect(page.messages.map((m) => m.text)).toEqual(['Invented question'])

    // Observe: a server the user runs (here a tiny SSE stand-in) is read once the setting is on.
    const { createServer: createHttp } = await import('node:http')
    const srv = createHttp((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        `data: ${JSON.stringify({ payload: { type: 'session.status', properties: { sessionID: 'ses_live9', status: { type: 'busy' } } } })}\n\n`,
      )
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as { port: number }).port
    try {
      expect(app.office.query.agent('oc:ses_live9')).toBeUndefined()
      await app.office.settings.update({ openCodeObserve: { enabled: true, port } })
      for (let i = 0; i < 200 && !app.office.query.agent('oc:ses_live9'); i++) await wait(10)
      expect(app.office.query.agent('oc:ses_live9')).toMatchObject({
        provider: 'opencode',
        status: 'thinking',
      })
      await app.office.settings.update({ openCodeObserve: { enabled: false, port } })
    } finally {
      srv.closeAllConnections()
      srv.close()
      await app.stopAll()
      rmSync(fixDir, { recursive: true, force: true })
    }
  })

  it('has no prj channels without a vault', async () => {
    const { app, handlers } = setup()
    await app.start()
    expect(handlers.has(IPC.prjList)).toBe(false)
  })

  it('writes the MCP wrapper and serves /mcp only with a bearer token', async () => {
    const { app, dir } = setup({}, { vault: new MemoryRecordLog() })
    await app.start()
    expect(existsSync(join(dir, 'userData', 'mcp', 'agent-office-mcp.sh'))).toBe(true)
    const res = await fetch(`http://127.0.0.1:${app.apiPort()}/mcp`, {
      method: 'POST',
      headers: { host: `localhost:${app.apiPort()}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(401)
  })

  it('locates an agent from an observe hook workspace key without exposing the key', async () => {
    const { app, dir, call } = setup({}, { vault: new MemoryRecordLog() })
    await app.start()
    const token = readFileSync(join(dir, 'home', 'token'), 'utf8').trim()
    const res = await fetch(`http://127.0.0.1:${app.apiPort()}/api/events`, {
      method: 'POST',
      headers: {
        host: `localhost:${app.apiPort()}`,
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        agentId: 'cur:1',
        provider: 'cursor',
        status: 'thinking',
        workspace: KEY,
      }),
    })
    expect(res.status).toBe(202)
    await wait(50)
    const sessions = (await call(IPC.prjSessions, {})) as { agentId?: string }[]
    expect(sessions.length).toBe(1)
    expect(JSON.stringify(await call(IPC.ready))).not.toContain(KEY)
    expect(JSON.stringify(sessions)).not.toContain(KEY)
  })

  function writeHistory(dir: string) {
    const pdir = join(dir, 'claude', 'projects')
    mkdirSync(join(pdir, '-work-shop'), { recursive: true })
    const file = join(pdir, '-work-shop', 'sess-hist-1.jsonl')
    writeFileSync(
      file,
      JSON.stringify({
        type: 'user',
        sessionId: 'sess-hist-1',
        cwd: '/work/SENTINEL-shop',
        timestamp: '2026-01-01T10:00:00.000Z',
        message: { role: 'user', content: 'SENTINEL-body' },
      }) +
        '\n' +
        JSON.stringify({ type: 'ai-title', sessionId: 'sess-hist-1', aiTitle: 'Fix checkout' }) +
        '\n',
    )
    // Old enough that the live tailer ignores it (recent files are already observed sessions).
    const old = new Date(Date.now() - 3 * 86_400_000)
    utimesSync(file, old, old)
    return pdir
  }

  it('imports Claude history as imported, resumable records when claudeAdapter is on (idempotent, no leak)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ao-hist-'))
    const { app, call } = setup(
      { AGENT_OFFICE_CLAUDE: '1', CLAUDE_PROJECTS_DIR: writeHistory(dir) },
      { vault: new MemoryRecordLog() },
    )
    await app.start()
    expect(await call(IPC.prjImportHistory, {})).toEqual({ imported: 1, skipped: 0 })
    expect(await call(IPC.prjImportHistory, {})).toEqual({ imported: 0, skipped: 1 })
    const sessions = (await call(IPC.prjSessions, {})) as {
      origin: string
      title: string
      canResume?: boolean
      hasTranscript: boolean
    }[]
    expect(sessions.find((x) => x.origin === 'imported')).toMatchObject({
      title: 'Fix checkout',
      canResume: true,
      hasTranscript: true,
    })
    expect(JSON.stringify(sessions)).not.toMatch(/SENTINEL|\/work\//)
  })

  it('imports nothing while the Claude adapter is off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ao-hist-'))
    const { app, call } = setup(
      { AGENT_OFFICE_CLAUDE: '0', CLAUDE_PROJECTS_DIR: writeHistory(dir) },
      { vault: new MemoryRecordLog() },
    )
    await app.start()
    expect(await call(IPC.prjImportHistory, {})).toEqual({ imported: 0, skipped: 0 })
  })

  it('tasks flow over IPC and show up on the dashboard', async () => {
    const { app, call } = setup({}, { vault: new MemoryRecordLog() })
    await app.start()
    const prj = (await call(IPC.prjCreate, { name: 'Shop', folders: [] })) as { id: string }
    const t = (await call(IPC.prjTaskCreate, { projectId: prj.id, title: 'Ship it' })) as {
      id: string
    }
    await call(IPC.prjTaskUpdate, { taskId: t.id, state: 'done', confirm: true })
    const list = (await call(IPC.prjTasks, prj.id)) as { state: string; evidence?: unknown }[]
    expect(list).toHaveLength(1)
    expect(list[0]!.state).toBe('done')
    const dash = (await call(IPC.prjDashboard, { projectId: prj.id })) as {
      tasks: { id: string }[]
      completed: { evidence: string }[]
    }
    expect(dash.tasks.map((x) => x.id)).toEqual([t.id])
    expect(dash.completed[0]!.evidence).toBe('user-confirmed')
  })

  /** A past Claude session with one agent reply (invented content), old enough for the tailer. */
  function writeKnowledgeHistory(dir: string) {
    const pdir = join(dir, 'claude', 'projects')
    mkdirSync(join(pdir, '-work-know'), { recursive: true })
    const file = join(pdir, '-work-know', 'sess-know-1.jsonl')
    const lines = [
      {
        type: 'user',
        uuid: 'u1',
        sessionId: 'sess-know-1',
        cwd: '/work/nowhere-know',
        timestamp: '2026-01-01T10:00:00.000Z',
        message: { role: 'user', content: 'SENTINEL-prompt' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        sessionId: 'sess-know-1',
        timestamp: '2026-01-01T10:01:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Invented reply KNOW-77' }] },
      },
      { type: 'ai-title', sessionId: 'sess-know-1', aiTitle: 'Know the thing' },
    ]
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const old = new Date(Date.now() - 3 * 86_400_000)
    utimesSync(file, old, old)
    return pdir
  }

  async function until<T>(fn: () => Promise<T | undefined | false>, ms = 3000): Promise<T> {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > end) throw new Error('timed out')
      await wait(20)
    }
  }

  type Status = { on: boolean; added: number; lastRunAt?: number }
  type Mem = { id: string; state: string; title: string; provenance: { reviewedAt?: number } }

  it('automatic import: opting in records the approval in main, imports, removes, turns off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ao-know-'))
    const { app, call, handlers } = setup(
      { AGENT_OFFICE_CLAUDE: '1', CLAUDE_PROJECTS_DIR: writeKnowledgeHistory(dir) },
      { vault: new MemoryRecordLog() },
    )
    await app.start()
    expect(await call(IPC.prjImportStatus)).toMatchObject({ on: false })
    // The renderer can never set the approval time itself.
    await expect(call(IPC.settingsSet, { autoImportApprovedAt: 1 })).rejects.toThrow(
      /invalid settings/,
    )
    // The user confirms the opt-in: main records when, then the first run imports the session.
    await call(IPC.settingsSet, { autoImportHistory: true })
    const status = await until(async () => {
      const s = (await call(IPC.prjImportStatus)) as Status
      return s.on && s.lastRunAt !== undefined ? s : undefined
    })
    expect(status.added).toBe(1)
    const settings = (await call(IPC.settingsGet)) as { autoImportApprovedAt?: number }
    expect(settings.autoImportApprovedAt).toBeGreaterThan(0)
    const items = (await call(IPC.prjMemories, {
      scope: 'unassigned',
      origin: 'session-import',
    })) as Mem[]
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ state: 'approved', title: 'Session: Know the thing' })
    expect(items[0]!.provenance.reviewedAt).toBe(settings.autoImportApprovedAt)
    expect(JSON.stringify(items)).not.toContain('SENTINEL')
    // Only the trusted renderer may remove them.
    await expect(handlers.get(IPC.prjRemoveImported)!('https://evil.example')).rejects.toThrow(
      /untrusted/,
    )
    expect(await call(IPC.prjRemoveImported)).toEqual({ removed: 1 })
    // Turning it off stops the import; the approval time stays recorded.
    await call(IPC.settingsSet, { autoImportHistory: false })
    expect(await call(IPC.prjImportStatus)).toMatchObject({ on: false })
    expect(
      ((await call(IPC.settingsGet)) as { autoImportApprovedAt?: number }).autoImportApprovedAt,
    ).toBe(settings.autoImportApprovedAt)
  })

  it('automatic import starts at launch when saved on, and stays off without the Claude adapter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ao-know-'))
    const on = setup(
      { AGENT_OFFICE_CLAUDE: '1', CLAUDE_PROJECTS_DIR: writeKnowledgeHistory(dir) },
      { vault: new MemoryRecordLog() },
    )
    await on.app.office.settings.update({ autoImportHistory: true, autoImportApprovedAt: 123 })
    await on.app.start()
    const items = await until(async () => {
      const list = (await on.call(IPC.prjMemories, { scope: 'unassigned' })) as Mem[]
      return list.length ? list : undefined
    })
    expect(items[0]!.provenance.reviewedAt).toBe(123)

    const off = setup(
      { AGENT_OFFICE_CLAUDE: '0', CLAUDE_PROJECTS_DIR: writeKnowledgeHistory(dir) },
      { vault: new MemoryRecordLog() },
    )
    await off.app.office.settings.update({ autoImportHistory: true, autoImportApprovedAt: 123 })
    await off.app.start()
    expect(await off.call(IPC.prjImportStatus)).toMatchObject({ on: false })
  })
})
