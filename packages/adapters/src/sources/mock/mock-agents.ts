import type { AgentInbox, EventSubscriber, OfficeQuery, ReportActivity, Scheduler } from '@agent-office/core'
import { AGENT_STATUSES, type AgentEvent, type AgentStatus } from '@agent-office/shared'

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
const TOOLS = ['Read', 'Edit', 'Bash', 'Grep', 'WebFetch']
const BUSY: AgentStatus[] = ['thinking', 'tool', 'tool', 'waiting', 'idle']

export interface MockAgentsOptions {
  activity: ReportActivity
  inbox: AgentInbox
  query: OfficeQuery
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

  constructor(private opts: MockAgentsOptions) {
    this.random = opts.random ?? Math.random
  }

  seed(): void {
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
        ...(status === 'tool' ? { tool: this.pick(TOOLS), text: 'working on it' } : { text: '' }),
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
        for (const m of claimed) this.opts.inbox.reply(agentId, `(mock) got it: ${m.text}`, { inReplyTo: m.id })
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

  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.random() * xs.length) % xs.length]!
  }
}
