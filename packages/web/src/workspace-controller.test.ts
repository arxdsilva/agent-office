import {
  DEFAULT_SETTINGS,
  type AgentOfficeApi,
  type ProjectMessage,
  type Settings,
} from '@agent-office/shared'
import { describe, expect, it, vi } from 'vitest'
import {
  NOW,
  P1,
  P2,
  dashboard,
  handoff,
  memory,
  overview,
  project,
  provider,
  session,
} from './app/workspace/__fixtures__/projects.ts'
import {
  detail,
  effective,
  inspection,
  preview,
  report,
  summary,
} from './app/workspace/__fixtures__/harness.ts'
import type { PaletteVM } from './app/workspace/types.ts'
import { createWorkspaceController } from './workspace-controller.ts'
import type { WorkspaceViews, WorkspaceSceneHooks } from './workspace-ports.ts'

type Fn = (...a: never[]) => unknown
/** A view that records its latest VM and exposes the registered callbacks. */
function fakeView(): any {
  const cbs: Record<string, Fn> = {}
  const calls: unknown[] = []
  return new Proxy(
    { cbs, calls, last: undefined as unknown },
    {
      get(t: any, k: string) {
        if (k in t) return t[k]
        if (k === 'render')
          return (vm: unknown) => {
            t.last = vm
            calls.push(vm)
          }
        return (fn: Fn) => {
          cbs[k] = fn
        }
      },
    },
  )
}

