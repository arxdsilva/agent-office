// Driven adapter: managed Codex sessions over `codex app-server` (stdio JSONL, JSON-RPC without the
// "jsonrpc" field). Lifecycle: docs/provider-integrations.md §5.1. Events are status/tool only;
// the agent's reply goes only to the session's own chat (onResult, ≤ 4000 chars).
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
import { type ByteSink, type ByteSource, JsonRpcPeer, PeerClosedError } from '../common/jsonrpc.ts'
import {
  classifyExit,
  type RuntimeExit,
  spawnRuntime,
  type SpawnRuntimeOptions,
} from '../common/process.ts'
import {
  approvalToPermission,
  CODEX_DEFAULT_MODE,
  CODEX_MODES,
  decisionToCodex,
  itemEvent,
  modePreset,
  sandboxPolicy,
  turnCompletedEvent,
  type EventPatch,
} from './codex-map.ts'
import {
  AccountReadResult,
  AgentMessageDelta,
  CommandApprovalParams,
  type CodexDecision,
  FileChangeApprovalParams,
  ItemNotification,
  M,
  ModelListResult,
  ThreadStartResult,
  TurnNotification,
  TurnStartResult,
} from './codex-protocol.ts'

/** What the runner needs from a spawned app-server (a `RuntimeProcess`, or an in-process double). */
export interface CodexTransport {
  readonly stdin: ByteSink & { end?(): unknown }
  readonly stdout: ByteSource
  kill(): Promise<void>
  readonly exited: Promise<RuntimeExit>
  stderrTail(): string
  alive(): boolean
}

export interface CodexRunnerOptions {
  /** The Codex CLI. Default 'codex' (resolved on PATH by the OS). */
  bin?: string
  /** Default ['app-server']. */
  args?: string[]
  /** Extra environment for the CLI (merged over process.env; our token is always removed). */
  env?: Record<string, string | undefined>
  log?: Logger
  /** Per-request timeout for control calls (initialize, thread/start, …). Default 30 s. */
  requestTimeoutMs?: number
  /** Test seam: replaces spawning a process. */
  spawn?: (bin: string, args: string[], o: SpawnRuntimeOptions) => CodexTransport
}

const MAX_REPLY = 4000
const MAX_ITEMS = 64
const CLIENT = { name: 'agent-office', title: 'agent-office', version: '1' }

const EXIT_MESSAGES: Record<NonNullable<RunnerExit['error']>, string> = {
  auth: 'Codex needs a login. Run `codex login`, then start the session again.',
  folder: 'The folder does not exist.',
  runtime: 'Codex could not be started.',
  crash: 'Codex stopped unexpectedly.',
}

export const CODEX_DECL: RunnerDecl = {
  provider: 'codex',
  prefix: 'cx:',
  caps: [
    'launch',
    'send-message',
    'interrupt',
    'stop',
    'approve-tools',
    'select-model',
    'change-mode',
    'attach-context',
  ],
  modes: CODEX_MODES,
  defaultModeId: CODEX_DEFAULT_MODE,
  fallbackModels: [],
}

export class CodexRunner implements AgentRunner {
  readonly decl: RunnerDecl = CODEX_DECL

  constructor(private o: CodexRunnerOptions = {}) {}

  start(s: RunnerStart): RunnerSession {
    return new CodexSession(this.o, s)
  }
}

interface ActiveTurn {
  id?: string
  interruptRequested?: boolean
}

type Item = { type: string; id: string } & Record<string, unknown>

