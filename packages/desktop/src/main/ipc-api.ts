import {
  DomainError,
  SessionStartError,
  type ComposedMessage,
  type ComposeMessage,
  type HookManagement,
  type ManagedSessions,
  type OfficeQuery,
  type ProviderCatalog,
  type ProviderHooks,
  type Scheduler,
  type SettingsManagement,
  type UpdateManagement,
  type UserChat,
} from '@agent-office/core'
import {
  AnswerArgsSchema,
  CopyTextSchema,
  IPC,
  NewSessionArgsSchema,
  PickKindSchema,
  ProviderCallSchema,
  ProviderEnableArgsSchema,
  SendMessageArgsSchema,
  SessionCallSchema,
  SetModeArgsSchema,
  SetModeIdArgsSchema,
  SetModelArgsSchema,
  SettingsPatchSchema,
  type ConnectionInfo,
  type ContextRef,
  type HookStatus,
  type PowerState,
  type StartResult,
  type SendResult,
  type ServerMessage,
  type TestEventResult,
} from '@agent-office/shared'

/** A picked file or folder as main knows it (the absolute path never leaves main). */
export interface ContextEntry {
  path: string
  kind: 'file' | 'folder'
  label: string
  hint: string
}

/** Opaque `ctx_` refs for paths picked in the native dialog (built by the composition root). */
export interface ContextRegistry {
  pick(kind: 'files' | 'folder'): Promise<ContextRef[]>
  resolve(ref: string): ContextEntry | undefined
  exists(path: string): boolean
}

/** Display labels for capability ids the composer may attach. */
export function useLabel(id: string): string {
  if (id === 'mcp:claude-in-chrome') return 'Chrome browser'
  if (id === 'shell') return 'Shell'
  if (id === 'web') return 'Web'
  if (id === 'subagents') return 'Subagents'
  return id.slice(id.indexOf(':') + 1)
}

class InvalidContextError extends Error {}

/** The driving ports the renderer may reach through IPC — nothing concrete. */
export interface IpcPorts {
  query: OfficeQuery
  chat: UserChat
  settings: SettingsManagement
  hooks: HookManagement
  updates: UpdateManagement
  version: string
  /** Live connection facts (never the token) and the self-test, built by the composition root. */
  connections: { info(): Promise<ConnectionInfo>; test(): Promise<TestEventResult> }
  /** Writes to the system clipboard (main side; the renderer permission stays denied). */
  copyText(text: string): void
  /** Called after hook install/uninstall (tray refresh). */
  onHookChanged: () => void
  /** Called when a renderer (re)loads and asks for the snapshot. */
  onReady: () => void
  /** Messages with context/tool hints (falls back to `chat` when absent). */
  compose?: ComposeMessage
  /** Managed Claude Code sessions; the session and context channels exist only with both. */
  sessions?: ManagedSessions
  context?: ContextRegistry
  /** The power source (Electron powerMonitor via power.ts); absent reads as on AC. */
  power?: { state(): PowerState }
  /** Provider registry; the `prov:*` channels exist only with it. */
  providers?: ProviderCatalog
  /** Observation hooks for hook-based providers; absent reads as 'not-installed'. */
  providerHooks?: ProviderHooks
  /** Called after a provider action so connection info is pushed again. */
  onProvidersChanged?: () => void
}

export type IpcHandler = (...args: unknown[]) => unknown | Promise<unknown>

/**
 * Driving adapter: one handler per IPC channel. Every payload is validated with the shared zod
 * schemas — the renderer is treated as untrusted input.
 */
