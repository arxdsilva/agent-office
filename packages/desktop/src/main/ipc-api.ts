import { basename } from 'node:path'
import {
  DomainError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  SessionStartError,
  ValidationError,
  type Projects,
  type ComposedMessage,
  type ComposeMessage,
  type StartSession,
  type HookManagement,
  type ManagedSessions,
  type OfficeQuery,
  type ProviderCatalog,
  type ProviderHooks,
  type Scheduler,
  type SettingsManagement,
  type HarnessImport,
  type HarnessManagement,
  type HarnessPolicyEngine,
  type HarnessValidation,
  type UpdateManagement,
  type UserChat,
} from '@agent-office/core'
import { z } from 'zod'
import {
  AgentIdArgsSchema,
  AnswerArgsSchema,
  CoverageArgsSchema,
  HarnessAttachArgsSchema,
  HarnessDraftSchema,
  HarnessIdArgsSchema,
  HarnessUpdateArgsSchema,
  ImportCommitArgsSchema,
  ImportDetectArgsSchema,
  ImportPreviewArgsSchema,
  RunGatesArgsSchema,
  TemplateArgsSchema,
  AssignSessionArgsSchema,
  ContextPreviewArgsSchema,
  CopyTextSchema,
  HandoffIdSchema,
  HandoffPrepareArgsSchema,
  HandoffUpdateArgsSchema,
  ImportHistoryArgsSchema,
  IPC,
  MemoryActionArgsSchema,
  MemoryDraftSchema,
  MemoryEditArgsSchema,
  MemoryListArgsSchema,
  MemoryMergeArgsSchema,
  MemorySupersedeArgsSchema,
  NewProjectArgsSchema,
  ProjectIdSchema,
  RepoRefSchema,
  SearchArgsSchema,
  SessionIdSchema,
  SessionListArgsSchema,
  SessionMessagesArgsSchema,
  TaskCreateArgsSchema,
  TaskUpdateArgsSchema,
  UpdateProjectArgsSchema,
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
  type ProjectMessage,
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

/** The Harness Builder services (docs/harness.md); typed by port so this file never names a class. */
export interface HarnessPorts {
  harness: HarnessManagement
  harnessImport: HarnessImport
  policy: HarnessPolicyEngine
  validation: HarnessValidation
}

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
  /** Projects, memory, handoffs and search (only with a vault); the `prj:*` channels need it. */
  projects?: HarnessPorts &
    Pick<
      Projects,
      | 'catalog'
      | 'repos'
      | 'sessions'
      | 'assignment'
      | 'memory'
      | 'context'
      | 'handoffs'
      | 'workspace'
      | 'search'
      | 'tasks'
      | 'history'
      | 'knowledge'
    >
}

