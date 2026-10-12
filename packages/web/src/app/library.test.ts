import { describe, expect, it } from 'vitest'
import { cap } from './__fixtures__/capabilities.ts'
import { LIBRARY_CAPACITY, assignLibrary, libraryShelf } from './library.ts'

describe('assignLibrary', () => {
  it('orders books by scope (project, user, plugin) then name', () => {
    const lib = assignLibrary([
      cap('skill:zeta', { scope: 'plugin' }),
      cap('skill:beta', { scope: 'user' }),
      cap('skill:alpha', { scope: 'user' }),
      cap('skill:run-office', { scope: 'project' }),
      cap('skill:loose'),
      cap('fs'),
    ])
    expect(lib.books.occupant.slice(0, 5)).toEqual([
      'skill:run-office',
      'skill:alpha',
      'skill:beta',
      'skill:zeta',
      'skill:loose',
    ])
    expect(lib.books.slot.has('fs')).toBe(false)
  })

  it('orders boards: project CLAUDE/AGENTS, project rules, user CLAUDE.md, user rules; notebooks by name', () => {
    const lib = assignLibrary([
      cap('rule:user:style.md'),
      cap('rule:project:TESTING.md'),
      cap('rule:user:CLAUDE.md'),
      cap('rule:project:AGENTS.md'),
      cap('rule:project:ARCHITECTURE.md'),
      cap('rule:project:CLAUDE.md'),
      cap('memory:zebra', { label: 'Zebra notes' }),
      cap('memory:apple', { label: 'Apple notes' }),
    ])
    expect(lib.boards.occupant).toEqual([
      'rule:project:AGENTS.md',
      'rule:project:CLAUDE.md',
      'rule:project:ARCHITECTURE.md',
      'rule:project:TESTING.md',
      'rule:user:CLAUDE.md',
      'rule:user:style.md',
    ])
    expect(lib.notebooks.occupant.slice(0, 2)).toEqual(['memory:apple', 'memory:zebra'])
    expect(lib.boards.slot.has('memory:apple')).toBe(false)
  })

  it('keeps slots stable while capabilities exist; newcomers take freed slots', () => {
    const first = assignLibrary(['a', 'b', 'c'].map((n) => cap(`skill:${n}`, { scope: 'user' })))
    const second = assignLibrary(
      ['b', 'c', '0-first'].map((n) => cap(`skill:${n}`, { scope: 'user' })),
      first,
    )
    expect(second.books.slot.get('skill:b')).toBe(1)
    expect(second.books.slot.get('skill:c')).toBe(2)
    expect(second.books.slot.get('skill:0-first')).toBe(0)
  })

  it('puts "+N more" on the last slot of each kind when it overflows', () => {
    const books = Array.from({ length: 26 }, (_, i) => cap(`skill:s${String(i).padStart(2, '0')}`))
    const rules = Array.from({ length: 8 }, (_, i) => cap(`rule:project:r${i}.md`))
    const notes = Array.from({ length: 9 }, (_, i) => cap(`memory:m${i}`))
    const lib = assignLibrary([...books, ...rules, ...notes])
    expect(lib.books.overflow).toEqual(['skill:s23', 'skill:s24', 'skill:s25'])
    expect(lib.books.occupant[23]).toBeUndefined()
    expect(lib.books.slot.get('skill:s25')).toBe(23)
    expect(lib.boards.overflow).toHaveLength(3)
    expect(lib.notebooks.overflow).toEqual(['memory:m7', 'memory:m8'])
    // Capacities follow the manifest when given.
    const small = assignLibrary(books.slice(0, 3), undefined, { books: 2, boards: 6, notebooks: 8 })
    expect(small.books.overflow).toEqual(['skill:s01', 'skill:s02'])
    expect(LIBRARY_CAPACITY).toEqual({ books: 24, boards: 6, notebooks: 8 })
  })

  it('knows which shelf spot is nearest a slot', () => {
    expect(libraryShelf('skill', 3)).toBe(0)
    expect(libraryShelf('skill', 12)).toBe(1)
    expect(libraryShelf('rule', 2)).toBe(0)
    expect(libraryShelf('memory', 2)).toBe(1)
  })

  it('breaks label ties by id', () => {
    const lib = assignLibrary([
      cap('skill:b', { label: 'same' }),
      cap('skill:a', { label: 'same' }),
    ])
    expect(lib.books.occupant.slice(0, 2)).toEqual(['skill:a', 'skill:b'])
  })
})
