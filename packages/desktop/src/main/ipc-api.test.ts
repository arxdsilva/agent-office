import {
  DEFAULT_SETTINGS,
  IPC,
  type ConnectionInfo,
  type ServerMessage,
} from '@agent-office/shared'
import { ManualScheduler } from '@agent-office/core/testing'
import {
  NotAllowedError,
  SessionStartError,
  UnknownAgentError,
  ValidationError,
} from '@agent-office/core'
import { describe, expect, it, vi } from 'vitest'
import { createIpcHandlers, createPushBridge, registerIpc, type IpcPorts } from './ipc-api.ts'

const INFO: ConnectionInfo = {
  api: {
    host: '127.0.0.1',
    port: 4317,
    listening: true,
    portBusy: false,
    tokenFile: '~/.agent-office/token',
  },
  claude: {
    enabled: true,
    projectsDir: '~/.claude/projects',
    projectsDirFound: true,
    activeSessions: 1,
  },
  hook: 'installed',
  mock: { enabled: false },
}

function ports(over: Partial<IpcPorts> = {}): IpcPorts {
  return {
    query: {
      snapshot: () => ({ agents: [], messages: [] }),
      agents: () => [],
      agent: () => undefined,
      watch: () => () => {},
    },
    chat: {
      send: (agentId, text) => {
        if (agentId === 'ghost') throw new UnknownAgentError(agentId)
        return { id: 'm1', agentId, from: 'user', text, ts: 1, state: 'queued' }
      },
      history: () => [],
    },
    settings: {
      get: async () => DEFAULT_SETTINGS,
      update: async (patch) => {
        if (patch.port === 1) throw new ValidationError('port: too small')
        return { settings: { ...DEFAULT_SETTINGS, ...patch }, restartRequired: false }
      },
    },
    hooks: {
      status: async () => 'not-installed',
      install: async () => 'installed',
      uninstall: async () => 'not-installed',
      heal: async () => {},
    },
    updates: {
      state: () => ({ policy: 'off', status: 'idle' }),
      check: async () => ({ policy: 'off', status: 'idle' }),
      install: vi.fn(),
      onChange: () => () => {},
    },
    version: '1.2.3',
    connections: {
      info: async () => INFO,
      test: async () => ({ ok: false, error: 'API not listening' }),
    },
    copyText: vi.fn(),
    onHookChanged: vi.fn(),
    onReady: vi.fn(),
    ...over,
  }
}

describe('createIpcHandlers', () => {
  it('serves the snapshot and notifies readiness', async () => {
    const p = ports()
    const h = createIpcHandlers(p)
    expect(await h[IPC.ready]!()).toEqual({ agents: [], messages: [] })
    expect(p.onReady).toHaveBeenCalled()
  })

  it('validates send arguments and maps domain errors to results', async () => {
    const h = createIpcHandlers(ports())
    expect(await h[IPC.send]!({ agentId: 'a', text: 'hi' })).toMatchObject({
      ok: true,
      message: { text: 'hi' },
    })
    expect(await h[IPC.send]!({ agentId: 'ghost', text: 'hi' })).toEqual({
      ok: false,
      error: 'unknown agent: ghost',
    })
    expect(await h[IPC.send]!({ agentId: 'a', text: '' })).toMatchObject({ ok: false })
    expect(await h[IPC.send]!('garbage')).toMatchObject({ ok: false })
  })

  it('validates settings patches strictly', async () => {
    const h = createIpcHandlers(ports())
    expect(await h[IPC.settingsSet]!({ notifications: false })).toMatchObject({
      settings: { notifications: false },
    })
    await expect(h[IPC.settingsSet]!({ hacked: true })).rejects.toThrow(/invalid settings/)
    await expect(h[IPC.settingsSet]!({ port: 1 })).rejects.toThrow(/port/)
    expect(await h[IPC.settingsGet]!()).toEqual(DEFAULT_SETTINGS)
  })

  it('hook actions report back so the tray can refresh', async () => {
    const p = ports()
    const h = createIpcHandlers(p)
    expect(await h[IPC.hookStatus]!()).toBe('not-installed')
    expect(await h[IPC.hookInstall]!()).toBe('installed')
    expect(await h[IPC.hookUninstall]!()).toBe('not-installed')
    expect(p.onHookChanged).toHaveBeenCalledTimes(2)
  })

  it('version and updates', async () => {
    const p = ports()
    const h = createIpcHandlers(p)
    expect(await h[IPC.version]!()).toBe('1.2.3')
    expect(await h[IPC.updateCheck]!()).toEqual({ policy: 'off', status: 'idle' })
    await h[IPC.updateInstall]!()
    expect(p.updates.install).toHaveBeenCalled()
  })
})

