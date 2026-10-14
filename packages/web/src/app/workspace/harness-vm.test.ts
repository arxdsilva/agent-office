import { describe, expect, it } from 'vitest'
import {
  COVERAGE_WORD,
  changedFields,
  checkLabel,
  defaultImportSelection,
  defaultImportSteps,
  draftFromDetail,
  emptyCheck,
  emptyPolicy,
  flowPreview,
  gateFromFields,
  importStepsArg,
  isRepoRelative,
  newStepForm,
  ruleFieldsFrom,
  ruleFromFields,
  stepDraftFromView,
  stepFormFrom,
  stepFromForm,
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
  it('lists the seven tabs with Flow after Overview', () => {
    const vm = harnessEditorVM(detail(), 'overview')
    expect(vm.tabs.map((t) => t.id)).toEqual([
      'overview',
      'flow',
      'rules',
      'gates',
      'providers',
      'import',
      'history',
    ])
    expect(vm.tabs.find((t) => t.active)?.id).toBe('overview')
    expect(vm.history.items).toEqual([])
    expect(vm.history.empty).toBe('Loading…')
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

const STEP = {
  id: 'stp_aaaaaa',
  index: 0,
  name: 'Outline',
  goal: 'An outline exists',
  optional: false,
  exit: [
    { kind: 'approval' as const, label: 'Outline approved', prompt: 'Outline approved' },
    { kind: 'gate' as const, label: 'Check', gateId: 'gat_g1' },
    {
      kind: 'artifact' as const,
      label: 'docs/outline.md',
      path: 'docs/outline.md',
      mustExist: true,
    },
    { kind: 'report' as const, label: 'Say when done' },
  ],
}
const flowDetail = () =>
  detail({ steps: [STEP, { ...STEP, id: 'stp_bbbbbb', index: 1, name: 'Draft' }], stepCount: 2 })

describe('harnessLibraryVM (pane additions)', () => {
  it('counts steps, shows the flow chip and the drop line from the drag', () => {
    const vm = harnessLibraryVM([summary({ stepCount: 3 }), summary({ id: 'hrn_bbbbbbbbbb' })], {
      projects: [],
      currentProjectId: null,
      drag: {
        harnessId: 'hrn_bbbbbbbbbb',
        source: 'library',
        over: { kind: 'library-card', harnessId: 'hrn_aaaaaaaaaa', after: true },
      },
    })
    expect(vm.items[0]).toMatchObject({ counts: '3 steps · 3 rules · 1 gate', stepCount: 3 })
    expect(vm.items[0]?.dropMark).toBe('after')
    expect(vm.items[1]).toMatchObject({ dragging: true, dropMark: null })
    expect(vm.items[0]?.projects).toEqual([])
  })
})

describe('Flow editor', () => {
  it('turns stored steps into draft steps, keeping ids', () => {
    const d = draftFromDetail(flowDetail())
    expect(d.steps?.[0]).toEqual({
      id: 'stp_aaaaaa',
      name: 'Outline',
      goal: 'An outline exists',
      exit: [
        { kind: 'approval', prompt: 'Outline approved' },
        { kind: 'gate', gateId: 'gat_g1' },
        { kind: 'artifact', path: 'docs/outline.md', mustExist: true },
        { kind: 'report', note: 'Say when done' },
      ],
      optional: false,
    })
    expect(d.flowMode).toBe('sequential')
    expect(
      stepDraftFromView({ ...STEP, exit: [{ kind: 'report', label: '' }], roles: ['main'] }),
    ).toMatchObject({ roles: ['main'], exit: [{ kind: 'report' }] })
  })

  it('lists steps with ↑/↓ flags and checks in words; shows the mode only with steps', () => {
    const vm = harnessEditorVM(flowDetail(), 'flow')
    expect(vm.flow.steps.map((x) => [x.key, x.position, x.up, x.down])).toEqual([
      ['stp_aaaaaa', '1', false, true],
      ['stp_bbbbbb', '2', true, false],
    ])
    expect(vm.flow.steps[0]?.checks.map((c) => c.label)).toEqual([
      'Approval: "Outline approved"',
      'Gate: Check',
      'File: docs/outline.md',
      'Agent report: Say when done',
    ])
    expect(vm.flowMode).toBe('sequential')
    expect(harnessEditorVM(detail(), 'flow').flowMode).toBeNull()
    expect(harnessEditorVM(detail(), 'flow').flow.empty).toContain('No steps')
    expect(vm.flow.addStep.enabled).toBe(true)
    expect(vm.overview.find((r) => r.label === 'Contents')?.value).toBe(
      '2 steps · 3 rules · 1 gate',
    )
  })

  it('renders a client-side preview of what agents receive', () => {
    const lines = flowPreview(draftFromDetail(flowDetail()))
    expect(lines[0]).toBe('Flow: Team standards (sequential)')
    expect(lines[1]).toContain('1. Outline — An outline exists Exit: Approval')
    expect(flowPreview({ name: 'x' })).toEqual([])
    expect(
      flowPreview({
        name: 'x',
        flowMode: 'free',
        steps: [{ name: 'a', goal: 'g', instructions: 'Do it', exit: [{ kind: 'report' }] }],
      }),
    ).toEqual(['Flow: x (free)', '1. a — g Exit: Agent report', '   Do it'])
    expect(checkLabel({ kind: 'artifact', path: 'x', mustExist: false }, [])).toBe('No file: x')
    expect(checkLabel({ kind: 'gate', gateId: 'gat_zz' as never }, [])).toBe('Gate: gat_zz')
  })

  it('validates the step form: name, goal, ≥1 check, gate refs, repo-relative paths', () => {
    const f = { ...newStepForm(), checks: [] }
    const bad = stepFromForm(f, [])
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(Object.keys(bad.form.errors).sort()).toEqual(['checks', 'goal', 'name'])
    }
    const form = {
      ...newStepForm(),
      name: 'Review',
      goal: 'Reviewed',
      checks: [
        { ...emptyCheck('gate'), gateId: 'gat_nope' },
        { ...emptyCheck('artifact'), path: '../etc/passwd' },
        { ...emptyCheck('approval') },
      ],
      policies: [emptyPolicy()],
    }
    const r = stepFromForm(form, ['gat_g1'])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(Object.keys(r.form.checkErrors)).toEqual(['0', '1', '2'])
      expect(r.form.policyErrors[0]).toContain('restriction')
    }
    const ok = stepFromForm(
      {
        ...form,
        roles: 'main, reviewer',
        instructions: ' Check tone ',
        optional: true,
        checks: [
          { ...emptyCheck('gate'), gateId: 'gat_g1' },
          { ...emptyCheck('artifact'), path: 'drafts/**', mustExist: true },
          { ...emptyCheck('approval'), prompt: 'Looks good?' },
          { ...emptyCheck('report'), note: ' ' },
        ],
        policies: [{ ...emptyPolicy(), paths: 'published/**' }],
      },
      ['gat_g1'],
      'stp_keep01',
    )
    expect(ok).toEqual({
      ok: true,
      step: {
        id: 'stp_keep01',
        name: 'Review',
        goal: 'Reviewed',
        instructions: 'Check tone',
        roles: ['main', 'reviewer'],
        exit: [
          { kind: 'gate', gateId: 'gat_g1' },
          { kind: 'artifact', path: 'drafts/**', mustExist: true },
          { kind: 'approval', prompt: 'Looks good?' },
          { kind: 'report' },
        ],
        policies: [{ effect: 'deny', paths: ['published/**'] }],
        optional: true,
      },
    })
  })

  it('round-trips a step through the form', () => {
    const step = draftFromDetail(flowDetail()).steps![0]!
    const f = stepFormFrom({ ...step, policies: [{ effect: 'ask', commands: ['git'] }] }, 0)
    expect(f).toMatchObject({ index: 0, name: 'Outline', policies: [{ commands: 'git' }] })
    const back = stepFromForm(f, ['gat_g1'], step.id)
    expect(back.ok && back.step.exit).toEqual(step.exit)
  })

  it('shows the step form with gate options, counters and the check limit', () => {
    const d = flowDetail()
    const vm = harnessEditorVM(d, 'flow', [], {
      stepForm: { ...newStepForm(), goal: 'abc', checks: Array(6).fill(emptyCheck()) },
    })
    expect(vm.flow.form).toMatchObject({
      okLabel: 'Add step',
      goalCount: '3/600',
      canAddCheck: false,
      gateOptions: [{ id: 'gat_g1', name: 'Check' }],
    })
    expect(vm.flow.addStep.enabled).toBe(false)
    const edit = harnessEditorVM(d, 'flow', [], { stepForm: { ...newStepForm(), index: 0 } })
    expect(edit.flow.form?.okLabel).toBe('Update step')
  })

  it('warns when another applied harness also defines steps', () => {
    expect(harnessEditorVM(flowDetail(), 'flow', [], { otherFlows: true }).flow.warning).toContain(
      'Applied order',
    )
    expect(harnessEditorVM(detail(), 'flow', [], { otherFlows: true }).flow.warning).toBeNull()
  })

  it('checks repo-relative paths', () => {
    expect(isRepoRelative('docs/a.md')).toBe(true)
    for (const p of ['', '/etc', '~/x', 'C:/x', 'a/../b', '\\x'])
      expect(isRepoRelative(p)).toBe(false)
  })
})

describe('editor save state', () => {
  it('is clean until the draft differs; Save, Discard and Publish follow', () => {
    const d = detail({ status: 'draft' })
    const clean = harnessEditorVM(d)
    expect(clean).toMatchObject({ dirty: false, changed: 0 })
    expect(clean.save.enabled).toBe(false)
    expect(clean.publish?.enabled).toBe(true)
    const draft = { ...draftFromDetail(d), name: 'New', retryBudget: 4 }
    const vm = harnessEditorVM(d, 'overview', [], { draft })
    expect(vm).toMatchObject({ dirty: true, changed: 2, title: 'New' })
    expect(vm.save.enabled).toBe(true)
    expect(vm.discard.enabled).toBe(true)
    expect(vm.publish?.enabled).toBe(false)
    expect(harnessEditorVM(d, 'overview', [], { draft, busy: true }).save.enabled).toBe(false)
    expect(harnessEditorVM(d, 'overview', [], { saved: true }).save.label).toBe('Saved')
    expect(harnessEditorVM(detail()).save.hint).toContain('next version')
    expect(harnessEditorVM(detail()).publish).toBeNull()
  })

  it('draws rules from the draft (new rules included) with source titles', () => {
    const d = detail()
    const draft = draftFromDetail(d)
    draft.rules = [
      ...(draft.rules ?? []),
      { name: 'Fresh', text: 'x', category: 'content', enforcement: 'instruction' },
    ]
    const vm = harnessEditorVM(d, 'rules', [], {
      draft,
      ruleEditId: 'new-3',
      highlightRuleId: 'rul_a1',
    })
    expect(vm.rules.map((g) => g.label)).toEqual(['Coding', 'Testing', 'Security', 'Content'])
    expect(vm.rules.find((g) => g.category === 'content')?.rules[0]).toMatchObject({
      id: 'new-3',
      index: 3,
    })
    expect(vm.ruleEdit?.name).toBe('Fresh')
    expect(vm.rules[0]?.rules[0]?.highlighted).toBe(true)
    expect(vm.rules.find((g) => g.category === 'security')?.rules[0]?.sourceTitle).toContain('h ·')
  })

  it('lists versions newest first and shows an old one read-only with a banner', () => {
    const versions = [detail({ version: 1, publishedAt: 86_400_000 }), detail({ version: 2 })]
    const vm = harnessEditorVM(detail(), 'history', [], { versions, viewVersion: 1 })
    expect(vm.history.items.map((v) => [v.version, v.current, v.viewing])).toEqual([
      [2, true, false],
      [1, false, true],
    ])
    expect(vm.history.items[1]?.text).toContain('v1 · Published · 1970-01-02')
    expect(vm.history.banner).toBe('Viewing v1 (Published). Edit opens the current draft.')
    expect(vm.editable).toBe(false)
    expect(harnessEditorVM(detail(), 'history', [], { versions: [] }).history.empty).toBe(
      'No earlier version.',
    )
  })

  it('counts changed fields', () => {
    expect(changedFields({ name: 'a' }, { name: 'a' })).toEqual([])
    expect(changedFields({ name: 'a', rules: [] }, { name: 'b' })).toEqual(['name', 'rules'])
  })
})

describe('rule and gate forms', () => {
  it('validates a rule and keeps id and appliesTo', () => {
    expect(ruleFromFields(ruleFieldsFrom())).toEqual({
      ok: false,
      error: 'A rule needs a name and a text.',
    })
    const f = { ...ruleFieldsFrom(), name: 'N', text: 'T', enforcement: 'runtime-policy' as const }
    expect(ruleFromFields(f)).toMatchObject({ ok: false, error: expect.stringContaining('tool') })
    const r = ruleFromFields(
      { ...f, tools: 'Edit', roles: 'main', runtimes: ['codex'], category: 'compliance' },
      {
        id: 'rul_k1' as never,
        name: 'x',
        text: 'y',
        category: 'coding',
        enforcement: 'instruction',
      },
    )
    expect(r).toEqual({
      ok: true,
      rule: {
        id: 'rul_k1',
        name: 'N',
        text: 'T',
        category: 'compliance',
        enforcement: 'runtime-policy',
        severity: 'required',
        policy: { effect: 'deny', tools: ['Edit'], roles: ['main'] },
        appliesTo: { runtimes: ['codex'] },
      },
    })
    const back = ruleFieldsFrom(r.ok ? r.rule : undefined)
    expect(back).toMatchObject({ tools: 'Edit', roles: 'main', runtimes: ['codex'] })
    const dropped = ruleFromFields(
      { ...back, runtimes: [] },
      {
        name: 'x',
        text: 'y',
        category: 'coding',
        enforcement: 'instruction',
        appliesTo: { runtimes: ['codex'], agentRoles: ['main'] },
      },
    )
    expect(dropped.ok && dropped.rule.appliesTo).toEqual({ agentRoles: ['main'] })
    const none = ruleFromFields(
      { ...back, runtimes: [] },
      {
        name: 'x',
        text: 'y',
        category: 'coding',
        enforcement: 'instruction',
        appliesTo: { runtimes: ['codex'] },
      },
    )
    expect(none.ok && none.rule.appliesTo).toBeUndefined()
  })

  it('refuses shell characters in a gate and builds argv, timeout, pins, platforms', () => {
    const f = {
      name: '',
      command: 'make check',
      required: true,
      timeoutMin: 5,
      subdir: '',
      pins: 'Makefile, package.json',
      platforms: ['linux' as const],
    }
    expect(gateFromFields({ ...f, command: ' ' })).toEqual({
      ok: false,
      error: 'Type the command to run.',
    })
    const bad = gateFromFields({ ...f, command: 'make a | b && c' })
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.error).toContain('| &')
    expect(gateFromFields({ ...f, subdir: '../x' }).ok).toBe(false)
    expect(gateFromFields({ ...f, subdir: 'web', timeoutMin: 7 })).toEqual({
      ok: true,
      gate: {
        name: 'make check',
        argv: ['make', 'check'],
        required: true,
        timeoutMs: 600_000,
        subdir: 'web',
        pinFiles: ['Makefile', 'package.json'],
        platforms: ['linux'],
      },
    })
  })
})

