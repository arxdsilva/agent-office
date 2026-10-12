import { describe, expect, it } from 'vitest'
import { cap } from './__fixtures__/capabilities.ts'
import { assignLibrary } from './library.ts'
import { assignStations } from './stations.ts'
import {
  capabilityBubbles,
  surfacesVM,
  boardVM,
  bookVM,
  capabilityBubble,
  capabilityPanelVM,
  notebookVM,
  overflowVM,
  stationVM,
  usedChips,
} from './capability-vm.ts'

const names = new Map([
  ['a', 'Ada'],
  ['l', 'Linus'],
])
const nameOf = (id: string) => names.get(id) ?? id

describe('stationVM (adapter station screen)', () => {
  it('shows the glyph, what it can see, its tools and who is calling', () => {
    const gmail = cap('mcp:claude_ai_Gmail', {
      label: 'Gmail',
      declared: false,
      sees: ['account: work'],
      tools: ['search_threads', 'get_thread', 'a', 'b', 'c', 'd', 'e', 'f'],
      calls: 47,
      lastUsedAt: 7_000,
      active: ['a', 'l'],
    })
    expect(stationVM(gmail, 10_000, nameOf)).toEqual({
      title: 'Gmail',
      glyph: 'plug',
      subtitle: 'MCP · observed',
      sees: ['account: work'],
      tools: 'search_threads, get_thread, a, b, c, d, +2',
      callers: '● 2 calling: Ada, Linus',
      last: 'last call 3s ago',
      calls: '47 calls',
      active: true,
      color: '#EC4899',
    })
  })

  it('is calm when unused, and pinned built-ins get their own glyphs', () => {
    const fs = cap('fs', { label: 'Filesystem', sees: ['project: workspace'] })
    expect(stationVM(fs, 0, nameOf)).toMatchObject({
      glyph: 'folder',
      subtitle: 'Built-in · declared',
      callers: '',
      last: 'not used yet',
      calls: '0 calls',
      active: false,
      tools: '',
    })
    expect(stationVM(cap('shell'), 0, nameOf).glyph).toBe('terminal')
    expect(stationVM(cap('web'), 0, nameOf).glyph).toBe('globe')
    expect(stationVM(cap('subagents'), 0, nameOf).glyph).toBe('people')
    expect(stationVM(cap('mcp:postgres_db'), 0, nameOf).glyph).toBe('database')
    expect(stationVM(cap('api:search'), 0, nameOf).glyph).toBe('braces')
    expect(stationVM(cap('fs', { calls: 1 }), 0, nameOf).calls).toBe('1 call')
  })

  it('caps "can see" at 5 lines', () => {
    const sees = ['1', '2', '3', '4', '5', '6', '7']
    expect(stationVM(cap('web', { sees }), 0, nameOf).sees).toEqual(['1', '2', '3', '4', '+3 more'])
  })
})

describe('overflowVM ("+N more" aggregate on the last slot)', () => {
  it('lists the rest and lights up when any of them is in use', () => {
    const rest = [cap('mcp:a', { label: 'Alpha' }), cap('mcp:b', { label: 'Beta', active: ['a'] })]
    expect(overflowVM(rest)).toEqual({
      title: '+2 more',
      glyph: 'plug',
      subtitle: 'More adapters',
      sees: ['Alpha', 'Beta'],
      tools: '',
      callers: '● 1 calling',
      last: '',
      calls: '0 calls',
      active: true,
      color: '#8a8f98',
    })
  })
})

