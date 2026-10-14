import { describe, expect, it } from 'vitest'
import {
  harnessBadgeVM,
  harnessTabVM,
  newSessionHarnessVM,
  panelTabsVM,
} from './harness-inspector-vm.ts'
import { badge, effective, inspection, report } from './workspace/__fixtures__/harness.ts'
import type {
  FlowProgressView,
  GateResultView,
  HarnessEventView,
  PermissionRequestVM,
} from '@agent-office/shared'

const gate = (over: Partial<GateResultView> = {}): GateResultView => ({
  id: 'gtr_1',
  gateId: 'gat_g1',
  name: 'Check',
  status: 'pass',
  exitCode: 0,
  startedAt: 10,
  durationMs: 5,
  outputTail: '',
  required: true,
  harnessVersion: 'hrn_aaaaaaaaaa@2',
  ...over,
})
const denied = (over: Partial<HarnessEventView> = {}): HarnessEventView => ({
  id: 'hev_1',
  ts: 100,
  kind: 'action-denied',
  ruleIds: ['rul_b1'],
  tool: 'Edit',
  summary: 'Edit .env',
  ...over,
})

describe('harnessTabVM', () => {
  it('is loading until the first inspection arrives', () => {
    expect(harnessTabVM(null).state).toBe('loading')
  })

  it('says why nothing applies', () => {
    const none = harnessTabVM(inspection({ effective: null, report: null }))
    expect(none.state).toBe('none')
    expect(none.message).toContain('Attach one')
    const noProject = harnessTabVM(
      inspection({ effective: null, report: null, projectId: undefined }),
    )
    expect(noProject.message).toContain('not in a project')
  })

  it('names the applied harnesses with their versions and shows the six coverage rows', () => {
    const vm = harnessTabVM(inspection())
    expect(vm.state).toBe('ready')
    expect(vm.applied).toEqual(['Team standards v2'])
    expect(vm.coverage?.rows).toHaveLength(6)
    expect(vm.coverage?.rows[0]?.word).toBe('Enforced by runtime')
  })

  it('writes the counts line', () => {
    expect(harnessTabVM(inspection()).countsLine).toBe('12 allowed · 2 blocked · 1 asked')
  })

  it('marks gates not run, passed, failed and running', () => {
    const vm = harnessTabVM(
      inspection({
        effective: {
          ...inspection().effective!,
          gates: [
            {
              id: 'gat_g1',
              name: 'Check',
              argv: ['make', 'check'],
              timeoutMs: 1000,
              required: true,
            },
            {
              id: 'gat_g2',
              name: 'Lint',
              argv: ['make', 'lint'],
              timeoutMs: 1000,
              required: false,
            },
            {
              id: 'gat_g3',
              name: 'Types',
              argv: ['make', 'types'],
              timeoutMs: 1000,
              required: true,
            },
          ],
        },
        gates: [
          gate({ gateId: 'gat_g1', status: 'fail', startedAt: 20 }),
          gate({ id: 'gtr_0', gateId: 'gat_g1', status: 'pass', startedAt: 5 }),
          gate({ id: 'gtr_2', gateId: 'gat_g2', status: 'running' }),
        ],
      }),
    )
    expect(vm.gates.map((g) => [g.name, g.mark, g.statusLabel])).toEqual([
      ['Check', '✗', 'Failed'],
      ['Lint', '⏳', 'Running'],
      ['Types', '–', 'Not run'],
    ])
    expect(vm.gates[0]?.command).toBe('make check')
  })

  it('switches Run validation to Cancel while a gate runs, and disables it with no gates', () => {
    expect(harnessTabVM(inspection()).run).toMatchObject({
      action: 'run-gates',
      label: 'Run validation',
      enabled: true,
    })
    const running = harnessTabVM(inspection({ gates: [gate({ status: 'running' })] }))
    expect(running.run).toMatchObject({
      action: 'cancel-gates',
      label: 'Cancel validation',
      enabled: true,
    })
    const none = harnessTabVM(inspection({ effective: { ...inspection().effective!, gates: [] } }))
    expect(none.run.enabled).toBe(false)
    expect(none.run.hint).toBeTruthy()
  })

  it('shows completion and verification in words with tones', () => {
    const vm = harnessTabVM(inspection({ verification: 'failed', completion: 'validation-failed' }))
    expect(vm.completion).toEqual({ text: 'Validation failed', tone: 'bad' })
    expect(vm.verification).toEqual({ text: 'Validation failed', tone: 'bad' })
    const ok = harnessTabVM(
      inspection({ verification: 'verified', completion: 'harness-verified' }),
    )
    expect(ok.completion.tone).toBe('good')
    expect(ok.verification.text).toContain('Verified')
  })

  it('explains blocked actions with the rule names, newest first', () => {
    const vm = harnessTabVM(
      inspection({
        events: [
          denied({ id: 'hev_2', ts: 200, ruleIds: ['rul_zzz'] }),
          denied(),
          { id: 'hev_3', ts: 150, kind: 'action-allowed', ruleIds: [] },
        ],
      }),
    )
    expect(vm.denied.map((d) => d.id)).toEqual(['hev_2', 'hev_1'])
    expect(vm.denied[1]).toMatchObject({
      tool: 'Edit',
      summary: 'Edit .env',
      ruleNames: ['No secrets'],
    })
    expect(vm.denied[0]?.ruleNames).toEqual(['a rule that was removed'])
  })

  it('reports the retries left and a pinned-file warning', () => {
    const vm = harnessTabVM(inspection({ retriesLeft: 1, gates: [gate({ pinChanged: true })] }))
    expect(vm.retries).toBe('1 validation retry left')
    expect(vm.pinWarning).toContain('pinned file')
    expect(harnessTabVM(inspection()).retries).toBeUndefined()
  })

  it('never says guaranteed', () => {
    expect(JSON.stringify(harnessTabVM(inspection())).toLowerCase()).not.toContain('guarantee')
  })
})

