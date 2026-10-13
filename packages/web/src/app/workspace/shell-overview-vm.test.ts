import { describe, expect, it } from 'vitest'
import { NOW, P1, P2, overview, project, provider } from './__fixtures__/projects.ts'
import { healthVM, notificationCount, shellVM } from './shell-vm.ts'
import { overviewVM } from './overview-vm.ts'
import { initialState, reduce, type WorkspaceState } from './state.ts'
import { WS_COPY } from './workspace-copy.ts'

const loaded = (): WorkspaceState => {
  let s = initialState()
  s = reduce(s, {
    type: 'projects',
    projects: [project(), project({ id: P2, name: 'Beta', activeAgents: 0, archived: false })],
  })
  s = reduce(s, { type: 'overview', overview: overview() })
  s = reduce(s, { type: 'providers', providers: [provider()] })
  return s
}

describe('shellVM', () => {
  it('lists sidebar items with the active one and attention counts', () => {
    const s = reduce(loaded(), { type: 'navigate', view: 'sessions' })
    const vm = shellVM(s)
    expect(vm.sidebar.map((i) => i.id)).toEqual(['overview', 'office', 'sessions', 'memory'])
    expect(vm.sidebar.find((i) => i.active)?.id).toBe('sessions')
    expect(vm.sidebar.find((i) => i.id === 'sessions')?.count).toBe(2)
    expect(vm.sidebar.find((i) => i.id === 'memory')?.count).toBe(3)
    expect(vm.stageVisible).toBe(false)
  })
  it('project views activate no sidebar item; the Office shows the stage', () => {
    const s = reduce(loaded(), { type: 'navigate', view: 'project', projectId: P1 })
    expect(shellVM(s).sidebar.some((i) => i.active)).toBe(false)
    expect(shellVM(reduce(s, { type: 'navigate', view: 'office' })).stageVisible).toBe(true)
  })
  it('project list carries ids, active counts and the active flag; archived hidden', () => {
    let s = reduce(loaded(), { type: 'navigate', view: 'project', projectId: P1 })
    s = reduce(s, { type: 'projects', projects: [project(), project({ id: P2, archived: true })] })
    const vm = shellVM(s)
    expect(vm.projects).toHaveLength(1)
    expect(vm.projects[0]).toMatchObject({ projectId: P1, count: 2, active: true, pending: 1 })
    expect(vm.topbar.currentProject).toMatchObject({ id: P1, name: 'Alpha' })
    expect(vm.topbar.projectLabel).toBe('Alpha')
  })
  it('empty states and top bar basics', () => {
    const vm = shellVM(initialState())
    expect(vm.projectsEmpty).toBe(WS_COPY.projectsEmpty)
    expect(vm.topbar.projectLabel).toBe(WS_COPY.noProject)
    expect(vm.topbar.notifications).toBe(0)
    expect(vm.topbar.vault.status).toBe('unknown')
    expect(vm.topbar.health.label).toBe(WS_COPY.health.none.label)
    expect(vm.topbar.notificationsLabel).toBe(WS_COPY.notifications(0))
  })
  it('notification count = waiting agents + pending approvals; vault tones', () => {
    const s = loaded()
    expect(notificationCount(s)).toBe(4)
    expect(notificationCount({ overview: null })).toBe(0)
    expect(shellVM(s).topbar.vault).toMatchObject({ status: 'encrypted', tone: 'good' })
    expect(
      shellVM(reduce(s, { type: 'push', msg: { type: 'vault', status: 'memory-only' } })).topbar
        .vault.tone,
    ).toBe('warn')
    expect(WS_COPY.notifications(1)).toContain('1 item ')
  })
  it('health pill: ok, warn with names, none for disabled providers', () => {
    expect(healthVM([provider()]).tone).toBe('good')
    const bad = healthVM([
      provider(),
      provider({ id: 'codex', label: 'Codex', state: 'needs-auth' }),
    ])
    expect(bad.tone).toBe('warn')
    expect(bad.detail).toContain('Codex')
    expect(healthVM([provider({ enabled: false })]).tone).toBe('neutral')
  })
})

