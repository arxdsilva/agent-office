import { describe, expect, it } from 'vitest'
import { P1, P2, handoff, project, provider, session } from './__fixtures__/projects.ts'
import { handoffProviders, handoffVM } from './handoff-vm.ts'
import { newProjectVM } from './new-project-vm.ts'
import { hitAction, mergeHits, paletteCommands, paletteItems, paletteVM } from './palette-vm.ts'
import { projectDirectoryVM } from './project-directory-vm.ts'
import { initialState, reduce, type WorkspaceState } from './state.ts'

const base = (): WorkspaceState => {
  let s = reduce(initialState(), {
    type: 'projects',
    projects: [project(), project({ id: P2, name: 'Beta', archived: false })],
  })
  s = reduce(s, { type: 'sessions', sessions: [session()] })
  return reduce(s, {
    type: 'providers',
    providers: [
      provider(),
      provider({ id: 'codex', label: 'Codex' }),
      provider({ id: 'gemini', label: 'Gemini', managedCaps: [] }),
      provider({ id: 'copilot', label: 'Off', enabled: false }),
    ],
  })
}

describe('paletteVM', () => {
  it('lists every command and one open-project entry per project', () => {
    const items = paletteItems(base())
    const labels = items.map((i) => i.label)
    for (const l of [
      'Create a project',
      'Start an agent',
      'Find a session',
      'Search memory',
      'Review approvals',
      'Inspect context',
      'Switch to 2D',
      'Switch to 3D',
      'Connect a provider',
      'Open project: Alpha',
      'Open project: Beta',
    ]) {
      expect(labels).toContain(l)
    }
    expect(labels).not.toContain('Continue work') // needs a current project
    const s = reduce(base(), { type: 'navigate', view: 'project', projectId: P1 })
    expect(paletteCommands(s).map((c) => c.id)).toContain('continue')
  })
  it('filters commands by every typed word', () => {
    let s = reduce(base(), { type: 'palette-open' })
    s = reduce(s, { type: 'palette-query', query: 'pixel mode' })
    expect(paletteItems(s).map((i) => i.label)).toEqual(['Switch to 2D'])
    s = reduce(s, { type: 'palette-query', query: 'zzz' })
    expect(paletteVM(s).items).toEqual([])
  })
  it('adds search hits only while querying, and maps each kind to an action', () => {
    let s = reduce(base(), { type: 'palette-open' })
    s = reduce(s, {
      type: 'palette-hits',
      hits: [
        {
          kind: 'message',
          id: 'm',
          projectId: P1,
          title: 'Login talk',
          snippet: '…login…',
          sessionId: 'ses_aaaaaaaaaa',
          messageId: 'm7',
        },
      ],
    })
    expect(paletteItems(s).some((i) => i.group === 'message')).toBe(false)
    s = reduce(s, { type: 'palette-query', query: 'login' })
    const hit = paletteItems(s).find((i) => i.group === 'message')!
    expect(hit.action).toEqual({
      type: 'open-session',
      sessionId: 'ses_aaaaaaaaaa',
      messageId: 'm7',
    })
    expect(hit.detail).toContain('login')
    const mk = (kind: 'project' | 'session' | 'memory' | 'handoff' | 'agent') =>
      hitAction({ kind, id: 'x', projectId: null, title: 't', snippet: '' })
    expect(mk('project')).toEqual({ type: 'open-project', projectId: 'x' })
    expect(mk('session')).toEqual({ type: 'open-session', sessionId: 'x' })
    expect(mk('memory')).toEqual({ type: 'open-memory', memoryId: 'x', projectId: undefined })
    expect(mk('handoff')).toEqual({ type: 'open-handoff', handoffId: 'x' })
    expect(mk('agent')).toEqual({ type: 'focus-agent', agentId: 'x' })
  })
  it('exactly one item is selected and the index is clamped', () => {
    let s = reduce(base(), { type: 'palette-open' })
    s = { ...s, palette: { ...s.palette, selected: 999 } }
    const vm = paletteVM(s)
    expect(vm.items.filter((i) => i.selected)).toHaveLength(1)
    expect(vm.items[vm.items.length - 1]?.selected).toBe(true)
    expect(paletteVM(initialState()).open).toBe(false)
  })
})