function setup(over: { settings?: Partial<Settings>; gateway?: Record<string, unknown> } = {}) {
  let push: (m: ProjectMessage) => void = () => {}
  let connChange: () => void = () => {}
  const unsub = vi.fn()
  const projects = {
    overview: vi.fn(async () => overview()),
    list: vi.fn(async () => [project(), project({ id: P2, name: 'Beta' })]),
    dashboard: vi.fn(async (id: string) => dashboard({ project: { ...dashboard().project, id } })),
    create: vi.fn(async (a: { name: string }) => project({ id: 'prj_cccccccccc', name: a.name })),
    sessions: vi.fn(async () => [session(), session({ id: 'ses_cccccccccc', projectId: null })]),
    messages: vi.fn(async () => ({
      messages: [{ id: 'm1', role: 'user' as const, text: 'hi', ts: NOW, source: 'chat' as const }],
      more: false,
    })),
    assign: vi.fn(async (id: string, pid: string | null) => session({ id, projectId: pid })),
    memories: vi.fn(async ({ scope }: { scope: string }) =>
      scope === P1
        ? [
            memory(),
            memory({ id: 'mem_bbbbbbbbbb', state: 'pending' }),
            memory({ id: 'mem_eeeeeeeeee' }),
          ]
        : [],
    ),
    reviewMemory: vi.fn(async (id: string, a: string) =>
      memory({ id, state: a === 'approve' ? 'approved' : 'rejected' }),
    ),
    editMemory: vi.fn(async (a: { memoryId: string }) =>
      memory({ id: a.memoryId, title: 'Edited' }),
    ),
    supersedeMemory: vi.fn(async () => memory({ id: 'mem_ffffffffff' })),
    mergeMemories: vi.fn(async () => memory({ id: 'mem_gggggggggg' })),
    inspect: vi.fn(async (agentId: string) => ({
      agentId,
      projectId: P1,
      available: 3,
      retrieved: [],
      delivered: [],
    })),
    prepareHandoff: vi.fn(async () => handoff()),
    updateHandoff: vi.fn(async (a: { include?: string[]; note?: string }) =>
      handoff({
        note: a.note ?? '',
        bundle: {
          ...handoff().bundle,
          items: handoff().bundle.items.map((i) => ({
            ...i,
            included: !a.include || a.include.includes(i.ref.id) || i.ref.kind !== 'memory',
          })),
        },
      }),
    ),
    launchHandoff: vi.fn(async () => ({ ok: true as const, agentId: 'cx:9' })),
    search: vi.fn(async () => [
      {
        kind: 'message' as const,
        id: 'm',
        projectId: P1,
        title: 'Hit',
        snippet: 'snip',
        sessionId: 'ses_aaaaaaaaaa',
        messageId: 'm1',
      },
    ]),
    createTask: vi.fn(async () => ({})),
    updateTask: vi.fn(async () => ({})),
    importHistory: vi.fn(async () => ({ imported: 3, skipped: 1 })),
    resumeSession: vi.fn(async () => ({ ok: true as const, agentId: 'cc:77' })),
    removeImported: vi.fn(async () => ({ removed: 2 })),
    importStatus: vi.fn(async () => ({
      on: true,
      lastRunAt: NOW - 5 * 60_000,
      imported: 4,
      added: 3,
    })),
    createMemory: vi.fn(async (d: { title: string }) =>
      memory({ id: 'mem_iiiiiiiiii', title: d.title }),
    ),
    onPush: vi.fn((cb: (m: ProjectMessage) => void) => {
      push = cb
      return unsub
    }),
    harness: {
      list: vi.fn(async () => [summary({ projectIds: [P1] })]),
      get: vi.fn(async () => detail()),
      templates: vi.fn(async () => [
        { id: 'basic', name: 'Basic', description: 'Starter', ruleCount: 2, gateCount: 0 },
      ]),
      create: vi.fn(async () => detail({ status: 'draft', version: 1 })),
      createFromTemplate: vi.fn(async () => detail({ status: 'draft', version: 1 })),
      update: vi.fn(async () => detail({ name: 'Renamed' })),
      publish: vi.fn(async () => detail()),
      archive: vi.fn(async () => detail({ status: 'archived' })),
      attach: vi.fn(async () => [summary({ projectIds: [P1] })]),
      detach: vi.fn(async () => []),
      importDetect: vi.fn(async () => preview().sources),
      importPreview: vi.fn(async () => preview()),
      importCommit: vi.fn(async () => detail({ status: 'draft', version: 1 })),
      coverage: vi.fn(async (_p: string, provider: string) => ({
        effective: effective(),
        report: report({ provider: provider as never }),
      })),
      inspect: vi.fn(async (agentId: string) => inspection({ agentId })),
      runGates: vi.fn(async () => []),
      cancelGates: vi.fn(async () => {}),
      badges: vi.fn(async () => []),
    },
  }
  const gateway = {
    projects,
    providers: { list: vi.fn(async () => [provider(), provider({ id: 'codex', label: 'Codex' })]) },
    connections: {
      onChange: vi.fn((cb: () => void) => {
        connChange = cb
        return unsub
      }),
    },
    context: {
      pick: vi.fn(async () => [
        { ref: 'ctx_aaaaaaaaaaaa', kind: 'folder' as const, label: 'repo', hint: '~/repo' },
      ]),
    },
    ...over.gateway,
  } as unknown as AgentOfficeApi
  const names = [
    'shell',
    'overview',
    'dashboard',
    'sessions',
    'memory',
    'inspector',
    'palette',
    'newProject',
    'handoff',
    'harness',
  ] as const
  const v = Object.fromEntries(names.map((n) => [n, fakeView()])) as Record<
    (typeof names)[number],
    any
  >
  const scene: WorkspaceSceneHooks = {
    select: vi.fn(),
    focusAgents: vi.fn(),
    setOfficeVisible: vi.fn(),
    openNewSession: vi.fn(),
    switchMode: vi.fn(),
    openConnect: vi.fn(),
  }
  const timers: (() => void)[] = []
  const ctl = createWorkspaceController({
    schedule: (fn) => {
      timers.push(fn)
      return () => {
        const i = timers.indexOf(fn)
        if (i >= 0) timers.splice(i, 1)
      }
    },
    gateway,
    views: v as unknown as WorkspaceViews,
    scene,
    settings: () => ({ ...DEFAULT_SETTINGS, ...over.settings }),
    clock: { now: () => NOW },
  })
  const cb = (view: keyof typeof v, name: string) =>
    v[view].cbs[name] as (...a: unknown[]) => unknown
  return {
    ctl,
    v,
    scene,
    projects,
    gateway,
    cb,
    timers,
    push: (m: ProjectMessage) => push(m),
    connChange: () => connChange(),
    unsub,
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('start', () => {
  it('opens the Overview with projects (auto) and hides the office', async () => {
    const t = setup()
    await t.ctl.start()
    expect(t.ctl.getState().view).toBe('overview')
    expect(t.scene.setOfficeVisible).toHaveBeenLastCalledWith(false)
    expect(
      t.v.overview.last.sections.find((s: any) => s.id === 'attention').items.length,
    ).toBeGreaterThan(0)
    expect(t.v.shell.last.projects.map((p: any) => p.projectId)).toEqual([P1, P2])
    expect(t.v.shell.last.topbar.health.tone).toBe('good')
  })
  it('opens the Office with no projects, and honours startView=office', async () => {
    const empty = setup({
      gateway: {
        projects: {
          ...setup().projects,
          list: async () => [],
          overview: async () => overview({ projects: [] }),
          onPush: () => () => {},
        },
      },
    })
    await empty.ctl.start()
    expect(empty.ctl.getState().view).toBe('office')
    expect(empty.scene.setOfficeVisible).toHaveBeenLastCalledWith(true)
    const forced = setup({ settings: { startView: 'office' } })
    await forced.ctl.start()
    expect(forced.ctl.getState().view).toBe('office')
  })
  it('a failing gateway becomes an error string, not a throw', async () => {
    const t = setup()
    t.projects.list.mockRejectedValue(new Error('vault locked'))
    t.projects.overview.mockRejectedValue(new Error('vault locked'))
    await expect(t.ctl.start()).resolves.toBeUndefined()
    expect(t.ctl.getState().error).toBe('vault locked')
    expect(t.ctl.getState().view).toBe('office')
  })
  it('dispose unsubscribes and stops rendering', async () => {
    const t = setup()
    await t.ctl.start()
    t.ctl.dispose()
    expect(t.unsub).toHaveBeenCalled()
    const n = t.v.shell.calls.length
    t.push({ type: 'vault', status: 'memory-only' })
    expect(t.v.shell.calls.length).toBe(n)
  })
})

describe('navigation', () => {
  it('sidebar targets fetch their data and toggle the stage', async () => {
    const t = setup()
    await t.ctl.start()
    await t.cb('shell', 'onNavigate')('office')
    await flush()
    expect(t.scene.setOfficeVisible).toHaveBeenLastCalledWith(true)
    await t.cb('shell', 'onNavigate')('sessions')
    await flush()
    expect(t.scene.setOfficeVisible).toHaveBeenLastCalledWith(false)
    expect(t.projects.sessions).toHaveBeenCalledWith({ scope: undefined, query: undefined })
    expect(t.v.sessions.last.groups.length).toBeGreaterThan(0)
    await t.cb('shell', 'onNavigate')('memory')
    await flush()
    expect(t.projects.memories).toHaveBeenCalledTimes(4) // two projects + global + unassigned
    await t.cb('shell', 'onNavigate')('overview')
    await flush()
    expect(t.ctl.getState().view).toBe('overview')
  })
  it('selecting a project opens its dashboard; sessions and memory then scope to it', async () => {
    const t = setup()
    await t.ctl.start()
    await t.cb('shell', 'onSelectProject')(P1)
    await flush()
    expect(t.v.dashboard.last.projectId).toBe(P1)
    expect(t.v.dashboard.last.sections).toHaveLength(5)
    await t.cb('shell', 'onNavigate')('sessions')
    await flush()
    expect(t.projects.sessions).toHaveBeenLastCalledWith({ scope: P1, query: undefined })
    await t.cb('shell', 'onNavigate')('memory')
    await flush()
    expect(t.projects.memories).toHaveBeenLastCalledWith({ scope: P1 })
    expect(t.v.shell.last.topbar.currentProject.name).toBe('Alpha')
  })
  it('dashboard is not rendered outside the project view', async () => {
    const t = setup()
    await t.ctl.start()
    expect(t.v.dashboard.last).toBeNull()
  })
  it('leaving the office clears agent focus; notifications go to the Overview', async () => {
    const t = setup({ settings: { startView: 'office' } })
    await t.ctl.start()
    await t.cb('shell', 'onNotifications')()
    await flush()
    expect(t.ctl.getState().view).toBe('overview')
    expect(t.scene.focusAgents).toHaveBeenCalledWith(null)
  })
  it('top bar: new agent prefills the current project; health opens Connect', async () => {
    const t = setup()
    await t.ctl.start()
    await t.cb('shell', 'onSelectProject')(P2)
    await flush()
    t.cb('shell', 'onNewAgent')()
    expect(t.scene.openNewSession).toHaveBeenCalledWith({ projectId: P2 })
    t.cb('shell', 'onHealth')()
    expect(t.scene.openConnect).toHaveBeenCalled()
  })
  it('a dashboard failure shows the error in the VM', async () => {
    const t = setup()
    await t.ctl.start()
    t.projects.dashboard.mockRejectedValue(new Error('gone'))
    await t.ctl.navigate('project', 'prj_zzzzzzzzzz')
    expect(t.v.dashboard.last.error).toBe('gone')
  })
  it('context view without an agent stops loading', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.navigate('context')
    expect(t.ctl.getState().loading).toBe(false)
    expect(t.v.inspector.last.agentId).toBeNull()
  })
})

describe('sidebar collapse', () => {
  it('renders the persisted layout and saves changes through settings.set', async () => {
    const set = vi.fn(async () => ({ ok: true }))
    const t = setup({
      settings: { layout: { sidebarCollapsed: true } },
      gateway: { settings: { set } },
    })
    await t.ctl.start()
    expect(t.v.shell.last.layout.sidebarCollapsed).toBe(true)
    await t.cb('shell', 'onCollapse')(false)
    await flush()
    expect(set).toHaveBeenCalledWith({ layout: { sidebarCollapsed: false } })
    expect(t.v.shell.last.layout.sidebarCollapsed).toBe(false)
  })
  it('a failed save shows the error', async () => {
    const set = vi.fn(async () => {
      throw new Error('disk full')
    })
    const t = setup({ gateway: { settings: { set } } })
    await t.ctl.start()
    await t.cb('shell', 'onCollapse')(true)
    await flush()
    expect(t.ctl.getState().error).toBe('disk full')
  })
})

describe('dashboard actions', () => {
  it('Start agent opens the New Agent flow with the project', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'start-agent', projectId: P1 })
    expect(t.scene.openNewSession).toHaveBeenCalledWith({ projectId: P1 })
  })
  it('Review approvals opens memory filtered to pending', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'review-approvals', projectId: P1 })
    expect(t.ctl.getState().memoryFilter).toBe('pending')
    expect(t.v.memory.last.rows.map((r: any) => r.id)).toEqual(['mem_bbbbbbbbbb'])
  })
  it('Open memory selects the item; Search history opens sessions', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'open-memory', projectId: P1, memoryId: 'mem_eeeeeeeeee' })
    expect(t.v.memory.last.detail.id).toBe('mem_eeeeeeeeee')
    await t.ctl.perform({ type: 'search-history', projectId: P1 })
    expect(t.ctl.getState().view).toBe('sessions')
  })
  it('Inspect context picks the first active agent of the project', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'inspect-context', projectId: P1 })
    expect(t.projects.inspect).toHaveBeenCalledWith('cc:1')
    expect(t.v.inspector.last.available.summary).toContain('3 approved items')
    await t.ctl.perform({ type: 'inspect-context', agentId: 'cc:2' })
    expect(t.projects.inspect).toHaveBeenLastCalledWith('cc:2')
    t.cb('inspector', 'onRefresh')()
    await flush()
    expect(t.projects.inspect).toHaveBeenCalledTimes(3)
  })
  it('focus-agent shows the office and selects; connect and mode go to the scene', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'focus-agent', agentId: 'cc:1' })
    expect(t.scene.select).toHaveBeenCalledWith('cc:1')
    expect(t.ctl.getState().view).toBe('office')
    await t.ctl.perform({ type: 'connect-provider' })
    expect(t.scene.openConnect).toHaveBeenCalled()
    await t.ctl.perform({ type: 'switch-mode', mode: 'pixel' })
    expect(t.scene.switchMode).toHaveBeenCalledWith('pixel')
  })
  it('overview actions route through perform; activity filter is applied', async () => {
    const t = setup()
    await t.ctl.start()
    await t.cb('overview', 'onAction')({ type: 'open-project', projectId: P1 })
    await flush()
    expect(t.ctl.getState().view).toBe('project')
    t.cb('dashboard', 'onActivityFilter')('problems')
    expect(t.v.dashboard.last.sections[1].rows.map((r: any) => r.id)).toEqual(['act3'])
    await t.cb('dashboard', 'onAction')({ type: 'open-overview' })
    await flush()
    expect(t.ctl.getState().view).toBe('overview')
    await t.ctl.perform({ type: 'open-office' })
    expect(t.ctl.getState().view).toBe('office')
  })
})

