// Harness Builder contract (docs/harness.md): versioned rule sets attached to projects, their
// enforcement coverage per runtime, validation gates and the compliance inspection the UI shows.
// Additive changes only (ARCHITECTURE rule). Views never carry absolute paths or raw tool input.
import { z } from 'zod'
import { ProjectIdSchema } from './projects.ts'
import { ProviderIdSchema, type ProviderId } from './providers.ts'

// ── Ids ────────────────────────────────────────────────────────────────────────────────────────

export const HarnessIdSchema = z.string().regex(/^hrn_[a-z0-9]{10,24}$/)
export const RuleIdSchema = z.string().regex(/^rul_[a-z0-9]{6,24}$/)
export const GateIdSchema = z.string().regex(/^gat_[a-z0-9]{6,24}$/)
/** A candidate in an import preview (not persisted). */
export const TempIdSchema = z.string().regex(/^cand_[a-z0-9]{1,24}$/)
/** A flow step inside a harness. */
export const StepIdSchema = z.string().regex(/^stp_[a-z0-9]{6,24}$/)
export const PreviewIdSchema = z.string().regex(/^prv_[a-z0-9]{6,24}$/)

// ── Enums ──────────────────────────────────────────────────────────────────────────────────────

export const RULE_CATEGORIES = [
  'architecture',
  'coding',
  'testing',
  'security',
  'workflow',
  'tools',
  'completion',
  // Flows for any kind of work (docs/harness.md §2a), not only engineering.
  'process',
  'content',
  'research',
  'communication',
  'compliance',
  'other',
] as const
export type RuleCategory = (typeof RULE_CATEGORIES)[number]

/** How a rule is applied: text the agent reads, a check before an action, or a command after a turn. */
export const ENFORCEMENT = ['instruction', 'runtime-policy', 'validation-gate'] as const
export type Enforcement = (typeof ENFORCEMENT)[number]

export const SEVERITY = ['required', 'recommended'] as const
export type Severity = (typeof SEVERITY)[number]

export const HARNESS_STATUS = ['draft', 'published', 'archived'] as const
export type HarnessStatus = (typeof HARNESS_STATUS)[number]

export const HARNESS_SCOPES = ['global', 'workspace', 'project'] as const
export type HarnessScope = (typeof HARNESS_SCOPES)[number]

/** `strict`: an unsupported required rule blocks launch. `advisory`: the user is told and may proceed. */
export const LAUNCH_POLICIES = ['strict', 'advisory'] as const
export type LaunchPolicy = (typeof LAUNCH_POLICIES)[number]

/** When gates run: only on "Run validation", or after every turn that wrote or ran something. */
export const GATE_TRIGGERS = ['manual', 'turn-end'] as const
export type GateTrigger = (typeof GATE_TRIGGERS)[number]

/** Ask the runtime for an OS sandbox around file writes (Claude SDK sandbox; Codex sandbox floor). */
export const FS_ISOLATION = ['off', 'prefer', 'require'] as const
export type FsIsolation = (typeof FS_ISOLATION)[number]

/**
 * What a runtime really does with a rule. Never "guaranteed": `enforced` means a trusted
 * interception boundary (hook, approval channel, sandbox) blocks the action before it happens.
 */
export const COVERAGE = ['enforced', 'partial', 'instruction-only', 'unsupported'] as const
export type Coverage = (typeof COVERAGE)[number]

export const ENFORCEMENT_CAPABILITIES = [
  'instructions',
  'tool-deny',
  'path-deny',
  'command-deny',
  'fs-isolation',
  'subagents',
] as const
export type EnforcementCapability = (typeof ENFORCEMENT_CAPABILITIES)[number]

export const GATE_STATUSES = ['running', 'pass', 'fail', 'timeout', 'cancelled', 'error'] as const
export type GateStatus = (typeof GATE_STATUSES)[number]

