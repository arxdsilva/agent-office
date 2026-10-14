import { describe, expect, it } from 'vitest'
import { NOW, P1, activity, dashboard, overview, project } from './__fixtures__/projects.ts'
import { detail, inspection, preview, summary, badge } from './__fixtures__/harness.ts'
import { dashboardVM } from './dashboard-vm.ts'
import { paletteCommands } from './palette-vm.ts'
import { initialState, reduce, type WorkspaceState } from './state.ts'

describe('harness reducer', () => {
  it('stores the library, the open harness and the badges', () => {
    let s = reduce(initialState(), { type: 'harnesses', list: [summary()] })
    expect(s.harness.listLoaded).toBe(true)
    s = reduce(s, { type: 'harness-detail', detail: detail() })
    s = reduce(s, { type: 'harness-badges', badges: [badge()] })
    expect(s.harness.detail?.name).toBe('Team standards')
    expect(s.harness.badges).toHaveLength(1)
  })

  it('selects every non-duplicate candidate when a preview arrives and clears it with null', () => {
    let s = reduce(initialState(), { type: 'import-preview', preview: preview() })
    expect(s.harness.selection).toEqual({ selected: ['cand_1', 'cand_3'], gates: [] })
    s = reduce(s, { type: 'import-preview', preview: null })
    expect(s.harness.selection).toEqual({ selected: [], gates: [] })
  })

  it('patches the pane view state; there is no open flag any more', () => {
    const s = reduce(initialState(), {
      type: 'harness-ui',
      patch: { tab: 'import', projectId: P1 },
    })
    expect(s.harness).toMatchObject({ tab: 'import', projectId: P1 })
    expect('open' in s.harness).toBe(false)
  })

  it('stores and clears the drag state', () => {
    let s = reduce(initialState(), {
      type: 'harness-ui',
      patch: { drag: { harnessId: 'hrn_aaaaaaaaaa', source: 'library', status: 'published' } },
    })
    expect(s.harness.drag?.harnessId).toBe('hrn_aaaaaaaaaa')
    s = reduce(s, { type: 'harness-ui', patch: { drag: null } })
    expect(s.harness.drag).toBeNull()
  })

  it('navigating to the pane seeds the scope from the current project once', () => {
    let s = reduce(initialState(), { type: 'projects', projects: [project()] })
    s = reduce(s, { type: 'navigate', view: 'harness' })
    expect(s.harness.projectId).toBe(P1)
    s = reduce(s, { type: 'harness-ui', patch: { projectId: null } })
    s = reduce(s, { type: 'navigate', view: 'harness', projectId: P1 })
    expect(s.harness.projectId).toBe(P1)
    s = reduce(s, { type: 'harness-ui', patch: { projectId: 'prj_other' } })
    s = reduce(s, { type: 'navigate', view: 'harness' })
    expect(s.harness.projectId).toBe('prj_other')
    expect(s.projectId).toBe(P1)
  })

  it('opening another harness drops the unsaved edits; the same one keeps them', () => {
    let s = reduce(initialState(), { type: 'harness-detail', detail: detail() })
    s = reduce(s, { type: 'harness-ui', patch: { draft: { name: 'x' }, undo: { name: 'y' } } })
    s = reduce(s, { type: 'harness-detail', detail: detail({ version: 3 }) })
    expect(s.harness.draft).toEqual({ name: 'x' })
    s = reduce(s, { type: 'harness-detail', detail: detail({ id: 'hrn_bbbbbbbbbb' }) })
    expect(s.harness.draft).toBeNull()
    expect(s.harness.undo).toBeNull()
  })

  it('resets step suggestions and the category filter with a new preview', () => {
    let s = reduce(initialState(), { type: 'harness-ui', patch: { importFilter: 'testing' } })
    s = reduce(s, {
      type: 'import-preview',
      preview: {
        ...preview(),
        steps: [
          {
            tempId: 'cand_s2',
            index: 1,
            name: 'b',
            goal: 'b',
            source: preview().candidates[0]!.source,
          },
          {
            tempId: 'cand_s1',
            index: 0,
            name: 'a',
            goal: 'a',
            source: preview().candidates[0]!.source,
          },
        ],
      },
    })
    expect(s.harness.importFilter).toBeNull()
    expect(s.harness.importSteps).toEqual({
      order: ['cand_s1', 'cand_s2'],
      selected: [],
      checks: {},
    })
  })

  it('keeps an inspection per agent and drops it when a push names that agent', () => {
    let s = reduce(initialState(), {
      type: 'harness-inspection',
      agentId: 'cc:1',
      inspection: inspection(),
    })
    expect(s.harness.inspections['cc:1']).toBeDefined()
    s = reduce(s, { type: 'push', msg: { type: 'harness', projectId: P1 } })
    expect(s.harness.inspections['cc:1']).toBeDefined()
    s = reduce(s, { type: 'push', msg: { type: 'harness', agentId: 'cc:1' } })
    expect(s.harness.inspections['cc:1']).toBeUndefined()
  })
})

