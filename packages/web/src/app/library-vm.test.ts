import { describe, expect, it } from 'vitest'
import type { Capability } from '@agent-office/shared'
import { builtins, cap } from './__fixtures__/capabilities.ts'
import { assignLibrary } from './library.ts'
import { assignStations } from './stations.ts'
import { LIB_COPY } from './library-copy.ts'
import {
  defaultLibraryProvider,
  libraryProviders,
  libraryVM,
  moreTooltipText,
  overflowCount,
  parseMore,
  shelfSlot,
  tabOf,
  tooltipText,
  type LibraryInput,
} from './library-vm.ts'

const NOW = 1_000_000
const skills = Array.from({ length: 30 }, (_, i) =>
  cap(`skill:s${String(i).padStart(2, '0')}`, {
    scope: i < 3 ? 'project' : 'plugin',
    summary: i === 5 ? 'Runs the OFFICE app' : `Skill number ${i}`,
  }),
)
const caps: Capability[] = [
  ...builtins(),
  cap('mcp:github', { sees: ['repos', 'issues', 'pull requests'] }),
  ...skills,
  cap('rule:project:CLAUDE.md', { summary: 'Project guide' }),
  cap('rule:project:TESTING.md'),
  cap('memory:prefs', { summary: 'secret personal fact' }),
]
const all = new Map([['claude-code', caps]])
const input = (over: Partial<LibraryInput> = {}): LibraryInput => ({
  capabilities: all,
  tab: 'skills',
  query: '',
  sort: 'shelf',
  now: NOW,
  nameOf: (id) => (id === 'a1' ? 'Maya' : id),
  ...over,
})

describe('libraryVM', () => {
  it('LBV-1: tabs and counts per category and kind', () => {
    const vm = libraryVM(input())
    expect(vm.provider).toBe('claude-code')
    expect(vm.tabs).toEqual([
      { id: 'skills', label: 'Skills', count: 30 },
      { id: 'rules', label: 'Rules', count: 2 },
      { id: 'memory', label: 'Memory', count: 1 },
      { id: 'adapters', label: 'Adapters', count: 5 },
    ])
    expect(tabOf(cap('memory:x'))).toBe('memory')
    expect(tabOf(cap('fs'))).toBe('adapters')
    expect(libraryVM(input({ tab: 'rules' })).rows.map((r) => r.label)).toEqual([
      'CLAUDE.md',
      'TESTING.md',
    ])
  })

  it('LBV-1: rows carry icon, scope, summary, usage, in-use and slot', () => {
    const used = cap('skill:s01', {
      scope: 'project',
      summary: 'Skill number 1',
      calls: 3,
      lastUsedAt: NOW - 120_000,
      active: ['a1'],
    })
    const vm = libraryVM(
      input({
        capabilities: new Map([
          ['claude-code', [used, ...caps.filter((c) => c.id !== 'skill:s01')]],
        ]),
      }),
    )
    expect(vm.rows[1]).toEqual({
      ref: { provider: 'claude-code', id: 'skill:s01' },
      icon: '📖',
      label: 's01',
      scope: 'project',
      summary: 'Skill number 1',
      usage: 'used 3× · 2m ago · by Maya',
      inUse: true,
      slot: 1,
    })
    expect(vm.rows[0]!.usage).toBe(LIB_COPY.never)
    expect(vm.rows[0]!.inUse).toBe(false)
    const mem = libraryVM(input({ tab: 'memory' })).rows[0]!
    expect(mem).toMatchObject({ icon: '📓', label: 'prefs', slot: 0 })
    expect(mem.summary).toBeUndefined()
    const ad = libraryVM(input({ tab: 'adapters' })).rows.find((r) => r.label === 'github')!
    expect(ad).toMatchObject({ icon: '🔌', canSee: ['repos', 'issues'] })
    expect(libraryVM(input({ tab: 'rules' })).rows[0]!.icon).toBe('📜')
  })

  it('LBV-2: search filters label and summary, case-insensitive; counts follow', () => {
    const vm = libraryVM(input({ query: '  office ' }))
    expect(vm.rows.map((r) => r.label)).toEqual(['s05'])
    expect(vm.tabs.map((t) => t.count)).toEqual([1, 0, 0, 0])
    expect(libraryVM(input({ query: 'S2' })).rows.map((r) => r.label)).toEqual([
      's20',
      's21',
      's22',
    ])
    // Memory is matched on its title only (its summary is never shown).
    expect(libraryVM(input({ tab: 'memory', query: 'secret' })).rows).toEqual([])
  })

  it('LBV-3: sorts by recent use, A–Z or shelf order', () => {
    const list = [
      cap('skill:b', { lastUsedAt: 10 }),
      cap('skill:a'),
      cap('skill:c', { lastUsedAt: 50 }),
    ]
    const m = new Map([['claude-code', list]])
    const labels = (sort: LibraryInput['sort']) =>
      libraryVM(input({ capabilities: m, sort })).rows.map((r) => r.label)
    expect(labels('shelf')).toEqual(['a', 'b', 'c'])
    expect(labels('recent')).toEqual(['c', 'b', 'a'])
    expect(labels('az')).toEqual(['a', 'b', 'c'])
    const z = new Map([['claude-code', [cap('skill:Zed'), cap('skill:alpha')]]])
    expect(libraryVM(input({ capabilities: z, sort: 'az' })).rows.map((r) => r.label)).toEqual([
      'alpha',
      'Zed',
    ])
  })

  it('LBV-4: the overflow group is exactly the items without a slot', () => {
    const vm = libraryVM(input())
    const lib = assignLibrary(caps)
    expect(vm.overflow.map((r) => r.ref.id)).toEqual(lib.books.overflow)
    expect(vm.overflow).toHaveLength(7)
    expect(vm.overflow.every((r) => r.slot === undefined)).toBe(true)
    expect(vm.rows).toHaveLength(23)
    expect(vm.overflowLabel).toBe('Not on a shelf (7)')
    // Uses the director's slot maps when given (stable slots).
    const prev = assignLibrary(caps)
    expect(libraryVM(input({ library: new Map([['claude-code', prev]]) })).rows).toHaveLength(23)
  })

  it('LBV-5: empty states per tab and for a search with no match', () => {
    const none = new Map([['langgraph', [cap('fs', { provider: 'langgraph' })]]])
    expect(libraryVM(input({ capabilities: none })).empty).toBe(LIB_COPY.empty.skills)
    expect(libraryVM(input({ capabilities: none, tab: 'rules' })).empty).toBe(LIB_COPY.empty.rules)
    expect(libraryVM(input({ capabilities: none, tab: 'memory' })).empty).toBe(
      LIB_COPY.empty.memory,
    )
    expect(libraryVM(input({ query: 'zzz' })).empty).toBe('Nothing matches “zzz”.')
    expect(libraryVM(input()).empty).toBeUndefined()
    expect(libraryVM(input({ capabilities: new Map() }))).toMatchObject({
      provider: '',
      providers: [],
      rows: [],
      empty: LIB_COPY.empty.skills,
    })
  })

  it('LBV-6: providers are those with capabilities, defaulting to the selected agent’s', () => {
    const m = new Map<string, Capability[]>([
      ['langgraph', [cap('skill:x', { provider: 'langgraph' })]],
      ['empty', []],
      ['claude-code', caps],
    ])
    expect(libraryProviders(m)).toEqual(['claude-code', 'langgraph'])
    expect(defaultLibraryProvider(m, 'langgraph')).toBe('langgraph')
    expect(defaultLibraryProvider(m, 'empty')).toBe('claude-code')
    expect(defaultLibraryProvider(m)).toBe('claude-code')
    expect(
      defaultLibraryProvider(
        new Map([
          ['b', [cap('fs')]],
          ['a', [cap('fs')]],
        ]),
      ),
    ).toBe('a')
    const vm = libraryVM(input({ capabilities: m, selectedProvider: 'langgraph' }))
    expect(vm.provider).toBe('langgraph')
    expect(vm.providers).toEqual(['claude-code', 'langgraph'])
    // An explicit choice wins.
    expect(
      libraryVM(input({ capabilities: m, provider: 'claude-code', selectedProvider: 'langgraph' }))
        .provider,
    ).toBe('claude-code')
  })

  it('passes the focus through (scroll to the overflow group)', () => {
    expect(libraryVM(input({ focus: 'overflow' })).focus).toBe('overflow')
  })

  it('memory and adapter overflow stay in the rows (no "Not on a shelf" group)', () => {
    const many = Array.from({ length: 10 }, (_, i) => cap(`memory:m${i}`))
    const vm = libraryVM(input({ capabilities: new Map([['claude-code', many]]), tab: 'memory' }))
    expect(vm.rows).toHaveLength(10)
    expect(vm.overflow).toEqual([])
    expect(vm.rows.slice(-3).map((r) => r.slot)).toEqual([undefined, undefined, undefined])
  })
})