describe('connections and clipboard', () => {
  it('passes connection info and the test result through', async () => {
    const h = createIpcHandlers(ports())
    expect(await h[IPC.connInfo]!()).toEqual(INFO)
    expect(await h[IPC.connTest]!()).toEqual({ ok: false, error: 'API not listening' })
  })

  it('copies validated text only', async () => {
    const p = ports()
    const h = createIpcHandlers(p)
    await h[IPC.copyText]!('curl http://127.0.0.1:4317/api/events')
    expect(p.copyText).toHaveBeenCalledWith('curl http://127.0.0.1:4317/api/events')
    for (const bad of ['', 'x'.repeat(4001), 42, undefined])
      await expect(async () => h[IPC.copyText]!(bad)).rejects.toThrow('invalid text')
    expect(p.copyText).toHaveBeenCalledTimes(1)
  })
})

describe('registerIpc', () => {
  it('rejects calls from untrusted senders before reaching a handler', async () => {
    const registered = new Map<
      string,
      (senderUrl: string | undefined, ...args: unknown[]) => unknown
    >()
    const handler = vi.fn(async () => 'ok')
    registerIpc(
      { handle: (c, fn) => registered.set(c, fn) },
      { [IPC.version]: handler },
      (url) => url === 'app://ok',
    )
    await expect(registered.get(IPC.version)!('app://ok')).resolves.toBe('ok')
    await expect(registered.get(IPC.version)!('https://evil')).rejects.toThrow(/untrusted/)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('createPushBridge', () => {
  it('batches UI messages per frame and stops cleanly', () => {
    let emit: (m: ServerMessage) => void = () => {}
    const sent: unknown[] = []
    const scheduler = new ManualScheduler()
    const stop = createPushBridge(
      { watch: (fn) => ((emit = fn), () => (emit = () => {})) },
      (c, p) => sent.push([c, p]),
      scheduler,
    )
    emit({ type: 'remove', id: 'a' })
    emit({ type: 'remove', id: 'b' })
    expect(sent).toEqual([])
    scheduler.fireTimers()
    expect(sent).toEqual([
      [
        IPC.push,
        [
          { type: 'remove', id: 'a' },
          { type: 'remove', id: 'b' },
        ],
      ],
    ])
    scheduler.fireTimers()
    expect(sent).toHaveLength(1)
    stop()
    emit({ type: 'remove', id: 'c' })
    scheduler.fireTimers()
    expect(sent).toHaveLength(1)
  })
})

describe('managed sessions and context over IPC', () => {
  const FOLDER = 'ctx_aaaaaaaaaaaa'
  const FILE = 'ctx_bbbbbbbbbbbb'
  const GONE = 'ctx_cccccccccccc'
  const entry = (path: string, kind: 'file' | 'folder') => ({
    path,
    kind,
    label: path.split('/').pop()!,
    hint: path.replace('/Users/me', '~'),
  })
  const entries: Record<string, ReturnType<typeof entry>> = {
    [FOLDER]: entry('/Users/me/code/shop-api', 'folder'),
    [FILE]: entry('/Users/me/code/shop-api/README.md', 'file'),
    [GONE]: entry('/Users/me/deleted', 'folder'),
  }
  const ok = <T>(v: T) => vi.fn(async () => v)

  function managed(over: Partial<IpcPorts> = {}) {
    const sessions = {
      start: vi.fn(async () => 'cc:s1'),
      setMode: ok(undefined),
      setModel: ok(undefined),
      models: ok([{ id: 'opus', label: 'Opus' }]),
      interrupt: ok(undefined),
      stop: ok(undefined),
      answer: vi.fn(),
      pending: () => [],
      isManaged: () => true,
      isManagedSession: () => true,
      count: () => 1,
      stopAll: ok(undefined),
    }
    const compose = {
      send: vi.fn(async (agentId: string, m: { text: string }) => ({
        id: 'm1',
        agentId,
        from: 'user' as const,
        text: m.text,
        ts: 1,
        state: 'delivered' as const,
      })),
    }
    const context = {
      pick: vi.fn(async () => [
        { ref: FOLDER, kind: 'folder' as const, label: 'shop-api', hint: '~/code/shop-api' },
      ]),
      resolve: (ref: string) => entries[ref],
      exists: (path: string) => path !== '/Users/me/deleted',
    }
    const p = ports({ sessions, compose, context, ...over })
    return { h: createIpcHandlers(p), sessions, compose, context }
  }

  it('IPC-1 rejects bad payloads on every new channel', async () => {
    const { h, sessions } = managed()
    await expect(h[IPC.ctxPick]!('everything')).rejects.toThrow('invalid')
    expect(await h[IPC.sessStart]!({ folder: 'nope', text: 'x' })).toMatchObject({ ok: false })
    expect(await h[IPC.sessStart]!({ folder: FOLDER, text: 'x'.repeat(4001) })).toMatchObject({
      ok: false,
    })
    await expect(h[IPC.sessMode]!({ agentId: 'a', mode: 'yolo' })).rejects.toThrow('invalid')
    await expect(h[IPC.sessModel]!({ agentId: 'a', model: '' })).rejects.toThrow('invalid')
    await expect(h[IPC.sessModels]!(42)).rejects.toThrow('invalid')
    await expect(h[IPC.sessInterrupt]!({})).rejects.toThrow('invalid')
    await expect(h[IPC.sessStop]!(null)).rejects.toThrow('invalid')
    await expect(
      h[IPC.sessAnswer]!({ agentId: 'a', requestId: 'perm_bad', decision: 'allow' }),
    ).rejects.toThrow('invalid')
    expect(await h[IPC.send]!({ agentId: 'a', text: 'hi', context: ['ctx_zzzzzzzzzzzz'] })).toEqual(
      { ok: false, error: 'invalid context' },
    )
    expect(sessions.start).not.toHaveBeenCalled()
  })

  it('IPC-2 ctx:pick returns opaque refs without absolute paths', async () => {
    const { h, context } = managed()
    const refs = await h[IPC.ctxPick]!('folder')
    expect(context.pick).toHaveBeenCalledWith('folder')
    expect(JSON.stringify(refs)).not.toContain('/Users/me')
  })

  it('IPC-3 send resolves refs to absolute paths and use ids to labels for compose', async () => {
    const { h, compose } = managed()
    const r = await h[IPC.send]!({
      agentId: 'cc:s1',
      text: 'review',
      context: [FOLDER, FILE],
      use: ['mcp:claude-in-chrome', 'shell', 'skill:run-office', 'mcp:github', 'api:chat'],
    })
    expect(r).toMatchObject({ ok: true, message: { text: 'review' } })
    expect(compose.send).toHaveBeenCalledWith('cc:s1', {
      text: 'review',
      context: [
        {
          kind: 'folder',
          path: '/Users/me/code/shop-api',
          label: 'shop-api',
          hint: '~/code/shop-api',
        },
        {
          kind: 'file',
          path: '/Users/me/code/shop-api/README.md',
          label: 'README.md',
          hint: '~/code/shop-api/README.md',
        },
      ],
      use: [
        { id: 'mcp:claude-in-chrome', label: 'Chrome browser' },
        { id: 'shell', label: 'Shell' },
        { id: 'skill:run-office', label: 'run-office' },
        { id: 'mcp:github', label: 'github' },
        { id: 'api:chat', label: 'chat' },
      ],
    })
  })

  it('send maps domain errors to a failed result', async () => {
    const { h } = managed({
      compose: {
        send: async () => {
          throw new UnknownAgentError('x')
        },
      },
    })
    expect(await h[IPC.send]!({ agentId: 'x', text: 'hi' })).toEqual({
      ok: false,
      error: 'unknown agent: x',
    })
  })

  it('IPC-4 sess:start needs a picked, existing folder and maps start errors', async () => {
    const { h, sessions } = managed()
    expect(await h[IPC.sessStart]!({ folder: FILE, text: 'go' })).toEqual({
      ok: false,
      code: 'folder',
      error: 'choose a folder',
    })
    expect(await h[IPC.sessStart]!({ folder: GONE, text: 'go' })).toMatchObject({
      ok: false,
      code: 'folder',
    })
    expect(
      await h[IPC.sessStart]!({ folder: FOLDER, text: 'go', extraFolders: [FILE] }),
    ).toMatchObject({ ok: false, code: 'folder' })
    expect(
      await h[IPC.sessStart]!({ folder: FOLDER, text: 'go', context: ['ctx_zzzzzzzzzzzz'] }),
    ).toMatchObject({ ok: false, code: 'other', error: 'invalid context' })
    expect(sessions.start).not.toHaveBeenCalled()

    expect(
      await h[IPC.sessStart]!({
        folder: FOLDER,
        text: 'go',
        mode: 'plan',
        chrome: true,
        use: ['shell'],
      }),
    ).toEqual({ ok: true, agentId: 'cc:s1' })
    expect(sessions.start).toHaveBeenCalledWith({
      cwd: '/Users/me/code/shop-api',
      name: 'shop-api',
      mode: 'plan',
      extraDirs: [],
      chrome: true,
      first: { text: 'go', context: [], use: [{ id: 'shell', label: 'Shell' }] },
    })

    sessions.start.mockRejectedValueOnce(new SessionStartError('auth'))
    expect(
      await h[IPC.sessStart]!({ folder: FOLDER, text: 'go', name: 'x', model: 'opus' }),
    ).toEqual({ ok: false, code: 'auth', error: 'auth' })
    sessions.start.mockRejectedValueOnce(new NotAllowedError('Bypass is off'))
    expect(await h[IPC.sessStart]!({ folder: FOLDER, text: 'go' })).toEqual({
      ok: false,
      code: 'other',
      error: 'Bypass is off',
    })
    sessions.start.mockRejectedValueOnce(new Error('boom'))
    await expect(h[IPC.sessStart]!({ folder: FOLDER, text: 'go' })).rejects.toThrow('boom')
  })

  it('forwards mode, model, models, interrupt, stop and answer', async () => {
    const { h, sessions } = managed()
    await h[IPC.sessMode]!({ agentId: 'cc:s1', mode: 'acceptEdits' })
    await h[IPC.sessModel]!({ agentId: 'cc:s1', model: 'opus' })
    expect(await h[IPC.sessModels]!('cc:s1')).toEqual([{ id: 'opus', label: 'Opus' }])
    await h[IPC.sessModels]!(undefined)
    await h[IPC.sessInterrupt]!({ agentId: 'cc:s1' })
    await h[IPC.sessStop]!({ agentId: 'cc:s1' })
    await h[IPC.sessAnswer]!({
      agentId: 'cc:s1',
      requestId: 'perm_0a1b2c3d4e',
      decision: 'allow-session',
    })
    expect(sessions.setMode).toHaveBeenCalledWith('cc:s1', 'acceptEdits')
    expect(sessions.setModel).toHaveBeenCalledWith('cc:s1', 'opus')
    expect(sessions.models).toHaveBeenCalledWith('cc:s1')
    expect(sessions.models).toHaveBeenCalledWith()
    expect(sessions.interrupt).toHaveBeenCalledWith('cc:s1')
    expect(sessions.stop).toHaveBeenCalledWith('cc:s1')
    expect(sessions.answer).toHaveBeenCalledWith('cc:s1', 'perm_0a1b2c3d4e', 'allow-session')
  })

  it('without managed sessions, the session channels are absent and ctx:pick is too', () => {
    const h = createIpcHandlers(ports())
    expect(h[IPC.sessStart]).toBeUndefined()
    expect(h[IPC.ctxPick]).toBeUndefined()
  })
})
