// Driven (secondary) ports: what the core needs from the outside world.
// Implemented by adapters (packages/adapters, packages/desktop). Additive changes only.
import type {
  AgentEvent,
  Capability,
  ChatMessage,
  HookStatus,
  ModelOption,
  ModeOption,
  PermissionMode,
  ProviderId,
  SessionCap,
  Settings,
} from '@agent-office/shared'
import type { AgentState } from '../domain/agent.ts'
import type { Note } from '../domain/attention.ts'
import type { TrayModel } from '../domain/tray.ts'
import type { ActionPolicy, EnforcementDecl, GateRun, GateSpec } from '../domain/harness-types.ts'
import type { CancelSignal } from './driving.ts'

export interface Clock {
  now(): number
}

export interface IdGenerator {
  next(): string
}

export interface Logger {
  info(msg: string): void
  warn(msg: string): void
}

/** Timers, injected so the core never touches host globals and tests control time. */
export interface Scheduler {
  /** Runs `fn` every `ms`; returns a cancel function. */
  every(ms: number, fn: () => void): () => void
  /** Runs `fn` once after `ms`; returns a cancel function. */
  after(ms: number, fn: () => void): () => void
}

/** Current agents. In memory today; persistence/replay later. */
export interface AgentRepository {
  get(id: string): AgentState | undefined
  put(agent: AgentState): void
  delete(id: string): void
  list(): AgentState[]
}

/** Chat history and inboxes. Implementations cap history per agent. */
export interface MessageRepository {
  append(m: ChatMessage): void
  /** Replaces the stored message with the same id; no-op when unknown. */
  update(m: ChatMessage): void
  byAgent(agentId: string): ChatMessage[]
  /** Last `perAgent` messages of every agent. */
  recent(perAgent: number): ChatMessage[]
  dropAgent(agentId: string): void
}

/** Capabilities (adapters, skills, rules) per provider. In memory; docs/capabilities.md. */
export interface CapabilityRepository {
  get(provider: string, id: string): Capability | undefined
  /** Inserts or replaces by (provider, id). */
  put(c: Capability): void
  /** In insertion order. */
  listByProvider(provider: string): Capability[]
  providers(): string[]
}

export type OfficeEvent =
  | { type: 'agent.upserted'; agent: AgentState }
  | { type: 'agent.removed'; id: string }
  | { type: 'message.changed'; message: ChatMessage }
  | { type: 'inbox.queued'; agentId: string }
  /** A provider's capabilities changed (debounced); carries the provider's full list. */
  | { type: 'capabilities.changed'; provider: string; capabilities: Capability[] }
  /** A managed session's pending permission requests changed. */
  | { type: 'permission.changed'; agentId: string }

export interface EventPublisher {
  publish(e: OfficeEvent): void
}

export interface EventSubscriber {
  /** Returns an unsubscribe function. */
  subscribe(fn: (e: OfficeEvent) => void): () => void
}

export interface SettingsRepository {
  load(): Promise<Settings>
  save(s: Settings): Promise<void>
}

/** Claude Code's user settings file (~/.claude/settings.json). */
export interface ClaudeSettingsStore {
  /** undefined when the file does not exist. Throws ValidationError for invalid JSON. */
  read(): Promise<Record<string, unknown> | undefined>
  /** Writes after backing up the previous file. */
  write(json: Record<string, unknown>): Promise<void>
}

/** How Claude Code launches our hook script on this machine. */
export interface HookRunner {
  /** The exact command string registered in Claude Code settings. */
  command(): string
  /** Creates or refreshes whatever `command()` points at (e.g. a wrapper script). */
  ensureInstalled(): Promise<void>
  remove(): Promise<void>
}

export interface Notifier {
  notify(note: Note): void
}

export interface TrayView {
  render(model: TrayModel): void
}

export interface LoginItem {
  setOpenAtLogin(enabled: boolean): void
}

export interface UpdateInfo {
  version: string
  url?: string
}

export interface Updater {
  /** null when up to date. */
  check(): Promise<UpdateInfo | null>
  download(): Promise<void>
  restartToInstall(): void
}

