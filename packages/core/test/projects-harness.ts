// Builds the projects layer over fakes for use-case tests.
import type { Agent, ProviderId } from '@agent-office/shared'
import type { AgentState } from '../src/domain/agent.ts'
import { createProjects, type ProjectsDeps } from '../src/application/projects.ts'
import type { RepoIdentityInfo } from '../src/ports/driven.ts'
import type { ManagedSessions } from '../src/ports/driving.ts'
import {
  FakeAgentRepository,
  FakeClock,
  FakeEventBus,
  FakeHistorySource,
  FakeRecordLog,
  FakeRepoIdentity,
  FakeSearchIndex,
  FakeTranscriptReader,
  ManualScheduler,
  MemoryLogger,
  SeqRandom,
} from './fakes/index.ts'

export const identity = (over: Partial<RepoIdentityInfo> = {}): RepoIdentityInfo => ({
  commonDirKey: 'cd-shop',
  rootKey: 'rk-shop',
  rootCommit: 'c-shop',
  remotes: ['github.com/acme/shop'],
  name: 'shop',
  isWorktree: false,
  relPath: '',
  ...over,
})

export function harness(over: Partial<ProjectsDeps> = {}, log = new FakeRecordLog()) {
  const agents = new FakeAgentRepository()
  const bus = new FakeEventBus()
  const clock = new FakeClock()
  const logger = new MemoryLogger()
  const repos = new FakeRepoIdentity()
    .set('/work/shop', identity())
    .set('/work/shop/packages/web', identity({ relPath: 'packages/web' }))
    .set(
      '/work/blog',
      identity({
        commonDirKey: 'cd-blog',
        rootKey: 'rk-blog',
        rootCommit: 'c-blog',
        remotes: ['github.com/me/blog'],
        name: 'blog',
      }),
    )
  const transcripts = new FakeTranscriptReader()
  const history = new FakeHistorySource()
  const search = new FakeSearchIndex()
  const random = new SeqRandom()
  const scheduler = new ManualScheduler()
  const started: Parameters<ManagedSessions['start']>[0][] = []
  let nextAgent = 0
  const sessions = {
    start: async (o: Parameters<ManagedSessions['start']>[0]) => {
      started.push(o)
      const id = `${o.provider === 'codex' ? 'cx' : 'cc'}:launched-${++nextAgent}`
      putAgent({
        id,
        provider: o.provider ?? 'claude-code',
        name: o.name,
        managed: { chrome: false, pending: 0, phase: 'running' },
        ...(o.projectId ? { projectId: o.projectId } : {}),
      })
      return id
    },
  } as unknown as ManagedSessions
  const deps: ProjectsDeps = {
    vault: log,
    agents,
    bus,
    clock,
    log: logger,
    repoIdentity: repos,
    transcripts,
    history: { 'claude-code': history },
    searchIndex: search,
    random,
    enabledProviders: async () => ['claude-code', 'codex'] as ProviderId[],
    sessions: () => sessions,
    scheduler,
    ...over,
  }
  const projects = createProjects(deps)

  /** An agent changes the way ActivityService would publish it. */
  function putAgent(a: Partial<Agent> & { id: string }): AgentState {
    const prev = agents.get(a.id)
    const next: AgentState = {
      name: a.id,
      provider: 'claude-code',
      topic: 'untitled',
      status: 'thinking',
      source: 'claude-code',
      since: clock.now(),
      lastSeen: clock.now(),
      interactive: false,
      unread: 0,
      ...prev,
      ...a,
    }
    agents.put(next)
    bus.publish({ type: 'agent.upserted', agent: next })
    return next
  }
  function removeAgent(id: string) {
    agents.delete(id)
    bus.publish({ type: 'agent.removed', id })
  }
  return {
    projects,
    deps,
    agents,
    bus,
    clock,
    logger,
    repos,
    transcripts,
    history,
    search,
    random,
    scheduler,
    log,
    started,
    putAgent,
    removeAgent,
  }
}

export async function withProject(
  h: ReturnType<typeof harness>,
  name = 'Shop',
  folders = ['/work/shop'],
) {
  await h.projects.load()
  const p = await h.projects.catalog.create({ name, folders })
  return p.id
}