describe('palette', () => {
  it('Ctrl/Cmd+K toggles it; Esc closes the topmost dialog', async () => {
    const t = setup()
    await t.ctl.start()
    t.ctl.togglePalette()
    expect(t.v.palette.last.open).toBe(true)
    expect(t.ctl.escape()).toBe(true)
    expect(t.v.palette.last.open).toBe(false)
    expect(t.ctl.escape()).toBe(false)
    t.ctl.togglePalette()
    t.ctl.togglePalette()
    expect(t.ctl.getState().palette.open).toBe(false)
    t.cb('shell', 'onOpenPalette')()
    expect(t.ctl.getState().palette.open).toBe(true)
    t.cb('palette', 'onClose')()
    expect(t.ctl.getState().palette.open).toBe(false)
  })
  it('typing searches; message hits open the session at that message', async () => {
    const t = setup()
    await t.ctl.start()
    t.ctl.openPalette()
    t.cb('palette', 'onQuery')('login')
    await flush()
    expect(t.projects.search).toHaveBeenCalledWith({
      query: 'login',
      projectId: undefined,
      deep: false,
    })
    const vm = t.v.palette.last as PaletteVM
    const hit = vm.items.find((i) => i.group === 'message')!
    t.cb('palette', 'onChoose')(hit.id)
    await flush()
    await flush()
    expect(t.ctl.getState().palette.open).toBe(false)
    expect(t.ctl.getState().view).toBe('sessions')
    expect(t.ctl.getState().selectedSessionId).toBe('ses_aaaaaaaaaa')
    expect(t.v.sessions.last.detail.messages[0].highlighted).toBe(true)
    expect(t.projects.messages).toHaveBeenLastCalledWith({
      sessionId: 'ses_aaaaaaaaaa',
      limit: 200,
    })
  })
  it('keyboard: arrows move, Enter runs the selected command', async () => {
    const t = setup()
    await t.ctl.start()
    t.ctl.openPalette()
    t.cb('palette', 'onQuery')('connect')
    await flush()
    t.ctl.paletteMove(1)
    t.ctl.paletteMove(-1)
    await t.ctl.paletteChoose()
    expect(t.scene.openConnect).toHaveBeenCalled()
    await t.ctl.paletteChoose('nope')
  })
  it('an empty query clears hits without searching; stale results are dropped', async () => {
    const t = setup()
    await t.ctl.start()
    t.ctl.openPalette()
    t.cb('palette', 'onQuery')(' ')
    await flush()
    expect(t.projects.search).not.toHaveBeenCalled()
    let resolve: (v: never[]) => void = () => {}
    t.projects.search.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r as never
        }),
    )
    t.cb('palette', 'onQuery')('abc')
    t.ctl.closePalette()
    resolve([{ kind: 'project', id: P1 } as never])
    await flush()
    expect(t.ctl.getState().palette.hits).toEqual([])
  })
  it('New project from the palette opens the dialog', async () => {
    const t = setup()
    await t.ctl.start()
    t.ctl.openPalette()
    await t.ctl.paletteChoose('cmd:new-project')
    expect(t.ctl.getState().newProject.open).toBe(true)
  })
})

describe('sessions', () => {
  it('assign is explicit, updates the list; search and scope refetch; select loads messages', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'open-sessions' })
    expect(t.projects.assign).not.toHaveBeenCalled()
    await t.cb('sessions', 'onAssign')('ses_cccccccccc', P2)
    await flush()
    expect(t.projects.assign).toHaveBeenCalledWith('ses_cccccccccc', P2)
    expect(t.ctl.getState().sessions.find((s) => s.id === 'ses_cccccccccc')?.projectId).toBe(P2)
    t.cb('sessions', 'onSearch')('bug')
    await flush()
    expect(t.projects.sessions).toHaveBeenLastCalledWith({ scope: undefined, query: 'bug' })
    t.cb('sessions', 'onScope')('unassigned')
    await flush()
    expect(t.projects.sessions).toHaveBeenLastCalledWith({ scope: 'unassigned', query: 'bug' })
    t.cb('sessions', 'onSelect')('ses_cccccccccc')
    await flush()
    expect(t.ctl.getState().selectedSessionId).toBe('ses_cccccccccc')
    t.cb('sessions', 'onLoadMore')('ses_cccccccccc')
    await flush()
    expect(t.projects.messages).toHaveBeenLastCalledWith({
      sessionId: 'ses_cccccccccc',
      limit: 200,
    })
    t.cb('sessions', 'onResume')('ses_cccccccccc') // experimental: no-op
  })
  it('assign failure shows the error', async () => {
    const t = setup()
    await t.ctl.start()
    t.projects.assign.mockRejectedValue(new Error('denied'))
    await t.cb('sessions', 'onAssign')('ses_cccccccccc', P2)
    await flush()
    expect(t.v.sessions.last.error).toBe('denied')
  })
})