class CodexSession implements RunnerSession {
  readonly sessionId: Promise<string>
  private resolveId!: (id: string) => void
  private rejectId!: (e: RunnerExit) => void
  private t: CodexTransport
  private peer: JsonRpcPeer
  private threadId: string | undefined
  private started = false
  private ended = false
  private closed = false
  private queue: string[] = []
  private active: ActiveTurn | undefined
  private items = new Map<string, Item>()
  private reply = ''
  private replyItem: string | undefined
  private approvals = new Set<() => void>()
  private pendingModel: string | undefined
  private pendingMode: string | undefined
  private firstTurn = true
  private modeId: string
  private models: Promise<ModelOption[]> | undefined
  private events = new Set<(e: Omit<AgentEvent, 'agentId'>) => void>()
  private results = new Set<(r: { text: string; isError: boolean }) => void>()
  private permissionFn: ((r: RunnerPermission) => Promise<RunnerDecision>) | undefined
  private exitFns = new Set<(e: RunnerExit) => void>()

  constructor(
    private o: CodexRunnerOptions,
    private s: RunnerStart,
  ) {
    this.sessionId = new Promise((res, rej) => {
      this.resolveId = res
      this.rejectId = rej
    })
    this.sessionId.catch(() => {})
    this.modeId = this.allowedMode(s.modeId) ?? CODEX_DEFAULT_MODE
    const spawn = o.spawn ?? spawnRuntime
    this.t = spawn(o.bin ?? 'codex', o.args ?? ['app-server'], {
      cwd: s.cwd,
      ...(o.env ? { env: o.env } : {}),
    })
    this.peer = new JsonRpcPeer(this.t.stdout, this.t.stdin, {
      dialect: 'codex',
      timeoutMs: o.requestTimeoutMs ?? 30_000,
    })
    this.listen()
    void this.t.exited.then((e) => this.onProcessExit(e))
    void this.run()
  }

  /** A preset id this session may use: known, and dangerous only with `allowBypass`. */
  private allowedMode(id: string | undefined): string | undefined {
    const m = CODEX_MODES.find((x) => x.id === id)
    if (!m || (m.dangerous && !this.s.allowBypass)) return undefined
    return m.id
  }

  private async run(): Promise<void> {
    try {
      await this.peer.request(M.initialize, { clientInfo: CLIENT })
      this.peer.notify(M.initialized)
      const acct = AccountReadResult.parse(
        await this.peer.request(M.accountRead, { refreshToken: false }),
      )
      if (acct.requiresOpenaiAuth && !acct.account) return this.fail('auth', 'account')
      const preset = modePreset(this.modeId)!
      const thread = ThreadStartResult.parse(
        await this.peer.request(M.threadStart, {
          cwd: this.s.cwd,
          ...(this.s.model ? { model: this.s.model } : {}),
          approvalPolicy: preset.approvalPolicy,
          sandbox: preset.sandbox,
        }),
      )
      if (this.ended) return
      this.threadId = thread.thread.id
      this.started = true
      this.resolveId(this.threadId)
      this.pump()
    } catch (err) {
      // The process went away: its exit classifies the failure.
      if (err instanceof PeerClosedError || this.ended) return
      this.fail('runtime', err instanceof Error ? err.name : 'protocol')
    }
  }

  private listen(): void {
    const p = this.peer
    p.onNotification(M.turnStarted, (raw) => {
      const n = TurnNotification.safeParse(raw)
      if (!n.success || !this.ours(n.data.threadId)) return
      if (!this.active) this.active = { id: n.data.turn.id }
      else this.active.id ??= n.data.turn.id
      this.emit({ status: 'thinking' })
    })
    p.onNotification(M.itemStarted, (raw) => this.onItem(raw, 'started'))
    p.onNotification(M.itemCompleted, (raw) => this.onItem(raw, 'completed'))
    p.onNotification(M.agentMessageDelta, (raw) => {
      const n = AgentMessageDelta.safeParse(raw)
      if (!n.success || !this.ours(n.data.threadId)) return
      if (n.data.itemId !== this.replyItem) {
        this.replyItem = n.data.itemId
        this.reply = ''
      }
      this.reply = (this.reply + n.data.delta).slice(0, MAX_REPLY)
    })
    p.onNotification(M.turnCompleted, (raw) => {
      const n = TurnNotification.safeParse(raw)
      if (!n.success || !this.ours(n.data.threadId)) return
      this.onTurnCompleted(n.data.turn.id, String(n.data.turn.status))
    })
    p.onRequest(M.commandApproval, (raw) => this.approve('command', raw))
    p.onRequest(M.fileChangeApproval, (raw) => this.approve('fileChange', raw))
    // Every other server request (item/tool/requestUserInput, mcpServer/elicitation/request,
    // item/tool/call, …) gets the peer's -32601 reply, so Codex never waits on us.
  }

