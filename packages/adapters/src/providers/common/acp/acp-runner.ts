// Driven adapter: managed sessions of any ACP agent (Agent Client Protocol v1, JSON-RPC 2.0 NDJSON
// over stdio), configured by an AcpProfile. Lifecycle: docs/provider-integrations.md §5.2. Events
// are status/tool only; the agent's final message goes only to the session's own chat (onResult).
// We advertise no client fs/terminal: every agent→client request other than permissions gets
// -32601 from the peer, so the agent never waits on us.
import type {
  AgentRunner,
  Logger,
  RunnerDecision,
  RunnerDecl,
  RunnerExit,
  RunnerPermission,
  RunnerSession,
  RunnerStart,
} from '@agent-office/core'
import type { AgentEvent, ModelOption, PermissionMode } from '@agent-office/shared'
import {
  type ByteSink,
  type ByteSource,
  JsonRpcPeer,
  PeerClosedError,
  RpcError,
} from '../jsonrpc.ts'
import {
  classifyExit,
  type RuntimeExit,
  spawnRuntime,
  type SpawnRuntimeOptions,
} from '../process.ts'
import {
  chooseOption,
  type EventPatch,
  messageChunk,
  type ModelChoice,
  modelChoice,
  permissionRequest,
  shortModeId,
  stopReasonOutcome,
  updateEvent,
} from './acp-map.ts'
import { type AcpProfile, nativeModeId } from './acp-profile.ts'

/** What the runner needs from a spawned agent (a `RuntimeProcess`, or an in-process double). */
export interface AcpTransport {
  readonly stdin: ByteSink & { end?(): unknown }
  readonly stdout: ByteSource
  kill(): Promise<void>
  readonly exited: Promise<RuntimeExit>
  stderrTail(): string
  alive(): boolean
}

export interface AcpRunnerOptions {
  /** Overrides the profile's binary (tests run the fake with `process.execPath`). */
  bin?: string
  /** Overrides the profile's arguments. */
  args?: string[]
  /** Extra environment for the CLI (merged over process.env; our token is always removed). */
  env?: Record<string, string | undefined>
  log?: Logger
  /** Per-request timeout for control calls (initialize, session/new, …). Default 30 s. */
  requestTimeoutMs?: number
  /** Test seam: replaces spawning a process. */
  spawn?: (bin: string, args: string[], o: SpawnRuntimeOptions) => AcpTransport
}

export const ACP_PROTOCOL_VERSION = 1
const MAX_REPLY = 4000
const MAX_TOOL_KINDS = 64
const CLIENT_INFO = { name: 'agent-office', title: 'agent-office', version: '1' }
const M = {
  initialize: 'initialize',
  authenticate: 'authenticate',
  sessionNew: 'session/new',
  prompt: 'session/prompt',
  cancel: 'session/cancel',
  setMode: 'session/set_mode',
  setConfigOption: 'session/set_config_option',
  setModel: 'session/set_model',
  update: 'session/update',
  requestPermission: 'session/request_permission',
} as const

/** The declaration the core sees: native mode ids stay inside the adapter. */
export function acpDecl(p: AcpProfile): RunnerDecl {
  return {
    provider: p.provider,
    prefix: p.prefix,
    caps: [...p.caps],
    ...(p.modes
      ? {
          modes: p.modes.map((m) => ({
            id: m.id,
            label: m.label,
            ...(m.dangerous ? { dangerous: true } : {}),
          })),
        }
      : {}),
    ...(p.defaultModeId ? { defaultModeId: p.defaultModeId } : {}),
    fallbackModels: [],
  }
}

export class AcpRunner implements AgentRunner {
  readonly decl: RunnerDecl

  constructor(
    readonly profile: AcpProfile,
    private o: AcpRunnerOptions = {},
  ) {
    this.decl = acpDecl(profile)
  }

  start(s: RunnerStart): RunnerSession {
    return new AcpSession(this.profile, this.o, s)
  }
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined

function isAuthError(err: unknown): boolean {
  return err instanceof RpcError && (err.code === -32000 || /auth/i.test(err.message))
}

class AcpSession implements RunnerSession {
  readonly sessionId: Promise<string>
  private resolveId!: (id: string) => void
  private rejectId!: (e: RunnerExit) => void
  private t: AcpTransport
  private peer: JsonRpcPeer
  private id: string | undefined
  private started = false
  private ended = false
  private closed = false
  private queue: string[] = []
  private active = false
  private reply = ''
  private replyMsg: string | undefined
  private replyStale = false
  private toolKinds = new Map<string, string>()
  private agentModes = new Set<string>()
  private currentMode: string | undefined
  private models: ModelChoice | undefined
  private permissions = new Set<() => void>()
  private events = new Set<(e: Omit<AgentEvent, 'agentId'>) => void>()
  private results = new Set<(r: { text: string; isError: boolean }) => void>()
  private permissionFn: ((r: RunnerPermission) => Promise<RunnerDecision>) | undefined
  private exitFns = new Set<(e: RunnerExit) => void>()
  private messages: Record<NonNullable<RunnerExit['error']>, string>