describe('harnessBadgeVM', () => {
  it('builds the Minimal pill and its tooltip', () => {
    const vm = harnessBadgeVM(badge())
    expect(vm).toMatchObject({
      text: '2 blocked',
      coverage: 'partial',
      verification: 'verified',
      completion: 'harness-verified',
    })
    expect(vm.title).toBe(
      'Team standards · 3 rules · Partially enforced · Verified against the harness · 2 blocked',
    )
  })

  it('shows verification when nothing is blocked and no flow runs', () => {
    expect(harnessBadgeVM(badge({ denied: 0 })).text).toBe('Harness: verified')
  })

  it('puts the active flow step before blocked actions and verification', () => {
    const vm = harnessBadgeVM(badge({ step: { index: 3, total: 5, name: 'Review' } }))
    expect(vm.text).toBe('Step 3/5 · Review')
    expect(vm.step).toEqual({ index: 3, total: 5, name: 'Review' })
    expect(vm.title).toContain('Step 3/5 · Review')
  })

  it('omits the blocked count when nothing was blocked', () => {
    expect(harnessBadgeVM(badge({ denied: 0 })).title).not.toContain('blocked')
  })
})

describe('panelTabsVM', () => {
  it('names both tabs and shows the blocked count once known', () => {
    expect(panelTabsVM('details', null)).toEqual({
      show: true,
      active: 'details',
      details: 'Details',
      harness: 'Harness',
    })
    expect(panelTabsVM('harness', inspection()).badge).toBe('2')
    expect(
      panelTabsVM('harness', inspection({ counts: { allowed: 1, denied: 0, asked: 0 } })).badge,
    ).toBeUndefined()
  })
})

describe('newSessionHarnessVM', () => {
  const preview = { effective: effective(), report: report() }
  it('is hidden without a project', () => {
    expect(newSessionHarnessVM({ status: 'ready' }).visible).toBe(false)
  })
  it('says it is checking, failed, or that nothing is attached', () => {
    expect(newSessionHarnessVM({ projectId: 'p', status: 'loading' })).toMatchObject({
      visible: true,
      state: 'loading',
    })
    expect(newSessionHarnessVM({ projectId: 'p', status: 'failed' }).state).toBe('failed')
    const none = newSessionHarnessVM({
      projectId: 'p',
      status: 'ready',
      preview: { ...preview, effective: effective({ resolved: [] }) },
    })
    expect(none.state).toBe('none')
  })
  it('lists the attached harnesses and the coverage rows for the provider', () => {
    const vm = newSessionHarnessVM({ projectId: 'p', status: 'ready', preview })
    expect(vm.names).toEqual(['Team standards v2'])
    expect(vm.coverage?.rows).toHaveLength(6)
    expect(vm.warning).toBeNull()
    expect(vm.inspect.label).toBe('Inspect')
  })
  it('warns when required rules are only partly enforced, and blocks on a strict launch', () => {
    const warn = newSessionHarnessVM({
      projectId: 'p',
      status: 'ready',
      preview: {
        ...preview,
        effective: effective({ unsupported: [{ ruleId: 'rul_b1', reason: 'No path rules' }] }),
      },
    })
    expect(warn.warning).toMatchObject({ blocked: false, reasons: ['No path rules'] })
    const blocked = newSessionHarnessVM({
      projectId: 'p',
      status: 'ready',
      preview: {
        ...preview,
        report: report({ launch: { ok: false, reasons: ['Needs a sandbox'] } }),
      },
    })
    expect(blocked.warning).toMatchObject({ blocked: true, reasons: ['Needs a sandbox'] })
  })
})