  private ours(threadId: string): boolean {
    return this.threadId === undefined || threadId === this.threadId
  }

  private onItem(raw: unknown, phase: 'started' | 'completed'): void {
    const n = ItemNotification.safeParse(raw)
    if (!n.success || !this.ours(n.data.threadId)) return
    const item = n.data.item as Item
    if (phase === 'started') {
      if (this.items.size >= MAX_ITEMS) this.items.delete(this.items.keys().next().value!)
      this.items.set(item.id, item)
    } else if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text) {
      this.replyItem = item.id
      this.reply = item.text.slice(0, MAX_REPLY)
    }
    const e = itemEvent(item, phase)
    if (e) this.emit(e)
  }

  private onTurnCompleted(turnId: string, status: string): void {
    const reply = this.reply
    this.reply = ''
    this.replyItem = undefined
    this.items.clear()
    this.cancelApprovals()
    const e = turnCompletedEvent(status, reply)
    if (e) this.emit(e)
    if (status === 'completed') this.result({ text: reply, isError: false })
    else if (status === 'interrupted') this.result({ text: '', isError: false })
    else if (status === 'failed') this.result({ text: '', isError: true })
    if (this.active && (this.active.id === undefined || this.active.id === turnId)) {
      this.active = undefined
      this.pump()
    }
  }

  /** Starts the next queued prompt when no turn is running (one turn at a time). */
  private pump(): void {
    if (!this.threadId || this.active || this.ended || this.closed) return
    const text = this.queue.shift()
    if (text === undefined) return
    const turn: ActiveTurn = {}
    this.active = turn
    const params: Record<string, unknown> = {
      threadId: this.threadId,
      input: [{ type: 'text', text }],
    }
    if (this.pendingModel) params.model = this.pendingModel
    const preset = modePreset(this.pendingMode ?? this.modeId)!
    if (this.pendingMode) params.approvalPolicy = preset.approvalPolicy
    if (this.pendingMode || (this.firstTurn && this.s.extraDirs.length))
      params.sandboxPolicy = sandboxPolicy(preset.sandbox, this.s.extraDirs)
    if (this.pendingMode) this.modeId = this.pendingMode
    this.pendingModel = undefined
    this.pendingMode = undefined
    this.firstTurn = false
    this.peer.request(M.turnStart, params).then(
      (raw) => {
        const r = TurnStartResult.safeParse(raw)
        if (r.success) turn.id ??= r.data.turn.id
        if (turn.interruptRequested && this.active === turn) void this.sendInterrupt(turn)
      },
      (err) => {
        if (err instanceof PeerClosedError || this.ended) return
        this.o.log?.warn(`codex: turn/start failed (${err instanceof Error ? err.name : 'error'})`)
        this.emit({ status: 'error' })
        this.result({ text: '', isError: true })
        if (this.active === turn) {
          this.active = undefined
          this.pump()
        }
      },
    )
  }

  private async approve(
    kind: 'command' | 'fileChange',
    raw: unknown,
  ): Promise<{ decision: CodexDecision }> {
    const parsed = (
      kind === 'command' ? CommandApprovalParams : FileChangeApprovalParams
    ).safeParse(raw)
    if (!parsed.success || !this.permissionFn || this.closed) return { decision: 'decline' }
    const perm = approvalToPermission(
      kind,
      parsed.data,
      this.items.get(parsed.data.itemId),
      this.s.cwd,
    )
    let cancel!: () => void
    const cancelled = new Promise<'cancel'>((r) => (cancel = () => r('cancel')))
    this.approvals.add(cancel)
    try {
      const d = await Promise.race([
        this.permissionFn(perm).catch((): RunnerDecision => ({
          behavior: 'deny',
          message: 'No decision',
        })),
        cancelled,
      ])
      return { decision: decisionToCodex(d) }
    } finally {
      this.approvals.delete(cancel)
    }
  }

  private cancelApprovals(): void {
    for (const c of [...this.approvals]) c()
    this.approvals.clear()
  }

  private async sendInterrupt(turn: ActiveTurn): Promise<void> {
    if (!this.threadId || !turn.id) return
    await this.peer
      .request(M.turnInterrupt, { threadId: this.threadId, turnId: turn.id })
      .catch(() => {})
  }

  private emit(e: EventPatch): void {
    for (const fn of this.events) fn(e)
  }

  private result(r: { text: string; isError: boolean }): void {
    for (const fn of this.results) fn(r)
  }

  private fail(error: NonNullable<RunnerExit['error']>, tag: string): void {
    this.o.log?.warn(`codex: session ended (${error}: ${tag})`)
    this.finish({ error, message: EXIT_MESSAGES[error] })
    void this.t.kill()
  }

  private onProcessExit(e: RuntimeExit): void {
    if (this.closed || this.ended) return this.finish({})
    const error = classifyExit(e.code, this.t.stderrTail(), e.spawnError)
    // Class and code only: stderr may hold paths or account details.
    this.o.log?.warn(`codex: app-server exited (${error}: ${e.spawnError ?? e.code ?? e.signal})`)
    this.finish({ error, message: EXIT_MESSAGES[error] })
  }

  private finish(e: RunnerExit): void {
    if (this.ended) return
    this.ended = true
    this.queue = []
    this.cancelApprovals()
    this.peer.close()
    if (!this.started) this.rejectId(e.error ? e : { error: 'crash' })
    for (const fn of this.exitFns) fn(e)
  }

  push(prompt: string): void {
    if (this.ended || this.closed) return
    this.queue.push(prompt)
    this.pump()
  }

  /** Claude permission modes do not apply to Codex; its presets go through `setModeId`. */
  async setMode(_mode: PermissionMode): Promise<void> {}

  /** Applied on the next `turn/start`. */
  async setModel(model: string): Promise<void> {
    this.pendingModel = model
  }

  /** Applied on the next `turn/start`; dangerous presets only with `allowBypass`. */
  async setModeId(modeId: string): Promise<void> {
    const id = this.allowedMode(modeId)
    if (!id) throw new Error(`Mode not available: ${modeId}`)
    this.pendingMode = id === this.modeId ? undefined : id
  }

  async supportedModels(): Promise<ModelOption[]> {
    if (this.ended || this.closed) return []
    this.models ??= this.listModels()
    const list = await this.models.catch(() => undefined)
    if (list) return list
    this.models = undefined
    return []
  }

  private async listModels(): Promise<ModelOption[]> {
    await this.sessionId
    const out: ModelOption[] = []
    let cursor: string | undefined
    for (let page = 0; page < 5; page++) {
      const r = ModelListResult.parse(
        await this.peer.request(M.modelList, {
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        }),
      )
      for (const m of r.data) {
        if (m.hidden) continue
        out.push({
          id: m.model,
          label: m.displayName,
          ...(m.description ? { description: m.description } : {}),
        })
      }
      if (!r.nextCursor) break
      cursor = r.nextCursor
    }
    return out
  }

  async interrupt(): Promise<void> {
    this.cancelApprovals()
    const turn = this.active
    if (!turn) return
    if (turn.id) await this.sendInterrupt(turn)
    else turn.interruptRequested = true
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.queue = []
    this.cancelApprovals()
    this.peer.close()
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