describe('memory review', () => {
  async function inMemory() {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'open-memory', projectId: P1 })
    return t
  }
  it('approve and reject update the item', async () => {
    const t = await inMemory()
    await t.cb('memory', 'onApprove')('mem_bbbbbbbbbb')
    await flush()
    expect(t.projects.reviewMemory).toHaveBeenCalledWith('mem_bbbbbbbbbb', 'approve')
    expect(t.ctl.getState().memories.find((m) => m.id === 'mem_bbbbbbbbbb')?.state).toBe('approved')
    await t.cb('memory', 'onReject')('mem_bbbbbbbbbb')
    await flush()
    expect(t.ctl.getState().memories.find((m) => m.id === 'mem_bbbbbbbbbb')?.state).toBe('rejected')
  })
  it('edit sends only the changed fields (title, scope)', async () => {
    const t = await inMemory()
    await t.cb('memory', 'onEdit')('mem_aaaaaaaaaa', { title: 'New', scope: 'global' })
    await flush()
    expect(t.projects.editMemory).toHaveBeenCalledWith({
      memoryId: 'mem_aaaaaaaaaa',
      title: 'New',
      scope: 'global',
    })
    expect(t.ctl.getState().memories.find((m) => m.id === 'mem_aaaaaaaaaa')?.title).toBe('Edited')
  })
  it('supersede keeps the project and selects the replacement', async () => {
    const t = await inMemory()
    const repl = { title: 'T', body: 'B', kind: 'decision' as const, scope: 'project' as const }
    await t.cb('memory', 'onSupersede')('mem_aaaaaaaaaa', repl)
    await flush()
    expect(t.projects.supersedeMemory).toHaveBeenCalledWith('mem_aaaaaaaaaa', {
      projectId: P1,
      ...repl,
      from: undefined,
    })
    expect(t.ctl.getState().selectedMemoryId).toBe('mem_ffffffffff')
    await t.cb('memory', 'onSupersede')('mem_unknown', repl)
    await flush()
    expect(t.projects.supersedeMemory).toHaveBeenCalledTimes(1)
  })
  it('merge needs two checked approved items', async () => {
    const t = await inMemory()
    const into = { title: 'M', body: 'B', kind: 'note' as const, scope: 'project' as const }
    await t.cb('memory', 'onMerge')(into)
    await flush()
    expect(t.projects.mergeMemories).not.toHaveBeenCalled()
    t.cb('memory', 'onToggleCheck')('mem_aaaaaaaaaa')
    t.cb('memory', 'onToggleCheck')('mem_eeeeeeeeee')
    await t.cb('memory', 'onMerge')(into)
    await flush()
    expect(t.projects.mergeMemories).toHaveBeenCalledWith(
      ['mem_aaaaaaaaaa', 'mem_eeeeeeeeee'],
      expect.objectContaining({ projectId: P1, title: 'M' }),
    )
    expect(t.ctl.getState().checkedMemoryIds).toEqual([])
  })
  it('select, scope, filter and search drive the VM; failures surface', async () => {
    const t = await inMemory()
    t.cb('memory', 'onSelect')('mem_aaaaaaaaaa')
    t.cb('memory', 'onFilter')('approved')
    t.cb('memory', 'onSearch')('zod')
    expect(t.v.memory.last.detail.id).toBe('mem_aaaaaaaaaa')
    t.cb('memory', 'onScope')(P2)
    await flush()
    expect(t.projects.memories).toHaveBeenLastCalledWith({ scope: P2 })
    t.projects.reviewMemory.mockRejectedValue(new Error('locked'))
    await t.cb('memory', 'onApprove')('mem_aaaaaaaaaa')
    await flush()
    expect(t.v.memory.last.error).toBe('locked')
  })
  it('a pushed proposal appears live in the open list', async () => {
    const t = await inMemory()
    t.push({
      type: 'memory',
      memory: memory({
        id: 'mem_hhhhhhhhhh',
        state: 'pending',
        provenance: { origin: 'agent-proposal', createdAt: NOW },
      }),
    })
    expect(
      t.v.memory.last.rows
        .find((r: any) => r.id === 'mem_hhhhhhhhhh')
        .badges.map((b: any) => b.label),
    ).toContain('agent-proposed')
  })
})

describe('new project', () => {
  it('picks folders through the native picker, then creates and opens the dashboard', async () => {
    const t = setup()
    await t.ctl.start()
    await t.cb('shell', 'onNewProject')()
    expect(t.v.newProject.last.open).toBe(true)
    t.cb('newProject', 'onName')('Gamma')
    await t.cb('newProject', 'onAddFolder')()
    await flush()
    await t.cb('newProject', 'onAddFolder')()
    await flush() // duplicates ignored
    expect(t.v.newProject.last.folders).toHaveLength(1)
    await t.cb('newProject', 'onCreate')()
    await flush()
    expect(t.projects.create).toHaveBeenCalledWith({ name: 'Gamma', folders: ['ctx_aaaaaaaaaaaa'] })
    expect(t.ctl.getState().newProject.open).toBe(false)
    expect(t.ctl.getState().projectId).toBe('prj_cccccccccc')
    expect(t.ctl.getState().view).toBe('project')
  })
  it('removing a folder, cancelling, empty names and failures', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'new-project' })
    await t.cb('newProject', 'onCreate')()
    await flush()
    expect(t.projects.create).not.toHaveBeenCalled()
    await t.cb('newProject', 'onAddFolder')()
    await flush()
    t.cb('newProject', 'onRemoveFolder')('ctx_aaaaaaaaaaaa')
    expect(t.v.newProject.last.folders).toEqual([])
    t.cb('newProject', 'onName')('X')
    t.projects.create.mockRejectedValue(new Error('exists'))
    await t.cb('newProject', 'onCreate')()
    await flush()
    expect(t.v.newProject.last.error).toBe('exists')
    expect(t.ctl.getState().newProject.open).toBe(true)
    expect(t.ctl.escape()).toBe(true)
    expect(t.ctl.getState().newProject.open).toBe(false)
    await t.ctl.perform({ type: 'new-project' })
    t.cb('newProject', 'onCancel')()
    expect(t.ctl.getState().newProject.open).toBe(false)
  })
})

describe('handoff', () => {
  it('Continue work -> preview -> toggle -> note -> launch -> select the new agent', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'continue-work', projectId: P1 })
    expect(t.v.handoff.last).toMatchObject({ open: true, stage: 'compose', provider: 'codex' })
    t.cb('handoff', 'onObjective')('Finish the tests')
    await t.cb('handoff', 'onPreview')()
    await flush()
    expect(t.projects.prepareHandoff).toHaveBeenCalledWith({
      sessionId: 'ses_aaaaaaaaaa',
      toProvider: 'codex',
      objective: 'Finish the tests',
    })
    expect(t.v.handoff.last.stage).toBe('review')
    await t.cb('handoff', 'onToggleItem')('mem_bbbbbbbbbb', false)
    await flush()
    expect(t.projects.updateHandoff).toHaveBeenCalledWith({
      handoffId: 'hof_aaaaaaaaaa',
      include: ['mem_aaaaaaaaaa'],
    })
    await t.cb('handoff', 'onToggleItem')('mem_bbbbbbbbbb', true)
    await flush()
    expect(t.projects.updateHandoff).toHaveBeenLastCalledWith({
      handoffId: 'hof_aaaaaaaaaa',
      include: expect.arrayContaining(['mem_aaaaaaaaaa', 'mem_bbbbbbbbbb']),
    })
    t.cb('handoff', 'onNote')('careful')
    await t.cb('handoff', 'onLaunch')()
    await flush()
    await flush()
    expect(t.projects.updateHandoff).toHaveBeenLastCalledWith({
      handoffId: 'hof_aaaaaaaaaa',
      note: 'careful',
    })
    expect(t.projects.launchHandoff).toHaveBeenCalledWith('hof_aaaaaaaaaa')
    expect(t.ctl.getState().handoff.open).toBe(false)
    expect(t.scene.select).toHaveBeenCalledWith('cx:9')
    expect(t.ctl.getState().view).toBe('office')
  })
  it('launch failure keeps the dialog open with the error', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'prepare-handoff', projectId: P1, sessionId: 'ses_aaaaaaaaaa' })
    t.cb('handoff', 'onObjective')('Go')
    t.cb('handoff', 'onProvider')('codex')
    await t.cb('handoff', 'onPreview')()
    await flush()
    t.projects.launchHandoff.mockResolvedValue({
      ok: false,
      error: 'no login',
      code: 'auth',
    } as never)
    await t.cb('handoff', 'onLaunch')()
    await flush()
    expect(t.v.handoff.last.error).toContain('no login')
    expect(t.ctl.getState().handoff.open).toBe(true)
  })
  it('preview without an objective does nothing; cancel and Esc close', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'continue-work', projectId: P1 })
    await t.cb('handoff', 'onPreview')()
    await flush()
    expect(t.projects.prepareHandoff).not.toHaveBeenCalled()
    await t.cb('handoff', 'onLaunch')()
    await flush()
    expect(t.projects.launchHandoff).not.toHaveBeenCalled()
    expect(t.ctl.escape()).toBe(true)
    await t.ctl.perform({ type: 'continue-work', projectId: P1 })
    t.cb('handoff', 'onCancel')()
    expect(t.ctl.getState().handoff.open).toBe(false)
  })
  it('a project without sessions explains why; Continue with… from the vault', async () => {
    const t = setup()
    await t.ctl.start()
    t.projects.sessions.mockResolvedValueOnce([])
    await t.ctl.perform({ type: 'continue-work', projectId: P2 })
    expect(t.v.handoff.last.error).toBeTruthy()
    t.ctl.escape()
    await t.ctl.perform({ type: 'open-sessions' })
    t.cb('sessions', 'onContinue')('ses_aaaaaaaaaa')
    await flush()
    expect(t.ctl.getState().handoff.sessionId).toBe('ses_aaaaaaaaaa')
    t.ctl.escape()
    t.cb('sessions', 'onContinue')('ses_cccccccccc')
    await flush() // unassigned: no handoff
    expect(t.ctl.getState().handoff.open).toBe(false)
  })
  it('opens an unfinished handoff from the Overview in review', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'open-handoff', handoffId: 'hof_aaaaaaaaaa' })
    expect(t.v.handoff.last).toMatchObject({ open: true, stage: 'review' })
    await t.ctl.perform({ type: 'open-handoff', handoffId: 'hof_missing' })
    expect(t.v.handoff.last.stage).toBe('review')
  })
})

