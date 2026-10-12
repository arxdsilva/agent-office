import { describe, expect, it } from 'vitest'
import { byProviderAndTopic, groupAgents } from './grouping.ts'
import type { Agent } from './index.ts'

const agent = (over: Partial<Agent>): Agent => ({
  id: 'a',
  name: 'a',
  provider: 'claude-code',
  topic: 'untitled',
  status: 'idle',
  source: 'http',
  since: 1,
  lastSeen: 1,
  interactive: false,
  unread: 0,
  ...over,
})

describe('byProviderAndTopic', () => {
  it('maps provider to zone and topic to row', () => {
    const a = agent({ provider: 'langgraph', topic: 'Data pipeline' })
    expect(byProviderAndTopic(a, () => undefined)).toEqual({
      zone: 'langgraph',
      row: 'Data pipeline',
    })
  })

  it("puts subagents in their parent's zone and row", () => {
    const parent = agent({ id: 'p', provider: 'claude-code', topic: 'Refactor auth' })
    const child = agent({ id: 'c', parentId: 'p', provider: 'other', topic: 'sub topic' })
    const lookup = (id: string) => (id === 'p' ? parent : undefined)
    expect(byProviderAndTopic(child, lookup)).toEqual({ zone: 'claude-code', row: 'Refactor auth' })
  })

  it('falls back to its own fields when the parent is unknown', () => {
    const orphan = agent({ parentId: 'gone', provider: 'x', topic: 'y' })
    expect(byProviderAndTopic(orphan, () => undefined)).toEqual({ zone: 'x', row: 'y' })
  })

  it('follows nested subagents up to the root', () => {
    const root = agent({ id: 'r', provider: 'p', topic: 't' })
    const mid = agent({ id: 'm', parentId: 'r' })
    const leaf = agent({ id: 'l', parentId: 'm' })
    const all = new Map([root, mid, leaf].map((a) => [a.id, a]))
    expect(byProviderAndTopic(leaf, (id) => all.get(id))).toEqual({ zone: 'p', row: 't' })
  })
})

describe('groupAgents', () => {
  it('builds sorted zones → rows → agents', () => {
    const agents = [
      agent({ id: '1', provider: 'b', topic: 'y' }),
      agent({ id: '2', provider: 'a', topic: 'z' }),
      agent({ id: '3', provider: 'b', topic: 'x' }),
    ]
    const zones = groupAgents(agents, byProviderAndTopic)
    expect(zones.map((z) => z.name)).toEqual(['a', 'b'])
    expect(zones[1]!.rows.map((r) => r.name)).toEqual(['x', 'y'])
    expect(zones[1]!.rows[0]!.agents.map((a) => a.id)).toEqual(['3'])
  })
})
