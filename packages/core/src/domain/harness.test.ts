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
