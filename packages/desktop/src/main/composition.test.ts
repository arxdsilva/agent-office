import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEnv } from '@agent-office/adapters'
import {
  FakeWindow,
  fakePlatform,
  ManualScheduler,
  RecordingLoginItem,
  RecordingNotifier,
  RecordingTray,
  ScriptedUpdater,
} from '@agent-office/core/testing'
import { IPC, type ConnectionInfo, type ServerMessage } from '@agent-office/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { compose, type Shell } from './composition.ts'

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

function fakeShell() {
  const handlers = new Map<string, (senderUrl: string | undefined, ...args: unknown[]) => unknown>()
  let quit = 0
  const copied: string[] = []
  const shell: Shell = {
    clipboard: { writeText: (t) => copied.push(t) },
    notifier: new RecordingNotifier(),
    tray: new RecordingTray(),
    loginItem: new RecordingLoginItem(),
    updater: new ScriptedUpdater(),
    platform: fakePlatform({ packaged: false, platform: 'darwin' }),
    window: new FakeShellWindow(),
    ipc: { handle: (c, fn) => handlers.set(c, fn), removeAll: () => handlers.clear() },
    rendererUrl: 'app://renderer/index.html',
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
  }
}

const apps: { stop(): Promise<void> }[] = []
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop()
})

function setup(
  envVars: Record<string, string | undefined> = {},
  opts: { scheduler?: ManualScheduler; homeDir?: string } = {},
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
    expect(info).toEqual({
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

  it('stop closes the API and unregisters IPC', async () => {
    const { app, handlers } = setup()
    await app.start()
    const port = app.apiPort()
    await app.stop()
    expect(handlers.size).toBe(0)
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow()
    await app.stop()
  })
})
