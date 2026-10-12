import type { SweepPolicy } from '../domain/agent.ts'
import type {
  AgentRepository,
  AgentRunner,
  CapabilityRepository,
  ClaudeSettingsStore,
  Clock,
  EventPublisher,
  EventSubscriber,
  HookRunner,
  IdGenerator,
  LoginItem,
  MessageRepository,
  Notifier,
  PlatformInfo,
  Scheduler,
  SettingsRepository,
  TrayView,
  Updater,
  WindowState,
} from '../ports/driven.ts'
import { ActivityService } from './activity-service.ts'
import { AttentionService } from './attention-service.ts'
import { CapabilityService } from './capability-service.ts'
import { HookService } from './hook-service.ts'
import { InboxService } from './inbox-service.ts'
import { ComposeService, ManagedSessionService } from './managed-session-service.ts'
import { OfficeQueryService } from './office-query.ts'
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
}

export type OfficeCore = ReturnType<typeof createOffice>

/** Builds the use cases around shared repositories and the event bus. */
export function createOffice(d: OfficeDeps) {
  const activity = new ActivityService({ ...d, policy: d.policy ?? DEFAULT_SWEEP_POLICY })
  const inbox = new InboxService(d)
  const capabilities = new CapabilityService({ ...d, repo: d.capabilities })
  const settings = new SettingsService({ repo: d.settingsRepo, loginItem: d.loginItem })
  const sessions = d.runner
    ? new ManagedSessionService({
        ...d,
        runner: d.runner,
        activity,
        inbox,
        settings,
        ...(d.rateLimitPerSec ? { rateLimitPerSec: d.rateLimitPerSec } : {}),
      })
    : undefined
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
    /** Managed Claude Code sessions (only with a runner). */
    sessions: sessions as ManagedSessionService | undefined,
    /** Messages with context/tool hints: managed → runner, others → inbox. */
    compose: new ComposeService({
      chat: inbox,
      messages: d.messages,
      bus: d.bus,
      ...(sessions ? { sessions } : {}),
    }),
    updates: new UpdateService({ ...d, enabled: d.autoUpdate ?? true }),
  }
}
