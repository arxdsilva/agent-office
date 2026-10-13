// Projects-first workspace (plan "projects-first" §1–§7; docs/projects.md). What the renderer sees:
// ids, names, labels (basenames), counts, states and provenance — never paths, remotes, keys, tokens
// or raw transcripts. Core owns the domain; these are its IPC views. Additive only.
import { z } from 'zod'
import { MAX_MESSAGE_CHARS } from './protocol.ts'
import { ProviderIdSchema, type ProviderId } from './providers.ts'

// ── Ids ───────────────────────────────────────────────────────────────────────────────────────
export const ProjectIdSchema = z.string().regex(/^prj_[a-z0-9]{10,24}$/)
export const RepoRefSchema = z.string().regex(/^rp_[a-z0-9]{10,24}$/)
export const SessionIdSchema = z.string().regex(/^ses_[a-z0-9]{10,24}$/)
export const MemoryIdSchema = z.string().regex(/^mem_[a-z0-9]{10,24}$/)
export const HandoffIdSchema = z.string().regex(/^hof_[a-z0-9]{10,24}$/)
export const TaskIdSchema = z.string().regex(/^tsk_[a-z0-9]{10,24}$/)
/** "No project yet": sessions awaiting association. */
export const UNASSIGNED = 'unassigned' as const
export const ProjectScopeSchema = z.union([ProjectIdSchema, z.literal(UNASSIGNED)])

// ── Projects ──────────────────────────────────────────────────────────────────────────────────
export const MEMORY_SCOPES = ['global', 'workspace', 'project', 'session'] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]
export const MEMORY_KINDS = ['instruction', 'constraint', 'decision', 'fact', 'note'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]
export const MEMORY_STATES = ['pending', 'approved', 'rejected', 'superseded'] as const
export type MemoryState = (typeof MEMORY_STATES)[number]
/** What a provider's managed sessions may do with this project's memory over MCP. */
export const PROVIDER_ACCESS = ['none', 'read', 'read-propose'] as const
export type ProviderAccess = (typeof PROVIDER_ACCESS)[number]

export const ContextPolicySchema = z.object({
  providers: z.partialRecord(ProviderIdSchema, z.enum(PROVIDER_ACCESS)),
  /** Scopes non-user principals may read besides this project's own items. */
  scopes: z.array(z.enum(MEMORY_SCOPES)).max(4),
  /** Session summaries may be returned to agents. */
  sessionExcerpts: z.boolean(),
})
export type ContextPolicy = z.infer<typeof ContextPolicySchema>

export interface RepoLinkView {
  id: string
  /** Basename only (never a path). */
  label: string
  isWorktree: boolean
}

export interface ProjectSummary {
  id: string
  name: string
  color: string
  repos: RepoLinkView[]
  activeAgents: number
  sessions: number
  approvedMemories: number
  pendingMemories: number
  openTasks: number
  lastActivityAt?: number
  archived: boolean
}

export interface ProjectDetail extends ProjectSummary {
  policy: ContextPolicy
  createdAt: number
}

// ── Sessions (the Session Vault) ─────────────────────────────────────────────────────────────
export const SESSION_ORIGINS = ['managed', 'observed', 'imported'] as const
export const SESSION_STATES = ['active', 'inactive', 'archived'] as const
export interface SessionSummary {
  id: string
  /** Live agent id while active (e.g. `cc:…`, `cx:…`). */
  agentId?: string
  provider: ProviderId | string
  origin: (typeof SESSION_ORIGINS)[number]
  projectId: string | null
  title: string
  state: (typeof SESSION_STATES)[number]
  startedAt: number
  lastSeenAt: number
  endedAt?: number
  /** Deterministic or provider summary (≤ 2000 chars), with where it came from. */
  summary?: { text: string; source: 'last-replies' | 'user' | 'provider'; provider?: string }
  /** Project suggestions for an unassigned session (never applied silently). */
  suggestions?: { projectId: string; name: string; rule: string; confidence: 'high' | 'low' }[]
  /** Assignment provenance. */
  assignedBy?: 'auto' | 'user'
  /** The handoff this session continues. */
  continuedFrom?: { handoffId: string; sessionId: string; provider: string }
  /** The provider's own history can be opened (main reads it on demand; nothing is copied). */
  hasTranscript: boolean
  /** Experimental: the provider can resume this session natively (Claude only, verified locally). */
  canResume?: boolean
}

export interface SessionMessageView {
  id: string
  role: 'user' | 'agent' | 'system'
  /** ≤ 4000 chars, plain text (rendered with textContent). */
  text: string
  ts: number
  /** Tool names used in this turn (never inputs or outputs). */
  tools?: string[]
  /** Where the message came from: agent-office's chat or the provider's own transcript. */
  source: 'chat' | 'transcript'
}