/** Validation state of a session's work against its current harness version. */
export const VERIFICATION = [
  'not-run',
  'running',
  'failed',
  'verified',
  'stale',
  /** Every gate passed but required flow steps remain. */
  'flow-incomplete',
] as const
export type Verification = (typeof VERIFICATION)[number]

/** Shown next to the provider's own lifecycle state; never replaces it. */
export const COMPLETION = [
  'agent-reported',
  'validation-pending',
  'validation-failed',
  'harness-verified',
  'user-approved',
] as const
export type Completion = (typeof COMPLETION)[number]

export const HARNESS_EVENT_KINDS = [
  'attached',
  'resolved',
  'instructions-delivered',
  'action-allowed',
  'action-denied',
  'action-asked',
  'approval-requested',
  'validation-started',
  'validation-passed',
  'validation-failed',
  'harness-updated',
  'exception-approved',
  // Flow progress (docs/harness.md §2a).
  'step-started',
  'step-done',
  'step-skipped',
  'approval-granted',
] as const
export type HarnessEventKind = (typeof HARNESS_EVENT_KINDS)[number]

export const RULE_SOURCE_FORMATS = [
  'agents-md',
  'claude-md',
  'claude-rule',
  'cursor-mdc',
  'cursorrules',
  'gemini-md',
  'copilot-instructions',
  'copilot-instruction-file',
  'makefile',
  'ci-workflow',
  'manual',
  'template',
] as const
export type RuleSourceFormat = (typeof RULE_SOURCE_FORMATS)[number]

// ── Drafts (what the UI sends) ─────────────────────────────────────────────────────────────────

const Glob = z.string().min(1).max(200)
const Word = z.string().min(1).max(60)

/** The enforceable part of a `runtime-policy` rule. Deny beats ask; `allow` is never a rule. */
export const ActionRuleSchema = z.object({
  effect: z.enum(['deny', 'ask']),
  /** Tool names as the runners normalize them (Edit, Bash, WebFetch, …), `class:write`, or `mcp__srv__*`. */
  tools: z.array(Word).max(20).optional(),
  /** Repo-relative globs (`**`, `*`, `?`, `{a,b}`); `@outside` matches paths outside the working directory. */
  paths: z.array(Glob).max(50).optional(),
  /** Carve-outs for `paths`. */
  except: z.array(Glob).max(50).optional(),
  /** Command names (argv[0] basename), e.g. `rm`, `git`, `curl`. Advisory for shells: see docs/harness.md §3. */
  commands: z.array(Word).max(50).optional(),
  /** Host globs for fetch tools. */
  hosts: z.array(Glob).max(50).optional(),
  /** `main` or a subagent type; absent = every role. */
  roles: z.array(Word).max(20).optional(),
})
export type ActionRule = z.infer<typeof ActionRuleSchema>

export const GateDraftSchema = z.object({
  /** Present when editing an existing gate (keeps its history). */
  id: GateIdSchema.optional(),
  name: z.string().trim().min(1).max(80),
  /** An argv array, never a shell string. `['make', 'check']`. */
  argv: z
    .array(
      z
        .string()
        .min(1)
        .max(200)
        .regex(/^[^\0\n\r]*$/),
    )
    .min(1)
    .max(32),
  /** Repo-relative working directory (monorepos). */
  subdir: z.string().max(200).optional(),
  timeoutMs: z.number().int().min(1000).max(1_800_000).default(600_000),
  required: z.boolean().default(true),
  platforms: z
    .array(z.enum(['darwin', 'linux', 'win32']))
    .max(3)
    .optional(),
  /** Repo-relative files hashed at session start and gate time; a change voids verification. */
  pinFiles: z.array(z.string().min(1).max(200)).max(16).optional(),
})
export type GateDraft = z.input<typeof GateDraftSchema>

export const AppliesToSchema = z.object({
  runtimes: z.array(ProviderIdSchema).max(20).optional(),
  filePatterns: z.array(Glob).max(50).optional(),
  agentRoles: z.array(Word).max(20).optional(),
})
export type AppliesTo = z.infer<typeof AppliesToSchema>

