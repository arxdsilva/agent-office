import { AGENT_STATUSES, type AgentEvent, type AgentStatus } from '@agent-office/shared'
import type { MessageStore } from '../messages.ts'
import type { AgentStore } from '../store.ts'

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

export interface MockSourceOptions {
  store: AgentStore
  messages: MessageStore
  random?: () => number
  replyDelayMs?: number
}

/** Simulated agents for demos and UI work. They also answer messages sent to them. */
export class MockSource {
  private random: () => number
  private timer: NodeJS.Timeout | undefined
  private subSeq = 0
  private extra = 0
  private replyTimers = new Set<NodeJS.Timeout>()

  constructor(private opts: MockSourceOptions) {
    this.random = opts.random ?? Math.random
  }

  seed(): void {
    for (const e of SEED) this.apply({ ...e, status: 'idle' })
    this.spawnSubagent()
  }

  /** Moves every live mock agent to a new random state. */
  tick(): void {
    for (const a of this.opts.store.list()) {
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
    for (const a of this.opts.store.list()) {
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
    this.opts.messages.on('queued', this.onQueued)
    let ticks = 0
    this.timer = setInterval(() => {
      this.tick()
      if (++ticks % 20 === 0) this.recycleSubagent()
    }, tickMs)
  }

  stop(): void {
    clearInterval(this.timer)
    this.opts.messages.off('queued', this.onQueued)
    for (const t of this.replyTimers) clearTimeout(t)
    this.replyTimers.clear()
  }

  private onQueued = (agentId: string) => {
    if (!agentId.startsWith('mock:')) return
    const claimed = this.opts.messages.claim(agentId)
    this.opts.store.markInteractive(agentId)
    const t = setTimeout(() => {
      this.replyTimers.delete(t)
      for (const m of claimed) this.opts.messages.reply(agentId, `(mock) got it: ${m.text}`, m.id)
    }, this.opts.replyDelayMs ?? 2000)
    this.replyTimers.add(t)
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
    this.opts.store.apply({ source: 'mock', ...e })
    this.opts.store.markInteractive(e.agentId)
  }

  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.random() * xs.length) % xs.length]!
  }
}
