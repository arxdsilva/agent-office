// Harness contract types shared by the core services and the runtime adapters (docs/harness.md).
// Pure types only; the behaviour lives in harness.ts, harness-policy.ts, harness-resolve.ts,
// harness-coverage.ts and harness-verification.ts. Additive changes only: adapters outside this
// repo implement `ActionPolicy` consumers and declare `EnforcementDecl`.
import type {
  ActionRule,
  AppliesTo,
  CheckState,
  Completion,
  FlowMode,
  StepCheck,
  StepState,
  ConflictView,
  Coverage,
  Enforcement,
  EnforcementCapability,
  FsIsolation,
  GateStatus,
  GateTrigger,
  HarnessEventKind,
  HarnessScope,
  HarnessStatus,
  LaunchPolicy,
  ProviderId,
  RuleCategory,
  RuleSourceFormat,
  Severity,
  Verification,
} from '@agent-office/shared'

// ── Entities (stored in the vault) ─────────────────────────────────────────────────────────────

/** Provenance of an imported rule. `path` is repo-relative; no absolute path is ever stored. */
export interface RuleSource {
  format: RuleSourceFormat
  path: string
  repoLabel: string
  /** sha256 (hex) of the source file at import time. */
  hash: string
  importedAt: number
  globs?: string[]
  alwaysApply?: boolean
}

export interface HarnessRule {
  /** `rul_…`, stable across versions of the harness. */
  id: string
  name: string
  text: string
  category: RuleCategory
  enforcement: Enforcement
  severity: Severity
  policy?: ActionRule
  appliesTo?: AppliesTo
  source?: RuleSource
}

export interface ValidationGate {
  /** `gat_…` */
  id: string
  name: string
  argv: string[]
  subdir?: string
  timeoutMs: number
  required: boolean
  platforms?: ('darwin' | 'linux' | 'win32')[]
  pinFiles?: string[]
}

/** One step of a flow (docs/harness.md §2a). `exit` checks must ALL pass to leave it. */
export interface FlowStep {
  /** `stp_…`, stable across versions. */
  id: string
  name: string
  goal: string
  instructions?: string
  roles?: string[]
  exit: StepCheck[]
  /** Restrictions active only while this step is current. */
  policies?: ActionRule[]
  optional: boolean
}

/**
 * One version of a harness. Every version is kept (`harness:id:version` in the catalog partition);
 * a published version is immutable and an edit opens `version + 1` as a draft.
 */
export interface Harness {
  /** `hrn_…`, the lineage id shared by every version. */
  id: string
  version: number
  name: string
  description?: string
  scope: HarnessScope
  status: HarnessStatus
  launchPolicy: LaunchPolicy
  gateTrigger: GateTrigger
  fsIsolation: FsIsolation
  retryBudget: number
  rules: HarnessRule[]
  gates: ValidationGate[]
  /** The flow; absent or empty = standards only. */
  steps?: FlowStep[]
  flowMode?: FlowMode
  createdAt: number
  updatedAt: number
  publishedAt?: number
  archivedAt?: number
}

/** On `Project.harnesses` (optional, additive to the project record). */
export interface HarnessAttachment {
  harnessId: string
  attachedAt: number
}

// ── Policy (pure engine input/output) ──────────────────────────────────────────────────────────

/** One enforceable rule after resolution; `id` is the originating `HarnessRule.id`. */
export interface PolicyRule extends ActionRule {
  id: string
  /** ≤ 200 chars, returned to the model on deny and shown in the inspector. */
  reason: string
  severity: Severity
  providers?: ProviderId[]
}

export interface PolicyAction {
  /** Normalized tool name (Edit, Bash, Read, WebFetch, Grep, mcp__srv__tool, Task, …). */
  tool: string
  /** Raw input as the runner received it; it never leaves the main process. */
  input: Record<string, unknown>
  cwd: string
  provider?: ProviderId
  /** `main` or a subagent type. */
  agentRole?: string
  /** The session's current flow step (step-scoped policies apply). */
  stepId?: string
}

export interface PolicyDecision {
  /** `allow` = the harness has no objection; the normal permission flow continues. */
  action: 'allow' | 'deny' | 'ask'
  ruleIds: string[]
  reason: string
  /** `heuristic`: a shell command was parsed by hand (reported as partial coverage). */
  basis: 'exact' | 'heuristic'
}

/** What a runner receives at start (`RunnerStart.harness`): compiled, provider-neutral policy. */
export interface ActionPolicy {
  /** Synchronous and total: never throws (an internal error is a deny). Also records the audit. */
  evaluate(a: PolicyAction): PolicyDecision
  /** The instruction block (≤ 16 KB) for the system prompt / developer instructions / first message. */
  instructions?: string
  /** Pre-extracted static parts a runtime can enforce natively. */
  native: {
    deniedTools: string[]
    denyPaths: string[]
    askPaths: string[]
    denyCommands: string[]
    askCommands: string[]
    fsIsolation: FsIsolation
  }
  /** True when any runtime-policy rule exists: the runtime must raise every action to us. */
  interceptAll: boolean
  /** `required` rules the target runtime cannot enforce (reported, never silently downgraded). */
  unsupported: { ruleId: string; reason: string }[]
}

/**
 * What a runtime really provides, declared by its adapter (`RunnerDecl.enforcement`). The
 * coverage report is computed from this and the session mode; nothing is inferred.
 */
