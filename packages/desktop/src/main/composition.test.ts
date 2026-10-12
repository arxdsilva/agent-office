import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEnv } from '@agent-office/adapters'
import { FakeWindow, fakePlatform, RecordingLoginItem, RecordingNotifier, RecordingTray, ScriptedUpdater } from '@agent-office/core/testing'
import { IPC, type ServerMessage } from '@agent-office/shared'
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
  const shell: Shell = {
    notifier: new RecordingNotifier(),
    tray: new RecordingTray(),
    loginItem: new RecordingLoginItem(),
    updater: new ScriptedUpdater(),
    platform: fakePlatform({ packaged: false }),
    window: new FakeShellWindow(),
    ipc: { handle: (c, fn) => handlers.set(c, fn), removeAll: () => handlers.clear() },
    rendererUrl: 'app://renderer/index.html',
    quit: () => quit++,
  }
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!('app://renderer/index.html', ...args)
  return { shell, handlers, call, window: shell.window as FakeShellWindow, tray: shell.tray as RecordingTray, quits: () => quit }
}

const apps: { stop(): Promise<void> }[] = []
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop()
})

function setup(envVars: Record<string, string> = {}) {
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
    const health = await fetch(`http://127.0.0.1:${app.apiPort()}/api/health`, { headers: { host: `localhost:${app.apiPort()}` } })
    expect(await health.json()).toMatchObject({ ok: true })
    expect([...handlers.keys()]).toEqual(expect.arrayContaining([IPC.ready, IPC.send, IPC.settingsSet, IPC.hookInstall]))
    expect(tray.models.length).toBeGreaterThan(0)
    // The renderer asks for the snapshot; mock agents are there.
    const snap = (await call(IPC.ready)) as { agents: unknown[] }
    expect(snap.agents.length).toBeGreaterThan(5)
    // A change is pushed to the window, batched.
    app.office.activity.report([{ agentId: 'x', provider: 'custom' }])
    await wait(40)
    const pushes = window.sent.filter(([c]) => c === IPC.push).flatMap(([, p]) => p as ServerMessage[])
    expect(pushes.some((m) => m.type === 'upsert' && m.agent.id === 'x')).toBe(true)
  })

  it('keeps running with a banner when the port is busy', async () => {
    const blocker = createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
    const port = String((blocker.address() as { port: number }).port)
    const { app, window, call } = setup({ PORT: port })
    await app.start()
    expect(app.apiPort()).toBeUndefined()
    expect(app.banner()).toEqual({ kind: 'error', text: `Port ${port} is busy — change it in Settings.` })
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
    expect(claude.hooks.Stop[0].hooks[0].command).toContain(join(dir, 'userData', 'hook', 'agent-office-hook.sh'))
    expect(existsSync(join(dir, 'userData', 'hook', 'agent-office-hook.sh'))).toBe(true)
    await wait(1100)
    expect(tray.last?.items).toContainEqual({ label: 'Claude Code hook: installed ✓', enabled: false })
    await app.onTrayAction({ type: 'quit' })
    expect(quits()).toBe(1)
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