const flow = (over: Partial<FlowProgressView> = {}): FlowProgressView => ({
  harnessVersion: 'hrn_aaaaaaaaaa@2',
  mode: 'sequential',
  current: 'stp_outline',
  done: 1,
  total: 4,
  steps: [
    {
      stepId: 'stp_research',
      index: 0,
      name: 'Research',
      goal: 'Sources gathered',
      state: 'done',
      optional: false,
      checks: [{ index: 0, kind: 'report', label: 'Agent reports', state: 'pass' }],
    },
    {
      stepId: 'stp_outline',
      index: 1,
      name: 'Outline',
      goal: 'Outline agreed',
      state: 'active',
      optional: false,
      checks: [
        { index: 0, kind: 'approval', label: 'Outline approved?', state: 'waiting-user' },
        { index: 1, kind: 'report', label: 'Agent reports', state: 'pending' },
      ],
    },
    {
      stepId: 'stp_draft',
      index: 2,
      name: 'Draft',
      goal: 'First draft written',
      state: 'pending',
      optional: true,
      checks: [{ index: 0, kind: 'artifact', label: 'drafts/**', state: 'pending' }],
    },
    {
      stepId: 'stp_publish',
      index: 3,
      name: 'Publish',
      goal: 'Live',
      state: 'skipped',
      optional: true,
      checks: [{ index: 0, kind: 'gate', label: 'make check', state: 'fail' }],
    },
  ],
  ...over,
})

describe('harnessTabVM: flow stepper', () => {
  const rows = () => harnessTabVM(inspection({ flow: flow() })).flow!.steps
  it('has no stepper without a flow', () => {
    expect(harnessTabVM(inspection()).flow).toBeUndefined()
  })

  it('numbers the steps from 1, marks the active one and words the states', () => {
    const vm = harnessTabVM(inspection({ flow: flow() })).flow!
    expect(vm.progress).toBe('1 of 4 steps done')
    expect(rows().map((r) => [r.index, r.state, r.current])).toEqual([
      [1, 'done', false],
      [2, 'active', true],
      [3, 'pending', false],
      [4, 'skipped', false],
    ])
    expect(rows()[1]!.checks[0]).toMatchObject({
      kind: 'approval',
      state: 'waiting-user',
      stateLabel: 'Waiting for you',
    })
  })

  it('offers Approve (primary) only for an approval waiting on the user', () => {
    const outline = rows()[1]!
    expect(outline.buttons.filter((b) => b.action === 'approve')).toEqual([
      { action: 'approve', label: 'Approve', primary: true, checkIndex: 0 },
    ])
    expect(rows()[2]!.buttons).toEqual([]) // pending in sequential mode: nothing to click
    const pass = flow()
    pass.steps[1]!.checks[0]!.state = 'pass'
    const again = harnessTabVM(inspection({ flow: pass })).flow!.steps[1]!
    expect(again.buttons.some((b) => b.action === 'approve')).toBe(false)
  })

  it('offers Mark done for a pending report check and Skip with a confirm on required steps', () => {
    const outline = rows()[1]!
    expect(outline.buttons.map((b) => b.action)).toEqual(['approve', 'mark-done', 'skip'])
    expect(outline.buttons.find((b) => b.action === 'skip')!.confirm).toContain('required step')
  })

  it('skips an optional step without a confirm, in free mode from pending', () => {
    const free = flow({ mode: 'free', current: null })
    const draft = harnessTabVM(inspection({ flow: free })).flow!.steps[2]!
    expect(draft.buttons).toEqual([{ action: 'skip', label: 'Skip', primary: false }])
  })

  it('offers Re-open on done and skipped steps', () => {
    expect(rows()[0]!.buttons.map((b) => b.action)).toEqual(['reopen'])
    expect(rows()[3]!.buttons.map((b) => b.action)).toEqual(['reopen'])
  })
})