export interface EnforcementDecl {
  /** `native`: system prompt / developer instructions. `first-message`: prepended to the first prompt. */
  instructions: 'native' | 'first-message' | 'none'
  /** `hook`: every call is raised before it runs. `approval`: only calls the runtime escalates. */
  toolDeny: 'hook' | 'approval' | 'none'
  pathDeny: 'hook' | 'approval' | 'partial' | 'none'
  commandDeny: 'hook' | 'approval' | 'partial' | 'none'
  fsIsolation: 'sandbox' | 'partial' | 'none'
  /** `inherited`: subagent calls reach the same policy. `opaque`: subagents exist but are not seen. */
  subagents: 'inherited' | 'opaque' | 'none'
  /** Permission modes / mode ids in which the runtime cannot intercept (coerced or refused). */
  nonInterceptingModes?: string[]
  /** The mode a non-intercepting session is coerced to under an advisory harness. */
  interceptingMode?: string
}

// ── Resolution and reports ─────────────────────────────────────────────────────────────────────

export interface EffectiveHarness {
  projectId: string
  provider: ProviderId
  resolved: { harnessId: string; version: number; name: string }[]
  rules: HarnessRule[]
  policies: PolicyRule[]
  gates: ValidationGate[]
  /** Flow steps in Applied order across the attached harnesses (empty = no flow). */
  steps?: FlowStep[]
  flowMode?: FlowMode
  /** The rendered instruction block (harness-instructions.ts). */
  instructions: string
  conflicts: ConflictView[]
  launchPolicy: LaunchPolicy
  gateTrigger: GateTrigger
  fsIsolation: FsIsolation
  retryBudget: number
  resolvedAt: number
}

export interface EnforcementRow {
  capability: EnforcementCapability
  level: Coverage
  reason: string
}

export interface EnforcementReport {
  provider: ProviderId
  rows: EnforcementRow[]
  perRule: Record<string, { coverage: Coverage; reason: string }>
  launch: { ok: true } | { ok: false; reasons: string[] }
}

/** Stored once per managed session (`s/<ses>`, `harness-snapshot`): what applied, for auditing. */
export interface HarnessSnapshot {
  /** `hsn_…` */
  id: string
  sessionId: string
  agentId: string
  projectId: string
  provider: ProviderId
  effective: EffectiveHarness
  report: EnforcementReport
  createdAt: number
}

/** One session's progress through its flow (`s/<ses>`, record `flow-progress`). */
export interface FlowProgress {
  /** `fpg_…` */
  id: string
  sessionId: string
  agentId: string
  projectId: string
  harnessVersion: string
  mode: FlowMode
  current: string | null
  steps: {
    stepId: string
    state: StepState
    checks: CheckState[]
    doneAt?: number
    by?: 'agent' | 'user' | 'checks'
  }[]
  updatedAt: number
}

// ── Audit and validation records ───────────────────────────────────────────────────────────────

export interface HarnessEvent {
  /** `hev_…` */
  id: string
  projectId: string
  sessionId: string
  agentId: string
  ts: number
  kind: HarnessEventKind
  ruleIds: string[]
  detail: {
    tool?: string
    /** ≤ 120 chars via `summarizeToolRequest`, then redacted. Never raw input. */
    summary?: string
    gateId?: string
    exitCode?: number | null
    durationMs?: number
    agentRole?: string
    harnessVersions?: string[]
  }
}

/** What the trusted runner executes: argv from the published harness, never a shell string. */
export interface GateSpec {
  id: string
  argv: string[]
  timeoutMs: number
  /** Repo-relative files whose hash is compared with the session-start hash. */
  pinFiles?: string[]
}

export interface GateRun {
  status: Exclude<GateStatus, 'running'>
  exitCode: number | null
  durationMs: number
  /** Redacted, ≤ 8 KB (domain/redact.ts). */
  outputTail: string
  pinChanged?: boolean
  spawnError?: string
}

export interface GateResult {
  /** `gtr_…` */
  id: string
  sessionId: string
  projectId: string
  gateId: string
  name: string
  required: boolean
  /** "hrn_…@3" per resolved harness, joined with ','. */
  harnessVersion: string
  startedAt: number
  run: GateRun
}

export type { Completion, Verification }

// ── Core-internal hooks between the session service and the harness services ───────────────────

/** What `ManagedSessionService` asks before, during and after a managed session (optional dep). */
export interface SessionHarnessHooks {
  /**
   * Resolves the project's effective harness for this runtime. Throws `SessionStartError('harness')`
   * when a strict harness has a required rule the runtime cannot enforce. undefined: nothing applies.
   */
  prepare(o: {
    projectId: string
    provider: ProviderId
    cwd: string
    mode: string
    modeId?: string
    enforcement?: EnforcementDecl
  }): Promise<ActionPolicy | undefined>
  /** The session is registered: the snapshot is written and later decisions carry the ids. */
  bind(o: { agentId: string; sessionId: string; projectId: string; policy: ActionPolicy }): void
  /** A permission request reached core (also used by runners that cannot hook): policy first. */
  evaluate(agentId: string, a: PolicyAction): PolicyDecision
  /** A turn ended; the validation service decides whether gates run. */
  turnEnded(agentId: string, r: { isError: boolean; interrupted: boolean }): void
  ended(agentId: string): void
}