describe('tooltipText (TT-1)', () => {
  it('icon, label and kind per category', () => {
    expect(tooltipText(cap('skill:run-office', { scope: 'project' }))).toBe(
      '📖 run-office · skill (project) · click to open',
    )
    expect(tooltipText(cap('rule:project:AGENTS.md'))).toBe(
      '📜 AGENTS.md · rule (project) · click to open',
    )
    expect(tooltipText(cap('memory:prefs'))).toBe('📓 prefs · memory · click to open')
    expect(tooltipText(cap('mcp:github'))).toBe('🔌 github · adapter · click to open')
    expect(tooltipText(cap('skill:x'))).toBe('📖 x · skill · click to open')
  })
})

describe('slots and overflow helpers', () => {
  it('shelfSlot is the own slot only (overflowed items have none)', () => {
    const lib = assignLibrary(caps)
    expect(
      shelfSlot(
        caps.find((c) => c.id === 'skill:s01')!,
        lib,
        undefined,
        caps,
      ),
    ).toBe(1)
    expect(
      shelfSlot(
        caps.find((c) => c.id === 'skill:s29')!,
        lib,
        undefined,
        caps,
      ),
    ).toBeUndefined()
    expect(shelfSlot(cap('fs'), undefined, undefined)).toBe(0)
    expect(overflowCount('skills', lib, assignStations(caps))).toBe(7)
  })

  it('parseMore reads the aggregate id and its tab', () => {
    expect(parseMore('+more')).toEqual({})
    expect(parseMore('+more:rules')).toEqual({ tab: 'rules' })
    expect(parseMore('+more:x')).toBeUndefined()
    expect(parseMore('skill:a')).toBeUndefined()
    expect(moreTooltipText(3)).toBe('📚 +3 more · Not on a shelf (overflow) · click to open')
  })
})