describe('pushes and directory', () => {
  it('projects push updates the sidebar and refreshes the Overview', async () => {
    const t = setup()
    await t.ctl.start()
    const before = t.projects.overview.mock.calls.length
    t.push({ type: 'projects', projects: [project({ activeAgents: 7 })] })
    expect(t.v.shell.last.projects[0].count).toBe(7)
    await flush()
    expect(t.projects.overview.mock.calls.length).toBe(before + 1)
  })
  it('session and activity pushes reach open views', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'open-project', projectId: P1 })
    t.push({
      type: 'activity',
      event: { id: 'new', projectId: P1, ts: NOW, kind: 'agent.error', actor: 'x', text: 'boom' },
    })
    expect(t.v.dashboard.last.sections[1].rows[0].id).toBe('new')
    t.push({ type: 'vault', status: 'memory-only' })
    expect(t.v.shell.last.topbar.vault.status).toBe('memory-only')
  })
  it('selecting a directory project focuses its agents; null clears', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.selectDirectoryProject(P1)
    expect(t.scene.focusAgents).toHaveBeenLastCalledWith(['cc:1', 'cc:2'])
    expect(t.ctl.projectDirectory().entries.find((e) => e.projectId === P1)?.selected).toBe(true)
    await t.ctl.selectDirectoryProject(null)
    expect(t.scene.focusAgents).toHaveBeenLastCalledWith(null)
  })
})

describe('tasks on the dashboard', () => {
  async function onProject() {
    const t = setup()
    await t.ctl.start()
    await t.ctl.navigate('project', P1)
    return t
  }
  it('adds a task, then refreshes the dashboard; blank titles are ignored', async () => {
    const t = await onProject()
    const before = t.projects.dashboard.mock.calls.length
    t.cb('dashboard', 'onTaskAdd')(P1, '   ')
    await flush()
    expect(t.projects.createTask).not.toHaveBeenCalled()
    t.cb('dashboard', 'onTaskAdd')(P1, ' Write the docs ')
    await flush()
    expect(t.projects.createTask).toHaveBeenCalledWith({ projectId: P1, title: 'Write the docs' })
    expect(t.projects.dashboard.mock.calls.length).toBe(before + 1)
  })
  it('changes state and confirms with user-confirmed evidence, refreshing each time', async () => {
    const t = await onProject()
    const before = t.projects.dashboard.mock.calls.length
    t.cb('dashboard', 'onTaskState')('tsk_cccccccccc', 'done')
    await flush()
    expect(t.projects.updateTask).toHaveBeenLastCalledWith({
      taskId: 'tsk_cccccccccc',
      state: 'done',
    })
    t.cb('dashboard', 'onTaskConfirm')('tsk_cccccccccc')
    await flush()
    expect(t.projects.updateTask).toHaveBeenLastCalledWith({
      taskId: 'tsk_cccccccccc',
      confirm: true,
    })
    expect(t.projects.dashboard.mock.calls.length).toBe(before + 2)
  })
  it('a failed write shows the error and does not refresh', async () => {
    const t = await onProject()
    const before = t.projects.dashboard.mock.calls.length
    t.projects.createTask.mockRejectedValue(new Error('vault locked'))
    t.cb('dashboard', 'onTaskAdd')(P1, 'x')
    await flush()
    expect(t.v.dashboard.last.error).toBe('vault locked')
    expect(t.projects.dashboard.mock.calls.length).toBe(before)
  })
})

describe('save as memory', () => {
  async function inVault(sessionId = 'ses_aaaaaaaaaa') {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'open-session', sessionId })
    return t
  }
  it('creates a project note with message provenance and confirms it', async () => {
    const t = await inVault()
    await t.cb('sessions', 'onSaveMemory')('ses_aaaaaaaaaa', 'm1', { title: 'hi', kind: 'note' })
    await flush()
    expect(t.projects.createMemory).toHaveBeenCalledWith({
      projectId: P1,
      scope: 'project',
      kind: 'note',
      title: 'hi',
      body: 'hi',
      from: { sessionId: 'ses_aaaaaaaaaa', messageId: 'm1' },
    })
    expect(t.v.sessions.last.notice).toBe('Saved as memory.')
    expect(t.ctl.getState().memories.some((m) => m.id === 'mem_iiiiiiiiii')).toBe(true)
  })
  it('uses global scope for a session without a project; ignores unknown messages', async () => {
    const t = await inVault('ses_cccccccccc')
    await t.cb('sessions', 'onSaveMemory')('ses_cccccccccc', 'nope', { title: 'x', kind: 'note' })
    expect(t.projects.createMemory).not.toHaveBeenCalled()
    await t.cb('sessions', 'onSaveMemory')('ses_cccccccccc', 'm1', { title: 'x', kind: 'fact' })
    await flush()
    expect(t.projects.createMemory).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: null, scope: 'global', kind: 'fact' }),
    )
  })
  it('a failure shows the error, no notice', async () => {
    const t = await inVault()
    t.projects.createMemory.mockRejectedValue(new Error('nope'))
    await t.cb('sessions', 'onSaveMemory')('ses_aaaaaaaaaa', 'm1', { title: 'hi', kind: 'note' })
    await flush()
    expect(t.v.sessions.last.error).toBe('nope')
    expect(t.v.sessions.last.notice).toBeNull()
  })
})

