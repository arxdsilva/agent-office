import { DEFAULT_SETTINGS, IPC, type ServerMessage } from '@agent-office/shared'
import { ManualScheduler } from '@agent-office/core/testing'
import { UnknownAgentError, ValidationError } from '@agent-office/core'
import { describe, expect, it, vi } from 'vitest'
import { createIpcHandlers, createPushBridge, registerIpc, type IpcPorts } from './ipc-api.ts'

function ports(over: Partial<IpcPorts> = {}): IpcPorts {
  return {
    query: { snapshot: () => ({ agents: [], messages: [] }), agents: () => [], agent: () => undefined, watch: () => () => {} },
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
    hooks: { status: async () => 'not-installed', install: async () => 'installed', uninstall: async () => 'not-installed', heal: async () => {} },
    updates: { state: () => ({ policy: 'off', status: 'idle' }), check: async () => ({ policy: 'off', status: 'idle' }), install: vi.fn(), onChange: () => () => {} },
    version: '1.2.3',
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
    expect(await h[IPC.send]!({ agentId: 'a', text: 'hi' })).toMatchObject({ ok: true, message: { text: 'hi' } })
    expect(await h[IPC.send]!({ agentId: 'ghost', text: 'hi' })).toEqual({ ok: false, error: 'unknown agent: ghost' })
    expect(await h[IPC.send]!({ agentId: 'a', text: '' })).toMatchObject({ ok: false })
    expect(await h[IPC.send]!('garbage')).toMatchObject({ ok: false })
  })

  it('validates settings patches strictly', async () => {
    const h = createIpcHandlers(ports())
    expect(await h[IPC.settingsSet]!({ notifications: false })).toMatchObject({ settings: { notifications: false } })
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

describe('registerIpc', () => {
  it('rejects calls from untrusted senders before reaching a handler', async () => {
    const registered = new Map<string, (senderUrl: string | undefined, ...args: unknown[]) => unknown>()
    const handler = vi.fn(async () => 'ok')
    registerIpc({ handle: (c, fn) => registered.set(c, fn) }, { [IPC.version]: handler }, (url) => url === 'app://ok')
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
    const stop = createPushBridge({ watch: (fn) => ((emit = fn), () => (emit = () => {})) }, (c, p) => sent.push([c, p]), scheduler)
    emit({ type: 'remove', id: 'a' })
    emit({ type: 'remove', id: 'b' })
    expect(sent).toEqual([])
    scheduler.fireTimers()
    expect(sent).toEqual([[IPC.push, [{ type: 'remove', id: 'a' }, { type: 'remove', id: 'b' }]]])
    scheduler.fireTimers()
    expect(sent).toHaveLength(1)
    stop()
    emit({ type: 'remove', id: 'c' })
    scheduler.fireTimers()
    expect(sent).toHaveLength(1)
  })
})
