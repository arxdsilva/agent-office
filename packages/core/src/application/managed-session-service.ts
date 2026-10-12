import type {
  AgentEvent,
  ChatMessage,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  PermissionRequestVM,
} from '@agent-office/shared'
import type { AgentState } from '../domain/agent.ts'
import {
  NotAllowedError,
  RateLimitedError,
  SessionStartError,
  UnknownAgentError,
  type SessionStartCode,
} from '../domain/errors.ts'
import { newUserMessage } from '../domain/message.ts'
import { RateWindow } from '../domain/rate-limit.ts'
import {
  allowKey,
  composePrompt,
  contextChips,
  MODE_LABELS,
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
  RunnerExit,
  RunnerPermission,
  RunnerSession,
  Scheduler,
} from '../ports/driven.ts'
import type {
  AgentInbox,
  ComposedMessage,
  ComposeMessage,
  ManagedSessions,
  ReportActivity,
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
  runner: AgentRunner
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
}

interface Pending {
  vm: PermissionRequestVM
  key: string
  resolve: (d: RunnerDecision) => void
}

interface Session {
  agentId: string
  sessionId: string
  runner: RunnerSession
  cwd: string
  allow: Set<string>
  pending: Map<string, Pending>
  /** The current turn was interrupted: its (error) result must not flip the status. */
  interrupted: boolean
  models?: ModelOption[]
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
 * Claude Code sessions agent-office starts and owns (through the AgentRunner port). Turns runner
 * activity into office events, permission prompts into approvable requests, and results into replies.
 */
export class ManagedSessionService implements ManagedSessions {
  private sessions = new Map<string, Session>()
  private starting = 0
  private rate: RateWindow
  private lastModels: ModelOption[] | undefined
  private cancelHeartbeat: (() => void) | undefined

  constructor(private d: ManagedSessionDeps) {
    this.rate = new RateWindow(d.rateLimitPerSec ?? 10)
  }

  async start(o: StartSession): Promise<string> {
    if (this.count() >= (this.d.maxSessions ?? MAX_MANAGED)) throw new SessionStartError('limit')
    const settings = await this.d.settings.get()
    const bypass = o.mode === 'bypassPermissions'
    if (bypass && !settings.allowBypassPermissions)
      throw new NotAllowedError('Bypass permissions is turned off in Settings')
    this.starting++
    let s: Session
    let sessionId: string
    try {
      const runner = this.d.runner.start({
        cwd: o.cwd,
        ...(o.model ? { model: o.model } : {}),
        mode: o.mode,
        extraDirs: o.extraDirs,
        chrome: o.chrome,
        allowBypass: bypass,
      })
      s = {
        agentId: '',
        sessionId: '',
        runner,
        cwd: o.cwd,
        allow: new Set(),
        pending: new Map(),
        interrupted: false,
      }
      const sess = s
      runner.onEvent((e) => this.onRunnerEvent(sess, e))
      runner.onResult((r) => this.onRunnerResult(sess, r))
      runner.onPermission((r) => this.onRunnerPermission(sess, r))
      runner.onExit((e) => this.onRunnerExit(sess, e))
      try {
        sessionId = await this.withTimeout(runner.sessionId)
      } catch (err) {
        void runner.close().catch(() => {})
        throw err
      }
    } catch (err) {
      throw toStartError(err)
    } finally {
      this.starting--
    }

    const agentId = `cc:${sessionId}`
    s.agentId = agentId
    s.sessionId = sessionId
    this.sessions.set(agentId, s)
    this.d.activity.report([
      {
        agentId,
        provider: 'claude-code',
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
      permissionMode: o.mode,
      managed: {
        chrome: o.chrome,
        pending: 0,
        phase: 'running',
        ...(o.model ? { modelId: o.model } : {}),
      },
    }))
    this.cancelHeartbeat ??= this.d.scheduler.every(HEARTBEAT_MS, () => this.heartbeat())
    this.deliver(s, o.first)
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
    await s.runner.setMode(mode)
    this.patch(agentId, (a) => ({ ...a, permissionMode: mode }))
    this.systemLine(agentId, SYSTEM.mode(MODE_LABELS[mode]))
  }

  async setModel(agentId: string, model: string): Promise<void> {
    const s = this.require(agentId)
    this.limit(agentId)
    await s.runner.setModel(model)
    const label = (s.models ?? this.lastModels ?? FALLBACK_MODELS).find(
      (x) => x.id === model,
    )?.label
    this.patch(agentId, (a) => ({
      ...a,
      model: (label ?? model).slice(0, 100),
      ...(a.managed ? { managed: { ...a.managed, modelId: model } } : {}),
    }))
    this.systemLine(agentId, SYSTEM.model(label ?? model))
  }

