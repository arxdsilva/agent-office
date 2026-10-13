import { describe, expect, it } from 'vitest'
import type { ProviderSurfaces } from './capability-vm.ts'
import {
  archiveVolumes,
  parseProjectRef,
  projectRefId,
  projectRefLabel,
  projectSurfaces,
  countLabel,
  projectLibraryVM,
  type ProjectMemoryCounts,
} from './project-library.ts'

const NOW = 1_000_000_000_000
const DAY = 86_400_000
const project = { id: 'prj_a', name: 'Alpha', color: '#3b82f6' }
const memory: ProjectMemoryCounts = {
  byKind: { instruction: 2, constraint: 1, decision: 4, fact: 3, note: 2 },
  pending: 5,
  handoffs: 1,
  acceptedDecisions: 3,
}

describe('projectLibraryVM', () => {
  // PL-1: notebooks map to the six collections in order, with counts only.
  it('maps notebooks to collections with counts (facts join notes)', () => {
    const vm = projectLibraryVM(project, memory, [], NOW)
    expect(vm.notebooks.map((n) => [n.label, n.count])).toEqual([
      ['Instructions', 2],
      ['Constraints', 1],
      ['Decisions', 4],
      ['Notes', 5],
      ['Pending review', 5],
      ['Handoffs', 1],
    ])
    expect(vm).toMatchObject({ projectId: 'prj_a', name: 'Alpha', color: '#3b82f6' })
  })

  // PL-2: boards show the accepted decisions count.
  it('puts accepted decisions on the board', () => {
    expect(projectLibraryVM(project, memory, [], NOW).boards).toEqual([
      { label: 'Accepted decisions', count: 3 },
    ])
  })

  // PL-3: missing kinds count as zero.
  it('treats absent kinds as zero', () => {
    const vm = projectLibraryVM(project, { ...memory, byKind: {} }, [], NOW)
    expect(vm.notebooks.slice(0, 4).map((n) => n.count)).toEqual([0, 0, 0, 0])
  })

  // PL-4: the VM carries no free text beyond fixed names, so a world label cannot leak a title.
  it('contains only collection names, counts and the project name', () => {
    const json = JSON.stringify(projectLibraryVM(project, memory, [{ lastSeenAt: NOW }], NOW))
    expect(json).not.toMatch(/title|body|summary/i)
  })
})

describe('archiveVolumes', () => {
  // PL-5: sessions group into time buckets and empty buckets vanish.
  it('groups sessions by age into volumes, skipping empty ones', () => {
    const s = (days: number) => ({ lastSeenAt: NOW - days * DAY })
    expect(archiveVolumes([s(0), s(0.5), s(3), s(20), s(60), s(400), s(900)], NOW)).toEqual([
      { label: 'Today', count: 2 },
      { label: 'This week', count: 1 },
      { label: 'This month', count: 1 },
      { label: 'Last 3 months', count: 1 },
      { label: 'Earlier', count: 2 },
    ])
    expect(archiveVolumes([], NOW)).toEqual([])
  })

  // PL-6: many sessions stay few books; a future timestamp counts as today.
  it('never makes one book per session', () => {
    const many = Array.from({ length: 500 }, () => ({ lastSeenAt: NOW + 5 }))
    expect(archiveVolumes(many, NOW)).toEqual([{ label: 'Today', count: 500 }])
  })
})

describe('countLabel', () => {
  it('joins name and count', () => {
    expect(countLabel('Decisions', 4)).toBe('Decisions · 4')
  })
})

describe('project surfaces', () => {
  const base = new Map<string, ProviderSurfaces>([
    [
      'claude-code',
      {
        stations: [undefined],
        books: Array.from({ length: 12 }, (_, i) => ({
          id: `skill-${i}`,
          vm: { title: `Secret skill ${i}`, scope: 'user', color: '#fff' },
          glow: 0,
          color: '#fff',
        })),
        boards: [
          {
            id: 'rule',
            vm: { title: 'Rule', scope: 'USER', summary: '', uses: '', last: '' },
            glow: 0,
            color: '#fff',
          },
        ],
        notebooks: [{ id: 'mem', vm: { title: 'Private memory title' }, glow: 0, color: '#fff' }],
        activeAdapters: 2,
      },
    ],
  ])
  const vm = projectLibraryVM(
    project,
    memory,
    [{ lastSeenAt: NOW }, { lastSeenAt: NOW - 3 * DAY }],
    NOW,
  )

  // PL-7: notebooks, books and boards are replaced; stations and adapter counts stay.
  it('swaps in collections, archive volumes and decisions, hiding the provider capabilities', () => {
    const s = projectSurfaces(base, vm).get('claude-code')!
    expect(s.stations).toEqual(base.get('claude-code')!.stations)
    expect(s.activeAdapters).toBe(2)
    expect(s.notebooks).toHaveLength(8)
    expect(s.notebooks.slice(0, 6).map((n) => n!.vm.title)).toEqual([
      'Instructions · 2',
      'Constraints · 1',
      'Decisions · 4',
      'Notes · 5',
      'Pending review · 5',
      'Handoffs · 1',
    ])
    expect(s.notebooks[6]).toBeUndefined()
    expect(s.books.map((b) => b?.vm.title)).toEqual([
      'Today · 1',
      'This week · 1',
      ...Array(10).fill(undefined),
    ])
    expect(s.boards[0]!.vm).toMatchObject({ title: 'Accepted decisions', summary: '3' })
    expect(JSON.stringify([...projectSurfaces(base, vm)])).not.toMatch(/Secret|Private/)
  })

  // PL-8: ids round-trip and name the slot's label.
  it('round-trips project ref ids and labels them', () => {
    const id = projectRefId('prj_a', 'collection', 'decisions')
    expect(parseProjectRef(id)).toEqual({
      projectId: 'prj_a',
      kind: 'collection',
      key: 'decisions',
    })
    expect(projectRefLabel(vm, id)).toBe('Decisions · 4')
    expect(projectRefLabel(vm, projectRefId('prj_a', 'archive', 1))).toBe('This week · 1')
    expect(projectRefLabel(vm, projectRefId('prj_a', 'decisions', 0))).toBe(
      'Accepted decisions · 3',
    )
    expect(projectRefLabel(vm, projectRefId('prj_a', 'archive', 9))).toBeNull()
    expect(projectRefLabel(vm, projectRefId('prj_zzz', 'archive', 0))).toBeNull()
    expect(projectRefLabel(vm, 'web')).toBeNull()
    expect(parseProjectRef('project:x')).toBeNull()
    expect(parseProjectRef('project:p:bogus:k')).toBeNull()
  })
})
