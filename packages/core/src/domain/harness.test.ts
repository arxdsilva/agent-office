import { describe, expect, it } from 'vitest'
import { ValidationError } from './errors.ts'
import {
  archiveHarness,
  createHarness,
  publishHarness,
  reviseHarness,
  toHarnessDetail,
  toHarnessSummary,
} from './harness.ts'

let n = 0
const newId = (p: string) => `${p}_${String(++n).padStart(10, '0')}`
const make = (draft: Parameters<typeof createHarness>[0]) =>
  createHarness(draft, { id: 'hrn_aaaaaaaaaa', now: 1, newId })

const RULE = {
  name: 'Tests',
  text: 'Run the tests',
  category: 'testing' as const,
  enforcement: 'instruction' as const,
}
const GATE = { name: 'Check', argv: ['make', 'check'] }

describe('harness entity', () => {
  it('creates a version-1 draft with defaults and fresh rule/gate ids', () => {
    const h = make({ name: ' Std ', rules: [RULE], gates: [GATE] })
    expect(h).toMatchObject({
      id: 'hrn_aaaaaaaaaa',
      version: 1,
      name: 'Std',
      status: 'draft',
      scope: 'project',
      launchPolicy: 'advisory',
      gateTrigger: 'manual',
      fsIsolation: 'off',
      retryBudget: 2,
      createdAt: 1,
      updatedAt: 1,
    })
    expect(h.rules[0]!.id).toMatch(/^rul_/)
    expect(h.rules[0]!.severity).toBe('required')
    expect(h.gates[0]).toMatchObject({
      id: expect.stringMatching(/^gat_/),
      timeoutMs: 600_000,
      required: true,
    })
  })

  it('rejects invalid drafts and runtime-policy without policy; drops policy on other levels', () => {
    expect(() => make({ name: '' })).toThrow(ValidationError)
    expect(() => make({ name: 'x', rules: [{ ...RULE, enforcement: 'runtime-policy' }] })).toThrow(
      ValidationError,
    )
    const h = make({ name: 'x', rules: [{ ...RULE, policy: { effect: 'deny', tools: ['Bash'] } }] })
    expect(h.rules[0]!.policy).toBeUndefined()
  })

  it('keeps sources passed for pre-assigned rule ids', () => {
    const src = {
      format: 'agents-md' as const,
      path: 'AGENTS.md',
      repoLabel: 'shop',
      hash: 'h',
      importedAt: 1,
    }
    const h = createHarness(
      { name: 'x', rules: [{ ...RULE, id: 'rul_imported01' }] },
      { id: 'hrn_aaaaaaaaaa', now: 1, newId, sources: new Map([['rul_imported01', src]]) },
    )
    expect(h.rules[0]).toMatchObject({ id: 'rul_imported01', source: src })
  })

  it('revise edits a draft in place; on published opens version+1; keeps known ids and provenance', () => {
    const src = {
      format: 'agents-md' as const,
      path: 'AGENTS.md',
      repoLabel: 'shop',
      hash: 'h',
      importedAt: 1,
    }
    const h0 = make({ name: 'x', rules: [RULE], gates: [GATE] })
    const h = { ...h0, rules: [{ ...h0.rules[0]!, source: src }] }
    const ruleId = h.rules[0]!.id
    const gateId = h.gates[0]!.id
    const d = reviseHarness(
      h,
      {
        name: 'y',
        rules: [
          { ...RULE, id: ruleId, text: 'Run all tests' },
          { ...RULE, id: 'rul_unknown000' },
        ],
        gates: [{ ...GATE, id: gateId }],
      },
      5,
      newId,
    )
    expect(d).toMatchObject({ version: 1, name: 'y', updatedAt: 5, createdAt: 1 })
    expect(d.rules[0]).toMatchObject({ id: ruleId, text: 'Run all tests', source: src })
    expect(d.rules[1]!.id).not.toBe('rul_unknown000')
    expect(d.gates[0]!.id).toBe(gateId)
    const p = publishHarness(d, 6)
    expect(p).toMatchObject({ status: 'published', publishedAt: 6 })
    const v2 = reviseHarness(p, { name: 'z', rules: [RULE] }, 7, newId)
    expect(v2).toMatchObject({ version: 2, status: 'draft', updatedAt: 7 })
    expect(v2.publishedAt).toBeUndefined()
    expect(() => reviseHarness(archiveHarness(p, 8), { name: 'z' }, 9, newId)).toThrow(
      ValidationError,
    )
  })

  it('publish refuses empty, non-draft and policy-opposite harnesses', () => {
    expect(() => publishHarness(make({ name: 'x' }), 2)).toThrow(ValidationError)
    expect(publishHarness(make({ name: 'x', gates: [GATE] }), 2).status).toBe('published')
    const p = publishHarness(make({ name: 'x', rules: [RULE] }), 2)
    expect(() => publishHarness(p, 3)).toThrow(ValidationError)
    const opposite = make({
      name: 'x',
      rules: [
        { ...RULE, enforcement: 'runtime-policy', policy: { effect: 'deny', commands: ['rm'] } },
        {
          ...RULE,
          text: 'other',
          enforcement: 'runtime-policy',
          policy: { effect: 'ask', commands: ['rm'] },
        },
      ],
    })
    expect(() => publishHarness(opposite, 2)).toThrow(/conflict/)
  })

  it('archive marks the version archived once', () => {
    const a = archiveHarness(make({ name: 'x' }), 4)
    expect(a).toMatchObject({ status: 'archived', archivedAt: 4 })
    expect(() => archiveHarness(a, 5)).toThrow(ValidationError)
  })

  it('summary and detail views', () => {
    const h = make({
      name: 'x',
      description: 'd',
      rules: [RULE, { ...RULE, enforcement: 'validation-gate' }],
      gates: [GATE],
    })
    expect(toHarnessSummary(h, ['prj_1'])).toEqual({
      id: h.id,
      name: 'x',
      description: 'd',
      version: 1,
      status: 'draft',
      scope: 'project',
      launchPolicy: 'advisory',
      ruleCount: 2,
      gateCount: 1,
      stepCount: 0,
      enforcement: { instruction: 1, 'runtime-policy': 0, 'validation-gate': 1 },
      projectIds: ['prj_1'],
      createdAt: 1,
      updatedAt: 1,
    })
    const det = toHarnessDetail(h, [], [])
    expect(det).toMatchObject({
      gateTrigger: 'manual',
      fsIsolation: 'off',
      retryBudget: 2,
      conflicts: [],
    })
    expect(det.rules[0]).toEqual(h.rules[0])
    expect(det.gates[0]).toEqual(h.gates[0])
  })
})

