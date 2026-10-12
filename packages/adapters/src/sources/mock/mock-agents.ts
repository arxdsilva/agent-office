import type {
  AgentInbox,
  EventSubscriber,
  OfficeQuery,
  ReportActivity,
  ReportCapabilities,
  Scheduler,
} from '@agent-office/core'
import {
  AGENT_STATUSES,
  type AgentEvent,
  type AgentStatus,
  type CapabilityDecl,
} from '@agent-office/shared'

const SEED: AgentEvent[] = [
  {
    agentId: 'mock:ada',
    name: 'Ada',
    provider: 'claude-code',
    topic: 'Refactor auth',
    model: 'claude-opus-5-5',
  },
  {
    agentId: 'mock:linus',
    name: 'Linus',
    provider: 'claude-code',
    topic: 'Refactor auth',
    model: 'claude-sonnet-5-5',
  },
  {
    agentId: 'mock:grace',
    name: 'Grace',
    provider: 'claude-code',
    topic: 'Landing page',
    model: 'claude-fable-5-1',
  },
  {
    agentId: 'mock:ken',
    name: 'Ken',
    provider: 'openai-agents',
    topic: 'Support triage',
    kind: 'triage',
  },
  {
    agentId: 'mock:barbara',
    name: 'Barbara',
    provider: 'openai-agents',
    topic: 'Support triage',
    kind: 'responder',
  },
  {
    agentId: 'mock:dennis',
    name: 'Dennis',
    provider: 'langgraph',
    topic: 'Data pipeline',
    kind: 'planner',
  },
  {
    agentId: 'mock:margaret',
    name: 'Margaret',
    provider: 'langgraph',
    topic: 'Data pipeline',
    kind: 'executor',
  },
  {
    agentId: 'mock:alan',
    name: 'Alan',
    provider: 'langgraph',
    topic: 'Eval reports',
    kind: 'critic',
  },
]
type Use = Pick<AgentEvent, 'tool' | 'target' | 'capability'> & { tool: string }

const adapter = (id: string, kind: CapabilityDecl['kind'], label: string): CapabilityDecl => ({
  id,
  category: 'adapter',
  kind,
  label,
})
const skill = (name: string, summary: string): CapabilityDecl => ({
  id: `skill:${name}`,
  category: 'skill',
  kind: 'skill',
  label: name,
  summary,
  scope: 'project',
})
const rule = (file: string, summary: string): CapabilityDecl => {
  const root = file === 'CLAUDE.md' || file === 'AGENTS.md'
  return {
    id: `rule:project:${file}`,
    category: 'rule',
    kind: root ? 'project-rules' : 'rule',
    label: root ? `${file} (agent-office)` : file,
    summary,
    scope: 'project',
  }
}

/** What each mock provider declares (docs/capabilities.md, plan §10.2/§10.B). Invented content. */
const DECLS: Record<string, CapabilityDecl[]> = {
  'claude-code': [
    adapter('fs', 'filesystem', 'Filesystem'),
    adapter('shell', 'shell', 'Shell'),
    adapter('web', 'web', 'Web'),
    adapter('subagents', 'subagents', 'Subagents'),
    adapter('mcp:claude_ai_Gmail', 'mcp', 'Gmail'),
    adapter('mcp:claude_ai_Google_Drive', 'mcp', 'Google Drive'),
    skill('run-office', 'Launch the app locally and verify a change with a screenshot.'),
    skill('scene-change', 'Change the 3D scene: rooms, behavior, characters, lighting.'),
    skill('asset-change', 'Change the Blender-built 3D assets and the graphics contract.'),
    skill('add-event-source', 'Add a new agent source or provider.'),
    rule('CLAUDE.md', 'Which rules and skills apply when.'),
    rule('AGENTS.md', 'The architecture, glossary and definition of done.'),
    rule('TESTING.md', 'Write a failing test first.'),
    rule('ARCHITECTURE.md', 'Dependencies point inward.'),
    rule('PRIVACY_SECURITY.md', 'Fail closed on auth, fail open in the hook.'),
    {
      id: 'memory:agent-office-project',
      category: 'rule',
      kind: 'memory',
      label: 'agent-office project',
    },
  ],
  'openai-agents': [
    adapter('web', 'web', 'Web'),
    adapter('api:code_interpreter', 'api', 'Code Interpreter'),
    adapter('api:vector_store', 'api', 'Vector Store'),
  ],
  langgraph: [
    adapter('mcp:postgres', 'database', 'Postgres'),
    adapter('web', 'web', 'Web'),
    adapter('api:chat', 'api', 'Chat'),
  ],
}