  constructor(
    private p: AcpProfile,
    private o: AcpRunnerOptions,
    private s: RunnerStart,
  ) {
    this.sessionId = new Promise((res, rej) => {
      this.resolveId = res
      this.rejectId = rej
    })
    this.sessionId.catch(() => {})
    this.messages = {
      auth: `${p.label} needs a login. Run \`${p.loginHint}\`, then start the session again.`,
      folder: 'The folder does not exist.',
      runtime: `${p.label} could not be started.`,
      crash: `${p.label} stopped unexpectedly.`,
    }
    const spawn = o.spawn ?? spawnRuntime
    this.t = spawn(o.bin ?? p.bin, o.args ?? p.args, {
      cwd: s.cwd,
      ...(o.env || p.env ? { env: { ...p.env, ...o.env } } : {}),
    })
    this.peer = new JsonRpcPeer(this.t.stdout, this.t.stdin, {
      dialect: 'jsonrpc2',
      timeoutMs: o.requestTimeoutMs ?? 30_000,
    })
    this.listen()
    void this.t.exited.then((e) => this.onProcessExit(e))
    void this.run()
  }

  /** The agent's id for a profile mode this session may use (dangerous only with `allowBypass`). */
  private allowedMode(id: string | undefined): string | undefined {
    const m = this.p.modes?.find((x) => x.id === id)
    if (!m || (m.dangerous && !this.s.allowBypass)) return undefined
    const native = nativeModeId(this.p, m.id)!
    return this.agentModes.has(native) ? native : undefined
  }

  private async run(): Promise<void> {
    try {
      const init = obj(
        await this.peer.request(M.initialize, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: CLIENT_INFO,
        }),
      )
      if (init?.protocolVersion !== ACP_PROTOCOL_VERSION) return this.fail('runtime', 'protocol')
      const result = obj(await this.newSession(init))
      if (!result) return
      if (this.ended) return
      if (typeof result.sessionId !== 'string' || !result.sessionId)
        return this.fail('runtime', 'session')
      this.id = result.sessionId
      const modes = obj(result.modes)
      for (const m of Array.isArray(modes?.availableModes) ? modes.availableModes : []) {
        const id = obj(m)?.id
        if (typeof id === 'string') this.agentModes.add(id)
      }
      if (typeof modes?.currentModeId === 'string') this.currentMode = modes.currentModeId
      this.models = modelChoice(result)
      await this.applyStartOptions()
      if (this.ended) return
      this.started = true
      this.resolveId(this.id)
      this.pump()
    } catch (err) {
      // The process went away: its exit classifies the failure.
      if (err instanceof PeerClosedError || this.ended) return
      this.fail('runtime', err instanceof Error ? err.name : 'protocol')
    }
  }

  /** `session/new`; on auth_required, `authenticate` once with a preferred, advertised method. */
  private async newSession(init: Obj): Promise<unknown> {
    const caps = obj(init.agentCapabilities)
    const extra = obj(caps?.sessionCapabilities)?.additionalDirectories
    const params = {
      cwd: this.s.cwd,
      // agent-office's project MCP server (docs/projects.md §5), only when the policy allows it.
      mcpServers: this.s.mcp
        ? [
            {
              name: this.s.mcp.name,
              command: this.s.mcp.command,
              args: [...this.s.mcp.args],
              env: Object.entries(this.s.mcp.env).map(([name, value]) => ({ name, value })),
            },
          ]
        : [],
      ...(extra && this.s.extraDirs.length ? { additionalDirectories: [...this.s.extraDirs] } : {}),
    }
    try {
      return await this.peer.request(M.sessionNew, params)
    } catch (err) {
      if (!isAuthError(err)) throw err
    }
    const advertised = new Set(
      (Array.isArray(init.authMethods) ? init.authMethods : []).flatMap((m) => {
        const id = obj(m)?.id
        return typeof id === 'string' ? [id] : []
      }),
    )
    const methodId = this.p.authMethodPrefer.find((id) => advertised.has(id))
    if (!methodId) return this.fail('auth', 'login')
    try {
      await this.peer.request(M.authenticate, { methodId })
      return await this.peer.request(M.sessionNew, params)
    } catch (err) {
      if (err instanceof PeerClosedError) throw err
      return this.fail(isAuthError(err) || err instanceof RpcError ? 'auth' : 'runtime', 'login')
    }
  }

