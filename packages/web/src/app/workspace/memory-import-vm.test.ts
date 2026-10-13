import { describe, expect, it } from 'vitest'
import { NOW, P1, P2, memory, project, session } from './__fixtures__/projects.ts'
import { memoryVM, memoryVisible, provenanceLines, provenanceLookup } from './memory-vm.ts'
import { initialState, reduce, type WorkspaceState } from './state.ts'
import { WS_COPY } from './workspace-copy.ts'

const imported = (over = {}) =>
  memory({
    id: 'mem_iiiiiiiiii',
    kind: 'note',
    title: 'Session: Fix the login bug',
    provenance: {
      origin: 'session-import',
      provider: 'claude-code',
      sessionId: 'ses_aaaaaaaaaa',
      createdAt: NOW - 1000,
      reviewedAt: NOW - 5000,
    },
    ...over,
  })
const mems = [
  memory(),
  imported(),
  imported({ id: 'mem_jjjjjjjjjj', projectId: P2 }),
  imported({ id: 'mem_kkkkkkkkkk', state: 'rejected', title: 'Removed one' }),
]
const st = (scope?: string): WorkspaceState => {
  let s = reduce(
    reduce(
      reduce(initialState(), {
        type: 'projects',
        projects: [project(), project({ id: P2, name: 'Beta' })],
      }),
      { type: 'memories', memories: mems },
    ),
    { type: 'sessions', sessions: [session()] },
  )
  if (scope) s = reduce(s, { type: 'memory-scope', scope })
  return s
}

describe('auto-imported memory', () => {
  it('badges session-import items "auto-imported" after their state', () => {
    const vm = memoryVM(st(), NOW)
    expect(vm.rows.find((r) => r.id === 'mem_iiiiiiiiii')!.badges.map((b) => b.label)).toEqual([
      'Approved',
      'auto-imported',
    ])
    expect(vm.rows.find((r) => r.id === 'mem_aaaaaaaaaa')!.badges.map((b) => b.label)).toEqual([
      'Approved',
    ])
  })

  it('has an Auto-imported chip counting the active (approved) imports, and filters by it', () => {
    let s = st()
    const chip = memoryVM(s, NOW).filters.find((f) => f.key === 'auto-imported')!
    expect(chip).toMatchObject({ label: 'Auto-imported', count: 2, active: false })
    s = reduce(s, { type: 'memory-filter', filter: 'auto-imported' })
    expect(memoryVisible(s).map((m) => m.id)).toEqual(['mem_iiiiiiiiii', 'mem_jjjjjjjjjj'])
    expect(memoryVM(s, NOW).filters.find((f) => f.key === 'auto-imported')!.active).toBe(true)
  })

  it('the chip count follows the scope', () => {
    const chip = memoryVM(st(P1), NOW).filters.find((f) => f.key === 'auto-imported')!
    expect(chip.count).toBe(1)
  })

  it('names the session by title and provider, never by id', () => {
    const m = imported()
    const lines = provenanceLines(m, NOW, provenanceLookup(st()))
    expect(lines[0]).toBe('Imported automatically from session “Fix the login bug” (claude-code)')
    expect(lines.join('\n')).not.toContain('ses_')
    expect(lines.filter((l) => /Imported automatically/.test(l))).toHaveLength(1)
  })

  it('falls back to a generic line when the session is not known', () => {
    const lines = provenanceLines(imported(), NOW)
    expect(lines[0]).toBe('Imported automatically from a session (claude-code)')
  })

  it('without a session id it keeps the plain origin text', () => {
    const m = imported({
      provenance: { origin: 'session-import', createdAt: NOW - 1000, reviewedAt: NOW - 5000 },
    })
    expect(provenanceLines(m, NOW)[0]).toBe(WS_COPY.memory.prov['session-import'])
  })
})

describe('Remove imported memory button', () => {
  it('is enabled for All memory and for a project that has imports', () => {
    expect(memoryVM(st(), NOW).removeImported).toMatchObject({
      id: 'remove-imported',
      label: 'Remove imported memory',
      enabled: true,
    })
    expect(memoryVM(st(P2), NOW).removeImported.enabled).toBe(true)
  })

  it('is disabled with a hint for Global and Unassigned, which cannot be targeted', () => {
    for (const scope of ['global', 'unassigned']) {
      const b = memoryVM(st(scope), NOW).removeImported
      expect(b.enabled).toBe(false)
      expect(b.hint).toBe(WS_COPY.memory.removeNeedScope)
    }
  })

  it('is disabled when the scope has nothing imported', () => {
    const s = reduce(st(), { type: 'memories', memories: [memory()] })
    const b = memoryVM(s, NOW).removeImported
    expect(b.enabled).toBe(false)
    expect(b.hint).toBe(WS_COPY.memory.removeNothing)
  })

  it('confirm text counts the items and names the scope', () => {
    const all = memoryVM(reduce(st(), { type: 'remove-imported-confirm', open: true }), NOW)
    expect(all.removeConfirm).toMatchObject({ open: true, ok: 'Remove', cancel: 'Cancel' })
    expect(all.removeConfirm.body).toContain('2 auto-imported items')
    expect(all.removeConfirm.body).toContain('All memory')
    const one = memoryVM(st(P1), NOW)
    expect(one.removeConfirm.open).toBe(false)
    expect(one.removeConfirm.body).toContain('1 auto-imported item ')
    expect(one.removeConfirm.body).toContain('Alpha')
  })

  it('carries the result notice', () => {
    expect(
      memoryVM(reduce(st(), { type: 'notice', notice: 'Removed 2 imported items' }), NOW).notice,
    ).toBe('Removed 2 imported items')
    expect(memoryVM(st(), NOW).notice).toBeNull()
  })

  it('navigating away closes the confirm', () => {
    const s = reduce(reduce(st(), { type: 'remove-imported-confirm', open: true }), {
      type: 'navigate',
      view: 'overview',
    })
    expect(s.removeImportedConfirm).toBe(false)
  })
})
