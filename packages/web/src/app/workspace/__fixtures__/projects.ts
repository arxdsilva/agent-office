// Invented project data shaped like the IPC views.
import type {
  ActivityView,
  ContextBundleView,
  GlobalOverview,
  HandoffView,
  MemoryView,
  ProjectDashboard,
  ProjectSummary,
  ProviderStatus,
  SessionSummary,
} from '@agent-office/shared'

export const NOW = 10_000_000
export const P1 = 'prj_aaaaaaaaaa'
export const P2 = 'prj_bbbbbbbbbb'

export const project = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: P1,
  name: 'Alpha',
  color: '#3366ff',
  repos: [{ id: 'rp_aaaaaaaaaa', label: 'alpha-repo', isWorktree: false }],
  activeAgents: 2,
  sessions: 3,
  approvedMemories: 4,
  pendingMemories: 1,
  openTasks: 2,
  lastActivityAt: NOW - 60_000,
  archived: false,
  ...over,
})

export const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 'ses_aaaaaaaaaa',
  provider: 'claude-code',
  origin: 'managed',
  projectId: P1,
  title: 'Fix the login bug',
  state: 'inactive',
  startedAt: NOW - 3_600_000,
  lastSeenAt: NOW - 120_000,
  hasTranscript: true,
  ...over,
})

export const memory = (over: Partial<MemoryView> = {}): MemoryView => ({
  id: 'mem_aaaaaaaaaa',
  version: 1,
  projectId: P1,
  scope: 'project',
  kind: 'decision',
  title: 'Use zod everywhere',
  body: 'Validate every boundary with zod.',
  state: 'approved',
  provenance: { origin: 'user', createdAt: NOW - 100_000, reviewedAt: NOW - 50_000 },
  ...over,
})

export const activity = (over: Partial<ActivityView> = {}): ActivityView => ({
  id: 'act1',
  projectId: P1,
  ts: NOW - 30_000,
  kind: 'session.started',
  actor: 'Claude Code',
  text: 'Started a session',
  ...over,
})

export const bundle = (over: Partial<ContextBundleView> = {}): ContextBundleView => ({
  projectId: P1,
  items: [
    {
      ref: { kind: 'memory', id: 'mem_aaaaaaaaaa' },
      kind: 'decision',
      title: 'Use zod everywhere',
      excerpt: 'Validate every boundary',
      score: 0.9,
      reasons: ['approved decision'],
      included: true,
    },
    {
      ref: { kind: 'memory', id: 'mem_bbbbbbbbbb' },
      kind: 'note',
      title: 'Old note',
      excerpt: 'Something',
      score: 0.2,
      reasons: ['recent'],
      included: true,
    },
    {
      ref: { kind: 'summary', id: 'sum_1' },
      kind: 'summary',
      title: 'Last session',
      excerpt: 'We fixed it',
      score: 0.5,
      reasons: ['same project'],
      included: true,
    },
  ],
  usedChars: 400,
  budgetChars: 8000,
  estimatedTokens: 100,
  ...over,
})

export const handoff = (over: Partial<HandoffView> = {}): HandoffView => ({
  id: 'hof_aaaaaaaaaa',
  projectId: P1,
  from: { sessionId: 'ses_aaaaaaaaaa', provider: 'claude-code', title: 'Fix the login bug' },
  toProvider: 'codex',
  objective: 'Finish the tests',
  note: '',
  bundle: bundle(),
  state: 'draft',
  ...over,
})

export const dashboard = (over: Partial<ProjectDashboard> = {}): ProjectDashboard => ({
  project: {
    ...project(),
    policy: { providers: {}, scopes: [], sessionExcerpts: false },
    createdAt: 1,
  },
  active: [
    {
      agentId: 'cc:1',
      name: 'Ada',
      provider: 'claude-code',
      status: 'waiting',
      activity: 'desk-idle',
    },
    { agentId: 'cc:2', name: 'Bo', provider: 'claude-code', status: 'thinking' },
  ],
  activity: [
    activity(),
    activity({ id: 'act2', kind: 'memory.proposed', text: 'Proposed memory', ts: NOW - 20_000 }),
    activity({ id: 'act3', kind: 'agent.error', text: 'An agent failed', ts: NOW - 10_000 }),
    activity({ id: 'act4', kind: 'handoff.prepared', text: 'Prepared a handoff', ts: NOW - 5_000 }),
  ],
  completed: [
    { taskId: 'tsk_aaaaaaaaaa', title: 'Ship login', evidence: 'agent-reported', at: NOW - 1000 },
    { taskId: 'tsk_bbbbbbbbbb', title: 'Fix CI', evidence: 'committed', at: NOW - 2000 },
  ],
  tasks: [
    {
      id: 'tsk_cccccccccc',
      projectId: P1,
      title: 'Write docs',
      state: 'open',
      source: 'user',
      sessionIds: [],
    },
    {
      id: 'tsk_dddddddddd',
      projectId: P1,
      title: 'Old',
      state: 'done',
      source: 'user',
      sessionIds: [],
    },
  ],
  knowledge: { approved: 4, pending: 1, decisions: [memory()] },
  sessions: [session()],
  ...over,
})

export const overview = (over: Partial<GlobalOverview> = {}): GlobalOverview => ({
  projects: [
    project(),
    project({ id: P2, name: 'Beta', activeAgents: 0, openTasks: 0, pendingMemories: 0 }),
  ],
  waiting: [{ agentId: 'cc:1', name: 'Ada', provider: 'claude-code', projectId: P1 }],
  recentCompletions: [activity({ id: 'c1', kind: 'task.completed', text: 'Finished login' })],
  recentDecisions: [memory()],
  pendingApprovals: 3,
  unfinishedHandoffs: [handoff()],
  unassignedSessions: 2,
  vault: 'encrypted',
  ...over,
})

export const provider = (over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id: 'claude-code',
  label: 'Claude Code',
  state: 'connected',
  enabled: true,
  managedCaps: ['launch', 'send-message'],
  observedCaps: [],
  integration: {},
  activeSessions: 1,
  ...over,
})