export interface PlatformInfo {
  platform: string
  packaged: boolean
  signed: boolean
  linuxAppImage: boolean
  version: string
}

export interface WindowState {
  isFocused(): boolean
}

export type { HookStatus }

/**
 * Starts sessions of one provider's runtime: Claude Code (Agent SDK), Codex (app-server), ACP
 * agents (Cursor, Gemini CLI, Copilot CLI); scripted fakes in tests. A runner without `decl` is
 * Claude Code (`cc:` ids), so existing runners need no change.
 */
export interface AgentRunner {
  readonly decl?: RunnerDecl
  /** Harness enforcement this runtime provides (docs/harness.md §3); runners without `decl` (Claude Code) declare it here. */
  readonly enforcement?: EnforcementDecl
  start(o: RunnerStart): RunnerSession
}

/** Who a runner's sessions belong to and what they can do (docs/provider-integrations.md). */
export interface RunnerDecl {
  provider: ProviderId
  /** Agent id prefix, e.g. 'cx:' (Codex), 'cu:' (Cursor). Unique per provider. */
  prefix: string
  /** Capabilities of a running managed session. */
  caps: SessionCap[]
  /** Provider-specific modes offered at start and in the session header (Claude: none). */
  modes?: ModeOption[]
  /** The default mode id when a start names none. */
  defaultModeId?: string
  /** Shown before a session reports its own model list. */
  fallbackModels?: ModelOption[]
  /** What this runtime can enforce of a harness (docs/harness.md §3). Absent: instruction-only. */
  enforcement?: EnforcementDecl
}

export interface RunnerStart {
  cwd: string
  model?: string
  mode: PermissionMode
  extraDirs: string[]
  chrome: boolean
  /** Only with mode 'bypassPermissions' and the user's setting on. */
  allowBypass: boolean
  /** Provider-specific mode (runners with `decl.modes`); dangerous modes only when `allowBypass`. */
  modeId?: string
  /**
   * agent-office's project MCP server (docs/projects.md §5), injected only when the session's
   * project policy allows this provider. A stdio command (the bridge wrapper) with its env.
   */
  mcp?: { name: string; command: string; args: string[]; env: Record<string, string> }
  /** Experimental: the provider's own session id to resume natively (runners that support it). */
  resume?: string
  /**
   * The project's effective harness, compiled (docs/harness.md). Runners deliver `instructions`,
   * apply `native` parts and raise every action they can to `evaluate` before it runs.
   */
  harness?: ActionPolicy
}

export type RunnerExit = { error?: 'auth' | 'runtime' | 'folder' | 'crash'; message?: string }

export interface RunnerSession {
  /** The Claude session id (from the init message). Rejects with the exit reason if it never starts. */
  readonly sessionId: Promise<string>
  /** Streams a user prompt into the session. */
  push(prompt: string): void
  setMode(mode: PermissionMode): Promise<void>
  setModel(model: string): Promise<void>
  /** Provider-specific mode change (runners with `decl.modes`). */
  setModeId?(modeId: string): Promise<void>
  supportedModels(): Promise<ModelOption[]>
  interrupt(): Promise<void>
  close(): Promise<void>
  /** Privacy-safe activity, already mapped like transcript lines (agentId filled by the service). */
  onEvent(fn: (e: Omit<AgentEvent, 'agentId'>) => void): () => void
  /** End of a turn: the final assistant text (≤ 4000 chars). */
  onResult(fn: (r: { text: string; isError: boolean }) => void): () => void
  /** A tool call needs approval; the returned promise is the user's decision. */
  onPermission(fn: (r: RunnerPermission) => Promise<RunnerDecision>): void
  onExit(fn: (e: RunnerExit) => void): void
  /** A subagent of this session started or changed (runtimes that expose them); `event` is mapped like `onEvent`. */
  onChild?(
    fn: (c: {
      childId: string
      kind?: string
      event: Omit<AgentEvent, 'agentId' | 'parentId'>
    }) => void,
  ): () => void
}