export const RuleDraftSchema = z.object({
  /** Present when editing an existing rule (keeps its provenance). */
  id: RuleIdSchema.optional(),
  name: z.string().trim().min(1).max(120),
  text: z.string().trim().min(1).max(2000),
  category: z.enum(RULE_CATEGORIES),
  enforcement: z.enum(ENFORCEMENT),
  severity: z.enum(SEVERITY).default('required'),
  /** Required for `runtime-policy`; ignored otherwise. */
  policy: ActionRuleSchema.optional(),
  appliesTo: AppliesToSchema.optional(),
})
export type RuleDraft = z.input<typeof RuleDraftSchema>

/** How a flow's steps are followed: one active step at a time, or a checklist in any order. */
export const FLOW_MODES = ['sequential', 'free'] as const
export type FlowMode = (typeof FLOW_MODES)[number]

export const STEP_CHECK_KINDS = ['approval', 'gate', 'artifact', 'report'] as const
export type StepCheckKind = (typeof STEP_CHECK_KINDS)[number]
/** An exit check of a step: ALL checks must pass to leave it. */
export const StepCheckSchema = z.discriminatedUnion('kind', [
  /** The user clicks Approve (Inspector or Overview). */
  z.object({ kind: z.literal('approval'), prompt: z.string().trim().min(1).max(200) }),
  /** One of the harness's gates has a fresh pass. */
  z.object({ kind: z.literal('gate'), gateId: GateIdSchema }),
  /** A repo-relative glob matches (or not) a file; checked by the trusted runner (stat only). */
  z.object({ kind: z.literal('artifact'), path: Glob, mustExist: z.boolean().default(true) }),
  /** The agent reports the step done (`report_step` MCP tool, or the user marks it). */
  z.object({ kind: z.literal('report'), note: z.string().trim().max(200).optional() }),
])
export type StepCheck = z.infer<typeof StepCheckSchema>

export const StepDraftSchema = z.object({
  /** Present when editing an existing step (keeps its progress history). */
  id: StepIdSchema.optional(),
  name: z.string().trim().min(1).max(80),
  /** What is true when the step is done. */
  goal: z.string().trim().min(1).max(600),
  instructions: z.string().trim().max(2000).optional(),
  /** `main` or subagent types that own the step; absent = everyone. */
  roles: z.array(Word).max(20).optional(),
  exit: z.array(StepCheckSchema).min(1).max(6),
  /** Restrictions active only while this step is current (deny-wins with the harness rules). */
  policies: z.array(ActionRuleSchema).max(20).optional(),
  /** The user may skip it without confirming. */
  optional: z.boolean().default(false),
})
export type StepDraft = z.input<typeof StepDraftSchema>

export const HarnessDraftSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(400).optional(),
  scope: z.enum(HARNESS_SCOPES).default('project'),
  launchPolicy: z.enum(LAUNCH_POLICIES).default('advisory'),
  gateTrigger: z.enum(GATE_TRIGGERS).default('manual'),
  fsIsolation: z.enum(FS_ISOLATION).default('off'),
  /** Validation feedback rounds per user message before the session is left `waiting`. */
  retryBudget: z.number().int().min(0).max(5).default(2),
  rules: z.array(RuleDraftSchema).max(200).default([]),
  gates: z.array(GateDraftSchema).max(32).default([]),
  /** The flow: ordered steps with checkpoints (docs/harness.md §2a). Empty = standards only. */
  steps: z.array(StepDraftSchema).max(24).default([]),
  flowMode: z.enum(FLOW_MODES).default('sequential'),
})
export type HarnessDraft = z.input<typeof HarnessDraftSchema>

// ── Views (what the UI reads) ──────────────────────────────────────────────────────────────────

