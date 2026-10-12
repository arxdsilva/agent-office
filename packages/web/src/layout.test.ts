import { byProviderAndTopic, type Agent, type Grouping } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { DESK_SPACING, layoutOffice, type LayoutState } from './layout.ts'

let seq = 0
const agent = (id: string, over: Partial<Agent> = {}): Agent => ({
  id,
  name: id,
  provider: 'claude-code',
  topic: 'T',
  status: 'idle',
  source: 'test',
  since: ++seq,
  lastSeen: seq,
  interactive: false,
  unread: 0,
  ...over,
})

const empty = (): LayoutState => new Map()

describe('layoutOffice', () => {
  it('returns no zones for no agents', () => {
    expect(layoutOffice([], byProviderAndTopic, empty()).zones).toEqual([])
  })

  it('makes one zone per provider (sorted) and one row per topic (sorted)', () => {
    const agents = [
      agent('a', { provider: 'langgraph', topic: 'Pipeline' }),
      agent('b', { provider: 'claude-code', topic: 'Zeta' }),
      agent('c', { provider: 'claude-code', topic: 'Alpha' }),
    ]
    const { zones, slots } = layoutOffice(agents, byProviderAndTopic, empty())
    expect(zones.map((z) => z.name)).toEqual(['claude-code', 'langgraph'])
    expect(zones[0]!.rows.map((r) => r.name)).toEqual(['Alpha', 'Zeta'])
    // zones sit side by side along x without overlapping
    expect(zones[0]!.x1).toBeLessThan(zones[1]!.x0)
    // rows of the same zone are at different depths
    expect(slots.get('b')!.z).not.toBe(slots.get('c')!.z)
  })

  it('seats a subagent right next to its parent', () => {
    const parent = agent('p')
    const other = agent('o')
    const child = agent('c', { parentId: 'p', provider: 'x', topic: 'y' })
    const { slots } = layoutOffice([parent, other, child], byProviderAndTopic, empty())
    expect(slots.get('c')!.z).toBe(slots.get('p')!.z)
    expect(Math.abs(slots.get('c')!.x - slots.get('p')!.x)).toBe(DESK_SPACING)
  })

  it('keeps existing desks when agents join, and reuses freed desks', () => {
    const a = agent('a')
    const b = agent('b')
    const first = layoutOffice([a, b], byProviderAndTopic, empty())
    const colB = first.state.get('b')!.col

    // A newcomer must not displace anyone.
    const c = agent('c')
    const second = layoutOffice([a, b, c], byProviderAndTopic, first.state)
    expect(second.state.get('b')!.col).toBe(colB)
    expect(second.state.get('c')!.col).toBe(2)

    // a leaves; the next newcomer takes its desk.
    const d = agent('d')
    const third = layoutOffice([b, c, d], byProviderAndTopic, second.state)
    expect(third.state.get('d')!.col).toBe(0)
    expect(third.state.has('a')).toBe(false)
  })

  it('moves an agent to a new row when its topic changes', () => {
    const a = agent('a', { topic: 'Old' })
    const first = layoutOffice([a], byProviderAndTopic, empty())
    const moved = layoutOffice([{ ...a, topic: 'New' }], byProviderAndTopic, first.state)
    expect(moved.state.get('a')!.row).toBe('New')
  })

  it('respects a custom grouping strategy', () => {
    const byStatus: Grouping = (a) => ({ zone: a.status, row: 'all' })
    const { zones } = layoutOffice(
      [agent('a', { status: 'tool' }), agent('b', { status: 'idle' })],
      byStatus,
      empty(),
    )
    expect(zones.map((z) => z.name)).toEqual(['idle', 'tool'])
  })

  it('grows a zone with its widest row', () => {
    const many = Array.from({ length: 6 }, (_, i) => agent(`m${i}`))
    const small = layoutOffice([agent('s')], byProviderAndTopic, empty()).zones[0]!
    const big = layoutOffice(many, byProviderAndTopic, empty()).zones[0]!
    expect(big.x1 - big.x0).toBeGreaterThan(small.x1 - small.x0)
  })

  it('places subagents on the far side when the right desk is taken', () => {
    const p = agent('p')
    const r = agent('r')
    const first = layoutOffice([p, r], byProviderAndTopic, empty())
    const c = agent('c', { parentId: 'p' })
    const second = layoutOffice([p, r, c], byProviderAndTopic, first.state)
    // p is col 0 and r col 1 → nearest free to p is col 2 (no negative columns)
    expect(second.state.get('c')!.col).toBe(2)
  })
})
