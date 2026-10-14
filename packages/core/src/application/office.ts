import { PROVIDER_IDS, type ProviderId, type Settings } from '@agent-office/shared'
import { mcpDecl } from '../domain/capabilities.ts'
import type { SweepPolicy } from '../domain/agent.ts'
import type {
  AgentRepository,
  AgentRunner,
  CapabilityRepository,
  ClaudeSettingsStore,
  Clock,
  EventPublisher,
  EventSubscriber,
  GateRunner,
  RepoFiles,
  HookRunner,
  IdGenerator,
  LoginItem,
  Logger,
  MessageRepository,
  Notifier,
  PlatformInfo,
  RecordLog,
  HistorySources,
  RepoIdentity,
  RuleSourceReader,
  RunnerStart,
  Scheduler,
  SearchIndex,
  SecureRandom,
  TranscriptReader,
  SettingsRepository,
  TrayView,
  Updater,
  WindowState,
} from '../ports/driven.ts'
import type { ProviderCatalog, ProviderHooks } from '../ports/driving.ts'
import { ActivityService } from './activity-service.ts'
import { AttentionService } from './attention-service.ts'
import { CapabilityService } from './capability-service.ts'
import { HookService } from './hook-service.ts'
import { InboxService } from './inbox-service.ts'
import { ComposeService, ManagedSessionService } from './managed-session-service.ts'
import { OfficeQueryService } from './office-query.ts'
import { ProviderHookService, type ProviderHookTargets } from './provider-hook-service.ts'
import { createProjects, type Projects } from './projects.ts'
import { ProviderService, type ProviderBinding } from './provider-service.ts'
import { SettingsService } from './settings-service.ts'
import { UpdateService } from './update-service.ts'

export const DEFAULT_SWEEP_POLICY: SweepPolicy = {
  idleAfterMs: 60_000,
  expireAfterMs: 600_000,
  doneTtlMs: 30_000,
  interactiveTtlMs: 600_000,
}

/** Every driven port the core needs. Built by the composition root. */
export interface OfficeDeps {
  agents: AgentRepository
  messages: MessageRepository
  /** Adapters, skills and rules per provider (docs/capabilities.md). */
  capabilities: CapabilityRepository
  bus: EventPublisher & EventSubscriber
  clock: Clock
  ids: IdGenerator
  scheduler: Scheduler
  settingsRepo: SettingsRepository
  loginItem: LoginItem
  claudeSettings: ClaudeSettingsStore
  hookRunner: HookRunner
  notifier: Notifier
  tray: TrayView
  window: WindowState
  updater: Updater
  platform: PlatformInfo
  releaseUrl: string
  policy?: SweepPolicy
  rateLimitPerSec?: number
  autoUpdate?: boolean
  /** Starts managed Claude Code sessions; without it `sessions` is undefined. */
  runner?: AgentRunner
  /** How working directories are shown on permission cards (e.g. '~'-abbreviated). */
  displayPath?: (path: string) => string
  /** Provider integrations (probes, runtimes, hook status). Default: Claude Code with `runner`. */
  providers?: ProviderBinding[]
  /** Managed runtimes by provider; `runner` stays the 'claude-code' entry. */
  runtimes?: ReadonlyMap<ProviderId, AgentRunner>
  /** Hook-based providers' observation hooks; without it `providerHooks` is undefined. */
  providerHookTargets?: ProviderHookTargets
  /** Provider statuses changed (refresh, enable): push ConnectionInfo. */
  onProvidersChange?: () => void
  log?: Logger
  // ── projects-first workspace (docs/projects.md); `projects` exists only with `vault` ──
  vault?: RecordLog
  repoIdentity?: RepoIdentity
  transcripts?: TranscriptReader
  /** Experimental: lists past provider sessions for the history import. */
  history?: HistorySources
  searchIndex?: SearchIndex
  /** Ids and MCP tokens; without it no MCP token is ever minted. */
  random?: SecureRandom
  /** The project MCP bridge command for a session token (the adapter owns the wrapper). */
  mcpLaunch?: (token: string) => RunnerStart['mcp']
  // ── Harness Builder (docs/harness.md); only with `vault` ──
  /** Reads rule files of linked repositories for the harness import. */
  ruleSources?: RuleSourceReader
  /** The trusted validation-gate runner. */
  gateRunner?: GateRunner
  /** Read-only artifact checks for flow steps (docs/harness.md §2a). */
  repoFiles?: RepoFiles
}

/** The project MCP server's capability (the Context Hub station). */
const CONTEXT_HUB = mcpDecl('agent-office-memory')

function enabledProviders(s: Settings): ProviderId[] {
  return PROVIDER_IDS.filter(
    (id) => s.providers?.[id]?.enabled ?? (id === 'claude-code' ? s.claudeAdapter : false),
  )
}

const SILENT: Logger = { info() {}, warn() {} }