describe('handoffVM', () => {
  it('compose stage needs an objective and a provider', () => {
    let s = reduce(base(), {
      type: 'handoff',
      patch: { open: true, sessionId: 'ses_aaaaaaaaaa', provider: 'codex' },
    })
    let vm = handoffVM(s)
    expect(vm.stage).toBe('compose')
    expect(vm.preview.enabled).toBe(false)
    expect(vm.preview.hint).toBeTruthy()
    expect(vm.launch.enabled).toBe(false)
    expect(vm.fromLabel).toContain('Fix the login bug')
    expect(vm.providerOptions.map((p) => p.id)).toEqual(['claude-code', 'codex'])
    s = reduce(s, { type: 'handoff', patch: { objective: 'Do it' } })
    vm = handoffVM(s)
    expect(vm.preview.enabled).toBe(true)
  })
  it('review stage lists bundle items with checkboxes and tokens', () => {
    const s = reduce(base(), {
      type: 'handoff',
      patch: {
        open: true,
        sessionId: 'ses_aaaaaaaaaa',
        stage: 'review',
        handoff: handoff({ note: 'n' }),
      },
    })
    const vm = handoffVM(s)
    expect(vm.stage).toBe('review')
    expect(vm.items.map((i) => [i.id, i.included, i.toggleable])).toEqual([
      ['mem_aaaaaaaaaa', true, true],
      ['mem_bbbbbbbbbb', true, true],
      ['sum_1', true, false],
    ])
    expect(vm.tokens).toMatchObject({ used: 100, label: 'About 100 tokens', budgetChars: 8000 })
    expect(vm.launch.enabled).toBe(true)
    expect(vm.note).toBe('n')
    expect(vm.fromLabel).toBe('From "Fix the login bug" (claude-code)')
    expect(vm.objective).toBe('Finish the tests')
  })
  it('launched handoffs cannot launch again; empty bundle shows its empty state', () => {
    const s = reduce(base(), {
      type: 'handoff',
      patch: { open: true, handoff: handoff({ state: 'launched' }) },
    })
    const vm = handoffVM(s)
    expect(vm.launch.enabled).toBe(false)
    expect(vm.launch.hint).toBeTruthy()
    expect(vm.itemsEmpty).toBeTruthy()
  })
  it('only enabled providers with a managed runtime are offered', () => {
    expect(handoffProviders([provider({ managedCaps: [] }), provider({ enabled: false })])).toEqual(
      [],
    )
  })
})

describe('newProjectVM / projectDirectoryVM', () => {
  it('create needs a name; folders capped at 8', () => {
    let s = initialState()
    expect(newProjectVM(s).create.enabled).toBe(false)
    s = reduce(s, {
      type: 'new-project',
      patch: {
        open: true,
        name: ' Gamma ',
        folders: [{ ref: 'ctx_aaaaaaaaaaaa', label: 'repo', hint: '~/repo' }],
      },
    })
    const vm = newProjectVM(s)
    expect(vm.create.enabled).toBe(true)
    expect(vm.folders).toHaveLength(1)
    expect(vm.addFolder.enabled).toBe(true)
    const full = reduce(s, {
      type: 'new-project',
      patch: {
        folders: Array.from({ length: 8 }, (_, i) => ({ ref: `ctx_${i}`, label: 'l', hint: 'h' })),
      },
    })
    expect(newProjectVM(full).addFolder.enabled).toBe(false)
  })
  it('directory lists active projects with counts and the five actions', () => {
    const vm = projectDirectoryVM([project(), project({ id: P2, archived: true })], P1)
    expect(vm.entries).toHaveLength(1)
    expect(vm.entries[0]).toMatchObject({
      projectId: P1,
      selected: true,
      counts: { agents: 2, sessions: 3, memories: 4, pending: 1, tasks: 2 },
    })
    expect(vm.entries[0]?.countsLabel).toBe('2 active, 3 sessions, 4 memory, 1 pending')
    expect(vm.entries[0]?.actions.map((a) => a.id)).toEqual([
      'dashboard',
      'memory',
      'sessions',
      'context',
      'start',
    ])
    expect(projectDirectoryVM([], null).entries).toEqual([])
  })
})

describe('palette deep search additions', () => {
  const hit = (id: string, messageId?: string) =>
    ({ kind: 'message', id, projectId: null, title: id, snippet: '', messageId }) as never
  it('merges later hits after the earlier ones and drops duplicates', () => {
    const merged = mergeHits(
      [hit('a', 'm1'), hit('b', 'm1')],
      [hit('b', 'm1'), hit('b', 'm2'), hit('c', 'm1')],
    )
    expect(merged.map((h) => `${h.id}:${h.messageId}`)).toEqual(['a:m1', 'b:m1', 'b:m2', 'c:m1'])
  })
  it('has an Import Claude history command', () => {
    const cmd = paletteCommands({ projects: [], projectId: null }).find(
      (c) => c.id === 'import-history',
    )!
    expect(cmd.action).toEqual({ type: 'import-history' })
    expect(cmd.label).toMatch(/experimental/i)
  })
})
