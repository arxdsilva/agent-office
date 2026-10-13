import { describe, expect, it } from 'vitest'
import {
  harnessBadgeVM,
  harnessTabVM,
  newSessionHarnessVM,
  panelTabsVM,
} from './harness-inspector-vm.ts'
import { badge, effective, inspection, report } from './workspace/__fixtures__/harness.ts'
import type { GateResultView, HarnessEventView } from '@agent-office/shared'

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
      text: 'Harness: verified',
      coverage: 'partial',
      verification: 'verified',
      completion: 'harness-verified',
    })
    expect(vm.title).toBe(
      'Team standards · 3 rules · Partially enforced · Verified against the harness · 2 blocked',
    )
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