describe('palette harness commands', () => {
  it('offers New harness, one command per harness and approvals of the selected project', () => {
    const cmds = paletteCommands({
      projects: [],
      projectId: P1,
      harness: { ...initialState().harness, list: [summary()] },
      overview: {
        flowApprovals: [
          {
            projectId: P1,
            projectName: 'Alpha',
            agentId: 'cc:1',
            agentName: 'Worker',
            stepId: 'stp_aaaaaa',
            stepName: 'Outline',
            checkIndex: 0,
            prompt: 'Outline approved?',
          },
          {
            projectId: 'prj_other',
            projectName: 'Other',
            agentId: 'cc:2',
            agentName: 'W',
            stepId: 'stp_bbbbbb',
            stepName: 'x',
            checkIndex: 0,
            prompt: 'Elsewhere',
          },
        ],
      } as never,
    })
    expect(cmds.find((c) => c.id === 'harness-new')?.action).toEqual({ type: 'harness-new' })
    expect(cmds.find((c) => c.id === 'harness:hrn_aaaaaaaaaa')).toMatchObject({
      label: 'Harness: Team standards',
      action: { type: 'harness-edit', harnessId: 'hrn_aaaaaaaaaa' },
    })
    const approvals = cmds.filter((c) => c.id.startsWith('approve:'))
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({
      label: 'Approve: Outline approved?',
      action: { type: 'flow-approve', agentId: 'cc:1', stepId: 'stp_aaaaaa', checkIndex: 0 },
    })
    expect(
      paletteCommands({ projects: [], projectId: null }).some((c) => c.id.startsWith('approve:')),
    ).toBe(false)
  })
})

describe('palette commands', () => {
  it('always offers Harnesses… and offers the import only inside a project', () => {
    const none = paletteCommands({ projects: [], projectId: null })
    expect(none.find((c) => c.id === 'harnesses')?.action).toEqual({
      type: 'open-harnesses',
      projectId: undefined,
    })
    expect(none.find((c) => c.id === 'harness-import')).toBeUndefined()
    const inProject = paletteCommands({ projects: [], projectId: P1 })
    expect(inProject.find((c) => c.id === 'harness-import')).toMatchObject({
      label: 'Import rules from project…',
      action: { type: 'harness-import', projectId: P1 },
    })
  })
})

describe('dashboard harness section', () => {
  const withDash = (): WorkspaceState => {
    let s = reduce(initialState(), { type: 'projects', projects: [project()] })
    s = reduce(s, { type: 'dashboard', dashboard: dashboard({ activity: [] }) })
    return s
  }

  it('says no harness is attached when nothing is', () => {
    const sec = dashboardVM(withDash(), P1, NOW)!.harness!
    expect(sec.id).toBe('harness')
    expect(sec.rows).toEqual([])
    expect(sec.empty).toContain('No harness')
  })

  it('lists attached harnesses, the last validation and blocked actions today', () => {
    let s = reduce(withDash(), {
      type: 'harnesses',
      list: [summary({ projectIds: [P1] }), summary({ id: 'hrn_bbbbbbbbbb', name: 'Other' })],
    })
    s = reduce(s, {
      type: 'dashboard',
      dashboard: dashboard({
        activity: [
          activity({
            id: 'a1',
            kind: 'validation.passed',
            ts: NOW - 120_000,
            text: 'Validation passed',
          }),
          activity({
            id: 'a2',
            kind: 'validation.failed',
            ts: NOW - 60_000,
            text: 'Validation failed',
          }),
          activity({ id: 'a3', kind: 'harness.denied', ts: NOW - 30_000, text: 'Blocked Edit' }),
          activity({ id: 'a4', kind: 'harness.denied', ts: NOW - 20_000, text: 'Blocked Bash' }),
          activity({ id: 'a5', kind: 'harness.denied', ts: NOW - 3 * 86_400_000, text: 'Old' }),
        ],
      }),
    })
    const rows = dashboardVM(s, P1, NOW)!.harness!.rows
    expect(rows.map((r) => r.id)).toEqual(['hrn_aaaaaaaaaa', 'validation', 'blocked'])
    expect(rows[0]).toMatchObject({
      title: 'Team standards',
      action: { type: 'harness-edit', harnessId: 'hrn_aaaaaaaaaa' },
    })
    expect(rows[1]?.title).toBe('Last validation: Failed · 1m ago')
    expect(rows[1]?.tone).toBe('bad')
    expect(rows[2]?.title).toBe('2 actions blocked today')
    expect(rows[2]?.action).toEqual({ type: 'open-harnesses', projectId: P1 })
  })

  it('orders rows by the Applied order, shows flows and offers Manage harnesses', () => {
    let s = reduce(withDash(), {
      type: 'projects',
      projects: [project({ harnessIds: ['hrn_bbbbbbbbbb', 'hrn_aaaaaaaaaa'] })],
    })
    s = reduce(s, {
      type: 'harnesses',
      list: [
        summary({ projectIds: [P1] }),
        summary({ id: 'hrn_bbbbbbbbbb', name: 'Flow', projectIds: [P1], stepCount: 5 }),
      ],
    })
    s = reduce(s, {
      type: 'harness-badges',
      badges: [badge({ agentId: 'cc:1', step: { index: 2, total: 5, name: 'Review' } })],
    })
    s = reduce(s, {
      type: 'overview',
      overview: overview({
        flowApprovals: [
          {
            projectId: P1,
            projectName: 'Alpha',
            agentId: 'cc:1',
            agentName: 'Ada',
            stepId: 'stp_aaaaaa',
            stepName: 'Outline',
            checkIndex: 0,
            prompt: 'Outline approved?',
          },
        ],
      }),
    })
    const sec = dashboardVM(s, P1, NOW)!.harness!
    expect(sec.rows.map((r) => r.id).slice(0, 2)).toEqual(['hrn_bbbbbbbbbb', 'hrn_aaaaaaaaaa'])
    expect(sec.rows[0]?.detail).toContain('Flow 5 steps')
    expect(sec.rows.find((r) => r.id === 'flows')).toMatchObject({
      title: 'Flows in progress: 1 · 1 waiting for your approval',
      action: { type: 'open-overview' },
    })
    expect(sec.action).toMatchObject({
      label: 'Manage harnesses',
      action: { type: 'open-harnesses', projectId: P1 },
    })
  })

  it('keeps the existing five sections untouched', () => {
    expect(dashboardVM(withDash(), P1, NOW)!.sections).toHaveLength(5)
  })
})