export interface RunnerPermission {
  /**
   * The tool, normalized by the adapter to the shared names `summarizeToolRequest` knows (Bash,
   * Edit, Read, WebFetch, Grep, …) so core never sees provider-specific tool kinds or raw titles.
   */
  tool: string
  input: Record<string, unknown>
  cwd: string
  /** The subagent asking, when the runtime tells them apart. */
  agent?: { id: string; type?: string }
}

export type RunnerDecision =
  /** `updatedInput`: the input to run with (a question card's answers merged in). */
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

/** Detects a provider's CLI without starting a session (`--version`, `--help`; documented status calls only). */
export interface ProviderProbe {
  readonly provider: ProviderId
  /** Never throws; reports failures in `error`. Must finish within its own timeout. */
  detect(): Promise<ProbeResult>
}

export interface ProbeResult {
  installed: boolean
  version?: string
  /** The CLI exposes the integration surface we use (e.g. `--acp`, `app-server`). */
  flagsOk: boolean
  auth: 'ok' | 'needed' | 'unknown'
  error?: 'timeout' | 'spawn' | 'protocol'
}

/**
 * A provider's JSON config file that holds our observation hooks (Cursor `hooks.json`, Gemini
 * `settings.json`, a Copilot hooks file). Backs up before the first write; refuses invalid JSON.
 */
export interface JsonConfigStore {
  /** undefined when the file does not exist. Throws ValidationError for invalid JSON. */
  read(): Promise<Record<string, unknown> | undefined>
  /** Atomic write (temp + rename) after backing up the previous file once. */
  write(json: Record<string, unknown>): Promise<void>
  /** Deletes the file (formats that own a whole file, e.g. Copilot's). */
  remove(): Promise<void>
}

// ── Projects-first workspace (docs/projects.md) ─────────────────────────────────────────────

/** One stored record: a typed JSON payload appended to a partition. */
export interface VaultRecord {
  /** Record type, e.g. 'project', 'session', 'assign', 'memory', 'activity', 'message'. */
  t: string
  /** Monotonic within the partition (assigned by the log). */
  seq?: number
  ts: number
  data: Record<string, unknown>
}

/**
 * The project vault: append-only record logs, one per partition ('catalog', 'p/<prj>', 's/<ses>').
 * The production adapter encrypts every line at rest; `memory-only` when no OS keychain exists.
 */
export interface RecordLog {
  status(): 'encrypted' | 'memory-only'
  /** Partition names starting with `prefix` (e.g. 'p/'). */
  partitions(prefix: string): Promise<string[]>
  /** All readable records in append order (corrupt lines are skipped and counted). */
  read(partition: string): Promise<VaultRecord[]>
  append(partition: string, records: VaultRecord[]): Promise<void>
  /** Atomically replaces the partition with `records` (compaction; same resulting state). */
  compact(partition: string, records: VaultRecord[]): Promise<void>
  /** Deletes a partition (e.g. a deleted session's chat). */
  drop(partition: string): Promise<void>
}

/** A repository's identity, without paths: keys are HMACs of real paths with a local salt. */
export interface RepoIdentityInfo {
  /** HMAC of the git common dir (same for all worktrees of one clone). */
  commonDirKey: string
  /** HMAC of the working-tree root. */
  rootKey: string
  /** The repository's first commit (stable across moves and renames). */
  rootCommit?: string
  /** Normalized remotes (host/path, no userinfo or query). */
  remotes: string[]
  /** Basename of the working-tree root (display only). */
  name: string
  isWorktree: boolean
  /** The locator's path relative to the root ('' at the root), for monorepo subprojects. */
  relPath: string
}

/** Resolves where a session works to a repository identity. Main-process only; never throws. */
export interface RepoIdentity {
  /** `locator` is an absolute directory known only to main. null when it can't be resolved. */
  resolve(locator: string): Promise<RepoIdentityInfo | null>
  /** The `wk_` key observe hooks send for the same directory (HMAC of the git common dir). */
  workspaceKey(locator: string): Promise<string | null>
}