describe('library surfaces', () => {
  it('bookVM: spine title, scope stripe, a stable color from the name', () => {
    const b = bookVM(cap('skill:run-office', { label: 'run-office', scope: 'project' }))
    expect(b).toMatchObject({ title: 'run-office', scope: 'project' })
    expect(b.color).toMatch(/^#[0-9a-f]{6}$/)
    expect(bookVM(cap('skill:run-office', { label: 'run-office' })).color).toBe(b.color)
    expect(bookVM(cap('skill:other', { label: 'other' })).color).not.toBe(b.color)
  })

  it('boardVM: title, scope badge, summary and recent use', () => {
    const rule = cap('rule:project:TESTING.md', {
      label: 'Testing rule',
      summary: 'TDD is mandatory for behavior changes.',
      calls: 3,
      lastUsedAt: 0,
    })
    expect(boardVM(rule, 12_000, nameOf)).toEqual({
      title: 'Testing rule',
      scope: 'PROJECT',
      summary: 'TDD is mandatory for behavior changes.',
      uses: 'read 3×',
      last: 'last read 12s ago',
    })
    expect(boardVM({ ...rule, active: ['a'] }, 0, nameOf).last).toBe('● Ada reading now')
    expect(boardVM(cap('rule:user:X.md', { label: 'X' }), 0, nameOf)).toMatchObject({
      scope: 'USER',
      summary: '',
      uses: 'not read yet',
      last: '',
    })
  })

  it('notebookVM: the memory title only (no summary, it may be personal)', () => {
    expect(notebookVM(cap('memory:prefs', { label: 'Prefs', summary: 'secret' }))).toEqual({
      title: 'Prefs',
    })
  })
})

describe('capabilityBubble (name-tag bubble during a call)', () => {
  it('names what is being used', () => {
    expect(capabilityBubble(cap('mcp:x', { label: 'Gmail' }), 'search_threads')).toBe(
      '🔌 Gmail · search_threads',
    )
    expect(capabilityBubble(cap('web', { label: 'Web' }))).toBe('🔌 Web')
    expect(capabilityBubble(cap('skill:run-office', { label: 'run-office' }))).toBe('📖 run-office')
    expect(capabilityBubble(cap('rule:project:TESTING.md', { label: 'TESTING.md' }))).toBe(
      '📜 TESTING.md',
    )
    expect(capabilityBubble(cap('memory:prefs', { label: 'Prefs' }))).toBe('📓 Prefs')
  })
})

describe('capabilityPanelVM', () => {
  it('describes an adapter with what it sees, its tools and who uses it', () => {
    const gmail = cap('mcp:claude_ai_Gmail', {
      label: 'Gmail',
      declared: false,
      sees: ['account: work'],
      tools: ['search_threads'],
      calls: 2,
      lastUsedAt: 1_000,
      active: ['a'],
    })
    expect(capabilityPanelVM(gmail, 4_000, nameOf)).toEqual({
      key: 'claude-code mcp:claude_ai_Gmail',
      provider: 'claude-code',
      id: 'mcp:claude_ai_Gmail',
      title: 'Gmail',
      subtitle: 'MCP · observed · claude-code',
      summary: '',
      sections: [
        { title: 'Can see', items: ['account: work'] },
        { title: 'Tools', items: ['search_threads'] },
      ],
      meta: [
        ['Calls', '2'],
        ['Last used', '3s ago'],
      ],
      usedBy: [{ id: 'a', name: 'Ada' }],
      showLinks: false,
    })
    expect(capabilityPanelVM(gmail, 4_000, nameOf, true).showLinks).toBe(true)
  })

  it('describes a skill or rule by its summary and scope', () => {
    const skill = cap('skill:run-office', {
      label: 'run-office',
      scope: 'project',
      summary: 'Launch the app and verify a change.',
    })
    expect(capabilityPanelVM(skill, 0, nameOf)).toMatchObject({
      subtitle: 'Skill · project · claude-code',
      summary: 'Launch the app and verify a change.',
      sections: [],
      meta: [
        ['Invocations', '0'],
        ['Last used', 'never'],
      ],
      usedBy: [],
    })
    expect(capabilityPanelVM(cap('rule:user:X.md'), 0, nameOf).meta[0]).toEqual(['Reads', '0'])
  })
})

describe('usedChips (agent panel: what this agent has used)', () => {
  it('splits adapters from skills and rules, most used first', () => {
    const used = new Map([
      ['web', 1],
      ['skill:run-office', 2],
      ['mcp:x', 5],
    ])
    const caps = [
      cap('web', { label: 'Web' }),
      cap('mcp:x', { label: 'Gmail' }),
      cap('skill:run-office', { label: 'run-office' }),
    ]
    expect(usedChips(caps, used)).toEqual({
      adapters: [
        { id: 'mcp:x', label: 'Gmail', count: 5, color: '#EC4899' },
        { id: 'web', label: 'Web', count: 1, color: '#2CB6A0' },
      ],
      library: [{ id: 'skill:run-office', label: 'run-office', count: 2, color: '#E8B74A' }],
    })
    expect(usedChips(caps, new Map())).toEqual({ adapters: [], library: [] })
  })
})

describe('surfacesVM (what every capability surface shows, per provider)', () => {
  it('fills station, book, board and notebook slots, with glow from recent use', () => {
    const caps = [
      cap('fs', { label: 'Filesystem', active: ['a'] }),
      cap('mcp:x', { label: 'Gmail', lastUsedAt: 9_000 }),
      cap('skill:run-office', { label: 'run-office', lastUsedAt: 1_000 }),
      cap('rule:project:TESTING.md', { label: 'Testing', lastUsedAt: 8_000 }),
      cap('memory:prefs', { label: 'Prefs' }),
    ]
    const stations = assignStations(caps)
    const library = assignLibrary(caps)
    const s = surfacesVM(
      new Map([['claude-code', caps]]),
      new Map([['claude-code', stations]]),
      new Map([['claude-code', library]]),
      10_000,
      nameOf,
    ).get('claude-code')!
    expect(s.stations[0]).toMatchObject({ id: 'fs', glow: 1, vm: { title: 'Filesystem' } })
    expect(s.stations[4]).toMatchObject({ id: 'mcp:x', glow: 0 })
    expect(s.stations[1]).toBeUndefined()
    expect(s.books[0]).toMatchObject({
      id: 'skill:run-office',
      glow: 0,
      vm: { title: 'run-office' },
    })
    // Used 2 s ago: still glowing (LIBRARY_GLOW_MS = 6 s).
    expect(s.boards[0]).toMatchObject({ id: 'rule:project:TESTING.md', glow: 1 })
    expect(s.notebooks[0]).toMatchObject({ id: 'memory:prefs', vm: { title: 'Prefs' } })
    expect(s.activeAdapters).toBe(1)
    expect(s.books).toHaveLength(24)
  })

  it('shows overflow aggregates on the last slot', () => {
    const caps = Array.from({ length: 10 }, (_, i) => cap(`mcp:m${i}`, { label: `M${i}` }))
    const s = surfacesVM(
      new Map([['claude-code', caps]]),
      new Map([['claude-code', assignStations(caps)]]),
      new Map([['claude-code', assignLibrary(caps)]]),
      0,
      nameOf,
    ).get('claude-code')!
    expect(s.stations[7]).toMatchObject({ id: '+more', vm: { title: '+3 more' } })
  })
})

describe('capabilityBubbles (name tags of agents calling or visiting)', () => {
  it('maps agents in call/visit activities to their bubble text', () => {
    const caps = new Map([
      ['claude-code', [cap('mcp:x', { label: 'Gmail' }), cap('skill:s', { label: 's' })]],
    ])
    const plan = (id: string, activity: string, capability?: string, tool?: string) => ({
      agent: { id, provider: 'claude-code', tool } as never,
      intent: { activity, target: '', since: 0, ...(capability ? { capability } : {}) } as never,
    })
    const plans = new Map([
      ['a', plan('a', 'connection-call', 'mcp:x', 'search')],
      ['b', plan('b', 'library-visit', 'skill:s')],
      ['c', plan('c', 'desk-work')],
      ['d', plan('d', 'connection-call', 'mcp:gone')],
    ])
    expect(capabilityBubbles(plans, caps)).toEqual(
      new Map([
        ['a', '🔌 Gmail · search'],
        ['b', '📖 s'],
      ]),
    )
  })
})