/** Absolute paths (posix or windows) never leave main, not even inside an error message. */
const PATHLIKE = /(?:[A-Za-z]:)?[\\/][^\s'"]*[\\/][^\s'"]*/g

/** A renderer-safe error: no paths, no stack, no internals. */
export function safeError(err: unknown): Error {
  if (err instanceof InvalidContextError) return new Error(err.message)
  if (err instanceof ForbiddenError) return new Error('forbidden')
  if (err instanceof NotFoundError) return new Error('not found')
  if (err instanceof RateLimitedError) return new Error('too many requests')
  if (err instanceof ValidationError)
    return new Error(err.message.replace(PATHLIKE, '[path]').slice(0, 200))
  return new Error('request failed')
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
    if (!r.success) throw new InvalidContextError('invalid request')
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
  if (p.projects) Object.assign(handlers, projectHandlers(p.projects, call, entry))
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
      if (!a.folder && !a.repo) return { ok: false, code: 'folder', error: 'choose a folder' }
      if ((a.repo || a.context_memories?.length) && !a.projectId)
        return { ok: false, code: 'other', error: 'choose a project' }
      let start: StartSession
      try {
        // A project repository (its directory stays in main) replaces the picked folder.
        let cwd: string
        let label: string
        if (a.repo) {
          const dir = p.projects?.repos.repoPath(a.projectId!, a.repo)
          if (!dir) return { ok: false, code: 'folder', error: 'repository not found' }
          cwd = dir
          label = basename(dir)
        } else {
          const folder = entry(a.folder!, 'folder')
          cwd = folder.path
          label = folder.label
        }
        const extra = a.extraFolders.map((ref) => entry(ref, 'folder'))
        const missing = !context.exists(cwd) || extra.some((f) => !context.exists(f.path))
        if (missing) return { ok: false, code: 'folder', error: 'folder not found' }
        start = {
          ...(a.provider !== 'claude-code' ? { provider: a.provider } : {}),
          ...(a.modeId ? { modeId: a.modeId } : {}),
          ...(a.projectId ? { projectId: a.projectId } : {}),
          cwd,
          name: a.name ?? label,
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
        const ids = a.context_memories
        const agentId =
          ids?.length && p.projects
            ? await p.projects.handoffs.startWithContext({ ...start, projectId: a.projectId! }, ids)
            : await sessions.start(start)
        return { ok: true, agentId }
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

type Call = <T>(schema: { safeParse(x: unknown): { success: boolean; data?: T } }, x: unknown) => T

/** `prj:*` — every payload validated; `ctx_` folders resolved to paths here, never in core. */
function projectHandlers(
  prj: NonNullable<IpcPorts['projects']>,
  call: Call,
  entry: (ref: string, kind?: 'file' | 'folder') => ContextEntry,
): Record<string, IpcHandler> {
  const guard =
    <R>(fn: (x: unknown) => R | Promise<R>) =>
    async (x: unknown): Promise<R> => {
      try {
        return await fn(x)
      } catch (err) {
        throw safeError(err)
      }
    }
  const h = <A>(
    schema: { safeParse(x: unknown): { success: boolean; data?: A } },
    fn: (a: A) => unknown,
  ) => guard((x) => fn(call(schema, x)))
  const folders = (refs: string[]) => refs.map((r) => entry(r, 'folder').path)
  const ProjectCall = z.object({ projectId: ProjectIdSchema })
  const AddRepos = ProjectCall.extend({ folders: NewProjectArgsSchema.shape.folders })
  const RemoveRepo = ProjectCall.extend({ repo: RepoRefSchema })
  const Inspect = z.object({ agentId: z.string().min(1).max(200) })
  const Launch = z.object({ handoffId: HandoffIdSchema })
  return {
    [IPC.prjOverview]: guard(() => prj.workspace.overview()),
    [IPC.prjList]: guard(() => prj.catalog.list()),
    [IPC.prjDashboard]: h(ProjectCall, (a) => prj.workspace.dashboard(a.projectId)),
    [IPC.prjCreate]: h(NewProjectArgsSchema, (a) =>
      prj.catalog.create({ name: a.name, folders: folders(a.folders) }),
    ),
    [IPC.prjUpdate]: h(UpdateProjectArgsSchema, (a) => prj.catalog.update(a)),
    [IPC.prjAddRepos]: h(AddRepos, (a) => prj.catalog.addRepos(a.projectId, folders(a.folders))),
    [IPC.prjRemoveRepo]: h(RemoveRepo, (a) => prj.catalog.removeRepo(a.projectId, a.repo)),
    [IPC.prjSessions]: h(SessionListArgsSchema, (a) => prj.sessions.list(a)),
    [IPC.prjMessages]: h(SessionMessagesArgsSchema, (a) =>
      prj.sessions.messages({
        sessionId: a.sessionId,
        limit: a.limit,
        ...(a.before ? { before: a.before } : {}),
      }),
    ),
    [IPC.prjAssign]: h(AssignSessionArgsSchema, (a) =>
      prj.assignment.assign(a.sessionId, a.projectId),
    ),
    [IPC.prjMemories]: h(MemoryListArgsSchema, (a) => prj.memory.list(a)),
    [IPC.prjMemoryCreate]: h(MemoryDraftSchema, (a) => prj.memory.create(a)),
    [IPC.prjMemoryReview]: h(MemoryActionArgsSchema, (a) =>
      prj.memory.review(a.memoryId, a.action),
    ),
    [IPC.prjMemoryEdit]: h(MemoryEditArgsSchema, (a) => prj.memory.edit(a)),
    [IPC.prjMemorySupersede]: h(MemorySupersedeArgsSchema, (a) =>
      prj.memory.supersede(a.memoryId, a.replacement),
    ),
    [IPC.prjMemoryMerge]: h(MemoryMergeArgsSchema, (a) => prj.memory.merge(a.memoryIds, a.into)),
    [IPC.prjContextPreview]: h(ContextPreviewArgsSchema, (a) => prj.context.preview(a)),
    [IPC.prjInspect]: h(Inspect, (a) => prj.context.inspect(a.agentId)),
    [IPC.prjHandoffPrepare]: h(HandoffPrepareArgsSchema, (a) => prj.handoffs.prepare(a)),
    [IPC.prjHandoffUpdate]: h(HandoffUpdateArgsSchema, (a) => prj.handoffs.update(a)),
    [IPC.prjHandoffLaunch]: async (x: unknown): Promise<StartResult> => {
      const a = call(Launch, x)
      try {
        return { ok: true, agentId: (await prj.handoffs.launch(a.handoffId)).agentId }
      } catch (err) {
        if (err instanceof SessionStartError)
          return { ok: false, code: err.code, error: err.message }
        throw safeError(err)
      }
    },
    [IPC.prjTasks]: h(ProjectIdSchema, (id) => prj.tasks.list(id)),
    [IPC.prjTaskCreate]: h(TaskCreateArgsSchema, (a) =>
      prj.tasks.create(a.projectId, a.title, a.sessionId ? { sessionId: a.sessionId } : {}),
    ),
    // A state change, `confirm` (adds user-confirmed evidence), or both; one TaskView comes back.
    [IPC.prjTaskUpdate]: h(TaskUpdateArgsSchema, async (a) => {
      let view = a.state ? await prj.tasks.setState(a.taskId, a.state) : undefined
      if (a.confirm) view = await prj.tasks.addEvidence(a.taskId, { level: 'user-confirmed' })
      return view
    }),
    // Experimental: past Claude Code sessions become unassigned records (references only).
    [IPC.prjImportHistory]: h(ImportHistoryArgsSchema, (a) => prj.history.importHistory(a)),
    [IPC.prjResume]: async (x: unknown): Promise<StartResult> => {
      const id = call(SessionIdSchema, x)
      try {
        return { ok: true, agentId: (await prj.history.resume(id)).agentId }
      } catch (err) {
        if (err instanceof SessionStartError)
          return { ok: false, code: err.code, error: err.message }
        throw safeError(err)
      }
    },
    [IPC.prjSearch]: h(SearchArgsSchema, (a) => prj.search.search(a)),
    // Automatic knowledge import: user actions; one project's items, or all when no id is given.
    [IPC.prjRemoveImported]: h(ProjectIdSchema.optional(), (id) =>
      prj.knowledge.removeImported(id),
    ),
    [IPC.prjImportStatus]: guard(() => prj.knowledge.status()),
    // Harness Builder (docs/harness.md): user actions; ids and repo-relative paths only.
    [IPC.hrnList]: guard(() => prj.harness.list()),
    [IPC.hrnGet]: h(HarnessIdArgsSchema, (a) => prj.harness.get(a.harnessId)),
    [IPC.hrnVersions]: h(HarnessIdArgsSchema, (a) => prj.harness.versions(a.harnessId)),
    [IPC.hrnCreate]: h(HarnessDraftSchema, (a) => prj.harness.create(a)),
    [IPC.hrnUpdate]: h(HarnessUpdateArgsSchema, (a) => prj.harness.update(a.harnessId, a.draft)),
    [IPC.hrnPublish]: h(HarnessIdArgsSchema, (a) => prj.harness.publish(a.harnessId)),
    [IPC.hrnArchive]: h(HarnessIdArgsSchema, (a) => prj.harness.archive(a.harnessId)),
    [IPC.hrnAttach]: h(HarnessAttachArgsSchema, (a) =>
      prj.harness.attach(a.projectId, a.harnessId),
    ),
    [IPC.hrnDetach]: h(HarnessAttachArgsSchema, (a) =>
      prj.harness.detach(a.projectId, a.harnessId),
    ),
    [IPC.hrnTemplates]: guard(() => prj.harness.templates()),
    [IPC.hrnFromTemplate]: h(TemplateArgsSchema, (a) =>
      prj.harness.createFromTemplate(a.templateId),
    ),
    [IPC.hrnImportDetect]: h(ImportDetectArgsSchema, (a) => prj.harnessImport.detect(a.projectId)),
    [IPC.hrnImportPreview]: h(ImportPreviewArgsSchema, (a) =>
      prj.harnessImport.preview({
        projectId: a.projectId,
        ...(a.paths ? { paths: a.paths } : {}),
      }),
    ),
    [IPC.hrnImportCommit]: h(ImportCommitArgsSchema, (a) => prj.harnessImport.commit(a)),
    [IPC.hrnCoverage]: h(CoverageArgsSchema, (a) => prj.policy.preview(a.projectId, a.provider)),
    [IPC.hrnInspect]: h(AgentIdArgsSchema, (a) => prj.policy.inspect(a.agentId)),
    [IPC.hrnRunGates]: h(RunGatesArgsSchema, (a) =>
      prj.validation.run({
        agentId: a.agentId,
        ...(a.gateIds ? { gateIds: a.gateIds } : {}),
      }),
    ),
    [IPC.hrnCancelGates]: h(AgentIdArgsSchema, (a) => {
      prj.validation.cancel(a.agentId)
    }),
    [IPC.hrnBadges]: guard(() => prj.policy.badges()),
  }
}

/**
 * Streams project messages to the renderer on `prj:push`, at most one flush per `windowMs`
 * (default 250 ms = 4/s). Snapshots of the same thing collapse to the latest one.
 */
export function createProjectPushBridge(
  source: Pick<Projects['workspace'], 'watch'>,
  send: (channel: string, payload: ProjectMessage) => void,
  scheduler: Scheduler,
  windowMs = 250,
): () => void {
  const pending = new Map<string, ProjectMessage>()
  let n = 0
  let cancelFlush: (() => void) | undefined
  const keyOf = (m: ProjectMessage): string => {
    switch (m.type) {
      case 'projects':
      case 'vault':
        return m.type
      case 'session':
        return `session:${m.session.id}`
      case 'memory':
        return `memory:${m.memory.id}`
      case 'agent-project':
        return `agent-project:${m.agentId}`
      case 'harness':
        return `harness:${m.harnessId ?? ''}:${m.projectId ?? ''}:${m.agentId ?? ''}` // same subject collapses
      default:
        return `${m.type}:${++n}` // activity and retrievals are events: keep each
    }
  }
  const flush = () => {
    cancelFlush = undefined
    const out = [...pending.values()]
    pending.clear()
    for (const m of out) send(IPC.prjPush, m)
  }
  const stopWatching = source.watch((m) => {
    const k = keyOf(m)
    pending.delete(k)
    pending.set(k, m)
    cancelFlush ??= scheduler.after(windowMs, flush)
  })
  return () => {
    stopWatching()
    cancelFlush?.()
    pending.clear()
  }
}
