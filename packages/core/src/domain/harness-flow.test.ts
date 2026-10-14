import { describe, expect, it } from 'vitest'
import { ValidationError } from './errors.ts'
import {
  advance,
  applyCheck,
  approve,
  artifactChecks,
  currentStepBadge,
  gateChecksFor,
  isStale,
  markDone,
  pendingApprovals,
  reopen,
  report,
  skip,
  startFlow,
  stepPolicies,
  toFlowView,
  transitions,
  voidGateChecks,
} from './harness-flow.ts'
import { compilePolicy } from './harness-policy.ts'
import type { EffectiveHarness, FlowProgress, FlowStep } from './harness-types.ts'

const step = (id: string, o: Partial<FlowStep> = {}): FlowStep => ({
  id,
  name: id.slice(4),
  goal: `goal ${id}`,
  exit: [{ kind: 'report' }],
  optional: false,
  ...o,
})

const STEPS: FlowStep[] = [
  step('stp_research'),
  step('stp_outline', { exit: [{ kind: 'approval', prompt: 'Outline approved' }] }),
  step('stp_draft', {
    exit: [{ kind: 'artifact', path: 'drafts/**', mustExist: true }, { kind: 'report' }],
    policies: [{ effect: 'deny', paths: ['published/**'] }],
  }),
  step('stp_tests', { optional: true, exit: [{ kind: 'gate', gateId: 'gat_check01' }] }),
  step('stp_publish'),
]

type Eff = Pick<EffectiveHarness, 'steps' | 'flowMode' | 'resolved' | 'gates'>
const eff = (mode: 'sequential' | 'free' = 'sequential', steps = STEPS): Eff => ({
  steps,
  flowMode: mode,
  resolved: [{ harnessId: 'hrn_aaaaaaaaaa', version: 2, name: 'Flow' }],
  gates: [{ id: 'gat_check01', name: 'Check', argv: ['make'], timeoutMs: 1000, required: true }],
})
const CTX = {
  sessionId: 'ses_1',
  agentId: 'cc:1',
  projectId: 'prj_1',
  now: 1,
  newId: (p: string) => `${p}_0000000001`,
}
const states = (p: FlowProgress) => p.steps.map((s) => s.state)

