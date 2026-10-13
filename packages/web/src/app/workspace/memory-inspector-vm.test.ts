import { describe, expect, it } from 'vitest'
import { NOW, P1, P2, memory, project } from './__fixtures__/projects.ts'
import { inspectorVM } from './inspector-vm.ts'
import { memoryDetailVM, memoryVM, memoryVisible, provenanceLines } from './memory-vm.ts'
import { initialState, reduce, type WorkspaceState } from './state.ts'
import { WS_COPY } from './workspace-copy.ts'

const mems = [
  memory(),
  memory({
    id: 'mem_bbbbbbbbbb',
    title: 'Agent idea',
    state: 'pending',
    provenance: {
      origin: 'agent-proposal',
      provider: 'claude-code',
      sessionId: 'ses_aaaaaaaaaa',
      messageId: 'm9',
      createdAt: NOW - 1000,
    },
  }),
  memory({ id: 'mem_cccccccccc', title: 'Dropped', state: 'rejected' }),
  memory({
    id: 'mem_dddddddddd',
    title: 'Old',
    state: 'superseded',
    supersededBy: 'mem_aaaaaaaaaa',
  }),
  memory({
    id: 'mem_eeeeeeeeee',
    title: 'Second approved',
    body: 'unique-token',
    state: 'approved',
    mergedFrom: ['a', 'b'],
  }),
]
const st = (): WorkspaceState =>
  reduce(
    reduce(initialState(), {
      type: 'projects',
      projects: [project(), project({ id: P2, name: 'Beta' })],
    }),
    { type: 'memories', memories: mems },
  )

describe('memoryVM', () => {
  it('shows state badges including agent-proposed', () => {
    const vm = memoryVM(st(), NOW)
    const idea = vm.rows.find((r) => r.id === 'mem_bbbbbbbbbb')!
    expect(idea.badges.map((b) => b.label)).toEqual(['Pending review', 'agent-proposed'])
    expect(vm.rows.find((r) => r.id === 'mem_aaaaaaaaaa')!.badges.map((b) => b.label)).toEqual([
      'Approved',
    ])
  })
  it('filters by state with counts, and by query', () => {
    let s = st()
    const f = memoryVM(s, NOW).filters
    expect(f.find((x) => x.key === 'all')?.count).toBe(5)
    expect(f.find((x) => x.key === 'approved')?.count).toBe(2)
    s = reduce(s, { type: 'memory-filter', filter: 'pending' })
    expect(memoryVM(s, NOW).rows.map((r) => r.id)).toEqual(['mem_bbbbbbbbbb'])
    s = reduce(reduce(s, { type: 'memory-filter', filter: 'all' }), {
      type: 'memory-query',
      query: 'UNIQUE-token',
    })
    expect(memoryVisible(s).map((m) => m.id)).toEqual(['mem_eeeeeeeeee'])
  })
  it('enables actions per state', () => {
    const s = st()
    const a = (id: string) =>
      memoryDetailVM(
        s,
        mems.find((m) => m.id === id)!,
        NOW,
      ).actions
    expect(a('mem_bbbbbbbbbb')).toMatchObject({
      approve: { enabled: true },
      reject: { enabled: true },
      edit: { enabled: true },
      supersede: { enabled: false },
      merge: { enabled: false },
    })
    expect(a('mem_aaaaaaaaaa')).toMatchObject({
      approve: { enabled: false },
      reject: { enabled: false },
      edit: { enabled: true },
      supersede: { enabled: true },
      scope: { enabled: true },
    })
    expect(a('mem_cccccccccc')).toMatchObject({
      approve: { enabled: false },
      edit: { enabled: false },
      supersede: { enabled: false },
    })
    expect(a('mem_cccccccccc').edit.hint).toBe(WS_COPY.memory.notEditable)
    expect(a('mem_dddddddddd').scope.enabled).toBe(false)
  })
  it('merge needs two checked approved items', () => {
    let s = st()
    s = reduce(s, { type: 'toggle-memory-check', memoryId: 'mem_aaaaaaaaaa' })
    expect(memoryDetailVM(s, mems[0]!, NOW).actions.merge.enabled).toBe(false)
    s = reduce(s, { type: 'toggle-memory-check', memoryId: 'mem_bbbbbbbbbb' })
    expect(memoryDetailVM(s, mems[0]!, NOW).actions.merge.enabled).toBe(false) // pending does not count
    s = reduce(s, { type: 'toggle-memory-check', memoryId: 'mem_eeeeeeeeee' })
    expect(memoryDetailVM(s, mems[0]!, NOW).actions.merge.enabled).toBe(true)
    expect(memoryVM(s, NOW).rows.filter((r) => r.checked)).toHaveLength(3)
  })
  it('provenance lines cover origin, provider, session, message, review and lineage', () => {
    const lines = provenanceLines(mems[1]!, NOW)
    expect(lines).toEqual(
      expect.arrayContaining([
        WS_COPY.memory.prov['agent-proposal'],
        'From a session (claude-code)',
        'Saved from a session message',
        WS_COPY.memory.notReviewed,
      ]),
    )
    const old = provenanceLines(mems[3]!, NOW)
    expect(old.some((l) => l.startsWith('Reviewed'))).toBe(true)
    expect(old).toContain('Superseded by a newer version')
    expect(provenanceLines(mems[4]!, NOW)).toContain('Merged from 2 items')
  })
  it('names the session by title and provider, never by raw id', () => {
    const lookup = {
      session: (id: string) =>
        id === 'ses_aaaaaaaaaa' ? { title: 'pagination', provider: 'codex' } : undefined,
      memory: (id: string) => (id === 'mem_aaaaaaaaaa' ? 'Cursor pagination' : undefined),
    }
    const lines = provenanceLines(mems[1]!, NOW, lookup)
    expect(lines).toContain('From session \u201cpagination\u201d (codex)')
    expect(lines.join('\n')).not.toMatch(/ses_|mem_|\bm9\b/)
    expect(provenanceLines(mems[3]!, NOW, lookup)).toContain(
      'Superseded by \u201cCursor pagination\u201d',
    )
  })
  it('detail follows the selection; empty states; scope tabs', () => {
    let s = st()
    expect(memoryVM(s, NOW).detail).toBeNull()
    s = reduce(s, { type: 'select-memory', memoryId: 'mem_aaaaaaaaaa' })
    const vm = memoryVM(s, NOW)
    expect(vm.detail?.scopeOptions.find((o) => o.current)?.scope).toBe('project')
    expect(vm.scopes.map((x) => x.key)).toEqual(['all', 'global', 'unassigned', P1, P2])
    expect(vm.scopeLabel).toBe('All memory')
    const none = memoryVM(initialState(), NOW)
    expect(none.rows).toEqual([])
    expect(none.filters.every((f) => f.count === 0)).toBe(true)
  })
})

