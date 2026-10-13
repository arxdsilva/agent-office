import { describe, expect, it } from 'vitest'
import type { EffectiveHarness, EnforcementDecl, HarnessRule } from './harness-types.ts'
import { COVERAGE_REASONS, coverageFor, toReportView, weakest } from './harness-coverage.ts'

const CLAUDE: EnforcementDecl = {
  instructions: 'native',
  toolDeny: 'hook',
  pathDeny: 'hook',
  commandDeny: 'hook',
  fsIsolation: 'sandbox',
  subagents: 'inherited',
  nonInterceptingModes: ['bypassPermissions'],
  interceptingMode: 'default',
}
const ACP: EnforcementDecl = {
  instructions: 'first-message',
  toolDeny: 'approval',
  pathDeny: 'none',
  commandDeny: 'none',
  fsIsolation: 'none',
  subagents: 'opaque',
}
const r = (id: string, o: Partial<HarnessRule> = {}): HarnessRule => ({
  id,
  name: id,
  text: id,
  category: 'coding',
  enforcement: 'instruction',
  severity: 'required',
  ...o,
})
const RULES = [
  r('ins'),
  r('gate', { enforcement: 'validation-gate' }),
  r('tool', { enforcement: 'runtime-policy', policy: { effect: 'deny', tools: ['WebFetch'] } }),
  r('path', { enforcement: 'runtime-policy', policy: { effect: 'deny', paths: ['.env'] } }),
  r('cmd', { enforcement: 'runtime-policy', policy: { effect: 'deny', commands: ['rm'] } }),
  r('cmdpath', {
    enforcement: 'runtime-policy',
    policy: { effect: 'deny', commands: ['rm'], paths: ['src/**'] },
  }),
  r('sub', {
    enforcement: 'runtime-policy',
    severity: 'recommended',
    policy: { effect: 'deny', tools: ['Write'], roles: ['Explore'] },
  }),
]
const eff = (o: Partial<EffectiveHarness> = {}): EffectiveHarness => ({
  projectId: 'prj_1',
  provider: 'claude-code',
  resolved: [],
  rules: RULES,
  policies: [],
  gates: [],
  instructions: 'x',
  conflicts: [],
  launchPolicy: 'advisory',
  gateTrigger: 'manual',
  fsIsolation: 'off',
  retryBudget: 2,
  resolvedAt: 1,
  ...o,
})
const level = (rep: ReturnType<typeof coverageFor>, cap: string) =>
  rep.rows.find((x) => x.capability === cap)!.level

describe('coverageFor', () => {
  it('Claude Code: hook-enforced tools and paths, partial commands, sandbox only when requested', () => {
    const rep = coverageFor(eff(), CLAUDE, { mode: 'default' })
    expect(rep.rows.map((x) => [x.capability, x.level])).toEqual([
      ['instructions', 'enforced'],
      ['tool-deny', 'enforced'],
      ['path-deny', 'enforced'],
      ['command-deny', 'partial'],
      ['fs-isolation', 'unsupported'],
      ['subagents', 'enforced'],
    ])
    expect(rep.perRule).toMatchObject({
      ins: { coverage: 'instruction-only' },
      gate: { coverage: 'partial' },
      tool: { coverage: 'enforced' },
      path: { coverage: 'enforced' },
      cmd: { coverage: 'partial' },
      cmdpath: { coverage: 'partial' },
      sub: { coverage: 'enforced' },
    })
    expect(rep.launch).toEqual({ ok: true })
    const sandboxed = coverageFor(eff({ fsIsolation: 'require' }), CLAUDE, { mode: 'default' })
    expect(level(sandboxed, 'fs-isolation')).toBe('enforced')
    expect(sandboxed.perRule.cmdpath!.coverage).toBe('enforced')
    expect(sandboxed.perRule.cmd!.coverage).toBe('partial')
  })

  it('a non-intercepting mode drops every deny capability; strict refuses it', () => {
    const rep = coverageFor(eff(), CLAUDE, { mode: 'bypassPermissions' })
    expect(level(rep, 'tool-deny')).toBe('unsupported')
    expect(rep.perRule.tool!.coverage).toBe('unsupported')
    expect(rep.launch).toEqual({ ok: true })
    const strict = coverageFor(eff({ launchPolicy: 'strict' }), CLAUDE, {
      mode: 'x',
      modeId: 'bypassPermissions',
    })
    expect(strict.launch.ok).toBe(false)
    expect(strict.launch).toMatchObject({
      reasons: expect.arrayContaining([COVERAGE_REASONS.modeRefused]),
    })
  })

  it('ACP: first-message instructions, partial tools, unsupported paths; strict blocks on required unsupported', () => {
    const rep = coverageFor(eff({ launchPolicy: 'strict' }), ACP, { mode: 'default' })
    expect(level(rep, 'instructions')).toBe('instruction-only')
    expect(level(rep, 'tool-deny')).toBe('partial')
    expect(level(rep, 'subagents')).toBe('unsupported')
    expect(rep.perRule.path!.coverage).toBe('unsupported')
    expect(rep.perRule.sub!.coverage).toBe('unsupported')
    expect(rep.launch.ok).toBe(false)
    if (!rep.launch.ok) {
      expect(rep.launch.reasons.length).toBe(3) // path, cmd, cmdpath (sub is recommended)
      for (const x of rep.launch.reasons) expect(x.length).toBeLessThanOrEqual(160)
    }
    expect(toReportView(rep)).toEqual({
      provider: 'claude-code',
      rows: rep.rows,
      launch: rep.launch,
    })
  })

  it('no declaration: nothing is delivered or enforced', () => {
    const rep = coverageFor(eff(), undefined, { mode: 'default' })
    expect(rep.rows.every((x) => x.level === 'unsupported' || x.capability === 'subagents')).toBe(
      true,
    )
    expect(rep.perRule.ins!.coverage).toBe('unsupported')
  })

  it('weakest', () => {
    expect(weakest(['enforced', 'partial'])).toBe('partial')
    expect(weakest([])).toBe('enforced')
  })
})