describe('palette deep search', () => {
  const hit = (over: object) => ({
    kind: 'message' as const,
    id: 'x',
    projectId: P1,
    title: 'T',
    snippet: 's',
    sessionId: 'ses_aaaaaaaaaa',
    messageId: 'm1',
    ...over,
  })
  async function typed(q: string) {
    const t = setup()
    await t.ctl.start()
    t.ctl.openPalette()
    t.cb('palette', 'onQuery')(q)
    await flush()
    return t
  }
  it('runs the shallow search at once and the deep one after the debounce', async () => {
    const t = await typed('login')
    expect(t.projects.search).toHaveBeenCalledTimes(1)
    expect(t.timers).toHaveLength(1)
    expect(t.v.palette.last.searching).toBe(true)
    t.projects.search.mockResolvedValueOnce([hit({ id: 'deep', messageId: 'm9' })])
    t.timers[0]!()
    await flush()
    expect(t.projects.search).toHaveBeenLastCalledWith({
      query: 'login',
      projectId: undefined,
      deep: true,
    })
    expect(t.ctl.getState().palette.hits.map((h) => h.id)).toEqual(['m', 'deep'])
    expect(t.v.palette.last.searching).toBe(false)
  })
  it('skips deep search under 3 chars and drops duplicates', async () => {
    const t = await typed('lo')
    expect(t.timers).toHaveLength(0)
    t.cb('palette', 'onQuery')('log')
    await flush()
    t.timers[0]!()
    await flush()
    expect(t.ctl.getState().palette.hits).toHaveLength(1)
  })
  it('a newer query or closing cancels the pending deep search; stale results are ignored', async () => {
    const t = await typed('login')
    t.cb('palette', 'onQuery')('logins')
    await flush()
    expect(t.timers).toHaveLength(1)
    let resolve: (v: unknown[]) => void = () => {}
    t.projects.search.mockImplementationOnce(() => new Promise((r) => (resolve = r as never)))
    t.timers.shift()!()
    t.cb('palette', 'onQuery')('other')
    resolve([hit({ id: 'stale' })])
    await flush()
    expect(t.ctl.getState().palette.hits.map((h) => h.id)).not.toContain('stale')
    t.ctl.closePalette()
    expect(t.timers).toHaveLength(0)
  })
  it('a failing deep search keeps the shallow hits and shows no error', async () => {
    const t = await typed('login')
    t.projects.search.mockRejectedValueOnce(new Error('disk'))
    t.timers[0]!()
    await flush()
    expect(t.ctl.getState().palette.hits).toHaveLength(1)
    expect(t.ctl.getState().error).toBeNull()
  })
  it('a deep message hit older than the first page is paged in, then highlighted', async () => {
    const t = setup()
    await t.ctl.start()
    t.projects.messages
      .mockResolvedValueOnce({
        messages: [{ id: 'm5', role: 'user', text: 'a', ts: NOW, source: 'chat' }],
        more: true,
      })
      .mockResolvedValueOnce({
        messages: [{ id: 'm5', role: 'user', text: 'a', ts: NOW, source: 'chat' }],
        more: true,
      })
      .mockResolvedValueOnce({
        messages: [{ id: 'm2', role: 'user', text: 'old', ts: NOW, source: 'chat' }],
        more: false,
      })
    await t.ctl.perform({ type: 'open-session', sessionId: 'ses_aaaaaaaaaa', messageId: 'm2' })
    expect(t.projects.messages).toHaveBeenLastCalledWith({
      sessionId: 'ses_aaaaaaaaaa',
      before: 'm5',
      limit: 200,
    })
    const d = t.v.sessions.last.detail
    expect(d.messages.map((m: any) => m.id)).toEqual(['m2', 'm5'])
    expect(d.messages[0].highlighted).toBe(true)
  })
  it('a memory hit opens the Memory browser with that item selected', async () => {
    const t = setup()
    await t.ctl.start()
    t.ctl.openPalette()
    t.projects.search.mockResolvedValueOnce([
      { kind: 'memory', id: 'mem_bbbbbbbbbb', projectId: P1, title: 'Old note', snippet: '' },
    ] as never)
    t.cb('palette', 'onQuery')('old')
    await flush()
    const item = t.v.palette.last.items.find((i: any) => i.group === 'memory')
    await t.cb('palette', 'onChoose')(item.id)
    await flush()
    expect(t.ctl.getState().view).toBe('memory')
    expect(t.v.memory.last.detail.id).toBe('mem_bbbbbbbbbb')
  })
})

describe('Session Vault: resume and import', () => {
  it('Resume starts the managed session and selects its agent in the Office', async () => {
    const t = setup()
    await t.ctl.start()
    t.projects.sessions.mockResolvedValue([session({ canResume: true })])
    await t.ctl.perform({ type: 'open-sessions' })
    await t.cb('sessions', 'onResume')('ses_aaaaaaaaaa')
    await flush()
    expect(t.projects.resumeSession).toHaveBeenCalledWith('ses_aaaaaaaaaa')
    expect(t.ctl.getState().view).toBe('office')
    expect(t.scene.select).toHaveBeenCalledWith('cc:77')
  })
  it('Resume is refused for sessions that cannot resume; a failed start shows the error', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'open-sessions' })
    await t.cb('sessions', 'onResume')('ses_aaaaaaaaaa')
    expect(t.projects.resumeSession).not.toHaveBeenCalled()
    t.projects.sessions.mockResolvedValue([session({ canResume: true })])
    await t.ctl.perform({ type: 'open-sessions' })
    t.projects.resumeSession.mockResolvedValue({ ok: false, error: 'no cli' } as never)
    await t.cb('sessions', 'onResume')('ses_aaaaaaaaaa')
    await flush()
    expect(t.ctl.getState().view).toBe('sessions')
    expect(t.v.sessions.last.error).toBe('Could not start the agent: no cli')
  })
  it('Import Claude history reports the count and refreshes the list (button and palette)', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'open-sessions' })
    const calls = t.projects.sessions.mock.calls.length
    await t.cb('sessions', 'onImport')()
    await flush()
    expect(t.projects.importHistory).toHaveBeenCalledTimes(1)
    expect(t.projects.sessions.mock.calls.length).toBe(calls + 1)
    expect(t.v.sessions.last.notice).toBe('Imported 3 sessions, 1 skipped.')
    await t.ctl.perform({ type: 'open-office' })
    await t.ctl.perform({ type: 'import-history' })
    expect(t.ctl.getState().view).toBe('sessions')
    expect(t.projects.importHistory).toHaveBeenCalledTimes(2)
  })
  it('a failed import shows the error and no notice', async () => {
    const t = setup()
    await t.ctl.start()
    t.projects.importHistory.mockRejectedValue(new Error('no folder'))
    await t.ctl.perform({ type: 'import-history' })
    expect(t.v.sessions.last.error).toBe('no folder')
    expect(t.v.sessions.last.notice).toBeNull()
  })
})

describe('handoff providers, inspector picker and Project Library', () => {
  it('refreshes providers every time the handoff dialog opens', async () => {
    const t = setup()
    await t.ctl.start()
    const calls = (t.gateway.providers.list as unknown as { mock: { calls: unknown[] } }).mock.calls
    const before = calls.length
    await t.ctl.perform({ type: 'continue-work', projectId: P1, sessionId: 'ses_aaaaaaaaaa' })
    await t.ctl.perform({ type: 'continue-work', projectId: P1, sessionId: 'ses_aaaaaaaaaa' })
    expect(calls.length).toBe(before + 2)
  })
  it('Inspect context defaults to the agent selected in the Office when it is in the project, and re-inspects on change', async () => {
    const t = setup()
    ;(t.scene as { selectedAgentId?: () => string | null }).selectedAgentId = () => 'cc:2'
    await t.ctl.start()
    await t.ctl.perform({ type: 'inspect-context', projectId: P1 })
    expect(t.projects.inspect).toHaveBeenLastCalledWith('cc:2')
    expect(t.v.inspector.last.agents.map((a: any) => [a.id, a.selected])).toEqual([
      ['cc:1', false],
      ['cc:2', true],
    ])
    t.cb('inspector', 'onAgent')('cc:1')
    await flush()
    expect(t.projects.inspect).toHaveBeenLastCalledWith('cc:1')
    expect(t.v.inspector.last.agentId).toBe('cc:1')
  })
  it('falls back to the first active agent when the selected one is elsewhere', async () => {
    const t = setup()
    ;(t.scene as { selectedAgentId?: () => string | null }).selectedAgentId = () => 'cc:99'
    await t.ctl.start()
    await t.ctl.perform({ type: 'inspect-context', projectId: P1 })
    expect(t.projects.inspect).toHaveBeenLastCalledWith('cc:1')
  })
  it('sends the selected project Library to the scene, refreshes on pushes, clears on deselect', async () => {
    const t = setup()
    const lib = vi.fn()
    ;(t.scene as { setProjectLibrary?: unknown }).setProjectLibrary = lib
    await t.ctl.start()
    expect(lib).toHaveBeenLastCalledWith(null)
    await t.ctl.navigate('project', P1)
    await flush()
    const vm = lib.mock.calls.at(-1)![0]
    expect(vm).toMatchObject({ projectId: P1, name: 'Alpha' })
    expect(vm.notebooks.find((n: any) => n.id === 'decisions').count).toBe(2)
    lib.mockClear()
    t.push({ type: 'memory', memory: memory({ id: 'mem_zzzzzzzzzz' }) })
    await flush()
    expect(lib).toHaveBeenCalled()
    await t.ctl.selectDirectoryProject(null)
    await flush()
    expect(lib).toHaveBeenLastCalledWith(null)
  })
})

