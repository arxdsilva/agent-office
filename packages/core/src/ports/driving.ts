// Driving (primary) ports: what adapters may ask of the core. One narrow port per actor (ISP).
// Implemented by application services. Additive changes only.
import type {
  Agent,
  AgentEvent,
  ChatMessage,
  HookStatus,
  ServerMessage,
  Settings,
  SettingsPatch,
  SettingsResult,
  Snapshot,
  UpdateState,
} from '@agent-office/shared'

/** Minimal cancellation signal (structurally compatible with the platform AbortSignal). */
export interface CancelSignal {
  readonly aborted: boolean
  addEventListener(type: 'abort', fn: () => void, opts?: { once?: boolean }): void
  removeEventListener(type: 'abort', fn: () => void): void
}

/** Producers of agent activity: HTTP /api/events, Claude Code tailer, mock agents. */
export interface ReportActivity {
  /** Returns how many events were accepted (out-of-order ones are dropped). */
  report(events: AgentEvent[]): number
}

/** Periodic cleanup (idle/expire). */
export interface Housekeeping {
  sweep(): void
}

/** An agent reading and answering its inbox: HTTP inbox/replies, mock agents. */
export interface AgentInbox {
  claim(agentId: string): ChatMessage[]
  peek(agentId: string): ChatMessage[]
  /** Resolves true as soon as messages are queued, false on timeout/abort. */
  waitForMessages(agentId: string, ms: number, signal?: CancelSignal): Promise<boolean>
  /** Returns null when `requireAwaiting` is set and nothing awaits a reply. */
  reply(
    agentId: string,
    text: string,
    opts?: { inReplyTo?: string; requireAwaiting?: boolean },
  ): ChatMessage | null
}

/** The human in the UI. */
export interface UserChat {
  /** Throws UnknownAgentError / RateLimitedError. */
  send(agentId: string, text: string): ChatMessage
  history(agentId: string): ChatMessage[]
}

/** Read model for UIs. */
export interface OfficeQuery {
  snapshot(): Snapshot
  agents(): Agent[]
  agent(id: string): Agent | undefined
  /** Streams changes as UI messages; returns unsubscribe. */
  watch(fn: (m: ServerMessage) => void): () => void
}

export interface HookManagement {
  status(): Promise<HookStatus>
  install(): Promise<HookStatus>
  uninstall(): Promise<HookStatus>
  /** Refreshes the hook wrapper if installed (e.g. after the app moved or updated). */
  heal(): Promise<void>
}

export interface SettingsManagement {
  get(): Promise<Settings>
  /** Throws ValidationError. */
  update(patch: SettingsPatch): Promise<SettingsResult>
}

export interface UpdateManagement {
  state(): UpdateState
  check(): Promise<UpdateState>
  install(): void
  onChange(fn: (s: UpdateState) => void): () => void
}
