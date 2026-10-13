import { describe, expect, it } from 'vitest'
import { NOW, P1, activity, dashboard, project } from './__fixtures__/projects.ts'
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

  it('patches the dialog view state', () => {
    const s = reduce(initialState(), {
      type: 'harness-ui',
      patch: { open: true, tab: 'import', projectId: P1 },
    })
    expect(s.harness).toMatchObject({ open: true, tab: 'import', projectId: P1 })
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
      action: { type: 'open-harnesses', projectId: P1 },
    })
    expect(rows[1]?.title).toBe('Last validation: Failed · 1m ago')
    expect(rows[1]?.tone).toBe('bad')
    expect(rows[2]?.title).toBe('2 actions blocked today')
    expect(rows[2]?.action).toEqual({ type: 'open-harnesses', projectId: P1 })
  })

  it('keeps the existing five sections untouched', () => {
    expect(dashboardVM(withDash(), P1, NOW)!.sections).toHaveLength(5)
  })
})
