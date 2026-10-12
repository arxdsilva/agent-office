import { z } from 'zod'
import type { ModeOption, SessionCap } from './providers.ts'

export const AGENT_STATUSES = ['idle', 'thinking', 'tool', 'waiting', 'error', 'done'] as const
export type AgentStatus = (typeof AGENT_STATUSES)[number]

export const MAX_MESSAGE_CHARS = 4000

/** Claude Code permission modes (Agent SDK `PermissionMode`; hook input `permission_mode`). */
export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]
export const PermissionModeSchema = z.enum(PERMISSION_MODES)

/**
 * Public contract for `POST /api/events`: a partial update keyed by `agentId`.
 * Missing fields keep their previous value. Changes must be additive (see ARCHITECTURE rule).
 */
export const AgentEventSchema = z.object({
  agentId: z.string().min(1).max(200),
  /** Label shown above the agent's head. */
  name: z.string().max(100).optional(),
  /** Who runs the agent (claude-code, openai-agents, langgraph, …). One office zone per provider. */
  provider: z.string().max(100).optional(),
  /** What the conversation is about. One row of desks per topic. */
  topic: z.string().max(200).optional(),
  /** Model in use, e.g. claude-opus-5-5. */
  model: z.string().max(100).optional(),
  /** Role or type of agent, e.g. a subagent's agentType. */
  kind: z.string().max(100).optional(),
  /** Agent that spawned this one; subagents sit next to their parent. */
  parentId: z.string().max(200).optional(),
  status: z.enum(AGENT_STATUSES).optional(),
  /** Tool currently in use. */
  tool: z.string().max(100).optional(),
  /** Short activity line. */
  text: z.string().max(500).optional(),
  /** Producer of the event: http, claude-code, mock, … */
  source: z.string().max(50).optional(),
  /** Epoch millis; defaults to receive time. */
  ts: z.number().int().positive().optional(),
  /**
   * Privacy-safe hint about what the current tool call touches (docs/capabilities.md §3):
   * 'project:<basename>' | 'host:<hostname>' | 'cmd:<word>' | 'skill:<name>' | 'rule:<scope>:<file>' | 'memory:<slug>'.
   * Never a full path, URL, argument or file content.
   */
  target: z.string().max(100).optional(),
  /** Explicit capability id for generic producers (otherwise classified from `tool` + `target`). */
  capability: z.string().max(120).optional(),
  /** Current permission mode (Claude Code: from the hook or transcript; others may send it too). */
  permissionMode: PermissionModeSchema.optional(),
  /** Provider-specific mode id the session reports (Codex presets, ACP modes); display only. */
  modeId: z.string().min(1).max(60).optional(),
  /**
   * Opaque workspace key from an observe hook: an HMAC of the repo's git common dir with a local
   * salt (docs/projects.md §4). Main matches it to a project; it never reaches the renderer.
   */
  workspace: z
    .string()
    .regex(/^wk_[a-f0-9]{32}$/)
    .optional(),
})
export type AgentEvent = z.infer<typeof AgentEventSchema>

export const AgentEventBatchSchema = z.union([AgentEventSchema, z.array(AgentEventSchema).max(500)])

/** Body of `POST /api/agents/:id/messages` (sent from the UI). */
export const ChatMessageSchema = z.object({ text: z.string().min(1).max(MAX_MESSAGE_CHARS) })

/** Body of `POST /api/agents/:id/replies` (sent by the agent). */
export const AgentReplySchema = z.object({
  text: z.string().min(1).max(MAX_MESSAGE_CHARS),
  inReplyTo: z.string().max(100).optional(),
  /** Record the reply only if a delivered UI message is waiting for one (used by the Claude Code hook). */
  requireAwaiting: z.boolean().optional(),
})

export interface Agent {
  id: string
  name: string
  provider: string
  topic: string
  model?: string
  kind?: string
  parentId?: string
  status: AgentStatus
  tool?: string
  text?: string
  source: string
  since: number
  lastSeen: number
  /** Something consumed this agent's inbox recently, so messages will be read. */
  interactive: boolean
  /** Messages queued but not yet delivered. */
  unread: number
  /** Last known permission mode (read-only for sessions agent-office doesn't own). */
  permissionMode?: PermissionMode
  /** Set only for managed sessions (started by agent-office). */
  managed?: ManagedInfo
  /**
   * What this session can do (docs/provider-integrations.md). Set only by core for provider
   * sessions; absent = the legacy rules (Claude Code transcripts, HTTP agents). Never from HTTP.
   */
  caps?: SessionCap[]
  /** Current provider-specific mode id (Codex presets, ACP modes); Claude uses `permissionMode`. */
  modeId?: string
  /** The project this agent's session belongs to (set by core; absent = unassigned). */
  projectId?: string
}

