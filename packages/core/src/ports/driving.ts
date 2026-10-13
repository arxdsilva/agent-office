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
  ContextBundleView,
  ContextInspection,
  ContextPolicy,
  GlobalOverview,
  ImportResult,
  HandoffView,
  MemoryDraft,
  MemoryKind,
  MemoryScope,
  MemoryState,
  MemoryView,
  ProjectDashboard,
  ProjectDetail,
  ProjectMessage,
  ProjectSummary,
  SearchHit,
  SessionMessageView,
  SessionSummary,
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
  /** The project this session belongs to (docs/projects.md); mints an MCP token when allowed. */
  projectId?: string
  /** Experimental: the provider's own session id to resume natively (Claude Code only). */
  resume?: string
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

// ── Projects-first workspace (docs/projects.md) ─────────────────────────────────────────────

/** Sources report where a session works (an absolute directory, main-process only). */
export interface SessionObservation {
  located(
    agentId: string,
    provider: string,
    where: { cwd?: string; workspaceKey?: string; transcriptRef?: string },
  ): Promise<void>
}

/** The MCP adapter's single entry point: every call is authorized against the token's principal. */
export interface McpMemoryAccess {
  /** Resolves a bearer token to its principal, or null (unknown, revoked or expired). */
  principal(token: string): McpPrincipal | null
  call(principal: McpPrincipal, tool: string, args: unknown): Promise<McpToolResult>
  tools(principal: McpPrincipal): McpToolDecl[]
}

export interface McpPrincipal {
  kind: 'mcp'
  projectId: string
  sessionId: string
  provider: string
  tokenId: string
  access: 'read' | 'read-propose'
}

export interface McpToolDecl {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpToolResult {
  /** Structured result (items with ids, versions and provenance). */
  structured: Record<string, unknown>
  /** One text block, starting with the data preface (docs/projects.md §5). */
  text: string
  isError?: boolean
}

// Driving ports of the projects layer, one per actor. Callers are the user (IPC) unless stated;
// every implementation authorizes first (core `authz.ts`). Folders are absolute directories the
// composition root resolved from `ctx_` refs (core never resolves refs or reads the disk).

export interface ProjectCatalog {
  list(): ProjectSummary[]
  get(projectId: string): ProjectDetail
  create(o: { name: string; folders: string[] }): Promise<ProjectSummary>
  update(o: {
    projectId: string
    name?: string
    color?: string
    policy?: ContextPolicy
    archived?: boolean
  }): Promise<ProjectSummary>
  addRepos(projectId: string, folders: string[]): Promise<ProjectSummary>
  removeRepo(projectId: string, repoId: string): Promise<ProjectSummary>
}

/** Main only: a project repository's directory (e.g. `NewSessionArgs.repo` → cwd). Never sent out. */
export interface ProjectRepos {
  repoPath(projectId: string, repoId: string): string | undefined
}

export interface SessionVault {
  /** `scope`: a project id or 'unassigned'; all sessions without it. */
  list(o: { scope?: string; query?: string }): SessionSummary[]
  get(sessionId: string): SessionSummary
  /** The provider transcript when one can be read (user only), else agent-office's chat. */
  messages(o: {
    sessionId: string
    before?: string
    limit: number
  }): Promise<{ messages: SessionMessageView[]; more: boolean }>
  archive(sessionId: string): Promise<SessionSummary>
}

export interface SessionAssignment {
  /** null unassigns. The previous assignment stays in the record's history. */
  assign(sessionId: string, projectId: string | null): Promise<SessionSummary>
}

export interface ProjectWorkspaceQuery {
  overview(): GlobalOverview
  dashboard(projectId: string): ProjectDashboard
  watch(fn: (m: ProjectMessage) => void): () => void
}

export interface MemoryService {
  list(o: { scope: string; states?: MemoryState[]; query?: string }): MemoryView[]
  create(draft: MemoryDraft): Promise<MemoryView>
  review(memoryId: string, action: 'approve' | 'reject'): Promise<MemoryView>
  edit(o: {
    memoryId: string
    title?: string
    body?: string
    kind?: MemoryKind
    scope?: MemoryScope
  }): Promise<MemoryView>
  supersede(memoryId: string, replacement: MemoryDraft): Promise<MemoryView>
  merge(memoryIds: string[], into: MemoryDraft): Promise<MemoryView>
  /** Every stored version of one lineage, oldest first. */
  versions(memoryId: string): MemoryView[]
}

export interface ContextEngine {
  preview(o: { projectId: string; objective?: string; provider?: ProviderId }): ContextBundleView
  inspect(agentId: string): ContextInspection
}

export interface HandoffService {
  prepare(o: { sessionId: string; toProvider: ProviderId; objective: string }): Promise<HandoffView>
  update(o: { handoffId: string; note?: string; include?: string[] }): Promise<HandoffView>
  /** Starts the target provider's managed session with the reviewed bundle. */
  launch(handoffId: string): Promise<{ agentId: string }>
  cancel(handoffId: string): Promise<HandoffView>
  list(projectId?: string): HandoffView[]
  /** New Agent with a reviewed bundle (`NewSessionArgs.context_memories`) in the first message. */
  startWithContext(o: StartSession & { projectId: string }, memoryIds: string[]): Promise<string>
}

export interface GlobalSearch {
  search(o: { query: string; projectId?: string; deep?: boolean }): Promise<SearchHit[]>
}

/** Experimental: import past provider sessions as unassigned records (references, never copies). */
export interface HistoryImport {
  importHistory(o: { limit: number }): Promise<ImportResult>
}

/** Experimental: continue a past Claude Code session natively as a managed session. */
export interface SessionResume {
  resume(sessionId: string): Promise<{ agentId: string }>
}