describe('inspectorVM', () => {
  const ins = {
    agentId: 'cc:1',
    projectId: P1,
    available: 4,
    retrieved: [
      { ts: NOW - 5000, tool: 'memory.search', query: 'zod', memoryIds: ['mem_aaaaaaaaaa'] },
    ],
    delivered: [
      {
        ts: NOW - 9000,
        memoryIds: ['mem_aaaaaaaaaa', 'mem_unknown'],
        via: 'first-message' as const,
      },
      { ts: NOW - 8000, memoryIds: [], via: 'handoff' as const },
    ],
  }
  it('says retrieved / delivered to the agent, never read or knows', () => {
    const s = reduce(st(), { type: 'inspection', agentId: 'cc:1', inspection: ins })
    const vm = inspectorVM(s, NOW)
    expect(vm.available.summary).toBe("4 approved items are available under this project's policy.")
    expect(vm.retrieved.heading).toBe('Retrieved')
    expect(vm.delivered.heading).toBe('Delivered to the agent')
    expect(vm.retrieved.entries[0]?.title).toBe('Retrieved with memory.search: "zod"')
    expect(vm.retrieved.entries[0]?.detail).toContain('Use zod everywhere')
    expect(vm.delivered.entries[0]?.detail).toContain('a memory item')
    expect(vm.delivered.entries[0]?.detail).not.toContain('mem_unknown')
    expect(vm.delivered.entries[1]?.title).toBe('Delivered to the agent in a handoff')
    expect(vm.projectName).toBe('Alpha')
    const copy = JSON.stringify(vm) + JSON.stringify(WS_COPY.inspector)
    expect(copy).not.toMatch(/\bread(s|ing)?\b/i)
    expect(copy).not.toMatch(/\bknow(s)?\b/i)
  })
  it('singular copy and empty states', () => {
    expect(WS_COPY.inspector.available(1)).toContain('1 approved item is')
    const vm = inspectorVM(initialState(), NOW)
    expect(vm.available.summary).toBe(WS_COPY.inspector.noAgent)
    expect(vm.retrieved.entries).toEqual([])
    expect(vm.retrieved.empty).toBe(WS_COPY.inspector.retrievedEmpty)
    expect(vm.delivered.empty).toBe(WS_COPY.inspector.deliveredEmpty)
    expect(vm.agentId).toBeNull()
  })
  it('a pushed retrieval without a timestamp shows no time', () => {
    let s = reduce(initialState(), {
      type: 'inspection',
      agentId: 'cc:1',
      inspection: { ...ins, retrieved: [], delivered: [] },
    })
    s = reduce(s, {
      type: 'push',
      msg: { type: 'retrieval', projectId: P1, agentId: 'cc:1', memoryIds: [] },
    })
    const e = inspectorVM(s, NOW).retrieved.entries[0]!
    expect(e.title).toBe('Retrieved with memory')
    expect(e.detail).toBe('0 items')
  })
})