export type MessageState = 'queued' | 'delivered' | 'replied'

/** Display-only attachment shown under a message (the agent receives paths/tool hints as text). */
export interface ContextChip {
  kind: 'file' | 'folder' | 'capability'
  /** Basename or capability label. Never a full path. */
  label: string
  /** '~'-abbreviated location or capability id, for the tooltip. */
  hint?: string
}

export interface ChatMessage {
  id: string
  agentId: string
  /** 'system': app notes in the thread (mode/model changes, interrupts); never delivered to agents. */
  from: 'user' | 'agent' | 'system'
  text: string
  ts: number
  state: MessageState
  inReplyTo?: string
  /** Files, folders and tools attached to a user message (≤ 15). */
  context?: ContextChip[]
}

/** A tool call a managed session wants approved (summary only, never the raw tool input). */
export interface PermissionRequestVM {
  /** `perm_` + 10 base36 chars. */
  id: string
  tool: string
  /** ≤ 120 chars, e.g. the first line of a Bash command or a cwd-relative path. */
  summary: string
  /** '~'-abbreviated working directory, when relevant. */
  where?: string
}

/** Present only on agents whose session agent-office started (any provider with a managed runtime). */
export interface ManagedInfo {
  /** Model id the session reports (checks the picker); `Agent.model` keeps the display string. */
  modelId?: string
  chrome: boolean
  /** Pending permission requests. */
  pending: number
  phase: 'starting' | 'running' | 'ended'
  /** Provider-specific modes the session offers (absent for Claude Code: `PERMISSION_MODES`). */
  modes?: ModeOption[]
}

/** Messages pushed from server to browser over the WebSocket. */
// ── Capabilities: adapters (connections), skills and rules (docs/capabilities.md) ──────────────
export const CAPABILITY_CATEGORIES = ['adapter', 'skill', 'rule'] as const
export type CapabilityCategory = (typeof CAPABILITY_CATEGORIES)[number]
export const CAPABILITY_KINDS = [
  'filesystem',
  'shell',
  'web',
  'subagents',
  'mcp',
  'api',
  'database',
  'skill',
  'project-rules',
  'rule',
  'user-rules',
  'memory',
  'other',
] as const
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number]
export const CAPABILITY_SCOPES = ['user', 'project', 'plugin'] as const
export type CapabilityScope = (typeof CAPABILITY_SCOPES)[number]

/** Declared by a provider (HTTP `POST /api/providers/:provider/capabilities` or a built-in source). */
export const CapabilityDeclSchema = z.object({
  id: z.string().min(1).max(120),
  category: z.enum(CAPABILITY_CATEGORIES),
  kind: z.enum(CAPABILITY_KINDS),
  label: z.string().min(1).max(80),
  summary: z.string().max(160).optional(),
  scope: z.enum(CAPABILITY_SCOPES).optional(),
  sees: z.array(z.string().max(80)).max(8).optional(),
  tools: z.array(z.string().max(80)).max(24).optional(),
})
export type CapabilityDecl = z.infer<typeof CapabilityDeclSchema>
export const CapabilityDeclBatchSchema = z.array(CapabilityDeclSchema).max(64)

/** What a provider's agents can use: an adapter (Adapters room), a skill or a rule (Library). */
export interface Capability {
  id: string
  provider: string
  category: CapabilityCategory
  kind: CapabilityKind
  label: string
  summary?: string
  scope?: CapabilityScope
  /** Adapters: what it can see/touch (≤ 8 short lines). */
  sees: string[]
  /** Adapters: tool names seen or declared (≤ 24). */
  tools: string[]
  /** Configured/declared (true) vs only observed in use (false). */
  declared: boolean
  /** Uses in this app session (calls · invocations · reads). */
  calls: number
  lastUsedAt?: number
  /** Agent ids using it right now. */
  active: string[]
}

export type ServerMessage =
  | { type: 'snapshot'; agents: Agent[]; messages: ChatMessage[]; capabilities?: Capability[] }
  | { type: 'upsert'; agent: Agent }
  | { type: 'remove'; id: string }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'capabilities'; provider: string; capabilities: Capability[] }
  /** Pending permission requests of a managed session (empty list = none). */
  | { type: 'permission'; agentId: string; requests: PermissionRequestVM[] }