  /** The start's mode and model, when the agent offers them; failures keep the agent's defaults. */
  private async applyStartOptions(): Promise<void> {
    const native = this.allowedMode(this.s.modeId)
    if (native && native !== this.currentMode)
      await this.peer
        .request(M.setMode, { sessionId: this.id, modeId: native })
        .then(() => (this.currentMode = native))
        .catch((err) => {
          if (err instanceof PeerClosedError) throw err
          this.o.log?.warn(`${this.p.provider}: start mode not applied`)
        })
    if (this.s.model && this.models)
      await this.changeModel(this.s.model).catch((err) => {
        if (err instanceof PeerClosedError) throw err
        this.o.log?.warn(`${this.p.provider}: start model not applied`)
      })
  }

  private listen(): void {
    this.peer.onNotification(M.update, (raw) => {
      const n = obj(raw)
      if (!n || (this.id !== undefined && n.sessionId !== this.id)) return
      this.onUpdate(n.update)
    })
    this.peer.onRequest(M.requestPermission, (raw) => this.askPermission(raw))
    // Everything else (fs/*, terminal/*, cursor/*, …) gets the peer's -32601 reply.
  }

  private onUpdate(update: unknown): void {
    const u = obj(update)
    const chunk = messageChunk(u)
    if (chunk) {
      if (this.replyStale || (chunk.messageId && chunk.messageId !== this.replyMsg)) {
        this.reply = ''
        this.replyStale = false
      }
      if (chunk.messageId) this.replyMsg = chunk.messageId
      this.reply = (this.reply + chunk.text).slice(0, MAX_REPLY)
      return
    }
    if (u?.sessionUpdate === 'tool_call') {
      // The final message is what comes after the last tool call.
      this.replyStale = true
      if (typeof u.toolCallId === 'string' && typeof u.kind === 'string') {
        if (this.toolKinds.size >= MAX_TOOL_KINDS)
          this.toolKinds.delete(this.toolKinds.keys().next().value!)
        this.toolKinds.set(u.toolCallId, u.kind)
      }
    }
    if (u?.sessionUpdate === 'current_mode_update' && typeof u.currentModeId === 'string') {
      this.currentMode = u.currentModeId
      // Report the profile's short id (never a native URL id) so the mode menu follows the agent.
      const modeId = shortModeId(u.currentModeId, this.p.modes)
      if (modeId) this.emit({ modeId })
    }
    const e = updateEvent(u, this.p.toolKindMap ? { toolKindMap: this.p.toolKindMap } : {})
    if (e) this.emit(e)
  }

  private async askPermission(raw: unknown): Promise<unknown> {
    const params = obj(raw)
    const options = params?.options
    if (!params || (this.id !== undefined && params.sessionId !== this.id))
      return chooseOption(options, 'cancel')
    const callId = obj(params.toolCall)?.toolCallId
    const knownKind = typeof callId === 'string' ? this.toolKinds.get(callId) : undefined
    const perm = permissionRequest(params, this.s.cwd, {
      ...(this.p.toolKindMap ? { toolKindMap: this.p.toolKindMap } : {}),
      ...(knownKind ? { knownKind } : {}),
    })
    if (!this.permissionFn || this.closed)
      return chooseOption(options, { behavior: 'deny', message: 'No decision' })
    let cancel!: () => void
    const cancelled = new Promise<'cancel'>((r) => (cancel = () => r('cancel')))
    this.permissions.add(cancel)
    try {
      const d = await Promise.race([
        this.permissionFn(perm).catch((): RunnerDecision => ({
          behavior: 'deny',
          message: 'No decision',
        })),
        cancelled,
      ])
      return chooseOption(options, d)
    } finally {
      this.permissions.delete(cancel)
    }
  }

  private cancelPermissions(): void {
    for (const c of [...this.permissions]) c()
    this.permissions.clear()
  }