/** Tool calls that use the declared capabilities, so demos show links and visits. */
const USES: Record<string, Use[]> = {
  'claude-code': [
    { tool: 'Read', target: 'project:agent-office' },
    { tool: 'Skill', target: 'skill:run-office' },
    { tool: 'Bash', target: 'cmd:pnpm' },
    { tool: 'Read', target: 'rule:project:TESTING.md' },
    { tool: 'mcp__claude_ai_Gmail__search_threads' },
    { tool: 'Edit', target: 'project:agent-office' },
    { tool: 'WebFetch', target: 'host:github.com' },
    { tool: 'Read', target: 'rule:project:CLAUDE.md' },
    { tool: 'Skill', target: 'skill:scene-change' },
    { tool: 'Bash', target: 'cmd:git' },
    { tool: 'mcp__claude_ai_Google_Drive__search_files' },
    { tool: 'Read', target: 'rule:project:ARCHITECTURE.md' },
    { tool: 'Agent' },
    { tool: 'Read', target: 'memory:agent-office-project' },
    { tool: 'Grep', target: 'project:agent-office' },
    { tool: 'Skill', target: 'skill:asset-change' },
    { tool: 'Read', target: 'rule:project:AGENTS.md' },
    { tool: 'WebFetch', target: 'host:docs.example.com' },
    { tool: 'Skill', target: 'skill:add-event-source' },
    { tool: 'Read', target: 'rule:project:PRIVACY_SECURITY.md' },
  ],
  'openai-agents': [
    { tool: 'WebFetch', target: 'host:help.example.com' },
    { tool: 'code_interpreter', capability: 'api:code_interpreter' },
    { tool: 'file_search', capability: 'api:vector_store' },
  ],
  langgraph: [
    { tool: 'query', capability: 'mcp:postgres' },
    { tool: 'WebSearch' },
    { tool: 'post_message', capability: 'api:chat' },
  ],
}
const BUSY: AgentStatus[] = ['thinking', 'tool', 'tool', 'waiting', 'idle']

export interface MockAgentsOptions {
  activity: ReportActivity
  inbox: AgentInbox
  query: OfficeQuery
  /** When set, each mock provider declares its adapters, skills and rules on seed(). */
  capabilities?: ReportCapabilities
  events: EventSubscriber
  scheduler: Scheduler
  random?: () => number
  replyDelayMs?: number
}

/** Simulated agents for demos and UI work. They also answer messages sent to them. */
export class MockAgents {
  private random: () => number
  private stops: (() => void)[] = []
  private subSeq = 0
  private extra = 0
  private useSeq = new Map<string, number>()

  constructor(private opts: MockAgentsOptions) {
    this.random = opts.random ?? Math.random
  }

  seed(): void {
    for (const [provider, decls] of Object.entries(DECLS))
      this.opts.capabilities?.declare(provider, decls)
    for (const e of SEED) this.apply({ ...e, status: 'idle' })
    this.spawnSubagent()
  }

  /** Moves every live mock agent to a new random state. */
  tick(): void {
    for (const a of this.opts.query.agents()) {
      if (!a.id.startsWith('mock:') || a.status === 'done') continue
      const status = this.pick(BUSY)
      this.apply({
        agentId: a.id,
        status,
        ...(status === 'tool'
          ? { ...this.nextUse(a.provider), text: 'working on it' }
          : { text: '' }),
      })
    }
  }

  /** Finishes the current subagent and spawns a new one, to exercise despawn/spawn. */
  recycleSubagent(): void {
    for (const a of this.opts.query.agents()) {
      if (a.id.startsWith('mock:sub') && a.status !== 'done')
        this.apply({ agentId: a.id, status: 'done' })
    }
    this.spawnSubagent()
  }

  /** Adds `n` extra agents (perf testing). */
  spawn(n: number): void {
    for (let i = 0; i < n; i++) {
      const k = this.extra++
      this.apply({
        agentId: `mock:extra${k}`,
        name: `Bot ${k}`,
        provider: ['claude-code', 'openai-agents', 'langgraph'][k % 3]!,
        topic: `Load test ${k % 7}`,
        status: this.pick(AGENT_STATUSES.filter((s) => s !== 'done')),
      })
    }
  }

  start(tickMs = 1500): void {
    let ticks = 0
    this.stops.push(
      this.opts.events.subscribe((e) => e.type === 'inbox.queued' && this.onQueued(e.agentId)),
      this.opts.scheduler.every(tickMs, () => {
        this.tick()
        if (++ticks % 20 === 0) this.recycleSubagent()
      }),
    )
  }

  stop(): void {
    for (const s of this.stops.splice(0)) s()
  }

  /** Mock agents read their own inbox and answer after a short delay. */
  private onQueued(agentId: string): void {
    if (!agentId.startsWith('mock:')) return
    const claimed = this.opts.inbox.claim(agentId)
    this.stops.push(
      this.opts.scheduler.after(this.opts.replyDelayMs ?? 2000, () => {
        for (const m of claimed)
          this.opts.inbox.reply(agentId, `(mock) got it: ${m.text}`, { inReplyTo: m.id })
      }),
    )
  }

  private spawnSubagent(): void {
    const n = this.subSeq++
    this.apply({
      agentId: `mock:sub${n}`,
      name: 'Explore',
      kind: 'Explore',
      parentId: 'mock:ada',
      provider: 'claude-code',
      topic: 'Refactor auth',
      status: 'thinking',
      text: 'Searching the codebase',
    })
  }

  private apply(e: AgentEvent): void {
    this.opts.activity.report([{ source: 'mock', ...e }])
    // Mock agents always "read" their inbox, so the UI shows them as reachable.
    this.opts.inbox.peek(e.agentId)
  }

  /** Rotates through the provider's tool calls so every capability gets used. */
  private nextUse(provider: string): Use {
    const uses = USES[provider] ?? USES['claude-code']!
    const n = this.useSeq.get(provider) ?? 0
    this.useSeq.set(provider, n + 1)
    return uses[n % uses.length]!
  }

  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.random() * xs.length) % xs.length]!
  }
}