/** Where an imported rule came from. `path` is repo-relative; the repository is named by label only. */
export interface RuleSourceView {
  format: RuleSourceFormat
  path: string
  repoLabel: string
  /** sha256 of the source file at import time. */
  hash: string
  importedAt: number
  /** Activation globs the source declared (Cursor `globs`, Copilot `applyTo`). */
  globs?: string[]
  /** The source file changed since import (checked on demand, slice 2 UI). */
  drift?: boolean
}

export interface HarnessRuleView {
  id: string
  name: string
  text: string
  category: RuleCategory
  enforcement: Enforcement
  severity: Severity
  policy?: ActionRule
  appliesTo?: AppliesTo
  source?: RuleSourceView
  /** Set in effective views: how the target runtime applies this rule. */
  coverage?: Coverage
  coverageReason?: string
}

export interface GateView {
  id: string
  name: string
  argv: string[]
  subdir?: string
  timeoutMs: number
  required: boolean
  platforms?: ('darwin' | 'linux' | 'win32')[]
  pinFiles?: string[]
}

export interface StepCheckView {
  kind: StepCheckKind
  /** One line: the prompt, the gate name, the path, or the note. */
  label: string
  gateId?: string
  path?: string
  mustExist?: boolean
  prompt?: string
}

export interface StepView {
  id: string
  index: number
  name: string
  goal: string
  instructions?: string
  roles?: string[]
  exit: StepCheckView[]
  policies?: ActionRule[]
  optional: boolean
}

export interface ConflictView {
  /** Same text twice; a never/always pair; opposite policy effects on one target (deny wins). */
  kind: 'duplicate' | 'negation' | 'policy-opposite'
  ruleIds: string[]
  /** One plain line for the review list. */
  text: string
}

export interface HarnessSummary {
  id: string
  name: string
  description?: string
  version: number
  status: HarnessStatus
  scope: HarnessScope
  launchPolicy: LaunchPolicy
  ruleCount: number
  gateCount: number
  /** Flow steps (0 = standards only). */
  stepCount?: number
  /** Rules per enforcement level. */
  enforcement: Record<Enforcement, number>
  /** Projects this harness is attached to. */
  projectIds: string[]
  createdAt: number
  updatedAt: number
  publishedAt?: number
}

export interface HarnessDetail extends HarnessSummary {
  gateTrigger: GateTrigger
  fsIsolation: FsIsolation
  retryBudget: number
  rules: HarnessRuleView[]
  gates: GateView[]
  conflicts: ConflictView[]
  steps?: StepView[]
  flowMode?: FlowMode
}

export interface HarnessTemplateView {
  id: string
  name: string
  description: string
  ruleCount: number
  gateCount: number
}

export interface ImportSourceView {
  /** Repo-relative. */
  path: string
  repoLabel: string
  format: RuleSourceFormat
  bytes: number
  /** Candidates extracted, once previewed. */
  ruleCount?: number
}

export interface ImportCandidateView {
  tempId: string
  name: string
  text: string
  category: RuleCategory
  enforcement: Enforcement
  severity: Severity
  source: RuleSourceView
  /** Another candidate (or an existing rule id) with the same normalized text. */
  duplicateOf?: string
  conflictsWith?: string[]
}

/** A command found in a fenced block or a Makefile target. Suggested only; never executed on import. */
export interface ImportGateSuggestion {
  tempId: string
  name: string
  argv: string[]
  source: RuleSourceView
  /** Why it cannot be a gate (shell metacharacters, pipes, substitutions). */
  rejected?: string
}

/** An ordered list item found under a workflow/process/checklist heading. Suggested only. */
export interface ImportStepSuggestion {
  tempId: string
  index: number
  name: string
  goal: string
  source: RuleSourceView
}

export interface ImportPreview {
  previewId: string
  projectId: string
  sources: ImportSourceView[]
  candidates: ImportCandidateView[]
  gates: ImportGateSuggestion[]
  /** Step suggestions in document order (absent for sources without lists). */
  steps?: ImportStepSuggestion[]
  conflicts: ConflictView[]
  totals: { rules: number; byCategory: Record<RuleCategory, number>; conflicts: number }
}

