import { describe, expect, it } from 'vitest'
import type { FlowStep, Harness, HarnessRule } from './harness-types.ts'
import { createProject } from './project.ts'
import { resolveEffective, versionKey } from './harness-resolve.ts'

const project = createProject({ id: 'prj_aaaaaaaaaaaa', name: 'Shop', now: 1 })
const rule = (id: string, o: Partial<HarnessRule> = {}): HarnessRule => ({
  id,
  name: `N${id}`,
  text: `Text of ${id}`,
  category: 'coding',
  enforcement: 'instruction',
  severity: 'required',
  ...o,
})
const h = (id: string, o: Partial<Harness> = {}): Harness => ({
  id,
  version: 1,
  name: id,
  scope: 'project',
  status: 'published',
  launchPolicy: 'advisory',
  gateTrigger: 'manual',
  fsIsolation: 'off',
  retryBudget: 3,
  rules: [],
  gates: [],
  createdAt: 1,
  updatedAt: 1,
  ...o,
})

describe('resolveEffective', () => {
  it('orders global → workspace → project, concatenates rules, builds policies and strictest settings', () => {
    const e = resolveEffective({
      project,
      provider: 'codex',
      now: 9,
      harnesses: [
        h('hrn_project', {
          version: 2,
          rules: [
            rule('rul_p', {
              enforcement: 'runtime-policy',
              text: 'x'.repeat(300),
              policy: { effect: 'deny', commands: ['rm'] },
              appliesTo: { runtimes: ['codex', 'claude-code'] },
            }),
          ],
          gates: [{ id: 'gat_1', name: 'g', argv: ['make'], timeoutMs: 1000, required: true }],
          gateTrigger: 'turn-end',
          retryBudget: 1,
        }),
        h('hrn_global', {
          scope: 'global',
          rules: [rule('rul_g')],
          launchPolicy: 'strict',
          fsIsolation: 'prefer',
        }),
        h('hrn_ws', {
          scope: 'workspace',
          rules: [rule('rul_w', { text: 'Text of rul_g' })],
          fsIsolation: 'require',
        }),
        h('hrn_draft', { status: 'draft', rules: [rule('rul_d')] }),
      ],
    })
    expect(e.resolved).toEqual([
      { harnessId: 'hrn_global', version: 1, name: 'hrn_global' },
      { harnessId: 'hrn_ws', version: 1, name: 'hrn_ws' },
      { harnessId: 'hrn_project', version: 2, name: 'hrn_project' },
    ])
    expect(e.rules.map((r) => r.id)).toEqual(['rul_g', 'rul_w', 'rul_p'])
    expect(e.policies).toEqual([
      {
        effect: 'deny',
        commands: ['rm'],
        id: 'rul_p',
        reason: `Nrul_p — ${'x'.repeat(120)}`,
        severity: 'required',
        providers: ['codex', 'claude-code'],
      },
    ])
    expect(e).toMatchObject({
      projectId: project.id,
      provider: 'codex',
      launchPolicy: 'strict',
      gateTrigger: 'turn-end',
      fsIsolation: 'require',
      retryBudget: 1,
      resolvedAt: 9,
    })
    expect(e.gates.map((g) => g.id)).toEqual(['gat_1'])
    expect(e.conflicts).toEqual([
      expect.objectContaining({ kind: 'duplicate', ruleIds: ['rul_g', 'rul_w'] }),
    ])
    expect(e.instructions).toContain('Text of rul_g')
    expect(versionKey(e)).toBe('hrn_global@1,hrn_ws@1,hrn_project@2')
  })

  it('drops rules for other runtimes but never a required parent rule; defaults when empty', () => {
    const e = resolveEffective({
      project,
      provider: 'claude-code',
      now: 1,
      harnesses: [
        h('hrn_a', {
          rules: [rule('rul_x', { appliesTo: { runtimes: ['codex'] } }), rule('rul_y')],
        }),
      ],
    })
    expect(e.rules.map((r) => r.id)).toEqual(['rul_y'])
    const empty = resolveEffective({ project, provider: 'claude-code', now: 1, harnesses: [] })
    expect(empty).toMatchObject({
      rules: [],
      launchPolicy: 'advisory',
      gateTrigger: 'manual',
      fsIsolation: 'off',
      retryBudget: 2,
      instructions: '',
    })
  })
})

const st = (id: string): FlowStep => ({
  id,
  name: id,
  goal: `goal ${id}`,
  exit: [{ kind: 'report' }],
  optional: false,
})

describe('resolveEffective flows', () => {
  it('concatenates steps in Applied order; free only when every flow is free; first step marked', () => {
    const e = resolveEffective({
      project,
      provider: 'claude-code',
      now: 1,
      harnesses: [
        h('hrn_a', { steps: [st('stp_a1'), st('stp_a2')], flowMode: 'free' }),
        h('hrn_b'),
        h('hrn_c', { steps: [st('stp_c1')], flowMode: 'sequential' }),
      ],
    })
    expect(e.steps!.map((s) => s.id)).toEqual(['stp_a1', 'stp_a2', 'stp_c1'])
    expect(e.flowMode).toBe('sequential')
    expect(e.instructions).toMatch(/1\. stp_a1 .*← you are here/)
    const free = resolveEffective({
      project,
      provider: 'claude-code',
      now: 1,
      harnesses: [h('hrn_a', { steps: [st('stp_a1')], flowMode: 'free' }), h('hrn_b')],
    })
    expect(free.flowMode).toBe('free')
    expect(free.instructions).not.toContain('← you are here')
  })

  it('has no steps without flows', () => {
    const e = resolveEffective({ project, provider: 'codex', now: 1, harnesses: [h('hrn_b')] })
    expect(e.steps).toEqual([])
    expect(e.flowMode).toBe('sequential')
  })
})