/** Every provider with a runtime gets a binding, and every binding its runtime and hook status. */
function bindingsOf(
  d: OfficeDeps,
  runtimes: ReadonlyMap<ProviderId, AgentRunner>,
  hooks: ProviderHookService | undefined,
): ProviderBinding[] {
  const out = new Map<ProviderId, ProviderBinding>()
  for (const b of d.providers ?? []) out.set(b.provider, { ...b })
  for (const [provider, runner] of runtimes) {
    const b = out.get(provider) ?? { provider }
    out.set(provider, { ...b, runner: b.runner ?? runner })
  }
  out.set('claude-code', out.get('claude-code') ?? { provider: 'claude-code' })
  for (const b of out.values())
    if (!b.hooks && hooks?.supports(b.provider))
      b.hooks = { status: () => hooks.status(b.provider) }
  for (const id of Object.keys(d.providerHookTargets ?? {}) as ProviderId[])
    if (!out.has(id) && hooks)
      out.set(id, { provider: id, hooks: { status: () => hooks.status(id) } })
  return [...out.values()]
}

export type OfficeCore = ReturnType<typeof createOffice>

/** Builds the use cases around shared repositories and the event bus. */
export function createOffice(d: OfficeDeps) {
  let sessions: ManagedSessionService | undefined
  const activity = new ActivityService({
    ...d,
    policy: d.policy ?? DEFAULT_SWEEP_POLICY,
    owned: (id) => sessions?.owns(id) ?? false,
  })
  const inbox = new InboxService(d)
  const capabilities = new CapabilityService({ ...d, repo: d.capabilities })
  const settings = new SettingsService({ repo: d.settingsRepo, loginItem: d.loginItem })
  const runtimes = new Map(d.runtimes ?? [])
  if (d.runner && !runtimes.has('claude-code')) runtimes.set('claude-code', d.runner)
  const projects: Projects | undefined = d.vault
    ? createProjects({
        vault: d.vault,
        agents: d.agents,
        bus: d.bus,
        clock: d.clock,
        log: d.log ?? SILENT,
        ...(d.repoIdentity ? { repoIdentity: d.repoIdentity } : {}),
        ...(d.transcripts ? { transcripts: d.transcripts } : {}),
        ...(d.history ? { history: d.history } : {}),
        ...(d.searchIndex ? { searchIndex: d.searchIndex } : {}),
        ...(d.random ? { random: d.random } : {}),
        enabledProviders: async () => enabledProviders(await settings.get()),
        sessions: () => sessions,
        onRetrieval: (provider) => capabilities.declare(provider, [CONTEXT_HUB]),
        scheduler: d.scheduler,
        ...(d.ruleSources ? { ruleSources: d.ruleSources } : {}),
        ...(d.gateRunner ? { gateRunner: d.gateRunner } : {}),
        ...(d.repoFiles ? { repoFiles: d.repoFiles } : {}),
        ...(d.platform?.platform ? { platform: d.platform.platform } : {}),
        enforcementOf: (p: ProviderId) => {
          const r = runtimes.get(p)
          return r?.enforcement ?? r?.decl?.enforcement
        },
      })
    : undefined
  sessions = runtimes.size
    ? new ManagedSessionService({
        ...d,
        runtimes,
        activity,
        inbox,
        settings,
        ...(d.rateLimitPerSec ? { rateLimitPerSec: d.rateLimitPerSec } : {}),
        ...(projects
          ? {
              projectExists: (id: string) => projects.store.projects.has(id),
              mcp: projects.mcp,
              observation: projects.observation,
              harness: projects.policy,
              ...(d.mcpLaunch ? { mcpLaunch: d.mcpLaunch } : {}),
            }
          : {}),
      })
    : undefined
  const providerHooks = d.providerHookTargets
    ? new ProviderHookService({ targets: d.providerHookTargets, log: d.log ?? SILENT })
    : undefined
  const live = sessions
  const providers = new ProviderService({
    bindings: bindingsOf(d, runtimes, providerHooks),
    settings,
    agents: d.agents,
    clock: d.clock,
    scheduler: d.scheduler,
    log: d.log ?? SILENT,
    ...(d.onProvidersChange ? { onChange: d.onProvidersChange } : {}),
    ...(live ? { liveModels: (p: ProviderId) => live.knownModels(p) } : {}),
  })
  const query = new OfficeQueryService({
    ...d,
    capabilities,
    ...(sessions ? { permissions: sessions } : {}),
  })
  return {
    activity,
    /** Implements ReportCapabilities; also the catalog behind snapshots. */
    capabilities,
    inbox,
    /** Same service, narrowed to the human-facing port. */
    chat: inbox,
    query,
    attention: new AttentionService({ ...d, query }),
    hooks: new HookService({ claude: d.claudeSettings, runner: d.hookRunner }),
    settings,
    /** Managed sessions of every provider (only with a runner or runtimes). */
    sessions: sessions as ManagedSessionService | undefined,
    /** Provider registry: status, enable/disable, models (always present). */
    providers: providers as ProviderCatalog,
    /** Observation hooks of hook-based providers (only with `providerHookTargets`). */
    providerHooks: providerHooks as ProviderHooks | undefined,
    /** Messages with context/tool hints: managed → runner, others → inbox. */
    compose: new ComposeService({
      chat: inbox,
      messages: d.messages,
      bus: d.bus,
      ...(sessions ? { sessions } : {}),
    }),
    updates: new UpdateService({ ...d, enabled: d.autoUpdate ?? true }),
    /**
     * Projects, sessions, memory, context, handoffs, search and MCP access (only with `vault`).
     * Call `load()` once at startup before serving IPC or MCP.
     */
    projects,
  }
}