export interface EnforcementRowView {
  capability: EnforcementCapability
  level: Coverage
  /** ≤ 160 chars, e.g. "PreToolUse hook blocks the call before it runs". */
  reason: string
}

export interface EnforcementReportView {
  provider: ProviderId
  rows: EnforcementRowView[]
  launch: { ok: true } | { ok: false; reasons: string[] }
}

export interface EffectiveHarnessView {
  resolved: { harnessId: string; version: number; name: string }[]
  rules: HarnessRuleView[]
  gates: GateView[]
  unsupported: { ruleId: string; reason: string }[]
  conflicts: ConflictView[]
  launchPolicy: LaunchPolicy
  gateTrigger: GateTrigger
  fsIsolation: FsIsolation
  /** Length of the instruction block the agent receives. */
  instructionsChars: number
  /** The flow steps in Applied order across attached harnesses. */
  steps?: StepView[]
  flowMode?: FlowMode
}

/** What a session of `provider` on this project would get: for the New Session dialog. */
export interface HarnessPreview {
  effective: EffectiveHarnessView
  report: EnforcementReportView
}

export interface HarnessEventView {
  id: string
  ts: number
  kind: HarnessEventKind
  ruleIds: string[]
  /** Normalized tool name (Edit, Bash, …). */
  tool?: string
  /** ≤ 120 chars, built like permission cards; never raw tool input. */
  summary?: string
  gateId?: string
  /** `main` or a subagent type. */
  agentRole?: string
}

export interface GateResultView {
  id: string
  gateId: string
  name: string
  status: GateStatus
  exitCode: number | null
  startedAt: number
  durationMs: number
  /** Redacted, ≤ 8 KB. */
  outputTail: string
  pinChanged?: boolean
  required: boolean
  /** The harness versions the gate came from, e.g. "hrn_…@3". */
  harnessVersion: string
}

export const STEP_STATES = ['pending', 'active', 'done', 'skipped'] as const
export type StepState = (typeof STEP_STATES)[number]
export const CHECK_STATES = ['pending', 'pass', 'fail', 'waiting-user'] as const
export type CheckState = (typeof CHECK_STATES)[number]

/** One session's progress through its flow (docs/harness.md §2a). */
export interface FlowProgressView {
  harnessVersion: string
  mode: FlowMode
  /** The active step in sequential mode; null when done or not started. */
  current: string | null
  steps: {
    stepId: string
    index: number
    name: string
    goal: string
    state: StepState
    optional: boolean
    checks: { index: number; kind: StepCheckKind; label: string; state: CheckState }[]
    doneAt?: number
    by?: 'agent' | 'user' | 'checks'
  }[]
  done: number
  total: number
}

export type { FlowApprovalView } from './projects.ts'

/** The Agent Details → Harness tab. */
export interface HarnessInspection {
  agentId: string
  sessionId?: string
  projectId?: string
  /** null: no harness applies (no project, or nothing attached). */
  effective: EffectiveHarnessView | null
  report: EnforcementReportView | null
  counts: { allowed: number; denied: number; asked: number }
  /** Newest first, ≤ 50. */
  events: HarnessEventView[]
  gates: GateResultView[]
  verification: Verification
  completion: Completion
  retriesLeft?: number
  lastEvent?: HarnessEventView
  /** Present when the effective harness has steps. */
  flow?: FlowProgressView
}

/** Compact per-agent state for Minimal mode and labels. */
export interface HarnessBadge {
  agentId: string
  harnessNames: string[]
  ruleCount: number
  /** The weakest coverage among required rules. */
  coverage: Coverage
  verification: Verification
  completion: Completion
  denied: number
  /** The active flow step, when there is a flow. */
  step?: { index: number; total: number; name: string }
}

