// Driven (secondary) ports: what the core needs from the outside world.
// Implemented by adapters (packages/adapters, packages/desktop). Additive changes only.
import type { ChatMessage, HookStatus, Settings } from '@agent-office/shared'
import type { AgentState } from '../domain/agent.ts'
import type { Note } from '../domain/attention.ts'
import type { TrayModel } from '../domain/tray.ts'

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

export type OfficeEvent =
  | { type: 'agent.upserted'; agent: AgentState }
  | { type: 'agent.removed'; id: string }
  | { type: 'message.changed'; message: ChatMessage }
  | { type: 'inbox.queued'; agentId: string }

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