// ── Memory ────────────────────────────────────────────────────────────────────────────────────
export interface ProvenanceView {
  origin: 'user' | 'agent-proposal' | 'session-summary' | 'handoff'
  provider?: string
  sessionId?: string
  messageId?: string
  createdAt: number
  reviewedAt?: number
}

export interface MemoryView {
  id: string
  version: number
  projectId: string | null
  scope: MemoryScope
  kind: MemoryKind
  title: string
  body: string
  state: MemoryState
  provenance: ProvenanceView
  supersededBy?: string
  mergedFrom?: string[]
  decision?: { status: 'proposed' | 'accepted' | 'deprecated' }
}

export const MemoryDraftSchema = z.object({
  projectId: ProjectIdSchema.nullable(),
  scope: z.enum(MEMORY_SCOPES),
  kind: z.enum(MEMORY_KINDS),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
  /** "Save as memory" from a message keeps its provenance. */
  from: z.object({ sessionId: SessionIdSchema, messageId: z.string().max(100) }).optional(),
})
export type MemoryDraft = z.infer<typeof MemoryDraftSchema>

// ── Tasks, activity ───────────────────────────────────────────────────────────────────────────
export const EVIDENCE_LEVELS = [
  'agent-reported',
  'committed',
  'user-confirmed',
  'tests-verified',
] as const
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number]
export interface TaskView {
  id: string
  projectId: string
  title: string
  state: (typeof TASK_STATES)[number]
  source: 'user' | 'agent-reported'
  /** Strongest evidence so far. */
  evidence?: EvidenceLevel
  sessionIds: string[]
}

export const ACTIVITY_KINDS = [
  'session.started',
  'session.ended',
  'session.assigned',
  'memory.proposed',
  'memory.approved',
  'memory.rejected',
  'memory.superseded',
  'context.delivered',
  'mcp.retrieval',
  'handoff.prepared',
  'handoff.launched',
  'task.created',
  'task.completed',
  'commit.detected',
  'permission.requested',
  'agent.error',
] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]
export interface ActivityView {
  id: string
  projectId: string
  ts: number
  kind: ActivityKind
  /** Who did it: "you", a provider label, or an agent name. */
  actor: string
  /** One plain line (≤ 160 chars), built from labels and ids — never message content. */
  text: string
  refs?: { sessionId?: string; memoryId?: string; handoffId?: string; agentId?: string }
}

// ── Context ───────────────────────────────────────────────────────────────────────────────────
export interface ContextItemView {
  ref: { kind: 'memory' | 'summary' | 'instruction'; id: string }
  kind: MemoryKind | 'summary'
  title: string
  excerpt: string
  score: number
  reasons: string[]
  included: boolean
  excludedReason?: string
}
export interface ContextBundleView {
  projectId: string
  objective?: string
  items: ContextItemView[]
  usedChars: number
  budgetChars: number
  /** ≈ usedChars / 4. */
  estimatedTokens: number
}
/** What an agent could see, what it actually retrieved, and what agent-office delivered. */
export interface ContextInspection {
  agentId: string
  projectId: string | null
  /** Approved items the session's policy makes available. */
  available: number
  /** Real MCP retrievals by this session (tool, ≤ 80-char query, item ids). */
  retrieved: { ts: number; tool: string; query?: string; memoryIds: string[] }[]
  /** Bundles agent-office put into the session (e.g. the first message of a handoff). */
  delivered: { ts: number; memoryIds: string[]; via: 'first-message' | 'handoff' }[]
}

// ── Handoffs ──────────────────────────────────────────────────────────────────────────────────
export interface HandoffView {
  id: string
  projectId: string
  from: { sessionId: string; provider: string; title: string }
  toProvider: ProviderId
  objective: string
  note: string
  bundle: ContextBundleView
  state: 'draft' | 'launched' | 'cancelled'
  launchedSessionId?: string
}

// ── Dashboards ────────────────────────────────────────────────────────────────────────────────
export interface ProjectDashboard {
  project: ProjectDetail
  active: { agentId: string; name: string; provider: string; status: string; activity?: string }[]
  activity: ActivityView[]
  completed: { taskId: string; title: string; evidence: EvidenceLevel; at: number }[]
  tasks: TaskView[]
  knowledge: { approved: number; pending: number; decisions: MemoryView[] }
  sessions: SessionSummary[]
}

export interface GlobalOverview {
  projects: ProjectSummary[]
  /** Agents waiting for the user (status waiting, or a permission request). */
  waiting: { agentId: string; name: string; provider: string; projectId: string | null }[]
  recentCompletions: ActivityView[]
  recentDecisions: MemoryView[]
  pendingApprovals: number
  unfinishedHandoffs: HandoffView[]
  unassignedSessions: number
  /** Vault health: where project data is kept. */
  vault: 'encrypted' | 'memory-only'
}