// ── IPC args ───────────────────────────────────────────────────────────────────────────────────

export const HarnessIdArgsSchema = z.object({ harnessId: HarnessIdSchema })
export const HarnessUpdateArgsSchema = z.object({
  harnessId: HarnessIdSchema,
  draft: HarnessDraftSchema,
})
export type HarnessUpdateArgs = z.input<typeof HarnessUpdateArgsSchema>
export const HarnessAttachArgsSchema = z.object({
  projectId: ProjectIdSchema,
  harnessId: HarnessIdSchema,
})
export const TemplateArgsSchema = z.object({ templateId: z.string().regex(/^[a-z0-9-]{1,40}$/) })
export const ImportDetectArgsSchema = z.object({ projectId: ProjectIdSchema })
export const ImportPreviewArgsSchema = z.object({
  projectId: ProjectIdSchema,
  /** Repo-relative paths from `detect`; absent = every detected source. */
  paths: z.array(z.string().min(1).max(300)).max(200).optional(),
})
export type ImportPreviewArgs = z.input<typeof ImportPreviewArgsSchema>
export const ImportCommitArgsSchema = z.object({
  previewId: PreviewIdSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(400).optional(),
  /** Candidates to keep (≤ 200). */
  selected: z.array(TempIdSchema).max(200),
  /** Per-candidate edits made in the review step. */
  edits: z
    .array(
      z.object({
        tempId: TempIdSchema,
        name: z.string().trim().min(1).max(120).optional(),
        text: z.string().trim().min(1).max(2000).optional(),
        category: z.enum(RULE_CATEGORIES).optional(),
        enforcement: z.enum(ENFORCEMENT).optional(),
        severity: z.enum(SEVERITY).optional(),
        policy: ActionRuleSchema.optional(),
      }),
    )
    .max(200)
    .optional(),
  /** Gate suggestions to keep (≤ 32); rejected ones are refused. */
  gates: z.array(TempIdSchema).max(32).default([]),
  /** Step suggestions to keep, in the order chosen, each with its exit check kind (default report). */
  steps: z
    .array(z.object({ tempId: TempIdSchema, check: z.enum(STEP_CHECK_KINDS).default('report') }))
    .max(24)
    .default([]),
  /** Attach the new draft's project right away (it still has to be published). */
  attach: z.boolean().default(false),
})
export type ImportCommitArgs = z.input<typeof ImportCommitArgsSchema>
export const CoverageArgsSchema = z.object({
  projectId: ProjectIdSchema,
  provider: ProviderIdSchema,
})
export const RunGatesArgsSchema = z.object({
  agentId: z.string().min(1).max(200),
  gateIds: z.array(GateIdSchema).max(32).optional(),
})
export type RunGatesArgs = z.input<typeof RunGatesArgsSchema>
export const AgentIdArgsSchema = z.object({ agentId: z.string().min(1).max(200) })

export const HarnessReorderArgsSchema = z.object({
  projectId: ProjectIdSchema,
  /** A permutation of the project's attached harness ids (≤ 16 = MAX_HARNESSES). */
  harnessIds: z.array(HarnessIdSchema).min(1).max(16),
})
export type HarnessReorderArgs = z.input<typeof HarnessReorderArgsSchema>
export const FlowStepArgsSchema = z.object({
  agentId: z.string().min(1).max(200),
  stepId: StepIdSchema,
  /** For `approve`: which exit check of the step (index in `exit`). */
  checkIndex: z.number().int().min(0).max(5).optional(),
})
export type FlowStepArgs = z.input<typeof FlowStepArgsSchema>
export const FlowSkipArgsSchema = z.object({
  agentId: z.string().min(1).max(200),
  stepId: StepIdSchema,
  /** Required to skip a non-optional step (the UI asks first). */
  confirmed: z.boolean().default(false),
})
export type FlowSkipArgs = z.input<typeof FlowSkipArgsSchema>
