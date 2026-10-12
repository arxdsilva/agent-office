import { ManualScheduler } from '@agent-office/core/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { makeOffice } from '../../../test/support.ts'
import { MockAgents } from './mock-agents.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function setup() {
  const { office, bus, scheduler: timers } = makeOffice()
  cleanups.push(() => timers.dispose())
  let r = 0
  const random = () => ((r = (r + 0.37) % 1), r)
  const scheduler = new ManualScheduler()
  const mock = new MockAgents({
    activity: office.activity,
    inbox: office.inbox,
    query: office.query,
    capabilities: office.capabilities,
    events: bus,
    scheduler,
    random,
    replyDelayMs: 2000,
  })
  return { office, mock, scheduler }
}

describe('MockAgents', () => {
  it('seeds interactive agents across three providers, with a subagent', () => {
    const { office, mock } = setup()
    mock.seed()
    const agents = office.query.agents()
    expect(new Set(agents.map((a) => a.provider))).toEqual(
      new Set(['claude-code', 'openai-agents', 'langgraph']),
    )
    expect(agents.some((a) => a.parentId)).toBe(true)
    expect(agents.every((a) => a.interactive)).toBe(true)
  })

  it('tick gives every tool-status agent a tool', () => {
    const { office, mock } = setup()
    mock.seed()
    for (let i = 0; i < 5; i++) mock.tick()
    for (const a of office.query.agents()) if (a.status === 'tool') expect(a.tool).toBeTruthy()
  })

  it('answers messages sent to mock agents after the reply delay', () => {
    const { office, mock, scheduler } = setup()
    mock.seed()
    mock.start(60_000)
    office.chat.send('mock:ada', 'hello')
    expect(office.chat.history('mock:ada').map((m) => m.state)).toEqual(['delivered'])
    scheduler.fireTimers()
    mock.stop()
    expect(office.chat.history('mock:ada').map((m) => [m.from, m.state, m.text])).toEqual([
      ['user', 'replied', 'hello'],
      ['agent', 'replied', '(mock) got it: hello'],
    ])
  })

  it('ignores messages for other agents and stops listening on stop()', () => {
    const { office, mock } = setup()
    mock.seed()
    mock.start(60_000)
    office.activity.report([{ agentId: 'real' }])
    office.chat.send('real', 'hi')
    mock.stop()
    office.chat.send('mock:ada', 'after stop')
    expect(office.query.agent('real')?.unread).toBe(1)
    expect(office.query.agent('mock:ada')?.unread).toBe(1)
  })

  it('spawn adds extra agents; recycleSubagent finishes the current subagent and spawns another', () => {
    const { office, mock } = setup()
    mock.spawn(25)
    expect(office.query.agents()).toHaveLength(25)
    mock.seed()
    const before = office.query.agents().find((a) => a.parentId)!.id
    mock.recycleSubagent()
    expect(office.query.agent(before)?.status).toBe('done')
    expect(office.query.agents().filter((a) => a.parentId && a.status !== 'done')).toHaveLength(1)
  })

  it('declares adapters, skills, rules and memory per provider (docs/capabilities.md)', () => {
    const { office, mock } = setup()
    mock.seed()
    const caps = office.query.snapshot().capabilities ?? []
    const ids = (p: string) => caps.filter((c) => c.provider === p).map((c) => c.id)
    expect(ids('claude-code')).toEqual(
      expect.arrayContaining([
        'fs',
        'shell',
        'web',
        'subagents',
        'mcp:claude_ai_Gmail',
        'mcp:claude_ai_Google_Drive',
        'skill:run-office',
        'skill:scene-change',
        'skill:asset-change',
        'skill:add-event-source',
        'rule:project:CLAUDE.md',
        'rule:project:AGENTS.md',
        'rule:project:TESTING.md',
        'rule:project:ARCHITECTURE.md',
        'rule:project:PRIVACY_SECURITY.md',
        'memory:agent-office-project',
      ]),
    )
    expect(ids('openai-agents')).toEqual(
      expect.arrayContaining(['web', 'api:code_interpreter', 'api:vector_store']),
    )
    expect(ids('langgraph')).toEqual(expect.arrayContaining(['mcp:postgres', 'web', 'api:chat']))
    expect(caps.every((c) => c.declared)).toBe(true)
    expect(caps.find((c) => c.kind === 'memory')).not.toHaveProperty('summary')
  })

  it('ticks use the declared capabilities: skills, rules, MCP, web hosts and shell commands', () => {
    const { office, mock } = setup()
    mock.seed()
    for (let i = 0; i < 200; i++) mock.tick()
    const used = (office.query.snapshot().capabilities ?? []).filter((c) => c.calls > 0)
    const cc = used.filter((c) => c.provider === 'claude-code').map((c) => c.category)
    expect(new Set(cc)).toEqual(new Set(['adapter', 'skill', 'rule']))
    const byId = (p: string, id: string) => used.find((c) => c.provider === p && c.id === id)
    expect(byId('claude-code', 'web')?.sees.some((s) => s.startsWith('host: '))).toBe(true)
    expect(byId('claude-code', 'shell')?.sees.some((s) => s.startsWith('cmd: '))).toBe(true)
    expect(used.some((c) => c.id.startsWith('mcp:') && c.provider === 'claude-code')).toBe(true)
    expect(byId('langgraph', 'mcp:postgres')?.calls).toBeGreaterThan(0)
    // Nothing observed outside what was declared.
    expect(used.every((c) => c.declared)).toBe(true)
  })

  it('start schedules ticks', () => {
    const { mock, scheduler } = setup()
    mock.seed()
    mock.start(1500)
    for (let i = 0; i < 20; i++) scheduler.runAll()
    mock.stop()
    expect(scheduler.jobs.every((j) => j.cancelled)).toBe(true)
  })
})