describe('harness flow steps', () => {
  const STEP = {
    name: 'Draft',
    goal: 'A first version exists',
    exit: [{ kind: 'report' as const }],
  }

  it('creates steps with fresh stp_ ids, keeps flowMode, and remaps template gate ids in gate checks', () => {
    const h = make({
      name: 'x',
      gates: [{ ...GATE, id: 'gat_tmplcheck' }],
      steps: [
        { ...STEP, id: 'stp_fromdraft' },
        { name: 'Tests', goal: 'Green', exit: [{ kind: 'gate', gateId: 'gat_tmplcheck' }] },
      ],
      flowMode: 'free',
    })
    expect(h.flowMode).toBe('free')
    expect(h.steps).toHaveLength(2)
    for (const s of h.steps!) expect(s.id).toMatch(/^stp_/)
    expect(h.steps![0]!.id).not.toBe('stp_fromdraft')
    expect(h.steps![0]).toMatchObject({ name: 'Draft', optional: false })
    expect(h.steps![1]!.exit).toEqual([{ kind: 'gate', gateId: h.gates[0]!.id }])
    expect(h.gates[0]!.id).not.toBe('gat_tmplcheck')
  })

  it('a harness without steps carries no steps field', () => {
    expect(make({ name: 'x', rules: [RULE] }).steps).toBeUndefined()
  })

  it('revise keeps existing step ids and assigns new ones', () => {
    const h = make({ name: 'x', steps: [STEP] })
    const id = h.steps![0]!.id
    const v = reviseHarness(
      h,
      {
        name: 'x',
        steps: [
          { ...STEP, id },
          { ...STEP, name: 'Review', id: 'stp_unknown01' },
        ],
      },
      2,
      newId,
    )
    expect(v.steps![0]!.id).toBe(id)
    expect(v.steps![1]!.id).not.toBe('stp_unknown01')
  })

  it('publish accepts a steps-only harness, refuses a gate check on an unknown gate', () => {
    expect(publishHarness(make({ name: 'x', steps: [STEP] }), 2).status).toBe('published')
    const bad = make({
      name: 'x',
      steps: [{ ...STEP, exit: [{ kind: 'gate', gateId: 'gat_nowhere1' }] }],
    })
    expect(() => publishHarness(bad, 2)).toThrow(/gate/)
  })

  it('summary counts steps; detail has step views with index and check labels', () => {
    const h = make({
      name: 'x',
      gates: [{ ...GATE, id: 'gat_tmplcheck' }],
      steps: [
        {
          ...STEP,
          instructions: 'Write it',
          roles: ['main'],
          optional: true,
          policies: [{ effect: 'deny', paths: ['published/**'] }],
          exit: [
            { kind: 'approval', prompt: 'Outline approved' },
            { kind: 'gate', gateId: 'gat_tmplcheck' },
            { kind: 'artifact', path: 'drafts/**' },
            { kind: 'report', note: 'Say when done' },
            { kind: 'report' },
          ],
        },
      ],
    })
    expect(toHarnessSummary(h, []).stepCount).toBe(1)
    const d = toHarnessDetail(h, [], [])
    expect(d.flowMode).toBe('sequential')
    expect(d.steps![0]).toMatchObject({
      id: h.steps![0]!.id,
      index: 0,
      name: 'Draft',
      goal: 'A first version exists',
      instructions: 'Write it',
      roles: ['main'],
      optional: true,
      policies: [{ effect: 'deny', paths: ['published/**'] }],
    })
    expect(d.steps![0]!.exit.map((c) => c.label)).toEqual([
      'Outline approved',
      'Check',
      'drafts/**',
      'Say when done',
      'The agent reports it done',
    ])
    expect(d.steps![0]!.exit[1]).toMatchObject({ kind: 'gate', gateId: h.gates[0]!.id })
    expect(d.steps![0]!.exit[2]).toMatchObject({
      kind: 'artifact',
      path: 'drafts/**',
      mustExist: true,
    })
    expect(d.steps![0]!.exit[0]).toMatchObject({ kind: 'approval', prompt: 'Outline approved' })
  })
})
