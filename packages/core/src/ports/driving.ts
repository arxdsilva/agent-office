// Driving (primary) ports: what adapters may ask of the core. One narrow port per actor (ISP).
// Implemented by application services. Additive changes only.
import type {
  Agent,
  AgentEvent,
  CapabilityDecl,
  ChatMessage,
  HookStatus,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  PermissionRequestVM,
  ProviderId,
  ProviderStatus,
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

/**
 * Producers that know what their agents can use: HTTP `POST /api/providers/:provider/capabilities`,
 * Claude Code discovery, mock agents. Declarations merge; usage counters are kept.
 */
export interface ReportCapabilities {
  declare(provider: string, decls: CapabilityDecl[]): void
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

/** A user message plus what the user attached (paths are resolved by the caller, never by the core). */
export interface ComposedMessage {
  text: string
  context: { kind: 'file' | 'folder'; path: string; label: string; hint: string }[]
  /** Capabilities the agent should use, with display labels (e.g. mcp:claude-in-chrome → Chrome browser). */
  use: { id: string; label: string }[]
}

/**
 * The UI sending a message with optional context/tool hints. Routes managed sessions straight to
 * their runner and everything else to the inbox (as text with a preamble). Throws like `UserChat.send`.
 */
export interface ComposeMessage {
  send(agentId: string, m: ComposedMessage): Promise<ChatMessage>
}

export interface StartSession {
  /** Defaults to 'claude-code'. */
  provider?: ProviderId
  /** Provider-specific mode (Codex presets, ACP modes); Claude Code uses `mode`. */
  modeId?: string
  cwd: string
  name: string
  model?: string
  mode: PermissionMode
  extraDirs: string[]
  chrome: boolean
  first: ComposedMessage
}

/**
 * Claude Code sessions agent-office starts and owns (Agent SDK). Throws `SessionStartError`
 * (code auth | runtime | folder | limit | other) from `start`, `UnknownAgentError` for ids it doesn't own.
 */
export interface ManagedSessions {
  /** Resolves with the new agent id (`cc:<sessionId>`). */
  start(o: StartSession): Promise<string>
  setMode(agentId: string, mode: PermissionMode): Promise<void>
  setModel(agentId: string, model: string): Promise<void>
  /** A running session's models; without an id, the last list seen (or a fallback). */
  models(agentId?: string): Promise<ModelOption[]>
  interrupt(agentId: string): Promise<void>
  stop(agentId: string): Promise<void>
  answer(agentId: string, requestId: string, decision: PermissionDecision): void
  pending(agentId: string): PermissionRequestVM[]
  isManaged(agentId: string): boolean
  /** By Claude session id (the transcript tailer skips these). */
  isManagedSession(sessionId: string): boolean
  count(): number
  stopAll(): Promise<void>
  /** Provider-specific mode change; needs the session's `change-mode` cap. */
  setModeId?(agentId: string, modeId: string): Promise<void>
  /** True for any agent id a managed session owns (all providers), for de-duplicating observers. */
  owns?(agentId: string): boolean
}

/** The provider registry as the UI sees it (docs/provider-integrations.md). */
export interface ProviderCatalog {
  list(): Promise<ProviderStatus[]>
  /** Re-runs detection for one provider or all; one failing probe never affects the others. */
  refresh(provider?: ProviderId): Promise<ProviderStatus[]>
  setEnabled(provider: ProviderId, enabled: boolean): Promise<ProviderStatus[]>
  models(provider: ProviderId): Promise<ModelOption[]>
}

/** Observation hooks for hook-based providers (Cursor, Gemini CLI, Copilot CLI). */
export interface ProviderHooks {
  status(provider: ProviderId): Promise<HookStatus>
  /** Explicit user action only; backs up first; never touches foreign hooks. */
  install(provider: ProviderId): Promise<HookStatus>
  uninstall(provider: ProviderId): Promise<HookStatus>
  /** Refreshes hooks that are already installed (e.g. after a port change). Never installs new ones. */
  heal(): Promise<void>
}
