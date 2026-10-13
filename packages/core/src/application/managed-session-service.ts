import type {
  AgentEvent,
  ChatMessage,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  PermissionRequestVM,
  ProviderId,
} from '@agent-office/shared'
import type { AgentState } from '../domain/agent.ts'
import {
  NotAllowedError,
  RateLimitedError,
  SessionStartError,
  UnknownAgentError,
  ValidationError,
  type SessionStartCode,
} from '../domain/errors.ts'
import type { ActionPolicy, EnforcementDecl, SessionHarnessHooks } from '../domain/harness-types.ts'
import { newUserMessage } from '../domain/message.ts'
import { ENDED_CAPS } from '../domain/providers.ts'
import { RateWindow } from '../domain/rate-limit.ts'
import {
  allowKey,
  composePrompt,
  contextChips,
  MODE_LABELS,
  modeOf,
  summarizeToolRequest,
} from '../domain/session-prompt.ts'
import type {
  AgentRepository,
  AgentRunner,
  Clock,
  EventPublisher,
  IdGenerator,
  MessageRepository,
  RunnerDecision,
  RunnerDecl,
  RunnerExit,
  RunnerPermission,
  RunnerSession,
  RunnerStart,
  Scheduler,
} from '../ports/driven.ts'
import type {
  AgentInbox,
  ComposedMessage,
  ComposeMessage,
  ManagedSessions,
  ReportActivity,
  SessionObservation,
  SettingsManagement,
  StartSession,
  UserChat,
} from '../ports/driving.ts'

export const MAX_MANAGED = 6
export const START_TIMEOUT_MS = 20_000
/** Keeps idle running sessions from expiring (the sweep removes agents silent for 10 min). */
export const HEARTBEAT_MS = 4 * 60_000
const MAX_REPLY = 4000

