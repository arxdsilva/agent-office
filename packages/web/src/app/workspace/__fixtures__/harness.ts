// Invented harness fixtures for the view-model tests (no real project content).
import type {
  EffectiveHarnessView,
  EnforcementReportView,
  HarnessBadge,
  HarnessDetail,
  HarnessInspection,
  HarnessRuleView,
  HarnessSummary,
  ImportPreview,
} from '@agent-office/shared'

export const rule = (over: Partial<HarnessRuleView> & { id: string }): HarnessRuleView => ({
  name: `Rule ${over.id}`,
  text: 'Keep functions small.',
  category: 'coding',
  enforcement: 'instruction',
  severity: 'required',
  ...over,
})

export const summary = (over: Partial<HarnessSummary> = {}): HarnessSummary => ({
  id: 'hrn_aaaaaaaaaa',
  name: 'Team standards',
  description: 'How we build',
  version: 2,
  status: 'published',
  scope: 'project',
  launchPolicy: 'advisory',
  ruleCount: 3,
  gateCount: 1,
  enforcement: { instruction: 1, 'runtime-policy': 1, 'validation-gate': 1 },
  projectIds: [],
  createdAt: 1,
  updatedAt: 2,
  ...over,
})

export const detail = (over: Partial<HarnessDetail> = {}): HarnessDetail => ({
  ...summary(),
  gateTrigger: 'manual',
  fsIsolation: 'off',
  retryBudget: 2,
  rules: [
    rule({ id: 'rul_a1', name: 'Small functions', category: 'coding' }),
    rule({
      id: 'rul_b1',
      name: 'No secrets',
      category: 'security',
      enforcement: 'runtime-policy',
      policy: {
        effect: 'deny',
        tools: ['Edit', 'Write'],
        paths: ['.env*'],
        except: ['.env.example'],
      },
      source: {
        format: 'claude-md',
        path: 'CLAUDE.md',
        repoLabel: 'repo',
        hash: 'h',
        importedAt: 5,
      },
    }),
    rule({
      id: 'rul_c1',
      name: 'Tests green',
      category: 'testing',
      enforcement: 'validation-gate',
    }),
  ],
  gates: [
    {
      id: 'gat_g1',
      name: 'Check',
      argv: ['make', 'check'],
      timeoutMs: 600_000,
      required: true,
      pinFiles: ['Makefile'],
    },
  ],
  conflicts: [{ kind: 'duplicate', ruleIds: ['rul_a1', 'rul_c1'], text: 'Same text twice' }],
  ...over,
})

export const report = (over: Partial<EnforcementReportView> = {}): EnforcementReportView => ({
  provider: 'claude-code',
  rows: [
    { capability: 'instructions', level: 'enforced', reason: 'System prompt' },
    { capability: 'tool-deny', level: 'enforced', reason: 'PreToolUse hook' },
    { capability: 'path-deny', level: 'partial', reason: 'Symlinks not followed' },
    { capability: 'command-deny', level: 'partial', reason: 'argv heuristic' },
    { capability: 'fs-isolation', level: 'unsupported', reason: 'No sandbox' },
    { capability: 'subagents', level: 'instruction-only', reason: 'First message only' },
  ],
  launch: { ok: true },
  ...over,
})

export const effective = (over: Partial<EffectiveHarnessView> = {}): EffectiveHarnessView => ({
  resolved: [{ harnessId: 'hrn_aaaaaaaaaa', version: 2, name: 'Team standards' }],
  rules: detail().rules,
  gates: detail().gates,
  unsupported: [],
  conflicts: [],
  launchPolicy: 'advisory',
  gateTrigger: 'manual',
  fsIsolation: 'off',
  instructionsChars: 900,
  ...over,
})

export const inspection = (over: Partial<HarnessInspection> = {}): HarnessInspection => ({
  agentId: 'cc:1',
  projectId: 'prj_1',
  effective: effective(),
  report: report(),
  counts: { allowed: 12, denied: 2, asked: 1 },
  events: [],
  gates: [],
  verification: 'not-run',
  completion: 'agent-reported',
  ...over,
})

export const badge = (over: Partial<HarnessBadge> = {}): HarnessBadge => ({
  agentId: 'cc:1',
  harnessNames: ['Team standards'],
  ruleCount: 3,
  coverage: 'partial',
  verification: 'verified',
  completion: 'harness-verified',
  denied: 2,
  ...over,
})

export const preview = (): ImportPreview => {
  const src = (path: string) => ({
    format: 'claude-md' as const,
    path,
    repoLabel: 'repo',
    hash: 'h',
    importedAt: 1,
  })
  return {
    previewId: 'prv_aaaaaa',
    projectId: 'prj_1',
    sources: [
      { path: 'CLAUDE.md', repoLabel: 'repo', format: 'claude-md', bytes: 100, ruleCount: 2 },
      { path: 'AGENTS.md', repoLabel: 'repo', format: 'agents-md', bytes: 80, ruleCount: 1 },
    ],
    candidates: [
      {
        tempId: 'cand_1',
        name: 'Use TDD',
        text: 'Write the test first.',
        category: 'testing',
        enforcement: 'instruction',
        severity: 'required',
        source: src('CLAUDE.md'),
      },
      {
        tempId: 'cand_2',
        name: 'Use TDD again',
        text: 'Write the test first.',
        category: 'testing',
        enforcement: 'instruction',
        severity: 'required',
        source: src('AGENTS.md'),
        duplicateOf: 'cand_1',
      },
      {
        tempId: 'cand_3',
        name: 'Never mock',
        text: 'Never mock the db.',
        category: 'testing',
        enforcement: 'instruction',
        severity: 'recommended',
        source: src('CLAUDE.md'),
        conflictsWith: ['cand_1'],
      },
    ],
    gates: [
      {
        tempId: 'cand_g1',
        name: 'check',
        argv: ['make', 'check'],
        source: { ...src('Makefile'), format: 'makefile' },
      },
      {
        tempId: 'cand_g2',
        name: 'pipe',
        argv: ['make', 'a|b'],
        source: { ...src('Makefile'), format: 'makefile' },
        rejected: 'contains a pipe',
      },
    ],
    conflicts: [{ kind: 'negation', ruleIds: ['cand_1', 'cand_3'], text: 'Always vs never' }],
    totals: {
      rules: 3,
      byCategory: {
        architecture: 0,
        coding: 0,
        testing: 3,
        security: 0,
        workflow: 0,
        tools: 0,
        completion: 0,
        process: 0,
        content: 0,
        research: 0,
        communication: 0,
        compliance: 0,
        other: 0,
      },
      conflicts: 1,
    },
  }
}