// ── Search ────────────────────────────────────────────────────────────────────────────────────
export interface SearchHit {
  kind: 'project' | 'session' | 'message' | 'memory' | 'handoff' | 'agent'
  id: string
  projectId: string | null
  title: string
  /** ≤ 200 chars around the match. */
  snippet: string
  /** For messages: the session to open and the message to scroll to. */
  sessionId?: string
  messageId?: string
}

// ── IPC payloads ──────────────────────────────────────────────────────────────────────────────
export const NewProjectArgsSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** Folders from the native picker (`ctx_` refs); each becomes a repo link. */
  folders: z
    .array(z.string().regex(/^ctx_[a-z0-9]{12}$/))
    .max(8)
    .default([]),
})
export type NewProjectArgs = z.input<typeof NewProjectArgsSchema>
export const UpdateProjectArgsSchema = z.object({
  projectId: ProjectIdSchema,
  name: z.string().trim().min(1).max(60).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .optional(),
  policy: ContextPolicySchema.optional(),
  archived: z.boolean().optional(),
})
export const AssignSessionArgsSchema = z.object({
  sessionId: SessionIdSchema,
  projectId: ProjectIdSchema.nullable(),
})
export const SessionListArgsSchema = z.object({
  scope: ProjectScopeSchema.optional(),
  query: z.string().max(200).optional(),
})
export const SessionMessagesArgsSchema = z.object({
  sessionId: SessionIdSchema,
  before: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(200).default(50),
})
export const MemoryListArgsSchema = z.object({
  scope: z.union([ProjectIdSchema, z.literal('global'), z.literal(UNASSIGNED)]),
  states: z.array(z.enum(MEMORY_STATES)).max(4).optional(),
  query: z.string().max(200).optional(),
})
export const MemoryActionArgsSchema = z.object({
  memoryId: MemoryIdSchema,
  action: z.enum(['approve', 'reject']),
})
export const MemoryEditArgsSchema = z.object({
  memoryId: MemoryIdSchema,
  title: z.string().trim().min(1).max(120).optional(),
  body: z.string().trim().min(1).max(MAX_MESSAGE_CHARS).optional(),
  kind: z.enum(MEMORY_KINDS).optional(),
  scope: z.enum(MEMORY_SCOPES).optional(),
})
export const MemorySupersedeArgsSchema = z.object({
  memoryId: MemoryIdSchema,
  replacement: MemoryDraftSchema,
})
export const MemoryMergeArgsSchema = z.object({
  memoryIds: z.array(MemoryIdSchema).min(2).max(10),
  into: MemoryDraftSchema,
})
export const ContextPreviewArgsSchema = z.object({
  projectId: ProjectIdSchema,
  objective: z.string().max(MAX_MESSAGE_CHARS).optional(),
  provider: ProviderIdSchema.optional(),
})
export const HandoffPrepareArgsSchema = z.object({
  sessionId: SessionIdSchema,
  toProvider: ProviderIdSchema,
  objective: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
})
export const HandoffUpdateArgsSchema = z.object({
  handoffId: HandoffIdSchema,
  note: z.string().max(MAX_MESSAGE_CHARS).optional(),
  /** Memory ids the user kept in the bundle. */
  include: z.array(MemoryIdSchema).max(40).optional(),
})
export const TASK_STATES = ['open', 'doing', 'done', 'dropped'] as const
export const TaskCreateArgsSchema = z.object({
  projectId: ProjectIdSchema,
  title: z.string().trim().min(1).max(120),
  sessionId: SessionIdSchema.optional(),
})
/** A state change, or `confirm` (adds `user-confirmed` evidence). At least one is required. */
export const TaskUpdateArgsSchema = z
  .object({
    taskId: TaskIdSchema,
    state: z.enum(TASK_STATES).optional(),
    confirm: z.literal(true).optional(),
  })
  .refine((a) => a.state !== undefined || a.confirm === true, { message: 'state or confirm' })
/** Experimental: import past Claude Code sessions as `imported`, unassigned records (refs only). */
export const ImportHistoryArgsSchema = z.object({
  limit: z.number().int().min(1).max(500).default(200),
})
export interface ImportResult {
  imported: number
  /** Already known or unreadable. */
  skipped: number
}
export const SearchArgsSchema = z.object({
  query: z.string().trim().min(1).max(200),
  projectId: ProjectIdSchema.optional(),
  /** Also search transcripts on disk (slower; main reads them on demand). */
  deep: z.boolean().default(false),
})

/** Pushed to the renderer on `prj:push` (≤ 4/s, coalesced). */
export type ProjectMessage =
  | { type: 'projects'; projects: ProjectSummary[] }
  | { type: 'session'; session: SessionSummary }
  | { type: 'memory'; memory: MemoryView }
  | { type: 'activity'; event: ActivityView }
  | { type: 'retrieval'; projectId: string; agentId: string; memoryIds: string[] }
  | { type: 'agent-project'; agentId: string; projectId: string | null }
  | { type: 'vault'; status: 'encrypted' | 'memory-only' }