/** Shown when the runtime can't list its models (Claude Code aliases). */
export const FALLBACK_MODELS: ModelOption[] = [
  { id: 'default', label: 'Default (recommended)' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
]

const SYSTEM = {
  mode: (l: string) => `Mode → ${l}`,
  model: (l: string) => `Model → ${l}`,
  interrupted: 'Interrupted',
  ended: 'Session ended',
  crashed: 'Session ended unexpectedly',
  needsApproval: 'Needs approval',
  denied: 'The user denied this request.',
}

export interface ManagedSessionDeps {
  /** Claude Code's runtime (the 'claude-code' entry when `runtimes` has none). */
  runner?: AgentRunner
  /** Every managed runtime by provider (Codex, ACP agents, …). */
  runtimes?: ReadonlyMap<ProviderId, AgentRunner>
  activity: ReportActivity
  agents: AgentRepository
  messages: MessageRepository
  inbox: AgentInbox
  settings: Pick<SettingsManagement, 'get'>
  bus: EventPublisher
  clock: Clock
  scheduler: Scheduler
  ids: IdGenerator
  /** `perm_` + 10 base36 chars; injectable for tests. */
  permId?: () => string
  /** How a working directory is shown on permission cards (the composition root '~'-abbreviates). */
  displayPath?: (path: string) => string
  maxSessions?: number
  startTimeoutMs?: number
  rateLimitPerSec?: number
  /** Projects (docs/projects.md): validates `StartSession.projectId`. */
  projectExists?: (projectId: string) => boolean
  /** Per-session MCP tokens; `mint` returns null when the project policy denies the provider. */
  mcp?: {
    mint(o: { projectId: string; provider: string }): { token: string; tokenId: string } | null
    bind(tokenId: string, agentId: string): void
    revoke(tokenId: string): void
  }
  /** The bridge command for a token (built by the adapter that owns the wrapper). */
  mcpLaunch?: (token: string) => RunnerStart['mcp']
  /** Sessions started outside a project report their folder for matching. */
  observation?: SessionObservation
  /** Harness policy for project sessions (docs/harness.md); without it nothing is enforced. */
  harness?: SessionHarnessHooks
}

/** The rule name on a harness permission card: the reason up to " — " (≤ 60 chars). */
function ruleNameOf(reason: string): string {
  return (reason.split(' — ')[0] ?? '').slice(0, 60) || 'Harness rule'
}

/** Never an absolute path: the last segment of a POSIX or Windows path. */
export function basenameOnly(path: string): string {
  const last = path.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
  return last ? `…/${last}` : '…'
}

interface Pending {
  vm: PermissionRequestVM
  key: string
  resolve: (d: RunnerDecision) => void
  /** A harness rule asked: answered once, never remembered for the session. */
  harness?: boolean
}

interface Session {
  provider: ProviderId
  prefix: string
  /** Absent for Claude Code: legacy UI rules, no provider modes. */
  decl?: RunnerDecl
  agentId: string
  sessionId: string
  runner: RunnerSession
  cwd: string
  allow: Set<string>
  pending: Map<string, Pending>
  /** The current turn was interrupted: its (error) result must not flip the status. */
  interrupted: boolean
  models?: ModelOption[]
  /** This session's MCP token (revoked when it ends). */
  mcpTokenId?: string
  /** The bound harness policy, and what the runtime enforces (mode switches are checked). */
  policy?: ActionPolicy
  enforcement?: EnforcementDecl
  /** Subagent agent ids this session reported (owned, ended with it). */
  children: Set<string>
  /**
   * Runner callbacks that arrived before start() registered the session (the first prompt is pushed
   * before the id is known); replayed in order once it is registered, dropped if the start fails.
   */
  early?: Early[]
}

interface Early {
  run: () => void
  /** Set for a permission request: answers it when the start fails. */
  deny?: (d: RunnerDecision) => void
}

const randomPermId = () => {
  let s = ''
  while (s.length < 10) s += Math.random().toString(36).slice(2)
  return `perm_${s.slice(0, 10)}`
}

const EXIT_CODES: Record<NonNullable<RunnerExit['error']>, SessionStartCode> = {
  auth: 'auth',
  runtime: 'runtime',
  folder: 'folder',
  crash: 'other',
}

function toStartError(err: unknown): SessionStartError {
  if (err instanceof SessionStartError) return err
  const exit = err as RunnerExit | undefined
  const code = (exit?.error && EXIT_CODES[exit.error]) ?? 'other'
  return new SessionStartError(code)
}

/**
 * Sessions agent-office starts and owns, for every provider runtime (AgentRunner port). Turns runner
 * activity into office events, permission prompts into approvable requests, and results into replies.
 */
export class ManagedSessionService implements ManagedSessions {
  private sessions = new Map<string, Session>()
  private starting = 0
  private rate: RateWindow
  /** The last model list each provider's sessions reported. */
  private lastModels = new Map<ProviderId, ModelOption[]>()
  private cancelHeartbeat: (() => void) | undefined

  constructor(private d: ManagedSessionDeps) {
    this.rate = new RateWindow(d.rateLimitPerSec ?? 10)
  }

  async start(o: StartSession): Promise<string> {
    if (this.count() >= (this.d.maxSessions ?? MAX_MANAGED)) throw new SessionStartError('limit')
    const provider = o.provider ?? 'claude-code'
    const runtime = this.runtime(provider)
    if (!runtime) throw new SessionStartError('runtime')
    const decl = runtime.decl
    if (o.chrome && decl && !decl.caps.includes('chrome'))
      throw new NotAllowedError('This provider cannot use Chrome')
    const settings = await this.d.settings.get()
    const bypass = o.mode === 'bypassPermissions'
    if (bypass && !settings.allowBypassPermissions)
      throw new NotAllowedError('Bypass permissions is turned off in Settings')
    const mode = decl?.modes ? this.modeOption(decl, o.modeId ?? decl.defaultModeId) : undefined
    if (mode?.dangerous && !settings.allowBypassPermissions)
      throw new NotAllowedError('Dangerous modes are turned off in Settings')
    if (o.projectId && this.d.projectExists && !this.d.projectExists(o.projectId))
      throw new ValidationError('unknown project')
    const sessionProvider = decl?.provider ?? 'claude-code'
    const enforcement = runtime.enforcement ?? decl?.enforcement
    const policy = o.projectId
      ? await this.prepareHarness(o, sessionProvider, mode?.id, enforcement)
      : undefined
    // Advisory harness: a mode the runtime cannot intercept in is coerced (strict refused above).
    const blind = (m: string | undefined) =>
      !!policy && m !== undefined && !!enforcement?.nonInterceptingModes?.includes(m)
    const permissionMode: PermissionMode = blind(o.mode)
      ? (modeOf(enforcement?.interceptingMode) ?? 'default')
      : o.mode
    const runMode =
      blind(mode?.id) && decl ? this.coercedMode(decl, enforcement?.interceptingMode) : mode
    const minted =
      o.projectId && this.d.mcp && this.d.mcpLaunch
        ? this.d.mcp.mint({ projectId: o.projectId, provider: sessionProvider })
        : null
    const mcp = minted ? this.d.mcpLaunch!(minted.token) : undefined
    this.starting++
    let s: Session
    let starting: Session | undefined
    let sessionId: string
    try {
      const runner = runtime.start({
        cwd: o.cwd,
        ...(o.model ? { model: o.model } : {}),
        mode: permissionMode,
        extraDirs: o.extraDirs,
        chrome: o.chrome,
        allowBypass: permissionMode === 'bypassPermissions' || !!runMode?.dangerous,
        ...(runMode ? { modeId: runMode.id } : {}),
        ...(mcp ? { mcp } : {}),
        ...(policy ? { harness: policy } : {}),
        // Native resume is Claude-only; other runners never see it.
        ...(o.resume && sessionProvider === 'claude-code' ? { resume: o.resume } : {}),
      })
      s = {
        provider: decl?.provider ?? 'claude-code',
        prefix: decl?.prefix ?? 'cc:',
        ...(decl ? { decl } : {}),
        agentId: '',
        sessionId: '',
        runner,
        cwd: o.cwd,
        allow: new Set(),
        pending: new Map(),
        interrupted: false,
        ...(minted ? { mcpTokenId: minted.tokenId } : {}),
        ...(policy ? { policy } : {}),
        ...(enforcement ? { enforcement } : {}),
        children: new Set(),
        early: [],
      }
      const sess = s
      starting = s
      runner.onEvent((e) => this.whenRegistered(sess, () => this.onRunnerEvent(sess, e)))
      runner.onResult((r) => this.whenRegistered(sess, () => this.onRunnerResult(sess, r)))
      runner.onPermission(
        (r) =>
          new Promise<RunnerDecision>((resolve) =>
            this.whenRegistered(sess, () => resolve(this.onRunnerPermission(sess, r)), resolve),
          ),
      )
      runner.onExit((e) => this.onRunnerExit(sess, e))
      runner.onChild?.((c) => this.whenRegistered(sess, () => this.onRunnerChild(sess, c)))
      // The first prompt goes in before the id: some runtimes (Claude CLI 2.1.x) report their
      // session id only once it arrives. Every runner queues prompts until it is ready.
      runner.push(composePrompt(o.first))
      try {
        sessionId = await this.withTimeout(runner.sessionId)
      } catch (err) {
        void runner.close().catch(() => {})
        throw err
      }
    } catch (err) {
      if (minted) this.d.mcp!.revoke(minted.tokenId)
      if (starting) this.dropEarly(starting)
      throw toStartError(err)
    } finally {
      this.starting--
    }

    const agentId = `${s.prefix}${sessionId}`
    s.agentId = agentId
    s.sessionId = sessionId
    this.sessions.set(agentId, s)
    if (minted) this.d.mcp!.bind(minted.tokenId, agentId)
    this.report([
      {
        agentId,
        provider: s.provider,
        source: 'managed',
        name: o.name,
        topic: o.name,
        status: 'thinking',
        text: '',
        ...(o.model ? { model: o.model } : {}),
      },
    ])
    this.patch(agentId, (a) => ({
      ...a,
      permissionMode,
      ...(decl ? { caps: [...decl.caps] } : {}),
      ...(runMode ? { modeId: runMode.id } : {}),
      ...(o.projectId ? { projectId: o.projectId } : {}),
      managed: {
        chrome: o.chrome,
        pending: 0,
        phase: 'running',
        ...(o.model ? { modelId: o.model } : {}),
        ...(decl?.modes ? { modes: decl.modes.map((m) => ({ ...m })) } : {}),
      },
    }))
    this.cancelHeartbeat ??= this.d.scheduler.every(HEARTBEAT_MS, () => this.heartbeat())
    if (policy && o.projectId)
      this.d.harness!.bind({ agentId, sessionId, projectId: o.projectId, policy })
    this.record(s, o.first)
    const early = s.early ?? []
    delete s.early
    for (const e of early) e.run()
    if (this.d.observation)
      void this.d.observation.located(agentId, s.provider, { cwd: o.cwd }).catch(() => {})
    return agentId
  }

  /** A user message to a managed session: stored as delivered, pushed to the runner. */
  async send(agentId: string, m: ComposedMessage): Promise<ChatMessage> {
    const s = this.require(agentId)
    this.limit(agentId)
    return this.deliver(s, m)
  }

  async setMode(agentId: string, mode: PermissionMode): Promise<void> {
    const s = this.require(agentId)
    this.limit(agentId)
    if (mode === 'bypassPermissions' && !(await this.d.settings.get()).allowBypassPermissions)
      throw new NotAllowedError('Bypass permissions is turned off in Settings')
    this.assertIntercepting(s, mode)
    await s.runner.setMode(mode)
    this.patch(agentId, (a) => ({ ...a, permissionMode: mode }))
    this.systemLine(agentId, SYSTEM.mode(MODE_LABELS[mode]))
  }

  async setModel(agentId: string, model: string): Promise<void> {
    const s = this.require(agentId)
    this.limit(agentId)
    await s.runner.setModel(model)
    const label = this.modelsOf(s).find((x) => x.id === model)?.label
    this.patch(agentId, (a) => ({
      ...a,
      model: (label ?? model).slice(0, 100),
      ...(a.managed ? { managed: { ...a.managed, modelId: model } } : {}),
    }))
    this.systemLine(agentId, SYSTEM.model(label ?? model))
  }

  async models(agentId?: string): Promise<ModelOption[]> {
    if (agentId === undefined) return this.lastModels.get('claude-code') ?? FALLBACK_MODELS
    const s = this.require(agentId)
    try {
      const list = await s.runner.supportedModels()
      if (list.length) {
        s.models = list
        this.lastModels.set(s.provider, list)
        return list
      }
    } catch {
      /* fall back below */
    }
    return this.modelsOf(s)
  }

  /** The last model list a session of this provider reported (none yet: undefined). */
  knownModels(provider: ProviderId): ModelOption[] | undefined {
    return this.lastModels.get(provider)
  }

  async setModeId(agentId: string, modeId: string): Promise<void> {
    const s = this.require(agentId)
    this.limit(agentId)
    if (!s.decl?.modes || !s.runner.setModeId)
      throw new ValidationError('this session has no provider modes')
    const mode = this.modeOption(s.decl, modeId)
    if (mode?.dangerous && !(await this.d.settings.get()).allowBypassPermissions)
      throw new NotAllowedError('Dangerous modes are turned off in Settings')
    this.assertIntercepting(s, modeId)
    await s.runner.setModeId(modeId)
    this.patch(agentId, (a) => ({ ...a, modeId }))
    this.systemLine(agentId, SYSTEM.mode(mode?.label ?? modeId))
  }

  owns(agentId: string): boolean {
    if (this.sessions.has(agentId)) return true
    for (const s of this.sessions.values()) if (s.children.has(agentId)) return true
    return false
  }

  async interrupt(agentId: string): Promise<void> {
    const s = this.require(agentId)
    this.limit(agentId)
    this.cancelPending(s, SYSTEM.interrupted)
    s.interrupted = true
    await s.runner.interrupt()
    this.report([{ agentId, status: 'idle', text: '' }])
    this.systemLine(agentId, SYSTEM.interrupted)
  }

  async stop(agentId: string): Promise<void> {
    const s = this.sessions.get(agentId)
    if (!s) {
      // An ended (crashed) session still shown in the office: Stop lets it leave.
      if (this.d.agents.get(agentId)?.managed?.phase === 'ended') {
        this.report([{ agentId, status: 'done', text: '' }])
        return
      }
      throw new UnknownAgentError(agentId)
    }
    this.limit(agentId)
    await this.end(s, 'stopped')
  }

  answer(agentId: string, requestId: string, decision: PermissionDecision): void {
    const s = this.require(agentId)
    this.limit(agentId)
    const p = s.pending.get(requestId)
    if (!p) return
    s.pending.delete(requestId)
    if (decision === 'deny') p.resolve({ behavior: 'deny', message: SYSTEM.denied })
    else p.resolve({ behavior: 'allow' })
    if (decision === 'allow-session' && !p.harness) {
      s.allow.add(p.key)
      for (const [id, other] of s.pending)
        if (other.key === p.key) {
          s.pending.delete(id)
          other.resolve({ behavior: 'allow' })
        }
    }
    this.pendingChanged(s)
  }

  pending(agentId: string): PermissionRequestVM[] {
    return [...(this.sessions.get(agentId)?.pending.values() ?? [])].map((p) => p.vm)
  }

  isManaged(agentId: string): boolean {
    return this.sessions.has(agentId)
  }

  isManagedSession(sessionId: string): boolean {
    return this.sessions.get(`cc:${sessionId}`)?.provider === 'claude-code'
  }

  count(): number {
    return this.sessions.size + this.starting
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => this.end(s, 'stopped')))
  }

  // ── runner callbacks ──

  private onRunnerEvent(s: Session, e: Omit<AgentEvent, 'agentId'>): void {
    if (!this.isLive(s)) return
    const { name: _name, ...rest } = e
    this.report([{ ...rest, agentId: s.agentId, source: 'managed', provider: s.provider }])
  }

  private onRunnerResult(s: Session, r: { text: string; isError: boolean }): void {
    if (!this.isLive(s)) return
    const text = r.text.slice(0, MAX_REPLY)
    if (text) this.d.inbox.reply(s.agentId, text)
    if (s.policy)
      this.d.harness?.turnEnded(s.agentId, { isError: r.isError, interrupted: s.interrupted })
    if (s.interrupted) {
      s.interrupted = false
      return
    }
    this.report([
      { agentId: s.agentId, status: r.isError && !text ? 'error' : 'waiting', text: '' },
    ])
  }

  private onRunnerPermission(s: Session, r: RunnerPermission): Promise<RunnerDecision> {
    if (!this.isLive(s)) return Promise.resolve({ behavior: 'deny', message: SYSTEM.ended })
    let rule: PermissionRequestVM['rule']
    if (s.policy && this.d.harness) {
      const d = this.d.harness.evaluate(s.agentId, {
        tool: r.tool,
        input: r.input,
        cwd: r.cwd,
        provider: s.provider,
        agentRole: r.agent?.type ?? 'main',
      })
      if (d.action === 'deny') return Promise.resolve({ behavior: 'deny', message: d.reason })
      if (d.action === 'ask') rule = { id: d.ruleIds[0] ?? 'harness', name: ruleNameOf(d.reason) }
    }
    const key = allowKey(r.tool, r.input)
    if (!rule && s.allow.has(key)) return Promise.resolve({ behavior: 'allow' })
    return new Promise((resolve) => {
      const id = (this.d.permId ?? randomPermId)()
      const { tool, summary } = summarizeToolRequest(r.tool, r.input, r.cwd)
      const where = (this.d.displayPath ?? basenameOnly)(r.cwd)
      s.pending.set(id, {
        vm: { id, tool, summary, where, ...(rule ? { rule } : {}) },
        key,
        resolve,
        ...(rule ? { harness: true } : {}),
      })
      this.pendingChanged(s)
    })
  }

  /** A subagent's event: reported as its own agent under this session (and owned by it). */
  private onRunnerChild(
    s: Session,
    c: { childId: string; event: Omit<AgentEvent, 'agentId' | 'parentId'> },
  ): void {
    if (!this.isLive(s) || !c.childId || c.childId === s.agentId) return
    s.children.add(c.childId)
    this.report([
      {
        ...c.event,
        agentId: c.childId,
        parentId: s.agentId,
        source: 'managed',
        provider: s.provider,
      },
    ])
  }

  private onRunnerExit(s: Session, e: RunnerExit): void {
    if (!this.isLive(s)) return // not started yet (start() maps it) or already ended
    void this.end(s, e.error ? 'crashed' : 'exited')
  }

  // ── helpers ──

  /** Runs `fn` now, or after start() registers the session; `deny` answers a dropped permission. */
  private whenRegistered(s: Session, fn: () => void, deny?: (d: RunnerDecision) => void): void {
    if (!s.early) return fn()
    s.early.push({ run: fn, ...(deny ? { deny } : {}) })
  }

  private dropEarly(s: Session): void {
    const early = s.early ?? []
    delete s.early
    for (const e of early) e.deny?.({ behavior: 'deny', message: SYSTEM.ended })
  }

  private runtime(provider: ProviderId): AgentRunner | undefined {
    const r = this.d.runtimes?.get(provider)
    return r ?? (provider === 'claude-code' ? this.d.runner : undefined)
  }

  /** Resolves the project's harness; any failure other than a refusal also refuses (fail closed). */
  private async prepareHarness(
    o: StartSession,
    provider: ProviderId,
    modeId: string | undefined,
    enforcement: EnforcementDecl | undefined,
  ): Promise<ActionPolicy | undefined> {
    if (!this.d.harness || !o.projectId) return undefined
    try {
      return await this.d.harness.prepare({
        projectId: o.projectId,
        provider,
        cwd: o.cwd,
        mode: o.mode,
        ...(modeId !== undefined ? { modeId } : {}),
        ...(enforcement ? { enforcement } : {}),
      })
    } catch (err) {
      throw err instanceof SessionStartError ? err : new SessionStartError('harness')
    }
  }

  private coercedMode(decl: RunnerDecl, modeId: string | undefined) {
    const m = modeId !== undefined ? decl.modes?.find((x) => x.id === modeId) : undefined
    if (!m) throw new NotAllowedError("This mode can't be used with the project's harness")
    return m
  }

  /** With a bound harness, a mode the runtime cannot intercept in is refused. */
  private assertIntercepting(s: Session, mode: string): void {
    if (s.policy && s.enforcement?.nonInterceptingModes?.includes(mode))
      throw new NotAllowedError("This mode can't be used with the project's harness")
  }

  /** Throws for an id the declaration doesn't offer. */
  private modeOption(decl: RunnerDecl, modeId: string | undefined) {
    if (modeId === undefined) return undefined
    const m = decl.modes?.find((x) => x.id === modeId)
    if (!m) throw new ValidationError(`unknown mode: ${modeId.slice(0, 60)}`)
    return m
  }

  private modelsOf(s: Session): ModelOption[] {
    const fallback = s.decl ? (s.decl.fallbackModels ?? []) : FALLBACK_MODELS
    return s.models ?? this.lastModels.get(s.provider) ?? fallback
  }

  /** Everything this service reports is the managed session's own activity (see ActivityService.owned). */
  private report(events: AgentEvent[]): void {
    this.d.activity.report(events.map((e) => (e.source ? e : { ...e, source: 'managed' })))
  }

  private isLive(s: Session): boolean {
    return !!s.agentId && this.sessions.get(s.agentId) === s
  }

  private require(agentId: string): Session {
    const s = this.sessions.get(agentId)
    if (!s) throw new UnknownAgentError(agentId)
    return s
  }

  private limit(agentId: string): void {
    if (!this.rate.allow(agentId, this.d.clock.now())) throw new RateLimitedError()
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = this.d.scheduler.after(this.d.startTimeoutMs ?? START_TIMEOUT_MS, () =>
        reject(new SessionStartError('other')),
      )
      p.then(
        (v) => {
          cancel()
          resolve(v)
        },
        (err) => {
          cancel()
          reject(err)
        },
      )
    })
  }

  private deliver(s: Session, m: ComposedMessage): ChatMessage {
    const msg = this.record(s, m)
    s.runner.push(composePrompt(m))
    return msg
  }

  /** Stores a user message as delivered and marks the agent thinking (the caller pushes it). */
  private record(s: Session, m: ComposedMessage): ChatMessage {
    const chips = contextChips(m)
    const msg: ChatMessage = {
      ...newUserMessage(this.d.ids.next(), s.agentId, m.text, this.d.clock.now()),
      state: 'delivered',
      ...(chips ? { context: chips } : {}),
    }
    this.d.messages.append(msg)
    this.d.bus.publish({ type: 'message.changed', message: msg })
    s.interrupted = false
    this.report([{ agentId: s.agentId, status: 'thinking', text: '' }])
    return msg
  }

  /** 'stopped' closes the runner; 'exited'/'crashed' come from the runner itself. */
  private async end(s: Session, how: 'stopped' | 'exited' | 'crashed'): Promise<void> {
    if (!this.isLive(s)) return
    this.sessions.delete(s.agentId)
    if (s.mcpTokenId) this.d.mcp?.revoke(s.mcpTokenId)
    if (s.policy) this.d.harness?.ended(s.agentId)
    if (s.children.size)
      this.report(
        [...s.children].map((agentId) => ({ agentId, status: 'done' as const, text: '' })),
      )
    if (this.sessions.size === 0) {
      this.cancelHeartbeat?.()
      this.cancelHeartbeat = undefined
    }
    this.cancelPending(s, SYSTEM.ended)
    if (how === 'stopped') await s.runner.close().catch(() => {})
    this.patch(s.agentId, (a) =>
      a.managed
        ? {
            ...a,
            ...(s.decl ? { caps: [...ENDED_CAPS] } : {}),
            managed: { ...a.managed, phase: 'ended', pending: 0 },
          }
        : a,
    )
    const crashed = how === 'crashed'
    this.report([
      {
        agentId: s.agentId,
        status: crashed ? 'error' : 'done',
        text: crashed ? SYSTEM.crashed : '',
      },
    ])
    this.systemLine(s.agentId, crashed ? SYSTEM.crashed : SYSTEM.ended)
  }

  private cancelPending(s: Session, message: string): void {
    if (!s.pending.size) return
    const all = [...s.pending.values()]
    s.pending.clear()
    for (const p of all) p.resolve({ behavior: 'deny', message })
    this.patch(s.agentId, (a) => (a.managed ? { ...a, managed: { ...a.managed, pending: 0 } } : a))
    this.d.bus.publish({ type: 'permission.changed', agentId: s.agentId })
  }

  private pendingChanged(s: Session): void {
    const n = s.pending.size
    this.report([
      {
        agentId: s.agentId,
        status: n ? 'waiting' : 'thinking',
        text: n ? SYSTEM.needsApproval : '',
      },
    ])
    this.patch(s.agentId, (a) => (a.managed ? { ...a, managed: { ...a.managed, pending: n } } : a))
    this.d.bus.publish({ type: 'permission.changed', agentId: s.agentId })
  }

  private heartbeat(): void {
    this.report([...this.sessions.keys()].map((agentId) => ({ agentId })))
  }

  /** `managed` and `permissionMode` are written only here, never through events. */
  private patch(agentId: string, fn: (a: AgentState) => AgentState): void {
    const prev = this.d.agents.get(agentId)
    if (!prev) return
    const next = fn(prev)
    if (next === prev) return
    this.d.agents.put(next)
    this.d.bus.publish({ type: 'agent.upserted', agent: next })
  }

  private systemLine(agentId: string, text: string): void {
    const m: ChatMessage = {
      id: this.d.ids.next(),
      agentId,
      from: 'system',
      text,
      ts: this.d.clock.now(),
      state: 'replied',
    }
    this.d.messages.append(m)
    this.d.bus.publish({ type: 'message.changed', message: m })
  }
}

export interface ComposeDeps {
  chat: UserChat
  messages: MessageRepository
  bus: EventPublisher
  /** Without it (no runner), everything goes through the inbox. */
  sessions?: Pick<ManagedSessionService, 'isManaged' | 'send'>
}

/** Routes a composed message: managed sessions → their runner; others → the inbox with a preamble. */
export class ComposeService implements ComposeMessage {
  constructor(private d: ComposeDeps) {}

  async send(agentId: string, m: ComposedMessage): Promise<ChatMessage> {
    if (this.d.sessions?.isManaged(agentId)) return this.d.sessions.send(agentId, m)
    const sent = this.d.chat.send(agentId, composePrompt(m))
    const chips = contextChips(m)
    if (!chips) return sent
    const withChips = { ...sent, context: chips }
    this.d.messages.update(withChips)
    this.d.bus.publish({ type: 'message.changed', message: withChips })
    return withChips
  }
}