describe('shellVM layout', () => {
  it('carries the collapsed flag and keeps the New Agent label here', () => {
    expect(shellVM(initialState()).layout).toEqual({ sidebarCollapsed: false })
    const vm = shellVM(initialState(), { sidebarCollapsed: true })
    expect(vm.layout.sidebarCollapsed).toBe(true)
    expect(vm.topbar.newAgentLabel).toBe('New Agent')
  })
})

describe('overviewVM', () => {
  it('has every section with cards and actions', () => {
    const vm = overviewVM(loaded(), NOW)
    expect(vm.sections.map((x) => x.id)).toEqual([
      'attention',
      'approvals',
      'handoffs',
      'projects',
      'completions',
      'decisions',
      'providers',
    ])
    const by = (id: string) => vm.sections.find((x) => x.id === id)!
    expect(by('attention').items[0]?.action).toEqual({ type: 'focus-agent', agentId: 'cc:1' })
    expect(by('attention').items.some((i) => i.id === 'unassigned')).toBe(true)
    expect(by('approvals').items[0]?.action).toEqual({ type: 'review-approvals' })
    expect(by('handoffs').items[0]?.action).toEqual({
      type: 'open-handoff',
      handoffId: 'hof_aaaaaaaaaa',
    })
    expect(by('projects').items.map((i) => i.title)).toEqual(['Alpha'])
    expect(by('completions').items).toHaveLength(1)
    expect(by('decisions').items[0]?.action).toMatchObject({
      type: 'open-memory',
      memoryId: 'mem_aaaaaaaaaa',
    })
    expect(by('providers').items[0]?.action).toBeUndefined()
  })
  it('empty states before the overview loads', () => {
    const vm = overviewVM(reduce(initialState(), { type: 'loading', on: true }), NOW)
    expect(vm.loading).toBe(true)
    for (const sec of vm.sections) {
      expect(sec.items).toEqual([])
      expect(sec.empty.length).toBeGreaterThan(0)
    }
    expect(vm.noProjects).toBe(false)
  })
  it('offers the create-first-project card once projects are known to be empty', () => {
    const s = reduce(initialState(), { type: 'projects', projects: [] })
    const vm = overviewVM(s, NOW)
    expect(vm.noProjects).toBe(true)
    expect(vm.createProject.action).toEqual({ type: 'new-project' })
  })
  it('warns with a connect action for a provider needing auth; surfaces errors', () => {
    let s = reduce(loaded(), { type: 'providers', providers: [provider({ state: 'needs-auth' })] })
    s = reduce(s, { type: 'error', error: 'nope' })
    const vm = overviewVM(s, NOW)
    expect(vm.sections.find((x) => x.id === 'providers')?.items[0]?.action).toEqual({
      type: 'connect-provider',
    })
    expect(vm.error).toBe('nope')
  })
  it('no approval card when nothing is pending; names unknown projects safely', () => {
    const s = reduce(loaded(), {
      type: 'overview',
      overview: overview({
        pendingApprovals: 0,
        unassignedSessions: 0,
        waiting: [{ agentId: 'x', name: 'X', provider: 'p', projectId: null }],
      }),
    })
    const vm = overviewVM(s, NOW)
    expect(vm.sections.find((x) => x.id === 'approvals')?.items).toEqual([])
    expect(vm.sections[0]?.items[0]?.detail).toContain('No project')
  })
})

describe('overview provider health', () => {
  it('lists a provider that needs attention in the attention section with a Connect action', () => {
    const s = reduce(loaded(), {
      type: 'providers',
      providers: [provider({ state: 'needs-auth' })],
    })
    const card = overviewVM(s, NOW).sections[0]!.items.find((i) => i.id === 'provider:claude-code')!
    expect(card).toMatchObject({
      tone: 'warn',
      action: { type: 'connect-provider' },
      actionLabel: 'Connect',
    })
  })
})
