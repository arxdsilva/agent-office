import { describe, expect, it } from 'vitest'
import {
  COVERAGE_WORD,
  defaultImportSelection,
  draftFromDetail,
  enforcementReportVM,
  harnessEditorVM,
  harnessLibraryVM,
  importPreviewVM,
  policyFromFields,
  policySummary,
} from './harness-vm.ts'
import { detail, preview, report, summary } from './__fixtures__/harness.ts'

describe('coverage words', () => {
  it('uses the fixed words and never "guaranteed"', () => {
    expect(COVERAGE_WORD).toEqual({
      enforced: 'Enforced by runtime',
      partial: 'Partially enforced',
      'instruction-only': 'Instruction applied',
      unsupported: 'Not supported here',
    })
    expect(JSON.stringify(COVERAGE_WORD).toLowerCase()).not.toContain('guarantee')
  })

  it('enforcementReportVM labels every row and carries the launch verdict', () => {
    const vm = enforcementReportVM(report())
    expect(vm.rows.map((r) => r.word)).toEqual([
      'Enforced by runtime',
      'Enforced by runtime',
      'Partially enforced',
      'Partially enforced',
      'Not supported here',
      'Instruction applied',
    ])
    expect(vm.rows[0]).toMatchObject({
      label: 'Instructions',
      tone: 'good',
      reason: 'System prompt',
    })
    expect(vm.rows[4]?.tone).toBe('bad')
    expect(vm.launch).toEqual({ ok: true, reasons: [] })
    const blocked = enforcementReportVM(
      report({ launch: { ok: false, reasons: ['no path rules'] } }),
    )
    expect(blocked.launch).toEqual({ ok: false, reasons: ['no path rules'] })
  })
})

describe('harnessLibraryVM', () => {
  const projects = [{ id: 'prj_1', name: 'Alpha' }]
  it('shows an empty state', () => {
    const vm = harnessLibraryVM([], { projects, currentProjectId: null })
    expect(vm.items).toEqual([])
    expect(vm.empty).toContain('No harness')
  })

  it('describes a card: version, status, counts, chips and attached project names', () => {
    const vm = harnessLibraryVM([summary({ projectIds: ['prj_1', 'prj_x'] })], {
      projects,
      currentProjectId: 'prj_1',
    })
    const c = vm.items[0]!
    expect(c).toMatchObject({
      name: 'Team standards',
      versionLabel: 'v2',
      status: 'published',
      statusLabel: 'Published',
      counts: '3 rules · 1 gate',
      projects: ['Alpha'],
      attached: true,
    })
    expect(c.chips.map((x) => [x.enforcement, x.count])).toEqual([
      ['instruction', 1],
      ['runtime-policy', 1],
      ['validation-gate', 1],
    ])
  })

  it('enables actions by status and by the current project', () => {
    const act = (s: Parameters<typeof summary>[0], cur: string | null) =>
      Object.fromEntries(
        harnessLibraryVM([summary(s)], { projects, currentProjectId: cur }).items[0]!.actions.map(
          (a) => [a.id, a.enabled],
        ),
      )
    expect(act({ status: 'draft' }, 'prj_1')).toMatchObject({
      edit: true,
      publish: true,
      archive: true,
      attach: false,
    })
    expect(act({ status: 'published' }, 'prj_1')).toMatchObject({ publish: false, attach: true })
    expect(act({ status: 'published' }, null)).toMatchObject({ attach: false })
    expect(act({ status: 'published', projectIds: ['prj_1'] }, 'prj_1')).toMatchObject({
      detach: true,
    })
    expect(act({ status: 'archived' }, 'prj_1')).toMatchObject({ archive: false, attach: false })
  })

  it('hides the zero-count chips', () => {
    const vm = harnessLibraryVM(
      [summary({ enforcement: { instruction: 3, 'runtime-policy': 0, 'validation-gate': 0 } })],
      { projects, currentProjectId: null },
    )
    expect(vm.items[0]?.chips).toHaveLength(1)
  })
})

describe('policySummary', () => {
  it('says what a deny rule blocks in words', () => {
    expect(
      policySummary({
        effect: 'deny',
        tools: ['Edit', 'Write'],
        paths: ['.env*'],
        except: ['.env.example'],
      }),
    ).toBe('Blocks Edit, Write on .env* (except .env.example)')
  })
  it('says what an ask rule does for commands, hosts and roles', () => {
    expect(
      policySummary({
        effect: 'ask',
        commands: ['rm', 'git'],
        hosts: ['*.evil.test'],
        roles: ['main'],
      }),
    ).toBe('Asks first for commands rm, git, hosts *.evil.test, for main')
  })
  it('handles an empty policy', () => {
    expect(policySummary({ effect: 'deny' })).toBe('Blocks every matching action')
  })
})

describe('policyFromFields', () => {
  it('splits comma lists and drops empties', () => {
    expect(
      policyFromFields({
        effect: 'deny',
        tools: 'Edit, Write,',
        paths: '',
        commands: 'rm',
        hosts: '',
      }),
    ).toEqual({ effect: 'deny', tools: ['Edit', 'Write'], commands: ['rm'] })
  })
})

