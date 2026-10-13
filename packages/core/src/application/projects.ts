// Wires the projects layer (docs/projects.md) around one vault-backed store.
import type { ProviderId } from '@agent-office/shared'
import type {
  AgentRepository,
  Clock,
  EventPublisher,
  EventSubscriber,
  HistorySources,
  Logger,
  RecordLog,
  RepoIdentity,
  Scheduler,
  SearchIndex,
  SecureRandom,
  TranscriptReader,
} from '../ports/driven.ts'
import type { ManagedSessions } from '../ports/driving.ts'
import { ActivityLog } from './activity-log.ts'
import { ContextEngineService } from './context-engine.ts'
import { GlobalSearchService } from './global-search.ts'
import { HandoffManager } from './handoff-service.ts'
import { KnowledgeImportService } from './knowledge-import-service.ts'
import { McpMemoryAccessService } from './mcp-memory-access.ts'
import { ProjectMemoryService } from './memory-service.ts'
import { ProjectCatalogService } from './project-catalog.ts'
import { ProjectsStore } from './projects-store.ts'
import { SessionHistoryService } from './session-history-service.ts'
import { SessionVaultService } from './session-vault-service.ts'
import { TaskService } from './task-service.ts'
import { VaultRecorder } from './vault-recorder.ts'
import { WorkspaceQueryService } from './workspace-query.ts'

export interface ProjectsDeps {
  vault: RecordLog
  agents: AgentRepository
  bus: EventPublisher & EventSubscriber
  clock: Clock
  log: Logger
  repoIdentity?: RepoIdentity
  transcripts?: TranscriptReader
  /** Experimental: past provider sessions on disk (history import). */
  history?: HistorySources
  searchIndex?: SearchIndex
  random?: SecureRandom
  /** Providers enabled in Settings (a new project's default policy). */
  enabledProviders?: () => Promise<ProviderId[]>
  /** Managed sessions (handoff launches); resolved lazily because they are built later. */
  sessions?: () => ManagedSessions | undefined
  /** A real MCP retrieval happened (the composition root pulses the Context Hub). */
  onRetrieval?: (provider: string) => void
  /** Timers for the automatic knowledge import (every 10 minutes while on). */
  scheduler?: Scheduler
}

export type Projects = ReturnType<typeof createProjects>

export function createProjects(d: ProjectsDeps) {
  const store = new ProjectsStore({
    log: d.vault,
    clock: d.clock,
    logger: d.log,
    ...(d.random ? { random: d.random } : {}),
  })
  const activity = new ActivityLog({ store, clock: d.clock })
  // Built after the vault service; its hooks resolve it lazily.
  let knowledge: KnowledgeImportService | undefined
  const syncKnowledge = (r: { id: string }) =>
    void knowledge?.sync(r.id).catch(() => d.log.warn('knowledge import failed for a session'))
  const sessions = new SessionVaultService({
    store,
    activity,
    agents: d.agents,
    bus: d.bus,
    clock: d.clock,
    log: d.log,
    ...(d.repoIdentity ? { repoIdentity: d.repoIdentity } : {}),
    ...(d.transcripts ? { transcripts: d.transcripts } : {}),
    onEnded: syncKnowledge,
    onAssigned: syncKnowledge,
  })
  const catalog = new ProjectCatalogService({
    store,
    agents: d.agents,
    clock: d.clock,
    ...(d.repoIdentity ? { repoIdentity: d.repoIdentity } : {}),
    ...(d.enabledProviders ? { enabledProviders: d.enabledProviders } : {}),
    onReposChanged: () => sessions.reposChanged(),
  })
  const memory = new ProjectMemoryService({ store, activity, clock: d.clock })
  const context = new ContextEngineService({ store, activity, clock: d.clock })
  const handoffs = new HandoffManager({
    store,
    context,
    vault: sessions,
    activity,
    clock: d.clock,
    ...(d.sessions ? { sessions: d.sessions } : {}),
  })
  const mcp = new McpMemoryAccessService({
    store,
    memory,
    context,
    clock: d.clock,
    ...(d.random ? { random: d.random } : {}),
    ...(d.onRetrieval ? { onRetrieval: d.onRetrieval } : {}),
  })
  const history = new SessionHistoryService({
    store,
    vault: sessions,
    clock: d.clock,
    ...(d.history ? { history: d.history } : {}),
    ...(d.sessions ? { sessions: d.sessions } : {}),
  })
  knowledge = new KnowledgeImportService({
    store,
    history,
    activity,
    clock: d.clock,
    log: d.log,
    ...(d.transcripts ? { transcripts: d.transcripts } : {}),
    ...(d.scheduler ? { scheduler: d.scheduler } : {}),
  })
  const tasks = new TaskService({ store, activity, clock: d.clock })
  const workspace = new WorkspaceQueryService({ store, agents: d.agents, handoffs })
  const search = new GlobalSearchService({
    store,
    agents: d.agents,
    ...(d.searchIndex ? { index: d.searchIndex } : {}),
    ...(d.transcripts ? { transcripts: d.transcripts } : {}),
  })
  const recorder = new VaultRecorder({
    store,
    vault: sessions,
    agents: d.agents,
    bus: d.bus,
    clock: d.clock,
  })
  let loaded: Promise<void> | undefined

  return {
    store,
    catalog,
    /** Main only: a repository's directory for `NewSessionArgs.repo`. */
    repos: catalog,
    sessions,
    assignment: sessions,
    observation: sessions,
    recorder,
    memory,
    context,
    handoffs,
    tasks,
    /** Experimental: history import and native resume. */
    history,
    /** Automatic knowledge import (opt-in; docs/projects.md §8b). User actions only. */
    knowledge,
    workspace,
    search,
    /** Implements McpMemoryAccess (+ mint/bind/revoke for managed sessions). */
    mcp,
    /** Rebuilds state from the vault, refreshes workspace keys, backfills live agents. Idempotent. */
    load(): Promise<void> {
      loaded ??= (async () => {
        await store.load()
        search.rebuild()
        await sessions.refreshWorkspaceKeys()
        recorder.start()
      })()
      return loaded
    },
  }
}
