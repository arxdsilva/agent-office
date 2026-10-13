import { describe, expect, it } from 'vitest'
import {
  NOW,
  P1,
  P2,
  activity,
  dashboard,
  memory,
  overview,
  project,
  session,
} from './__fixtures__/projects.ts'
import { initialState, memoryInScope, reduce, ACTIVITY_CAP, type WorkspaceState } from './state.ts'
import { startView } from './start-view.ts'

const withData = (): WorkspaceState => {
  let s = initialState()
  s = reduce(s, { type: 'projects', projects: [project(), project({ id: P2, name: 'Beta' })] })
  s = reduce(s, { type: 'dashboard', dashboard: dashboard() })
  s = reduce(s, { type: 'sessions', sessions: [session()] })
  return s
}

describe('startView', () => {
  it('auto opens the Overview only once a project exists', () => {
    expect(startView('auto', 0)).toBe('office')
    expect(startView('auto', 1)).toBe('overview')
  })
  it('explicit settings win', () => {
    expect(startView('office', 5)).toBe('office')
    expect(startView('overview', 0)).toBe('overview')
  })
})

describe('reduce navigation', () => {
  it('overview clears the current project; others keep or set it', () => {
    let s = reduce(initialState(), { type: 'navigate', view: 'project', projectId: P1 })
    expect(s.projectId).toBe(P1)
    s = reduce(s, { type: 'navigate', view: 'sessions' })
    expect(s.projectId).toBe(P1)
    expect(s.sessionScope).toBe(P1)
    s = reduce(s, { type: 'navigate', view: 'memory', projectId: null })
    expect(s.projectId).toBeNull()
    expect(s.memoryScope).toBe('all')
    s = reduce(s, { type: 'navigate', view: 'overview' })
    expect(s.projectId).toBeNull()
  })
  it('clears the error and resets the memory filter on entering memory', () => {
    let s = reduce(initialState(), { type: 'error', error: 'boom' })
    s = reduce(s, { type: 'memory-filter', filter: 'pending' })
    s = reduce(s, { type: 'navigate', view: 'memory' })
    expect(s.error).toBeNull()
    expect(s.memoryFilter).toBe('all')
  })
})

describe('reduce pushes', () => {
  it('replaces projects and vault, tracks agent project', () => {
    let s = reduce(initialState(), {
      type: 'push',
      msg: { type: 'projects', projects: [project()] },
    })
    expect(s.projects).toHaveLength(1)
    expect(s.projectsLoaded).toBe(true)
    s = reduce(s, { type: 'push', msg: { type: 'vault', status: 'memory-only' } })
    expect(s.vault).toBe('memory-only')
    s = reduce(s, { type: 'push', msg: { type: 'agent-project', agentId: 'cc:1', projectId: P1 } })
    expect(s.agentProjects['cc:1']).toBe(P1)
  })
  it('upserts sessions into the list and dashboards', () => {
    let s = withData()
    s = reduce(s, {
      type: 'push',
      msg: { type: 'session', session: session({ title: 'Renamed' }) },
    })
    expect(s.sessions[0]?.title).toBe('Renamed')
    expect(s.dashboards[P1]?.sessions[0]?.title).toBe('Renamed')
    s = reduce(s, {
      type: 'push',
      msg: { type: 'session', session: session({ id: 'ses_bbbbbbbbbb' }) },
    })
    expect(s.sessions).toHaveLength(2)
  })
  it('adds a pushed memory only when it belongs to the scope, updates when present', () => {
    let s = reduce(initialState(), { type: 'memory-scope', scope: P1 })
    s = reduce(s, {
      type: 'push',
      msg: { type: 'memory', memory: memory({ projectId: P2, id: 'mem_cccccccccc' }) },
    })
    expect(s.memories).toHaveLength(0)
    s = reduce(s, { type: 'push', msg: { type: 'memory', memory: memory() } })
    expect(s.memories).toHaveLength(1)
    s = reduce(s, { type: 'push', msg: { type: 'memory', memory: memory({ state: 'rejected' }) } })
    expect(s.memories[0]?.state).toBe('rejected')
  })
  it('keeps activity newest first, capped, and mirrors it into the dashboard', () => {
    let s = withData()
    for (let i = 0; i < ACTIVITY_CAP + 5; i++) {
      s = reduce(s, {
        type: 'push',
        msg: { type: 'activity', event: activity({ id: `n${i}`, ts: NOW + i }) },
      })
    }
    expect(s.activity[P1]).toHaveLength(ACTIVITY_CAP)
    expect(s.activity[P1]?.[0]?.id).toBe(`n${ACTIVITY_CAP + 4}`)
    expect(s.dashboards[P1]?.activity.some((a) => a.id === 'n0')).toBe(true)
  })
  it('records a retrieval only for the inspected agent', () => {
    let s = reduce(initialState(), {
      type: 'inspection',
      agentId: 'cc:1',
      inspection: { agentId: 'cc:1', projectId: P1, available: 2, retrieved: [], delivered: [] },
    })
    s = reduce(s, {
      type: 'push',
      msg: { type: 'retrieval', projectId: P1, agentId: 'cc:2', memoryIds: ['m'] },
    })
    expect(s.inspection?.retrieved).toHaveLength(0)
    s = reduce(s, {
      type: 'push',
      msg: { type: 'retrieval', projectId: P1, agentId: 'cc:1', memoryIds: ['m'] },
    })
    expect(s.inspection?.retrieved).toHaveLength(1)
  })
})