  async models(agentId?: string): Promise<ModelOption[]> {
    if (agentId === undefined) return this.lastModels ?? FALLBACK_MODELS
    const s = this.require(agentId)
    try {
      const list = await s.runner.supportedModels()
      if (list.length) {
        s.models = list
        this.lastModels = list
        return list
      }
    } catch {
      /* fall back below */
    }
    return s.models ?? this.lastModels ?? FALLBACK_MODELS
  }

  async interrupt(agentId: string): Promise<void> {
    const s = this.require(agentId)
    this.limit(agentId)
    this.cancelPending(s, SYSTEM.interrupted)
    s.interrupted = true
    await s.runner.interrupt()
    this.d.activity.report([{ agentId, status: 'idle', text: '' }])
    this.systemLine(agentId, SYSTEM.interrupted)
  }

  async stop(agentId: string): Promise<void> {
    const s = this.sessions.get(agentId)
    if (!s) {
      // An ended (crashed) session still shown in the office: Stop lets it leave.
      if (this.d.agents.get(agentId)?.managed?.phase === 'ended') {
        this.d.activity.report([{ agentId, status: 'done', text: '' }])
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
    if (decision === 'allow-session') {
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
    return this.sessions.has(`cc:${sessionId}`)
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
    this.d.activity.report([
      { ...rest, agentId: s.agentId, source: 'managed', provider: 'claude-code' },
    ])
  }

  private onRunnerResult(s: Session, r: { text: string; isError: boolean }): void {
    if (!this.isLive(s)) return
    const text = r.text.slice(0, MAX_REPLY)
    if (text) this.d.inbox.reply(s.agentId, text)
    if (s.interrupted) {
      s.interrupted = false
      return
    }
    this.d.activity.report([
      { agentId: s.agentId, status: r.isError && !text ? 'error' : 'waiting', text: '' },
    ])
  }

  private onRunnerPermission(s: Session, r: RunnerPermission): Promise<RunnerDecision> {
    if (!this.isLive(s)) return Promise.resolve({ behavior: 'deny', message: SYSTEM.ended })
    const key = allowKey(r.tool, r.input)
    if (s.allow.has(key)) return Promise.resolve({ behavior: 'allow' })
    return new Promise((resolve) => {
      const id = (this.d.permId ?? randomPermId)()
      const { tool, summary } = summarizeToolRequest(r.tool, r.input, r.cwd)
      const where = (this.d.displayPath ?? ((p: string) => p))(r.cwd)
      s.pending.set(id, { vm: { id, tool, summary, where }, key, resolve })
      this.pendingChanged(s)
    })
  }

  private onRunnerExit(s: Session, e: RunnerExit): void {
    if (!this.isLive(s)) return // not started yet (start() maps it) or already ended
    void this.end(s, e.error ? 'crashed' : 'exited')
  }

  // ── helpers ──

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
    const chips = contextChips(m)
    const msg: ChatMessage = {
      ...newUserMessage(this.d.ids.next(), s.agentId, m.text, this.d.clock.now()),
      state: 'delivered',
      ...(chips ? { context: chips } : {}),
    }
    this.d.messages.append(msg)
    this.d.bus.publish({ type: 'message.changed', message: msg })
    s.interrupted = false
    s.runner.push(composePrompt(m))
    this.d.activity.report([{ agentId: s.agentId, status: 'thinking', text: '' }])
    return msg
  }

  /** 'stopped' closes the runner; 'exited'/'crashed' come from the runner itself. */
  private async end(s: Session, how: 'stopped' | 'exited' | 'crashed'): Promise<void> {
    if (!this.isLive(s)) return
    this.sessions.delete(s.agentId)
    if (this.sessions.size === 0) {
      this.cancelHeartbeat?.()
      this.cancelHeartbeat = undefined
    }
    this.cancelPending(s, SYSTEM.ended)
    if (how === 'stopped') await s.runner.close().catch(() => {})
    this.patch(s.agentId, (a) =>
      a.managed ? { ...a, managed: { ...a.managed, phase: 'ended', pending: 0 } } : a,
    )
    const crashed = how === 'crashed'
    this.d.activity.report([
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
    this.d.activity.report([
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
    this.d.activity.report([...this.sessions.keys()].map((agentId) => ({ agentId })))
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