describe('import step suggestions and filters', () => {
  const withSteps = () => ({
    ...preview(),
    steps: [
      {
        tempId: 'cand_s1',
        index: 0,
        name: 'Plan',
        goal: 'Plan it',
        source: preview().candidates[0]!.source,
      },
      {
        tempId: 'cand_s2',
        index: 1,
        name: 'Ship',
        goal: 'Ship it',
        source: preview().candidates[0]!.source,
      },
    ],
  })
  it('lists steps in the chosen order, unticked by default, with their check kind', () => {
    const p = withSteps()
    const st = defaultImportSteps(p)
    let vm = importPreviewVM(p, { selected: [], gates: [] }, {}, { steps: st })
    expect(vm.steps.map((x) => [x.tempId, x.checked, x.check, x.up, x.down])).toEqual([
      ['cand_s1', false, 'report', false, true],
      ['cand_s2', false, 'report', true, false],
    ])
    expect(vm.canCreate).toBe(false)
    const chosen = {
      order: ['cand_s2', 'cand_s1'],
      selected: ['cand_s1'],
      checks: { cand_s1: 'approval' as const },
    }
    vm = importPreviewVM(p, { selected: [], gates: [] }, {}, { steps: chosen })
    expect(vm.steps.map((x) => x.tempId)).toEqual(['cand_s2', 'cand_s1'])
    expect(vm.canCreate).toBe(true)
    expect(importStepsArg(chosen)).toEqual([{ tempId: 'cand_s1', check: 'approval' }])
    expect(vm.checkOptions[0]).toEqual({ value: 'report', label: 'Agent report' })
  })
  it('filters candidates by category and offers compare targets and select-all state', () => {
    const p = preview()
    const vm = importPreviewVM(p, defaultImportSelection(p), { cand_1: { category: 'process' } })
    expect(vm.filters.map((f) => [f.category, f.count])).toEqual([
      [null, 3],
      ['testing', 2],
      ['process', 1],
    ])
    expect(vm.groups[0]?.allChecked).toBe(true)
    expect(vm.groups[1]?.allChecked).toBe(false)
    expect(vm.groups[1]?.candidates[0]?.marks[0]?.compare).toBe('cand_1')
    const only = importPreviewVM(
      p,
      defaultImportSelection(p),
      { cand_1: { category: 'process' } },
      {
        filter: 'process',
      },
    )
    expect(only.groups.flatMap((g) => g.candidates.map((c) => c.tempId))).toEqual(['cand_1'])
    expect(only.filters.find((f) => f.active)?.category).toBe('process')
    expect(importPreviewVM(p, defaultImportSelection(p)).filters).toEqual([])
  })
  it('shows an edited enforcement', () => {
    const p = preview()
    const vm = importPreviewVM(p, defaultImportSelection(p), {
      cand_1: { enforcement: 'runtime-policy' },
    })
    expect(vm.groups[0]?.candidates[0]).toMatchObject({
      enforcement: 'runtime-policy',
      enforcementLabel: 'Runtime policy',
    })
  })
})
