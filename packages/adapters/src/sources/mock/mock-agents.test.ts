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
  const mock = new MockAgents({ activity: office.activity, inbox: office.inbox, query: office.query, events: bus, scheduler, random, replyDelayMs: 2000 })
  return { office, mock, scheduler }
}

describe('MockAgents', () => {
  it('seeds interactive agents across three providers, with a subagent', () => {
    const { office, mock } = setup()
    mock.seed()
    const agents = office.query.agents()
    expect(new Set(agents.map((a) => a.provider))).toEqual(new Set(['claude-code', 'openai-agents', 'langgraph']))
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

  it('start schedules ticks', () => {
    const { mock, scheduler } = setup()
    mock.seed()
    mock.start(1500)
    for (let i = 0; i < 20; i++) scheduler.runAll()
    mock.stop()
    expect(scheduler.jobs.every((j) => j.cancelled)).toBe(true)
  })
})