/** One message of a provider transcript, as agent-office may show it: text and tool names only. */
export interface TranscriptMessage {
  uuid: string
  role: 'user' | 'assistant'
  /** ≤ 4000 chars; text blocks only (no tool input/output, no thinking). */
  text: string
  ts: number
  tools: string[]
}

/** Reads a provider's own transcript on demand (nothing is copied into the vault). */
export interface TranscriptReader {
  /** `ref` is an opaque `tr_` key the source registered; newest last; `before` is a message uuid. */
  page(
    ref: string,
    o: { before?: string; limit: number },
  ): Promise<{ messages: TranscriptMessage[]; more: boolean }>
  search(ref: string, query: string, limit: number): Promise<{ uuid: string; snippet: string }[]>
}

/** One past provider session found on disk (experimental history import). Metadata only. */
export interface PastSession {
  provider: string
  /** The provider's own session id (resume key); kept in main. */
  providerSessionId: string
  /** Opaque `tr_` ref registered with the TranscriptReader. */
  transcriptRef: string
  /** Where it ran; stays in main, used only for project matching. */
  cwd?: string
  title: string
  startedAt: number
  lastSeenAt: number
}

/** Lists past sessions of a provider (Claude Code: ~/.claude/projects). Newest first. */
export interface HistorySource {
  /** What a valid `providerSessionId` looks like for this provider. Default: letters, digits, `_`, `-` (≤ 100). */
  idPattern?: RegExp
  list(o: { limit: number }): Promise<PastSession[]>
}

/** One history source per provider that documents one (Claude transcripts, OpenCode server, …). */
export type HistorySources = Partial<Record<ProviderId, HistorySource>>

export interface SearchDoc {
  id: string
  projectId: string | null
  kind: 'project' | 'session' | 'message' | 'memory' | 'handoff'
  title: string
  text: string
  ts: number
}

/** Full-text search over vault content (rebuilt from the vault; never persisted in plaintext). */
export interface SearchIndex {
  upsert(doc: SearchDoc): void
  remove(id: string): void
  query(
    q: string,
    o: { projectIds?: (string | null)[]; kinds?: SearchDoc['kind'][]; limit: number },
  ): { id: string; score: number; snippet: string }[]
}

/** Cryptographically secure random tokens (MCP session tokens, ids). */
export interface SecureRandom {
  token(bytes: number): string
}

// ── Harness Builder (docs/harness.md) ───────────────────────────────────────────────────────────

/** One rule file found in a repository (repo-relative path; the adapter never executes anything). */
export interface RuleSourceFile {
  path: string
  format:
    | 'agents-md'
    | 'claude-md'
    | 'claude-rule'
    | 'cursor-mdc'
    | 'cursorrules'
    | 'gemini-md'
    | 'copilot-instructions'
    | 'copilot-instruction-file'
    | 'makefile'
    | 'ci-workflow'
  bytes: number
  /** sha256 hex of the whole file. */
  hash: string
}

/**
 * Reads rule files of one repository, read-only and bounded (no symlinks, ≤ 256 KB per file,
 * ≤ 64 KB parsed, ≤ 200 files). `repoPath` is an absolute directory known only to main.
 */
export interface RuleSourceReader {
  detect(repoPath: string): Promise<RuleSourceFile[]>
  /** The first 64 KB of a detected file and its current hash (drift detection re-reads it). */
  read(repoPath: string, relPath: string): Promise<{ text: string; hash: string }>
}

/**
 * The trusted validation runner: spawns `argv` with `shell: false` in `cwd`, a scrubbed env, a
 * timeout that kills the process tree, and returns a redacted output tail. Never a shell string.
 */
export interface GateRunner {
  run(spec: GateSpec, o: { cwd: string; signal?: CancelSignal }): Promise<GateRun>
}

/** Read-only existence checks in a repository for `artifact` flow checks (no symlinks, bounded). */
export interface RepoFiles {
  /** True when `relGlob` (repo-relative, `**`/`*`/`?`) matches at least one regular file. */
  exists(repoPath: string, relGlob: string): Promise<boolean>
}