describe('harness flow (pure)', () => {
  it('starts sequential with the first step active; free with every step pending', () => {
    const p = startFlow(eff(), CTX)
    expect(p).toMatchObject({
      id: 'fpg_0000000001',
      sessionId: 'ses_1',
      agentId: 'cc:1',
      projectId: 'prj_1',
      harnessVersion: 'hrn_aaaaaaaaaa@2',
      mode: 'sequential',
      current: 'stp_research',
      updatedAt: 1,
    })
    expect(states(p)).toEqual(['active', 'pending', 'pending', 'pending', 'pending'])
    expect(p.steps[2]!.checks).toEqual(['pending', 'pending'])
    const f = startFlow(eff('free'), CTX)
    expect(f.current).toBeNull()
    expect(states(f)).toEqual(['pending', 'pending', 'pending', 'pending', 'pending'])
  })

  it('sequential: advances only when every check passes; report passes only report checks', () => {
    let p = startFlow(eff(), CTX)
    p = report(eff(), p, 'stp_research', 2)
    expect(p.current).toBe('stp_outline')
    expect(p.steps[0]).toMatchObject({ state: 'done', by: 'agent', doneAt: 2 })
    // The outline needs an approval: a report cannot pass it.
    expect(() => report(eff(), p, 'stp_outline', 3)).toThrow(ValidationError)
    // Not the active step.
    expect(() => report(eff(), p, 'stp_draft', 3)).toThrow(ValidationError)
    p = approve(eff(), p, 'stp_outline', 0, 3)
    expect(p.steps[1]).toMatchObject({ state: 'done', by: 'user' })
    expect(p.current).toBe('stp_draft')
    // Report on draft: the artifact is still pending, so the step stays active.
    p = report(eff(), p, 'stp_draft', 4)
    expect(p.steps[2]!.checks).toEqual(['pending', 'pass'])
    expect(p.current).toBe('stp_draft')
    p = advance(applyCheck(p, 'stp_draft', 0, 'pass', 5), 'sequential', 5)
    expect(p.steps[2]).toMatchObject({ state: 'done', by: 'checks' })
    expect(p.current).toBe('stp_tests')
  })

  it('approve refuses non-approval checks and bad indexes', () => {
    const p = startFlow(eff(), CTX)
    expect(() => approve(eff(), p, 'stp_research', 0, 2)).toThrow(ValidationError)
    expect(() => approve(eff(), p, 'stp_research', 9, 2)).toThrow(ValidationError)
    expect(() => approve(eff(), p, 'stp_nowhere', 0, 2)).toThrow(ValidationError)
  })

  it('markDone passes report checks but refuses unpassed approval/gate/artifact checks', () => {
    let p = startFlow(eff(), CTX)
    p = markDone(eff(), p, 'stp_research', 'user', 2)
    expect(p.steps[0]).toMatchObject({ state: 'done', by: 'user' })
    expect(() => markDone(eff(), p, 'stp_outline', 'user', 3)).toThrow(ValidationError)
    p = approve(eff(), p, 'stp_outline', 0, 3)
    expect(() => markDone(eff(), p, 'stp_draft', 'user', 4)).toThrow(/artifact/)
  })

  it('skip: optional freely, required only when confirmed; done steps cannot be skipped', () => {
    let p = startFlow(eff(), CTX)
    expect(() => skip(eff(), p, 'stp_research', { confirmed: false }, 2)).toThrow(ValidationError)
    p = skip(eff(), p, 'stp_research', { confirmed: true }, 2)
    expect(p.steps[0]!.state).toBe('skipped')
    expect(p.current).toBe('stp_outline')
    p = skip(eff(), p, 'stp_tests', { confirmed: false }, 3) // optional, not current
    expect(states(p)).toEqual(['skipped', 'active', 'pending', 'skipped', 'pending'])
    p = approve(eff(), p, 'stp_outline', 0, 4)
    expect(() => skip(eff(), p, 'stp_outline', { confirmed: true }, 5)).toThrow(ValidationError)
    p = skip(eff(), p, 'stp_draft', { confirmed: true }, 5)
    expect(p.current).toBe('stp_publish') // the skipped optional step is passed over
  })

  it('reopen makes a finished step active again with fresh checks', () => {
    let p = startFlow(eff(), CTX)
    p = report(eff(), p, 'stp_research', 2)
    p = reopen(eff(), p, 'stp_research', 3)
    expect(states(p)).toEqual(['active', 'pending', 'pending', 'pending', 'pending'])
    expect(p.steps[0]!.checks).toEqual(['pending'])
    expect(p.steps[0]!.doneAt).toBeUndefined()
    expect(() => reopen(eff(), p, 'stp_outline', 4)).toThrow(ValidationError)
  })

  it('free mode: any order, done when all required ones are', () => {
    let p = startFlow(eff('free'), CTX)
    p = report(eff('free'), p, 'stp_publish', 2)
    expect(states(p)).toEqual(['pending', 'pending', 'pending', 'pending', 'done'])
    expect(p.current).toBeNull()
    p = approve(eff('free'), p, 'stp_outline', 0, 3)
    expect(p.steps[1]!.state).toBe('done')
    expect(toFlowView(eff('free'), p).done).toBe(2)
  })

  it('gate checks follow a fresh pass and are voided by a later write', () => {
    const e = eff('sequential', [
      step('stp_tests', {
        exit: [
          { kind: 'gate', gateId: 'gat_check01' },
          { kind: 'approval', prompt: 'ok' },
        ],
      }),
      step('stp_after'),
    ])
    expect(gateChecksFor(e, 'gat_check01')).toEqual([{ stepId: 'stp_tests', checkIndex: 0 }])
    expect(gateChecksFor(e, 'gat_other001')).toEqual([])
    let p = startFlow(e, CTX)
    p = applyCheck(p, 'stp_tests', 0, 'pass', 2)
    p = voidGateChecks(e, p, 3)
    expect(p.steps[0]!.checks).toEqual(['pending', 'pending'])
    p = approve(e, applyCheck(p, 'stp_tests', 0, 'pass', 4), 'stp_tests', 1, 5)
    expect(p.current).toBe('stp_after')
    // A finished step's gate pass is never voided.
    expect(voidGateChecks(e, p, 6).steps[0]!.checks).toEqual(['pass', 'pass'])
  })

  it('artifact checks pending on available steps', () => {
    let p = startFlow(eff(), CTX)
    expect(artifactChecks(eff(), p)).toEqual([])
    p = approve(eff(), report(eff(), p, 'stp_research', 2), 'stp_outline', 0, 3)
    expect(artifactChecks(eff(), p)).toEqual([
      { stepId: 'stp_draft', checkIndex: 0, path: 'drafts/**', mustExist: true },
    ])
  })

  it('step policies apply only while their step is current (deny through compilePolicy)', () => {
    const write = { tool: 'Write', input: { file_path: '/w/published/a.md' }, cwd: '/w' }
    let p = startFlow(eff(), CTX)
    expect(stepPolicies(eff(), p)).toEqual([])
    p = approve(eff(), report(eff(), p, 'stp_research', 2), 'stp_outline', 0, 3)
    const rules = stepPolicies(eff(), p)
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ id: 'stp_draft', effect: 'deny', severity: 'required' })
    expect(compilePolicy(rules)(write).action).toBe('deny')
    p = skip(eff(), p, 'stp_draft', { confirmed: true }, 4)
    expect(compilePolicy(stepPolicies(eff(), p))(write).action).toBe('allow')
    expect(stepPolicies(eff('free'), startFlow(eff('free'), CTX))).toEqual([])
  })

  it('stale on a harness version change', () => {
    const p = startFlow(eff(), CTX)
    expect(isStale(p, eff())).toBe(false)
    expect(
      isStale(p, { ...eff(), resolved: [{ harnessId: 'hrn_aaaaaaaaaa', version: 3, name: 'F' }] }),
    ).toBe(true)
  })

  it('view: labels, waiting-user approvals, repo access, counts, badge and pending approvals', () => {
    let p = startFlow(eff(), CTX)
    p = report(eff(), p, 'stp_research', 2)
    const v = toFlowView(eff(), p)
    expect(v).toMatchObject({
      harnessVersion: 'hrn_aaaaaaaaaa@2',
      mode: 'sequential',
      current: 'stp_outline',
      done: 1,
      total: 5,
    })
    expect(v.steps[0]).toMatchObject({
      stepId: 'stp_research',
      index: 0,
      state: 'done',
      by: 'agent',
    })
    expect(v.steps[1]!.checks).toEqual([
      { index: 0, kind: 'approval', label: 'Outline approved', state: 'waiting-user' },
    ])
    expect(v.steps[2]!.checks[0]!.label).toBe('drafts/** (cannot check: no repository access)')
    expect(toFlowView(eff(), p, { repoAccess: true }).steps[2]!.checks[0]!.label).toBe('drafts/**')
    expect(v.steps[3]!.checks[0]!.label).toBe('Check')
    expect(v.steps[3]!.optional).toBe(true)
    expect(currentStepBadge(eff(), p)).toEqual({ index: 2, total: 5, name: 'outline' })
    expect(currentStepBadge(eff('free'), startFlow(eff('free'), CTX))).toBeUndefined()
    expect(pendingApprovals(eff(), p)).toEqual([
      { stepId: 'stp_outline', stepName: 'outline', checkIndex: 0, prompt: 'Outline approved' },
    ])
    expect(pendingApprovals(eff(), startFlow(eff(), CTX))).toEqual([])
  })

  it('transitions lists started, done and skipped steps', () => {
    const a = startFlow(eff(), CTX)
    const b = report(eff(), a, 'stp_research', 2)
    expect(transitions(a, b)).toEqual({
      started: ['stp_outline'],
      done: [{ stepId: 'stp_research', by: 'agent' }],
      skipped: [],
    })
    const c = skip(eff(), b, 'stp_outline', { confirmed: true }, 3)
    expect(transitions(b, c)).toEqual({
      started: ['stp_draft'],
      done: [],
      skipped: ['stp_outline'],
    })
  })
})
