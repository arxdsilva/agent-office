import {
  DomainError,
  type HookManagement,
  type OfficeQuery,
  type Scheduler,
  type SettingsManagement,
  type UpdateManagement,
  type UserChat,
} from '@agent-office/core'
import {
  IPC,
  SendMessageArgsSchema,
  SettingsPatchSchema,
  type SendResult,
  type ServerMessage,
} from '@agent-office/shared'

/** The driving ports the renderer may reach through IPC — nothing concrete. */
export interface IpcPorts {
  query: OfficeQuery
  chat: UserChat
  settings: SettingsManagement
  hooks: HookManagement
  updates: UpdateManagement
  version: string
  /** Called after hook install/uninstall (tray refresh). */
  onHookChanged: () => void
  /** Called when a renderer (re)loads and asks for the snapshot. */
  onReady: () => void
}

export type IpcHandler = (...args: unknown[]) => unknown | Promise<unknown>

/**
 * Driving adapter: one handler per IPC channel. Every payload is validated with the shared zod
 * schemas — the renderer is treated as untrusted input.
 */
export function createIpcHandlers(p: IpcPorts): Record<string, IpcHandler> {
  return {
    [IPC.ready]: () => {
      p.onReady()
      return p.query.snapshot()
    },
    [IPC.send]: (args: unknown): SendResult => {
      const parsed = SendMessageArgsSchema.safeParse(args)
      if (!parsed.success) return { ok: false, error: 'invalid message' }
      try {
        return { ok: true, message: p.chat.send(parsed.data.agentId, parsed.data.text) }
      } catch (err) {
        if (err instanceof DomainError) return { ok: false, error: err.message }
        throw err
      }
    },
    [IPC.settingsGet]: () => p.settings.get(),
    [IPC.settingsSet]: async (patch: unknown) => {
      const parsed = SettingsPatchSchema.safeParse(patch)
      if (!parsed.success) {
        const where = parsed.error.issues.map((i) => i.path.join('.') || i.message).join(', ')
        throw new Error(`invalid settings: ${where}`)
      }
      return p.settings.update(parsed.data)
    },
    [IPC.hookStatus]: () => p.hooks.status(),
    [IPC.hookInstall]: async () => {
      const status = await p.hooks.install()
      p.onHookChanged()
      return status
    },
    [IPC.hookUninstall]: async () => {
      const status = await p.hooks.uninstall()
      p.onHookChanged()
      return status
    },
    [IPC.version]: () => p.version,
    [IPC.updateCheck]: () => p.updates.check(),
    [IPC.updateInstall]: () => p.updates.install(),
  }
}

export interface IpcRegistrar {
  handle(channel: string, fn: (senderUrl: string | undefined, ...args: unknown[]) => unknown): void
}

/** Registers handlers behind a sender check: calls from anything but our renderer are refused. */
export function registerIpc(
  registrar: IpcRegistrar,
  handlers: Record<string, IpcHandler>,
  isTrusted: (senderUrl: string | undefined) => boolean,
): void {
  for (const [channel, handler] of Object.entries(handlers)) {
    registrar.handle(channel, async (senderUrl, ...args) => {
      if (!isTrusted(senderUrl)) throw new Error('untrusted sender')
      return handler(...args)
    })
  }
}

/** Streams UI messages to the renderer, batched per ~frame to keep IPC traffic low. */
export function createPushBridge(
  source: Pick<OfficeQuery, 'watch'>,
  send: (channel: string, payload: ServerMessage[]) => void,
  scheduler: Scheduler,
  frameMs = 16,
): () => void {
  let batch: ServerMessage[] = []
  let cancelFlush: (() => void) | undefined
  const flush = () => {
    cancelFlush = undefined
    const out = batch
    batch = []
    if (out.length) send(IPC.push, out)
  }
  const stopWatching = source.watch((m) => {
    batch.push(m)
    cancelFlush ??= scheduler.after(frameMs, flush)
  })
  return () => {
    stopWatching()
    cancelFlush?.()
    batch = []
  }
}
