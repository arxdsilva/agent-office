// Public surface of the core: ports, domain types/errors and the use cases.
export * from './ports/driven.ts'
export * from './ports/driving.ts'
export * from './domain/errors.ts'
export { applyEvent, toDto, type AgentState, type SweepPolicy } from './domain/agent.ts'
export {
  builtinDecls,
  classifyUse,
  mcpDecl,
  prettifyServer,
  type CapabilityRef,
} from './domain/capabilities.ts'
export { HOOK_MARKER, addHooks, hookStatus, removeHooks } from './domain/hook-config.ts'
export type { Note } from './domain/attention.ts'
export type { TrayAction, TrayItem, TrayModel } from './domain/tray.ts'
export {
  createOffice,
  DEFAULT_SWEEP_POLICY,
  type OfficeCore,
  type OfficeDeps,
} from './application/office.ts'
// Individual use cases, for driving adapters that need just one (e.g. the hook CLI).
export { HookService } from './application/hook-service.ts'
export {
  CAPABILITY_DEBOUNCE_MS,
  CapabilityService,
  MAX_CAPABILITIES_PER_PROVIDER,
} from './application/capability-service.ts'
export {
  ComposeService,
  FALLBACK_MODELS,
  MAX_MANAGED,
  ManagedSessionService,
} from './application/managed-session-service.ts'
export {
  composePrompt,
  modeOf,
  MODE_LABELS,
  summarizeToolRequest,
} from './domain/session-prompt.ts'
export {
  ENDED_CAPS,
  PROVIDER_DECLS,
  prefixOf,
  providerOfAgentId,
  providerState,
  sessionCaps,
  type ProviderDecl,
  type ProviderStateInput,
  type ProviderStateResult,
} from './domain/providers.ts'
export {
  BLOCKING_EVENTS,
  HOOK_FORMATS,
  OBSERVE_MARKER,
  SUBSCRIBED,
  addHooks as addProviderHooks,
  hookStatus as providerHookStatus,
  removeHooks as removeProviderHooks,
  type HookFormat,
} from './domain/provider-hooks.ts'
export {
  PROBE_TIMEOUT_MS,
  PROBE_TTL_MS,
  ProviderService,
  type ProviderBinding,
  type ProviderServiceDeps,
} from './application/provider-service.ts'
export {
  ProviderHookService,
  type ProviderHookTarget,
  type ProviderHookTargets,
} from './application/provider-hook-service.ts'
// Projects-first workspace (docs/projects.md).
export { createProjects, type Projects, type ProjectsDeps } from './application/projects.ts'
export {
  McpMemoryAccessService,
  MCP_CALLS_PER_MIN,
  MCP_ITEM_BODY,
  MCP_PROPOSALS_PER_HOUR,
  MCP_RESULT_CHARS,
} from './application/mcp-memory-access.ts'
export { InMemorySearchIndex } from './application/global-search.ts'
export { basenameOnly } from './application/managed-session-service.ts'
export {
  authorize,
  ACTIONS,
  USER,
  type Action,
  type Principal,
  type Resource,
} from './domain/authz.ts'
export {
  matchProject,
  type MatchResult,
  type MatchRule,
  type Suggestion,
} from './domain/repo-identity.ts'
export { bm25, rankContext, tokenize, DEFAULT_BUDGET_CHARS } from './domain/context-rank.ts'
export { DATA_PREFACE, CONTEXT_OPEN, CONTEXT_CLOSE, renderContextBlock } from './domain/handoff.ts'
export type { Project, RepoLink } from './domain/project.ts'
export type * from './domain/harness-types.ts'
export type { SessionRecord } from './domain/session-record.ts'
export type { MemoryItem } from './domain/memory.ts'
// Harness Builder (docs/harness.md)
export { HarnessService } from './application/harness-service.ts'
export {
  HarnessImportService,
  type FormatOf,
  type ParseRuleFile,
} from './application/harness-import-service.ts'
export { HarnessPolicyService } from './application/harness-policy-service.ts'
export {
  CancelController,
  HarnessValidationService,
} from './application/harness-validation-service.ts'
export {
  compilePolicy,
  compileGlob,
  nativeOf,
  normalizePath,
  toolClass,
  OUTSIDE,
  OPAQUE_RULE,
  TOOL_CLASSES,
} from './domain/harness-policy.ts'
export { commandName, parseCommands, type ParsedCommands } from './domain/shell-words.ts'
export { coverageFor, toReportView, COVERAGE_REASONS } from './domain/harness-coverage.ts'
export {
  HARNESS_OPEN,
  HARNESS_CLOSE,
  HARNESS_PREFACE,
  renderHarnessBlock,
} from './domain/harness-instructions.ts'
export { redactSummary } from './domain/harness-events.ts'
export { detectConflicts, normalizeRuleText } from './domain/harness-conflicts.ts'
export { resolveEffective, versionKey } from './domain/harness-resolve.ts'
export { gateFeedback, verificationState, completionState } from './domain/harness-verification.ts'
export {
  formatOf,
  parseRuleFile,
  classifyCategory,
  RULE_FILE_RULES,
  type RawCandidate,
  type RawGate,
  type ParsedRuleFile,
} from './domain/harness-import.ts'