describe('reduce data events', () => {
  it('selects the first session when the selection disappears', () => {
    let s = reduce(initialState(), { type: 'sessions', sessions: [session()] })
    expect(s.selectedSessionId).toBe('ses_aaaaaaaaaa')
    s = reduce(s, { type: 'sessions', sessions: [session({ id: 'ses_bbbbbbbbbb' })] })
    expect(s.selectedSessionId).toBe('ses_bbbbbbbbbb')
    s = reduce(s, { type: 'sessions', sessions: [] })
    expect(s.selectedSessionId).toBeNull()
  })
  it('overview sets the vault and clears loading', () => {
    const s = reduce(
      { ...initialState(), loading: true },
      { type: 'overview', overview: overview() },
    )
    expect(s.vault).toBe('encrypted')
    expect(s.loading).toBe(false)
  })
  it('messages, session selection and highlight', () => {
    let s = reduce(initialState(), { type: 'messages', sessionId: 's', messages: [], more: true })
    expect(s.messages.s?.more).toBe(true)
    s = reduce(s, { type: 'select-session', sessionId: 's', messageId: 'm1' })
    expect(s.highlightMessageId).toBe('m1')
  })
  it('memory selection, checks and list refresh', () => {
    let s = reduce(initialState(), { type: 'memories', memories: [memory()] })
    s = reduce(s, { type: 'select-memory', memoryId: 'mem_aaaaaaaaaa' })
    s = reduce(s, { type: 'toggle-memory-check', memoryId: 'mem_aaaaaaaaaa' })
    expect(s.checkedMemoryIds).toEqual(['mem_aaaaaaaaaa'])
    s = reduce(s, { type: 'toggle-memory-check', memoryId: 'mem_aaaaaaaaaa' })
    expect(s.checkedMemoryIds).toEqual([])
    s = reduce(s, { type: 'toggle-memory-check', memoryId: 'mem_aaaaaaaaaa' })
    s = reduce(s, { type: 'memories', memories: [] })
    expect(s.selectedMemoryId).toBeNull()
    expect(s.checkedMemoryIds).toEqual([])
    s = reduce(s, { type: 'memory-updated', memory: memory() })
    expect(s.memories).toHaveLength(1)
    s = reduce(s, { type: 'memory-query', query: 'x' })
    expect(s.memoryQuery).toBe('x')
  })
  it('misc setters', () => {
    let s = initialState()
    s = reduce(s, { type: 'loading', on: true })
    s = reduce(s, { type: 'providers', providers: [] })
    s = reduce(s, { type: 'activity-filter', filter: 'memory' })
    s = reduce(s, { type: 'session-scope', scope: 'unassigned' })
    s = reduce(s, { type: 'session-query', query: 'q' })
    s = reduce(s, { type: 'new-project', patch: { open: true, name: 'n' } })
    s = reduce(s, { type: 'handoff', patch: { open: true } })
    expect([s.loading, s.activityFilter, s.sessionScope, s.sessionQuery]).toEqual([
      true,
      'memory',
      'unassigned',
      'q',
    ])
    expect(s.newProject.name).toBe('n')
    expect(s.handoff.open).toBe(true)
    s = reduce(s, { type: 'error', error: 'x' })
    expect(s.loading).toBe(false)
  })
})

describe('palette state', () => {
  it('opens clean, queries, clamps movement, closes', () => {
    let s = reduce(initialState(), { type: 'palette-open' })
    s = reduce(s, { type: 'palette-query', query: 'abc' })
    s = reduce(s, { type: 'palette-hits', hits: [] })
    s = reduce(s, { type: 'palette-searching', on: true })
    expect(s.palette.searching).toBe(true)
    s = reduce(s, { type: 'palette-move', delta: 5, count: 3 })
    expect(s.palette.selected).toBe(2)
    s = reduce(s, { type: 'palette-move', delta: -9, count: 3 })
    expect(s.palette.selected).toBe(0)
    s = reduce(s, { type: 'palette-move', delta: 1, count: 0 })
    expect(s.palette.selected).toBe(0)
    s = reduce(s, { type: 'palette-close' })
    expect(s.palette.open).toBe(false)
    s = reduce(s, { type: 'palette-open' })
    expect(s.palette.query).toBe('')
  })
})

describe('memoryInScope', () => {
  it('matches each scope kind', () => {
    const g = memory({ projectId: null, scope: 'global' })
    const u = memory({ projectId: null, scope: 'workspace' })
    expect(memoryInScope(g, 'all')).toBe(true)
    expect(memoryInScope(g, 'global')).toBe(true)
    expect(memoryInScope(u, 'global')).toBe(false)
    expect(memoryInScope(u, 'unassigned')).toBe(true)
    expect(memoryInScope(memory(), P1)).toBe(true)
    expect(memoryInScope(memory(), P2)).toBe(false)
  })
})

describe('notice and highlight lifetime', () => {
  it('stores a notice, clears it on navigation, and drops the highlight when leaving the vault', () => {
    let s = reduce(initialState(), { type: 'navigate', view: 'sessions' })
    s = reduce(s, { type: 'select-session', sessionId: 'ses_aaaaaaaaaa', messageId: 'm1' })
    s = reduce(s, { type: 'notice', notice: 'Saved as memory.' })
    expect(s.notice).toBe('Saved as memory.')
    expect(s.highlightMessageId).toBe('m1')
    s = reduce(s, { type: 'navigate', view: 'memory' })
    expect(s.notice).toBeNull()
    expect(s.highlightMessageId).toBeNull()
  })
})