describe('stale shell', () => {
  it('recomputes the health pill when connection info changes', async () => {
    const t = setup()
    await t.ctl.start()
    expect(t.v.shell.last.topbar.health.tone).toBe('good')
    ;(t.gateway.providers.list as any).mockResolvedValueOnce([])
    t.connChange()
    await flush()
    expect(t.v.shell.last.topbar.health.tone).toBe('neutral')
  })
  it('refreshes sidebar counts on session and memory pushes', async () => {
    const t = setup()
    await t.ctl.start()
    const before = t.projects.overview.mock.calls.length
    t.push({ type: 'session', session: session({ id: 'ses_zzzzzzzzzz' }) })
    await flush()
    t.push({ type: 'memory', memory: memory({ id: 'mem_zzzzzzzzzz' }) })
    await flush()
    expect(t.projects.overview.mock.calls.length).toBe(before + 2)
  })
  it('unsubscribes from connection changes on dispose', async () => {
    const t = setup()
    await t.ctl.start()
    t.unsub.mockClear()
    t.ctl.dispose()
    expect(t.unsub).toHaveBeenCalledTimes(2)
  })
})

describe('automatic knowledge import', () => {
  const imp = (over = {}) =>
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
  const withImports = (t: ReturnType<typeof setup>): void => {
    t.projects.memories.mockImplementation((async ({ scope }: { scope: string }) =>
      scope === P1 ? [memory(), imp()] : []) as never)
  }

  it('the Session Vault loads the import status and shows the line', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'open-sessions' })
    await flush()
    expect(t.projects.importStatus).toHaveBeenCalled()
    expect(t.v.sessions.last.importHistory).toMatchObject({
      label: 'Automatic import is on',
      enabled: false,
    })
    expect(t.v.sessions.last.importStatus).toBe('Last run 5m ago: 4 sessions, 3 summaries')
  })

  it('refreshes the status on memory and session pushes while the vault is open', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'open-sessions' })
    await flush()
    const n = t.projects.importStatus.mock.calls.length
    t.projects.importStatus.mockResolvedValue({ on: true, lastRunAt: NOW, imported: 9, added: 8 })
    t.push({ type: 'memory', memory: imp() })
    await flush()
    expect(t.projects.importStatus.mock.calls.length).toBe(n + 1)
    expect(t.v.sessions.last.importStatus).toBe('Last run 0s ago: 9 sessions, 8 summaries')
    t.push({ type: 'session', session: session() })
    await flush()
    expect(t.projects.importStatus.mock.calls.length).toBe(n + 2)
  })

  it('does not poll the status from other views', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'open-memory' })
    const n = t.projects.importStatus.mock.calls.length
    t.push({ type: 'memory', memory: imp() })
    await flush()
    expect(t.projects.importStatus.mock.calls.length).toBe(n)
  })

  it('a failing status call shows no error and leaves the one-shot button', async () => {
    const t = setup()
    t.projects.importStatus.mockRejectedValue(new Error('boom'))
    await t.ctl.start()
    await t.ctl.perform({ type: 'open-sessions' })
    await flush()
    expect(t.v.sessions.last.error).toBeNull()
    expect(t.v.sessions.last.importHistory.enabled).toBe(true)
    expect(t.v.sessions.last.importStatus).toBeNull()
  })

  it('the button asks first; Cancel closes the confirm without calling', async () => {
    const t = setup()
    withImports(t)
    await t.ctl.start()
    await t.ctl.perform({ type: 'open-memory', projectId: P1 })
    expect(t.v.memory.last.removeConfirm.open).toBe(false)
    t.cb('memory', 'onRemoveImported')()
    expect(t.v.memory.last.removeConfirm.open).toBe(true)
    t.cb('memory', 'onRemoveImportedCancel')()
    expect(t.v.memory.last.removeConfirm.open).toBe(false)
    expect(t.projects.removeImported).not.toHaveBeenCalled()
  })

  it('confirming in a project removes that project\u2019s imports, refreshes and reports the count', async () => {
    const t = setup()
    withImports(t)
    await t.ctl.start()
    await t.ctl.perform({ type: 'open-memory', projectId: P1 })
    const loads = t.projects.memories.mock.calls.length
    t.cb('memory', 'onRemoveImported')()
    t.projects.memories.mockImplementation((async () => [memory()]) as never)
    await t.cb('memory', 'onRemoveImportedConfirm')()
    await flush()
    expect(t.projects.removeImported).toHaveBeenCalledWith(P1)
    expect(t.projects.memories.mock.calls.length).toBeGreaterThan(loads)
    expect(t.v.memory.last.removeConfirm.open).toBe(false)
    expect(t.v.memory.last.notice).toBe('Removed 2 imported items')
    expect(t.v.memory.last.rows.map((r: { id: string }) => r.id)).toEqual(['mem_aaaaaaaaaa'])
  })

  it('in All memory it removes every project\u2019s imports', async () => {
    const t = setup()
    withImports(t)
    await t.ctl.start()
    await t.ctl.perform({ type: 'open-memory' })
    t.cb('memory', 'onRemoveImported')()
    await t.cb('memory', 'onRemoveImportedConfirm')()
    expect(t.projects.removeImported).toHaveBeenCalledWith(undefined)
  })

  it('never calls with a scope it cannot target (Global, Unassigned)', async () => {
    const t = setup()
    withImports(t)
    await t.ctl.start()
    await t.ctl.perform({ type: 'open-memory' })
    t.cb('memory', 'onScope')('global')
    t.cb('memory', 'onRemoveImported')()
    expect(t.v.memory.last.removeConfirm.open).toBe(false)
    await t.cb('memory', 'onRemoveImportedConfirm')()
    expect(t.projects.removeImported).not.toHaveBeenCalled()
  })

  it('a failed removal closes the confirm and shows the error', async () => {
    const t = setup()
    withImports(t)
    await t.ctl.start()
    await t.ctl.perform({ type: 'open-memory', projectId: P1 })
    t.projects.removeImported.mockRejectedValue(new Error('vault locked'))
    t.cb('memory', 'onRemoveImported')()
    await t.cb('memory', 'onRemoveImportedConfirm')()
    expect(t.v.memory.last.removeConfirm.open).toBe(false)
    expect(t.v.memory.last.error).toBe('vault locked')
    expect(t.v.memory.last.notice).toBeNull()
  })

  it('the palette command opens Memory in the current scope and asks to confirm', async () => {
    const t = setup()
    withImports(t)
    await t.ctl.start()
    await t.ctl.perform({ type: 'open-project', projectId: P1 })
    await t.ctl.perform({ type: 'remove-imported' })
    expect(t.ctl.getState().view).toBe('memory')
    expect(t.ctl.getState().memoryScope).toBe(P1)
    expect(t.v.memory.last.removeConfirm.open).toBe(true)
    expect(t.projects.removeImported).not.toHaveBeenCalled()
  })

  it('the palette command with nothing imported says so instead of asking', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'remove-imported' })
    expect(t.v.memory.last.removeConfirm.open).toBe(false)
    expect(t.v.memory.last.notice).toBe('There is no auto-imported memory here.')
  })

  it('Esc closes the confirm first', async () => {
    const t = setup()
    withImports(t)
    await t.ctl.start()
    await t.ctl.perform({ type: 'open-memory', projectId: P1 })
    t.cb('memory', 'onRemoveImported')()
    expect(t.ctl.escape()).toBe(true)
    expect(t.v.memory.last.removeConfirm.open).toBe(false)
    expect(t.ctl.escape()).toBe(false)
  })

  it('the Auto-imported chip filters the loaded list', async () => {
    const t = setup()
    withImports(t)
    await t.ctl.start()
    await t.ctl.perform({ type: 'open-memory', projectId: P1 })
    t.cb('memory', 'onFilter')('auto-imported')
    expect(t.v.memory.last.rows.map((r: { id: string }) => r.id)).toEqual(['mem_iiiiiiiiii'])
  })
})