  /** Sends the next queued prompt when none is running (one at a time). */
  private pump(): void {
    if (!this.id || this.active || this.ended || this.closed) return
    const text = this.queue.shift()
    if (text === undefined) return
    this.active = true
    this.reply = ''
    this.replyMsg = undefined
    this.replyStale = false
    this.peer
      .request(
        M.prompt,
        { sessionId: this.id, prompt: [{ type: 'text', text }] },
        // A turn lasts as long as the agent works; interrupt is the way out.
        { timeoutMs: 0 },
      )
      .then(
        (raw) => {
          const { event, result } = stopReasonOutcome(obj(raw)?.stopReason, this.reply)
          this.endTurn(event, result)
        },
        (err) => {
          if (err instanceof PeerClosedError || this.ended) return
          this.o.log?.warn(
            `${this.p.provider}: prompt failed (${err instanceof RpcError ? err.code : 'error'})`,
          )
          this.endTurn({ status: 'error' }, { text: '', isError: true })
        },
      )
  }

  private endTurn(event: EventPatch, result: { text: string; isError: boolean }): void {
    this.reply = ''
    this.replyMsg = undefined
    this.cancelPermissions()
    this.emit(event)
    for (const fn of this.results) fn(result)
    this.active = false
    this.pump()
  }

  private emit(e: EventPatch): void {
    for (const fn of this.events) fn(e)
  }

  private fail(error: NonNullable<RunnerExit['error']>, tag: string): undefined {
    this.o.log?.warn(`${this.p.provider}: session ended (${error}: ${tag})`)
    this.finish({ error, message: this.messages[error] })
    void this.t.kill()
    return undefined
  }

  private onProcessExit(e: RuntimeExit): void {
    if (this.closed || this.ended) return this.finish({})
    const error = classifyExit(e.code, this.t.stderrTail(), e.spawnError)
    // Class and code only: stderr may hold paths or account details.
    this.o.log?.warn(
      `${this.p.provider}: agent exited (${error}: ${e.spawnError ?? e.code ?? e.signal})`,
    )
    this.finish({ error, message: this.messages[error] })
  }

  private finish(e: RunnerExit): void {
    if (this.ended) return
    this.ended = true
    this.queue = []
    this.cancelPermissions()
    this.peer.close()
    if (!this.started) this.rejectId(e.error ? e : { error: 'crash' })
    for (const fn of this.exitFns) fn(e)
  }

  private async changeModel(model: string): Promise<void> {
    const m = this.models
    if (!m) throw new Error('Model selection is unsupported by this agent')
    if (m.via === 'config')
      await this.peer.request(M.setConfigOption, {
        sessionId: this.id,
        configId: m.configId,
        value: model,
      })
    else await this.peer.request(M.setModel, { sessionId: this.id, modelId: model })
  }

  push(prompt: string): void {
    if (this.ended || this.closed) return
    this.queue.push(prompt)
    this.pump()
  }

  /** Claude permission modes do not apply to ACP agents; their modes go through `setModeId`. */
  async setMode(_mode: PermissionMode): Promise<void> {}

  async setModel(model: string): Promise<void> {
    await this.sessionId
    await this.changeModel(model)
  }

  async setModeId(modeId: string): Promise<void> {
    await this.sessionId
    const native = this.allowedMode(modeId)
    if (!native) throw new Error(`Mode not available: ${modeId.slice(0, 60)}`)
    await this.peer.request(M.setMode, { sessionId: this.id, modeId: native })
    this.currentMode = native
  }

  async supportedModels(): Promise<ModelOption[]> {
    if (this.ended || this.closed) return []
    try {
      await this.sessionId
    } catch {
      return []
    }
    return this.models ? this.models.models.map((m) => ({ ...m })) : []
  }

  async interrupt(): Promise<void> {
    this.cancelPermissions()
    if (!this.active || !this.id) return
    this.peer.notify(M.cancel, { sessionId: this.id })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.queue = []
    this.cancelPermissions()
    this.peer.close()
    this.t.stdin.end?.()
    await this.t.kill()
    this.finish({})
  }

  onEvent(fn: (e: Omit<AgentEvent, 'agentId'>) => void): () => void {
    this.events.add(fn)
    return () => this.events.delete(fn)
  }

  onResult(fn: (r: { text: string; isError: boolean }) => void): () => void {
    this.results.add(fn)
    return () => this.results.delete(fn)
  }

  onPermission(fn: (r: RunnerPermission) => Promise<RunnerDecision>): void {
    this.permissionFn = fn
  }

  onExit(fn: (e: RunnerExit) => void): void {
    this.exitFns.add(fn)
  }
}
