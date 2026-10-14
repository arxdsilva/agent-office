import { describe, expect, it } from 'vitest'
import { harnessBuilderVM } from './harness-builder-vm.ts'
import { detail, preview, report, summary } from './__fixtures__/harness.ts'
import { P1, P2, project } from './__fixtures__/projects.ts'
import { initialState, reduce, type WorkspaceState } from './state.ts'

const A = 'hrn_aaaaaaaaaa'
const B = 'hrn_bbbbbbbbbb'
const C = 'hrn_cccccccccc'

describe('harnessBuilderVM', () => {
  const base = () => reduce(initialState(), { type: 'projects', projects: [project()] })
  const withApplied = (): WorkspaceState => {
    let s = reduce(initialState(), {
      type: 'projects',
      projects: [project({ harnessIds: [B, A] }), project({ id: P2, name: 'Beta' })],
    })
    s = reduce(s, {
      type: 'harnesses',
      list: [
        summary({ id: A, projectIds: [P1], createdAt: 1 }),
        summary({ id: B, name: 'TDD', projectIds: [P1], stepCount: 3, createdAt: 2 }),
        summary({ id: C, name: 'Draft one', status: 'draft', createdAt: 3 }),
      ],
    })
    return reduce(s, { type: 'navigate', view: 'harness' })
  }

  it('lists the four tabs and the active one; import needs a scope', () => {
    const vm = harnessBuilderVM(reduce(base(), { type: 'harness-ui', patch: { tab: 'import' } }))
    expect(vm.tabs.map((t) => [t.id, t.active])).toEqual([
      ['library', false],
      ['editor', false],
      ['import', true],
      ['coverage', false],
    ])
    expect(vm.tabs.find((t) => t.id === 'import')).toMatchObject({
      enabled: false,
      hint: 'Open a project first',
    })
    expect(vm.title).toBe('Harnesses')
    expect(vm.sub).toBe('Flows and standards agents follow.')
  })

  it('defaults the scope to the current project, else the first one', () => {
    const s = reduce(base(), { type: 'navigate', view: 'harness' })
    expect(harnessBuilderVM(s).scope.value).toBe(P1)
    expect(harnessBuilderVM(s).visible).toBe(true)
    const none = reduce(initialState(), { type: 'navigate', view: 'harness' })
    const vm = harnessBuilderVM(none)
    expect(vm.scope.value).toBeNull()
    expect(vm.scope.options[0]).toMatchObject({ id: null, name: 'No project', selected: true })
    expect(vm.applied.scopeSet).toBe(false)
    expect(vm.applied.noScope).toContain('Pick a project')
  })

  it('asks for a project before importing or showing coverage', () => {
    const vm = harnessBuilderVM(base())
    expect(vm.import.detect.enabled).toBe(false)
    expect(vm.coverage.projectName).toBeNull()
    expect(vm.head.importStart.enabled).toBe(false)
  })

  it('lists Applied rows in harnessIds order with ↑/↓ enabled except at the ends', () => {
    const vm = harnessBuilderVM(withApplied())
    expect(vm.applied.rows.map((r) => [r.id, r.position, r.up.enabled, r.down.enabled])).toEqual([
      [B, '1', false, true],
      [A, '2', true, false],
    ])
    expect(vm.applied.rows[0]?.flowChip).toBe('Flow · 3 steps')
    expect(vm.applied.emptyTip).toBeNull()
    expect(vm.applied.dropzone.text).toContain('Drop a harness here')
  })

  it('shows the empty tip when nothing is applied and the flow order with two flows', () => {
    let s = reduce(withApplied(), { type: 'harness-ui', patch: { projectId: P2 } })
    expect(harnessBuilderVM(s).applied.emptyTip).toContain('Tip')
    s = reduce(withApplied(), {
      type: 'harnesses',
      list: [
        summary({ id: A, name: 'Std', projectIds: [P1], stepCount: 2 }),
        summary({ id: B, name: 'TDD', projectIds: [P1], stepCount: 3 }),
      ],
    })
    expect(harnessBuilderVM(s).applied.flowOrder).toBe('Flow: TDD → Std')
  })

  it('falls back to the library when main sends no harnessIds', () => {
    let s = reduce(withApplied(), { type: 'projects', projects: [project()] })
    s = reduce(s, { type: 'harness-ui', patch: { projectId: P1 } })
    expect(harnessBuilderVM(s).applied.rows.map((r) => r.id)).toEqual([A, B])
  })

  it('sorts the library by the saved order, keeps the drawn order while dragging', () => {
    let s = reduce(withApplied(), { type: 'harness-ui', patch: { order: [A] } })
    expect(harnessBuilderVM(s).library.items.map((c) => c.id)).toEqual([A, C, B])
    s = reduce(s, {
      type: 'harness-ui',
      patch: { drag: { harnessId: B, source: 'library', status: 'published' } },
    })
    expect(harnessBuilderVM(s).library.items.map((c) => c.id)).toEqual([A, B, C])
    expect(harnessBuilderVM(s).library.items.find((c) => c.id === B)?.dragging).toBe(true)
    expect(harnessBuilderVM(s).library.sortHint).toBe('(drag to arrange)')
  })

  it('filters the library by the search text', () => {
    const s = reduce(withApplied(), { type: 'harness-ui', patch: { query: 'tdd' } })
    expect(harnessBuilderVM(s).library.items.map((c) => c.id)).toEqual([B])
    const none = reduce(withApplied(), { type: 'harness-ui', patch: { query: 'zzz' } })
    expect(harnessBuilderVM(none).library.noMatch).toBeTruthy()
  })

  it('marks draggable cards and why drafts would be refused', () => {
    let s = reduce(withApplied(), {
      type: 'harnesses',
      list: [summary({ id: A, status: 'archived' }), summary({ id: C, status: 'draft' })],
    })
    s = reduce(s, { type: 'harness-ui', patch: { selectedId: C } })
    const [draft, archived] = harnessBuilderVM(s).library.items
    expect(draft).toMatchObject({ id: C, draggable: true, selected: true })
    expect(draft?.dragReason).toContain('Publish')
    expect(archived).toMatchObject({ id: A, draggable: false })
    expect(draft?.summary).toContain('3 rules')
  })

  it('carries drop highlights from the drag state (re-render safe)', () => {
    let s = reduce(withApplied(), {
      type: 'harness-ui',
      patch: {
        drag: {
          harnessId: A,
          source: 'applied',
          status: 'published',
          over: { kind: 'applied-row', harnessId: B, after: false },
        },
      },
    })
    let vm = harnessBuilderVM(s)
    expect(vm.applied.rows.find((r) => r.id === B)?.dropMark).toBe('before')
    expect(vm.applied.rows.find((r) => r.id === A)?.dragging).toBe(true)
    s = reduce(s, {
      type: 'harness-ui',
      patch: {
        drag: { harnessId: C, source: 'library', status: 'draft', over: { kind: 'applied-zone' } },
      },
    })
    vm = harnessBuilderVM(s)
    expect(vm.applied.dropzone).toMatchObject({ over: false, reject: true })
    s = reduce(s, {
      type: 'harness-ui',
      patch: {
        drag: { harnessId: A, source: 'applied', status: 'published', over: { kind: 'library' } },
      },
    })
    expect(harnessBuilderVM(s).library.dropOver).toBe(true)
    expect(harnessBuilderVM(s).dnd.ctx).toMatchObject({ scopeProjectId: P1, applied: [B, A] })
  })

  it('words each confirm with the harness and the project', () => {
    let s = reduce(base(), { type: 'harnesses', list: [summary()] })
    s = reduce(s, {
      type: 'harness-ui',
      patch: { projectId: P1, confirm: { kind: 'attach', harnessId: 'hrn_aaaaaaaaaa' } },
    })
    const vm = harnessBuilderVM(s)
    expect(vm.confirm).toMatchObject({ open: true, okLabel: 'Attach', danger: false })
    expect(vm.confirm.text).toContain('"Team standards"')
    expect(vm.confirm.text).toContain('Alpha')
    expect(harnessBuilderVM(base()).confirm.open).toBe(false)
    const discard = reduce(s, {
      type: 'harness-ui',
      patch: { confirm: { kind: 'discard', harnessId: A } },
    })
    expect(harnessBuilderVM(discard).confirm).toMatchObject({
      text: 'Discard unsaved changes?',
      okLabel: 'Discard',
      danger: true,
    })
  })

  it('enables Create only with a selection and a name; prefills the name from the project', () => {
    let s = reduce(base(), { type: 'harness-ui', patch: { projectId: P1 } })
    s = reduce(s, { type: 'import-preview', preview: preview() })
    expect(harnessBuilderVM(s).import.name).toBe('Alpha standards')
    expect(harnessBuilderVM(s).import.create.enabled).toBe(true)
    s = reduce(s, { type: 'harness-ui', patch: { selection: { selected: [], gates: [] } } })
    expect(harnessBuilderVM(s).import.create.enabled).toBe(false)
  })

  it('marks excluded sources and needs one included to preview', () => {
    let s = reduce(base(), { type: 'harness-ui', patch: { projectId: P1 } })
    s = reduce(s, { type: 'import-sources', sources: preview().sources })
    expect(harnessBuilderVM(s).import.previewButton.enabled).toBe(true)
    s = reduce(s, { type: 'harness-ui', patch: { excluded: ['CLAUDE.md', 'AGENTS.md'] } })
    const vm = harnessBuilderVM(s)
    expect(vm.import.sources?.map((x) => x.included)).toEqual([false, false])
    expect(vm.import.previewButton.enabled).toBe(false)
  })

  it('carries the editor (with the dirty badge) and the provider coverage', () => {
    let s = reduce(base(), { type: 'harness-detail', detail: detail() })
    s = reduce(s, { type: 'harness-ui', patch: { coverage: [report()], editorTab: 'providers' } })
    let vm = harnessBuilderVM(s)
    expect(vm.editor?.providers).toHaveLength(1)
    expect(vm.coverage.reports).toHaveLength(1)
    expect(vm.coverage.reports[0]?.start.enabled).toBe(true)
    expect(vm.tabs.find((t) => t.id === 'editor')?.badge).toBeUndefined()
    s = reduce(s, {
      type: 'harness-ui',
      patch: { draft: { ...vm.editor!.draft, name: 'Renamed' } },
    })
    vm = harnessBuilderVM(s)
    expect(vm.editor?.dirty).toBe(true)
    expect(vm.tabs.find((t) => t.id === 'editor')?.badge).toBe('●')
  })

  it('shows the memory-only banner and lists disabled runtimes greyed', () => {
    let s = reduce(base(), { type: 'push', msg: { type: 'vault', status: 'memory-only' } })
    s = reduce(s, {
      type: 'providers',
      providers: [{ id: 'codex', label: 'Codex', enabled: false, state: 'installed' } as never],
    })
    const vm = harnessBuilderVM(s)
    expect(vm.banner).toContain('aren’t being saved')
    expect(vm.coverage.disabled).toEqual([
      { provider: 'codex', label: 'Codex', note: 'Not enabled in Settings' },
    ])
  })

  it('shows a flow preview for templates that carry steps', () => {
    const s = reduce(base(), {
      type: 'harness-ui',
      patch: {
        templates: [
          {
            id: 'content-pipeline',
            name: 'Content',
            description: 'd',
            ruleCount: 2,
            gateCount: 0,
            steps: [{ name: 'Research' }, { name: 'Outline' }, { name: 'Draft' }, { name: 'Pub' }],
          } as never,
        ],
      },
    })
    const t = harnessBuilderVM(s).templates[0]!
    expect(t.flow).toEqual(['1. Research', '2. Outline', '3. Draft'])
    expect(t.counts).toBe('4 steps · 2 rules · 0 gates')
  })
})
