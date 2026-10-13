import type { Agent } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { rememberFinished } from './finished.ts'
import type { FinishedStore } from './hierarchy-types.ts'

const ag = (over: Partial<Agent> & { id: string }): Agent => ({
  name: over.id,
  provider: 'claude-code',
  topic: 't',
  status: 'idle',
  source: 's',
  since: 0,
  lastSeen: 1000,
  interactive: false,
  unread: 0,
  ...over,
})
const empty: FinishedStore = new Map()
const MIN = 60_000

describe('rememberFinished', () => {
  it('stores an ended or done agent that vanished, keyed by endedAt ?? lastSeen', () => {
    const a = ag({ id: 'a', parentId: 'p', ended: 'completed', endedAt: 5000 })
    const b = ag({ id: 'b', parentId: 'p', status: 'done', lastSeen: 7000 })
    const s = rememberFinished(empty, [a, b, ag({ id: 'p' })], [ag({ id: 'p' })], 10_000)
    expect(s.get('a')).toEqual({ agent: a, at: 5000 })
    expect(s.get('b')).toEqual({ agent: b, at: 7000 })
  })

  it('ignores active agents that vanished and finished agents still present', () => {
    const a = ag({ id: 'a' })
    const d = ag({ id: 'd', status: 'done' })
    expect(rememberFinished(empty, [a, d], [d], 2000)).toBe(empty)
  })

  it('removes ids that are live again', () => {
    const a = ag({ id: 'a', ended: 'failed', endedAt: 1000 })
    const s1 = rememberFinished(empty, [a], [], 2000)
    const s2 = rememberFinished(s1, [], [ag({ id: 'a' })], 3000)
    expect(s2.size).toBe(0)
    expect(s1.size).toBe(1)
  })

  it('returns the same instance when nothing changed and never mutates the input', () => {
    const a = ag({ id: 'a', ended: 'failed', endedAt: 1000 })
    const s1 = rememberFinished(empty, [a], [], 2000)
    expect(rememberFinished(s1, [a], [], 3000)).toBe(s1)
    expect(rememberFinished(s1, [], [], 3000)).toBe(s1)
    expect(empty.size).toBe(0)
  })

  it('drops entries older than 30 minutes', () => {
    const a = ag({ id: 'a', ended: 'failed', endedAt: 0 })
    const s1 = rememberFinished(empty, [a], [], 10 * MIN)
    expect(s1.size).toBe(1)
    expect(rememberFinished(s1, [], [], 30 * MIN).size).toBe(1)
    expect(rememberFinished(s1, [], [], 30 * MIN + 1).size).toBe(0)
  })

  it('keeps the newest 5 per parent (roots share one key)', () => {
    const kids = Array.from({ length: 8 }, (_, i) =>
      ag({ id: `k${i}`, parentId: 'p', ended: 'completed', endedAt: 1000 + i }),
    )
    const roots = Array.from({ length: 7 }, (_, i) =>
      ag({ id: `r${i}`, ended: 'completed', endedAt: 2000 + i }),
    )
    const s = rememberFinished(empty, [...kids, ...roots], [], 3000)
    expect([...s.keys()].filter((k) => k.startsWith('k')).sort()).toEqual([
      'k3',
      'k4',
      'k5',
      'k6',
      'k7',
    ])
    expect([...s.keys()].filter((k) => k.startsWith('r')).length).toBe(5)
  })

  it('caps the total at 50, newest kept', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      ag({ id: `x${i}`, parentId: `p${i}`, ended: 'completed', endedAt: 1000 + i }),
    )
    const s = rememberFinished(empty, many, [], 2000)
    expect(s.size).toBe(50)
    expect(s.has('x59')).toBe(true)
    expect(s.has('x9')).toBe(false)
    expect(s.has('x10')).toBe(true)
  })
})
