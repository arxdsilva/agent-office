import { describe, expect, it } from 'vitest'
import { builtins, cap } from './__fixtures__/capabilities.ts'
import {
  CONTEXT_HUB_ID,
  CONTEXT_IDLE,
  STATION_COUNT,
  assignSlots,
  assignStations,
  contextHubActive,
  contextPulse,
} from './stations.ts'

const ids = (n: number, prefix = 'mcp:s') =>
  Array.from({ length: n }, (_, i) => cap(`${prefix}${i}`))

describe('assignStations', () => {
  it('pins fs, shell, web and subagents to stations 0–3 and fills 4–7 in first-seen order', () => {
    const s = assignStations([cap('mcp:github'), ...builtins().reverse(), cap('api:crm')])
    expect(Object.fromEntries(s.slot)).toEqual({
      fs: 0,
      shell: 1,
      web: 2,
      subagents: 3,
      'mcp:github': 4,
      'api:crm': 5,
    })
    expect(s.occupant).toEqual([
      'fs',
      'shell',
      'web',
      'subagents',
      'mcp:github',
      'api:crm',
      undefined,
      undefined,
    ])
    expect(s.overflow).toEqual([])
  })

  it('ignores skills and rules', () => {
    const s = assignStations([cap('fs'), cap('skill:run-office'), cap('rule:project:CLAUDE.md')])
    expect([...s.slot.keys()]).toEqual(['fs'])
  })

  it('keeps stations stable while capabilities come and go', () => {
    const first = assignStations([...builtins(), cap('mcp:a'), cap('mcp:b'), cap('mcp:c')])
    // mcp:a disappears; a newcomer takes its free station, nobody else moves.
    const second = assignStations(
      [...builtins(), cap('mcp:b'), cap('mcp:c'), cap('mcp:new')],
      first,
    )
    expect(second.slot.get('mcp:b')).toBe(first.slot.get('mcp:b'))
    expect(second.slot.get('mcp:c')).toBe(first.slot.get('mcp:c'))
    expect(second.slot.get('mcp:new')).toBe(4)
    // Input order does not move existing stations either.
    const shuffled = assignStations(
      [cap('mcp:c'), cap('mcp:new'), ...builtins().reverse(), cap('mcp:b')],
      second,
    )
    expect([...shuffled.slot].sort()).toEqual([...second.slot].sort())
  })

  it('turns station 7 into a "+N more" aggregate beyond eight adapters', () => {
    const s = assignStations([...builtins(), ...ids(6)])
    expect(s.occupant.slice(0, 7)).toEqual([
      'fs',
      'shell',
      'web',
      'subagents',
      'mcp:s0',
      'mcp:s1',
      'mcp:s2',
    ])
    expect(s.occupant[STATION_COUNT - 1]).toBeUndefined()
    expect(s.overflow).toEqual(['mcp:s3', 'mcp:s4', 'mcp:s5'])
    for (const id of s.overflow) expect(s.slot.get(id)).toBe(7)
    // Back to eight: the aggregate dissolves and station 7 is a normal station again.
    const fewer = assignStations([...builtins(), ...ids(4)], s)
    expect(fewer.overflow).toEqual([])
    expect(fewer.occupant[7]).toBe('mcp:s3')
  })

  it('lets other providers use unpinned stations 4–7 first, then the free pinned ones', () => {
    const s = assignStations(ids(6, 'api:x'))
    expect(s.occupant).toEqual([
      undefined,
      undefined,
      'api:x5',
      'api:x4',
      'api:x0',
      'api:x1',
      'api:x2',
      'api:x3',
    ])
    // A pinned adapter whose station is taken gets the next free one; a free pinned one is used.
    const later = assignStations([...ids(6, 'api:x'), cap('web'), cap('fs')], s)
    expect(later.slot.get('web')).toBe(1)
    expect(later.slot.get('fs')).toBe(0)
  })
})

describe('assignSlots', () => {
  it('collapses the last slot into an aggregate only when needed', () => {
    const s = assignSlots(['a', 'b', 'c'], undefined, 2)
    expect(s.occupant).toEqual(['a', undefined])
    expect(s.overflow).toEqual(['b', 'c'])
    expect(assignSlots(['a'], undefined, 2).overflow).toEqual([])
    expect(assignSlots([], undefined, 0).overflow).toEqual([])
  })
})

describe('Context Hub pulse (real retrievals only)', () => {
  const slot = (id: string, glow: number) => ({ id, glow })
  const surfaces = (...stations: ({ id: string; glow: number } | undefined)[]) => ({ stations })

  it('is active only while the project MCP station glows, in any provider', () => {
    expect(contextHubActive([])).toBe(false)
    expect(contextHubActive([surfaces(slot(CONTEXT_HUB_ID, 0))])).toBe(false)
    expect(contextHubActive([undefined, surfaces(undefined, slot(CONTEXT_HUB_ID, 1))])).toBe(true)
    // Another adapter glowing (a shell call, another MCP server) never moves the hub.
    expect(contextHubActive([surfaces(slot('shell', 1), slot('mcp:github', 1))])).toBe(false)
  })

  it('pulses between a dim idle glow and full strength, and never goes dark', () => {
    expect(contextPulse(0, false)).toBe(CONTEXT_IDLE)
    expect(contextPulse(1.234, false)).toBe(CONTEXT_IDLE)
    const levels = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map((t) => contextPulse(t, true))
    expect(Math.max(...levels)).toBeLessThanOrEqual(1)
    expect(Math.min(...levels)).toBeGreaterThan(CONTEXT_IDLE)
    expect(new Set(levels).size).toBeGreaterThan(3)
  })
})