export function createIpcHandlers(p: IpcPorts): Record<string, IpcHandler> {
  const entry = (ref: string, kind?: 'file' | 'folder'): ContextEntry => {
    const e = p.context?.resolve(ref)
    if (!e) throw new InvalidContextError('invalid context')
    if (kind && e.kind !== kind) throw new InvalidContextError('choose a folder')
    return e
  }
  const composed = (text: string, context: string[] = [], use: string[] = []): ComposedMessage => ({
    text,
    context: context.map((ref) => {
      const { path, kind, label, hint } = entry(ref)
      return { path, kind, label, hint }
    }),
    use: use.map((id) => ({ id, label: useLabel(id) })),
  })
  const call = <T>(
    schema: { safeParse(x: unknown): { success: boolean; data?: T } },
    x: unknown,
  ) => {
    const r = schema.safeParse(x)
    if (!r.success) throw new Error('invalid request')
    return r.data as T
  }

  const handlers: Record<string, IpcHandler> = {
    [IPC.ready]: () => {
      p.onReady()
      return p.query.snapshot()
    },
    [IPC.send]: async (args: unknown): Promise<SendResult> => {
      const parsed = SendMessageArgsSchema.safeParse(args)
      if (!parsed.success) return { ok: false, error: 'invalid message' }
      const { agentId, text, context, use } = parsed.data
      try {
        if (!p.compose) return { ok: true, message: p.chat.send(agentId, text) }
        return { ok: true, message: await p.compose.send(agentId, composed(text, context, use)) }
      } catch (err) {
        if (err instanceof DomainError || err instanceof InvalidContextError)
          return { ok: false, error: err.message }
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
    [IPC.connInfo]: () => p.connections.info(),
    [IPC.connTest]: () => p.connections.test(),
    [IPC.copyText]: (text: unknown) => {
      const parsed = CopyTextSchema.safeParse(text)
      if (!parsed.success) throw new Error('invalid text')
      p.copyText(parsed.data)
    },
    [IPC.appPowerGet]: (): PowerState => p.power?.state() ?? { onBattery: false },
  }
  const { providers } = p
  if (providers) {
    const changed = <T>(v: T): T => {
      p.onProvidersChanged?.()
      return v
    }
    const optionalProvider = (x: unknown) =>
      x === undefined ? undefined : call(ProviderCallSchema.partial(), x).provider
    Object.assign(handlers, {
      [IPC.provList]: () => providers.list(),
      [IPC.provRefresh]: async (args: unknown) =>
        changed(await providers.refresh(optionalProvider(args))),
      [IPC.provEnable]: async (args: unknown) => {
        const a = call(ProviderEnableArgsSchema, args)
        return changed(await providers.setEnabled(a.provider, a.enabled))
      },
      [IPC.provModels]: async (args: unknown) =>
        providers.models(call(ProviderCallSchema, args).provider),
      [IPC.provHooksInstall]: async (args: unknown): Promise<HookStatus> => {
        const a = call(ProviderCallSchema, args)
        return changed((await p.providerHooks?.install(a.provider)) ?? 'not-installed')
      },
      [IPC.provHooksRemove]: async (args: unknown): Promise<HookStatus> => {
        const a = call(ProviderCallSchema, args)
        return changed((await p.providerHooks?.uninstall(a.provider)) ?? 'not-installed')
      },
    })
  }
  const { sessions, context } = p
  if (!sessions || !context) return handlers

  return {
    ...handlers,
    [IPC.ctxPick]: async (kind: unknown) => context.pick(call(PickKindSchema, kind)),
    [IPC.sessStart]: async (args: unknown): Promise<StartResult> => {
      const parsed = NewSessionArgsSchema.safeParse(args)
      if (!parsed.success) return { ok: false, code: 'other', error: 'invalid session' }
      const a = parsed.data
      if (a.chrome && a.provider !== 'claude-code')
        return { ok: false, code: 'other', error: 'Chrome is only available for Claude Code' }
      let start
      try {
        const folder = entry(a.folder, 'folder')
        const extra = a.extraFolders.map((ref) => entry(ref, 'folder'))
        const missing = [folder, ...extra].some((f) => !context.exists(f.path))
        if (missing) return { ok: false, code: 'folder', error: 'folder not found' }
        start = {
          ...(a.provider !== 'claude-code' ? { provider: a.provider } : {}),
          ...(a.modeId ? { modeId: a.modeId } : {}),
          cwd: folder.path,
          name: a.name ?? folder.label,
          ...(a.model ? { model: a.model } : {}),
          mode: a.mode,
          extraDirs: extra.map((f) => f.path),
          chrome: a.chrome,
          first: composed(a.text, a.context, a.use),
        }
      } catch (err) {
        if (!(err instanceof InvalidContextError)) throw err
        const code = err.message === 'choose a folder' ? 'folder' : 'other'
        return { ok: false, code, error: err.message }
      }
      try {
        return { ok: true, agentId: await sessions.start(start) }
      } catch (err) {
        if (err instanceof SessionStartError)
          return { ok: false, code: err.code, error: err.message }
        if (err instanceof DomainError) return { ok: false, code: 'other', error: err.message }
        throw err
      }
    },
    [IPC.sessMode]: async (args: unknown) => {
      const a = call(SetModeArgsSchema, args)
      return sessions.setMode(a.agentId, a.mode)
    },
    [IPC.sessModeId]: async (args: unknown) => {
      const a = call(SetModeIdArgsSchema, args)
      if (!sessions.setModeId) throw new Error('unsupported')
      return sessions.setModeId(a.agentId, a.modeId)
    },
    [IPC.sessModel]: async (args: unknown) => {
      const a = call(SetModelArgsSchema, args)
      return sessions.setModel(a.agentId, a.model)
    },
    [IPC.sessModels]: async (agentId: unknown) =>
      agentId === undefined
        ? sessions.models()
        : sessions.models(call(SessionCallSchema.shape.agentId, agentId)),
    [IPC.sessInterrupt]: async (args: unknown) =>
      sessions.interrupt(call(SessionCallSchema, args).agentId),
    [IPC.sessStop]: async (args: unknown) => sessions.stop(call(SessionCallSchema, args).agentId),
    [IPC.sessAnswer]: async (args: unknown) => {
      const a = call(AnswerArgsSchema, args)
      sessions.answer(a.agentId, a.requestId, a.decision)
    },
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