describe('harnessEditorVM', () => {
  it('lists the six tabs with History as a stub', () => {
    const vm = harnessEditorVM(detail(), 'overview')
    expect(vm.tabs.map((t) => t.id)).toEqual([
      'overview',
      'rules',
      'gates',
      'providers',
      'import',
      'history',
    ])
    expect(vm.tabs.find((t) => t.active)?.id).toBe('overview')
    expect(vm.history).toContain('later version')
  })

  it('groups rules by category with labels and policy words', () => {
    const vm = harnessEditorVM(detail(), 'rules')
    expect(vm.rules.map((g) => g.label)).toEqual(['Coding', 'Testing', 'Security'])
    const sec = vm.rules.find((g) => g.category === 'security')!.rules[0]!
    expect(sec).toMatchObject({
      name: 'No secrets',
      enforcementLabel: 'Runtime policy',
      severityLabel: 'Required',
      policySummary: 'Blocks Edit, Write on .env* (except .env.example)',
    })
  })

  it('shows the gate argv joined for display', () => {
    const g = harnessEditorVM(detail(), 'gates').gates[0]!
    expect(g).toMatchObject({ name: 'Check', command: 'make check', required: true })
    expect(g.details).toContain('10 min')
    expect(g.details).toContain('Pinned files: Makefile')
  })

  it('names the conflicting rules', () => {
    const c = harnessEditorVM(detail(), 'overview').conflicts[0]!
    expect(c.kindLabel).toBe('Duplicate')
    expect(c.ruleNames).toEqual(['Small functions', 'Tests green'])
  })

  it('lists import provenance once per source file', () => {
    const vm = harnessEditorVM(detail(), 'import')
    expect(vm.sources).toEqual([
      { label: 'CLAUDE.md', path: 'CLAUDE.md', repoLabel: 'repo', rules: 1 },
    ])
  })

  it('adds the provider coverage when it was loaded', () => {
    const vm = harnessEditorVM(detail(), 'providers', [report()])
    expect(vm.providers).toHaveLength(1)
    expect(vm.providers[0]?.provider).toBe('claude-code')
  })

  it('is read-only when archived', () => {
    expect(harnessEditorVM(detail({ status: 'archived' }), 'rules').editable).toBe(false)
    expect(harnessEditorVM(detail(), 'rules').editable).toBe(true)
  })
})

describe('draftFromDetail', () => {
  it('keeps ids so provenance and history survive an edit', () => {
    const d = draftFromDetail(detail())
    expect(d.rules?.[1]).toMatchObject({ id: 'rul_b1', enforcement: 'runtime-policy' })
    expect(d.gates?.[0]).toMatchObject({ id: 'gat_g1', argv: ['make', 'check'] })
    expect(d).toMatchObject({ name: 'Team standards', retryBudget: 2, scope: 'project' })
  })
})

describe('importPreviewVM', () => {
  it('selects every non-duplicate candidate and no gate by default', () => {
    expect(defaultImportSelection(preview())).toEqual({
      selected: ['cand_1', 'cand_3'],
      gates: [],
    })
  })

  it('groups candidates by source and marks duplicates and conflicts', () => {
    const p = preview()
    const vm = importPreviewVM(p, defaultImportSelection(p))
    expect(vm.groups.map((g) => [g.label, g.candidates.length])).toEqual([
      ['CLAUDE.md', 2],
      ['AGENTS.md', 1],
    ])
    const dup = vm.groups[1]!.candidates[0]!
    expect(dup.checked).toBe(false)
    expect(dup.marks.map((m) => m.kind)).toEqual(['duplicate'])
    const conflict = vm.groups[0]!.candidates[1]!
    expect(conflict.marks.map((m) => m.kind)).toEqual(['conflict'])
    expect(conflict.checked).toBe(true)
  })

  it('shows rejected gates with their reason and cannot select them', () => {
    const p = preview()
    const vm = importPreviewVM(p, { selected: [], gates: ['cand_g1', 'cand_g2'] })
    expect(vm.gates[0]).toMatchObject({ command: 'make check', selectable: true, checked: true })
    expect(vm.gates[1]).toMatchObject({ selectable: false, checked: false })
    expect(vm.gates[1]?.rejected).toBe('Cannot be a gate: contains a pipe')
  })

  it('writes the totals line and enables create only with a name and a selection', () => {
    const p = preview()
    const vm = importPreviewVM(p, defaultImportSelection(p))
    expect(vm.totals).toBe('2 of 3 rules selected · 1 conflict to review')
    expect(vm.canCreate).toBe(true)
    expect(importPreviewVM(p, { selected: [], gates: [] }).canCreate).toBe(false)
  })

  it('lists the sources with their rule counts', () => {
    const vm = importPreviewVM(preview(), { selected: [], gates: [] })
    expect(vm.sources.map((s) => s.count)).toEqual(['2 rules', '1 rule'])
  })
})

describe('importPreviewVM edits', () => {
  it('shows the reviewer edits in the rows', () => {
    const p = preview()
    const vm = importPreviewVM(p, defaultImportSelection(p), {
      cand_1: { name: 'TDD first', category: 'workflow', severity: 'recommended' },
    })
    const c = vm.groups[0]!.candidates[0]!
    expect(c).toMatchObject({
      name: 'TDD first',
      category: 'workflow',
      categoryLabel: 'Workflow',
      severity: 'recommended',
    })
  })
})