describe('harnessTabVM: pending asks, gate output, running line, denied rows', () => {
  const ask = (over: Partial<PermissionRequestVM> = {}): PermissionRequestVM => ({
    id: 'perm_aaaaaaaaaa',
    tool: 'Bash',
    summary: 'git push',
    rule: { id: 'rul_b1', name: 'No pushes' },
    ...over,
  })

  it('lists harness ask cards with the rule that asked, never plain permissions or questions', () => {
    const vm = harnessTabVM(inspection(), {
      requests: [
        ask(),
        ask({ id: 'perm_bbbbbbbbbb', rule: undefined }),
        ask({
          id: 'perm_cccccccccc',
          question: { prompts: [{ question: 'Q?', header: '', options: [], multiSelect: false }] },
        }),
      ],
    })
    expect(vm.pending).toEqual([
      {
        requestId: 'perm_aaaaaaaaaa',
        tool: 'Bash',
        summary: 'git push',
        ruleName: 'No pushes',
        text: 'Asked because of the harness rule "No pushes"',
      },
    ])
  })

  it('keeps the redacted output of every finished gate behind "Show output"', () => {
    const vm = harnessTabVM(inspection({ gates: [gate({ outputTail: 'all green' })] }))
    expect(vm.gates[0]!.tail).toBe('all green')
    expect(vm.labels.showOutput).toBe('Show output')
  })

  it('writes a running line with the elapsed time', () => {
    const vm = harnessTabVM(inspection({ gates: [gate({ status: 'running', startedAt: 1000 })] }), {
      now: 13_000,
    })
    expect(vm.runningLine).toBe('Running Check… (12s)')
    expect(harnessTabVM(inspection()).runningLine).toBeUndefined()
  })

  it('shows 10 denied rows and a Show more count until expanded', () => {
    const events = Array.from({ length: 13 }, (_, i) => denied({ id: `hev_${i}`, ts: i }))
    const collapsed = harnessTabVM(inspection({ events }))
    expect(collapsed.denied).toHaveLength(10)
    expect(collapsed.deniedMore).toBe(3)
    expect(collapsed.labels.showMore).toBe('Show 3 more')
    const open = harnessTabVM(inspection({ events }), { showAllDenied: true })
    expect(open.denied).toHaveLength(13)
    expect(open.deniedMore).toBe(0)
  })
})

describe('panelTabsVM: badge', () => {
  it('adds pending asks, pending approvals and blocks since the panel opened', () => {
    const ins = inspection({ flow: flow() }) // 2 blocked, 1 approval waiting
    expect(panelTabsVM('details', ins, { baselineDenied: 0, pendingAsks: 2 }).badge).toBe('5')
    expect(panelTabsVM('details', ins, { baselineDenied: 2 }).badge).toBe('1')
    expect(
      panelTabsVM('details', inspection({ counts: { allowed: 0, denied: 2, asked: 0 } }), {
        baselineDenied: 2,
      }).badge,
    ).toBeUndefined()
  })
})

describe('newSessionHarnessVM: flow line', () => {
  it('names the flow and its first step', () => {
    const eff = {
      ...effective(),
      steps: [
        { id: 'stp_1', index: 0, name: 'Research', goal: 'g', exit: [], optional: false },
        { id: 'stp_2', index: 1, name: 'Draft', goal: 'g', exit: [], optional: false },
      ],
    }
    const vm = newSessionHarnessVM({
      projectId: 'prj_1',
      status: 'ready',
      preview: { effective: eff, report: report() },
    })
    expect(vm.flow).toEqual({
      line: 'Flow: Team standards · 2 steps',
      first: 'Starts with: Research',
    })
    const none = newSessionHarnessVM({
      projectId: 'prj_1',
      status: 'ready',
      preview: { effective: effective(), report: report() },
    })
    expect(none.flow).toBeUndefined()
  })
})