describe('Harness Builder', () => {
  const open = async (t: ReturnType<typeof setup>, projectId = P1) => {
    await t.ctl.start()
    await t.ctl.perform({ type: 'open-harnesses', projectId })
  }

  it('opens the library for a project and loads the harnesses and templates', async () => {
    const t = setup()
    await open(t)
    const vm = t.v.harness.last
    expect(vm.open).toBe(true)
    expect(vm.tab).toBe('library')
    expect(vm.library.items.map((c: any) => c.name)).toEqual(['Team standards'])
    expect(vm.library.items[0].attachedHere).toBe(true)
    expect(vm.templates.map((x: any) => x.id)).toEqual(['basic'])
  })

  it('opens the editor on harness-edit and fetches the detail', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'harness-edit', harnessId: 'hrn_aaaaaaaaaa' })
    expect(t.projects.harness.get).toHaveBeenCalledWith('hrn_aaaaaaaaaa')
    expect(t.v.harness.last.tab).toBe('editor')
    expect(t.v.harness.last.editor.title).toBe('Team standards')
  })

  it('confirms before publishing, archiving, attaching and detaching', async () => {
    const t = setup()
    await open(t)
    t.cb('harness', 'onCard')('hrn_aaaaaaaaaa', 'publish')
    expect(t.v.harness.last.confirm).toMatchObject({ open: true, okLabel: 'Publish' })
    expect(t.projects.harness.publish).not.toHaveBeenCalled()
    t.cb('harness', 'onConfirmCancel')()
    expect(t.v.harness.last.confirm.open).toBe(false)

    t.cb('harness', 'onCard')('hrn_aaaaaaaaaa', 'publish')
    await t.cb('harness', 'onConfirm')()
    await flush()
    expect(t.projects.harness.publish).toHaveBeenCalledWith('hrn_aaaaaaaaaa')

    t.cb('harness', 'onCard')('hrn_aaaaaaaaaa', 'attach')
    await t.cb('harness', 'onConfirm')()
    await flush()
    expect(t.projects.harness.attach).toHaveBeenCalledWith(P1, 'hrn_aaaaaaaaaa')

    t.cb('harness', 'onCard')('hrn_aaaaaaaaaa', 'detach')
    await t.cb('harness', 'onConfirm')()
    await flush()
    expect(t.projects.harness.detach).toHaveBeenCalledWith(P1, 'hrn_aaaaaaaaaa')

    t.cb('harness', 'onCard')('hrn_aaaaaaaaaa', 'archive')
    await t.cb('harness', 'onConfirm')()
    await flush()
    expect(t.projects.harness.archive).toHaveBeenCalledWith('hrn_aaaaaaaaaa')
  })

  it('harness-attach opens the dialog with the attach confirm already asked', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'harness-attach', projectId: P1, harnessId: 'hrn_aaaaaaaaaa' })
    expect(t.v.harness.last.confirm).toMatchObject({ open: true, okLabel: 'Attach' })
  })

  it('shows a failed change in the dialog, not as a global error', async () => {
    const t = setup()
    await open(t)
    t.projects.harness.publish.mockRejectedValueOnce(new Error('Not a draft'))
    t.cb('harness', 'onCard')('hrn_aaaaaaaaaa', 'publish')
    await t.cb('harness', 'onConfirm')()
    await flush()
    expect(t.v.harness.last.error).toBe('Not a draft')
    expect(t.ctl.getState().error).toBeNull()
  })

  it('runs the import flow: detect, preview, select, edit, create a draft', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'harness-import', projectId: P1 })
    await flush()
    expect(t.projects.harness.importDetect).toHaveBeenCalledWith(P1)
    expect(t.v.harness.last.tab).toBe('import')
    expect(t.v.harness.last.import.sources).toHaveLength(2)

    await t.cb('harness', 'onPreview')()
    await flush()
    expect(t.v.harness.last.import.preview.groups).toHaveLength(2)

    t.cb('harness', 'onToggleCandidate')('cand_3', false)
    t.cb('harness', 'onToggleGate')('cand_g1', true)
    t.cb('harness', 'onEditCandidate')('cand_1', { name: 'TDD first' })
    t.cb('harness', 'onImportName')('Imported')
    t.cb('harness', 'onImportAttach')(true)
    await t.cb('harness', 'onCommit')()
    await flush()
    expect(t.projects.harness.importCommit).toHaveBeenCalledWith({
      previewId: 'prv_aaaaaa',
      name: 'Imported',
      selected: ['cand_1'],
      edits: [{ tempId: 'cand_1', name: 'TDD first' }],
      gates: ['cand_g1'],
      attach: true,
    })
    expect(t.v.harness.last.tab).toBe('editor')
    expect(t.v.harness.last.import.preview).toBeNull()
  })

  it('saves editor changes and shows the returned detail', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'harness-edit', harnessId: 'hrn_aaaaaaaaaa' })
    const draft = { name: 'Renamed' }
    await t.cb('harness', 'onSave')('hrn_aaaaaaaaaa', draft)
    await flush()
    expect(t.projects.harness.update).toHaveBeenCalledWith({ harnessId: 'hrn_aaaaaaaaaa', draft })
    expect(t.v.harness.last.editor.title).toBe('Renamed')
  })

  it('creates a harness and one from a template', async () => {
    const t = setup()
    await open(t)
    await t.cb('harness', 'onCreate')()
    await flush()
    expect(t.projects.harness.create).toHaveBeenCalledWith({ name: 'New harness' })
    await t.cb('harness', 'onTemplate')('basic')
    await flush()
    expect(t.projects.harness.createFromTemplate).toHaveBeenCalledWith('basic')
    expect(t.v.harness.last.tab).toBe('editor')
  })

  it('loads the coverage of every startable provider for the project', async () => {
    const t = setup()
    await open(t)
    t.cb('harness', 'onTab')('coverage')
    await flush()
    await flush()
    const calls = t.projects.harness.coverage.mock.calls.map((c: unknown[]) => c[1])
    expect(calls).toContain('claude-code')
    expect(t.v.harness.last.coverage.reports.length).toBe(calls.length)
  })

  it('run-gates runs, then stores the fresh inspection', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'run-gates', agentId: 'cc:1' })
    expect(t.projects.harness.runGates).toHaveBeenCalledWith({ agentId: 'cc:1' })
    expect(t.ctl.getState().harness.inspections['cc:1']?.agentId).toBe('cc:1')
  })

  it('refreshes the library and the open detail on a harness push', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'harness-edit', harnessId: 'hrn_aaaaaaaaaa' })
    t.projects.harness.list.mockClear()
    t.projects.harness.get.mockClear()
    t.push({ type: 'harness', harnessId: 'hrn_aaaaaaaaaa' })
    await flush()
    expect(t.projects.harness.list).toHaveBeenCalled()
    expect(t.projects.harness.get).toHaveBeenCalled()
  })

  it('refetches the inspection of an agent it already holds when a push names it', async () => {
    const t = setup()
    await t.ctl.start()
    await t.ctl.perform({ type: 'run-gates', agentId: 'cc:1' })
    t.projects.harness.inspect.mockClear()
    t.push({ type: 'harness', agentId: 'cc:1' })
    await flush()
    expect(t.projects.harness.inspect).toHaveBeenCalledWith('cc:1')
    expect(t.ctl.getState().harness.inspections['cc:1']).toBeDefined()
  })

  it('Escape closes the confirm first, then the dialog', async () => {
    const t = setup()
    await open(t)
    t.cb('harness', 'onCard')('hrn_aaaaaaaaaa', 'archive')
    expect(t.ctl.escape()).toBe(true)
    expect(t.v.harness.last.confirm.open).toBe(false)
    expect(t.v.harness.last.open).toBe(true)
    expect(t.ctl.escape()).toBe(true)
    expect(t.v.harness.last.open).toBe(false)
  })

  it('works against a gateway without harnesses (older main)', async () => {
    const t = setup({ gateway: { projects: { ...setup().projects, harness: undefined } } })
    await t.ctl.start()
    await t.ctl.navigate('project', P1)
    expect(t.ctl.getState().error).toBeNull()
  })
})
