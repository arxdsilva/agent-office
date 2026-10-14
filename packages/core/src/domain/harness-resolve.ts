// The effective harness of one project for one runtime (docs/harness.md §2). Pure: the caller
// passes the attached, published versions (latest per lineage).
import type { FlowMode, FsIsolation, ProviderId } from '@agent-office/shared'
import { detectConflicts } from './harness-conflicts.ts'
import { renderHarnessBlock } from './harness-instructions.ts'
import type { EffectiveHarness, Harness, HarnessRule, PolicyRule } from './harness-types.ts'
import type { Project } from './project.ts'
import { oneLine } from './text.ts'

const SCOPE_ORDER = { global: 0, workspace: 1, project: 2 } as const
const ISOLATION_RANK: Record<FsIsolation, number> = { off: 0, prefer: 1, require: 2 }
const DEFAULT_RETRIES = 2

/** "hrn_…@3,hrn_…@1": the harness versions a snapshot, an event or a gate result came from. */
export function versionKey(e: Pick<EffectiveHarness, 'resolved'>): string {
  return e.resolved.map((r) => `${r.harnessId}@${r.version}`).join(',')
}

function applies(r: HarnessRule, provider: ProviderId): boolean {
  const runtimes = r.appliesTo?.runtimes
  return !runtimes?.length || runtimes.includes(provider)
}

export function toPolicyRule(r: HarnessRule): PolicyRule | undefined {
  if (r.enforcement !== 'runtime-policy' || !r.policy) return undefined
  const runtimes = r.appliesTo?.runtimes
  return {
    ...r.policy,
    id: r.id,
    reason: oneLine(`${oneLine(r.name, 60)} — ${oneLine(r.text, 4000).slice(0, 120)}`, 200),
    severity: r.severity,
    ...(runtimes?.length ? { providers: [...runtimes] } : {}),
  }
}

export function resolveEffective(o: {
  project: Pick<Project, 'id'>
  harnesses: Harness[]
  provider: ProviderId
  now: number
}): EffectiveHarness {
  const hs = o.harnesses
    .filter((h) => h.status === 'published')
    .map((h, i) => ({ h, i }))
    .sort((a, b) => SCOPE_ORDER[a.h.scope] - SCOPE_ORDER[b.h.scope] || a.i - b.i)
    .map((x) => x.h)
  // Children only add: every parent rule is kept (concatenation, no override by id or text).
  const rules = hs.flatMap((h) => h.rules).filter((r) => applies(r, o.provider))
  const policies = rules.map(toPolicyRule).filter((p): p is PolicyRule => !!p)
  const seen = new Set<string>()
  const gates = hs.flatMap((h) => h.gates).filter((g) => !seen.has(g.id) && !!seen.add(g.id))
  // Flows run in Applied order (the project's attachment order), not by scope.
  const applied = o.harnesses.filter((h) => h.status === 'published')
  const steps = applied.flatMap((h) => h.steps ?? [])
  const withSteps = applied.filter((h) => h.steps?.length)
  const flowMode: FlowMode =
    withSteps.length && withSteps.every((h) => h.flowMode === 'free') ? 'free' : 'sequential'
  return {
    projectId: o.project.id,
    provider: o.provider,
    resolved: hs.map((h) => ({ harnessId: h.id, version: h.version, name: h.name })),
    rules,
    policies,
    gates,
    steps,
    flowMode,
    instructions: renderHarnessBlock(
      { rules, gates, steps, flowMode },
      // Delivered at session start: in sequential mode the first step is the current one.
      { flow: { current: flowMode === 'sequential' ? (steps[0]?.id ?? null) : null } },
    ),
    conflicts: detectConflicts(rules),
    launchPolicy: hs.some((h) => h.launchPolicy === 'strict') ? 'strict' : 'advisory',
    gateTrigger: hs.some((h) => h.gateTrigger === 'turn-end') ? 'turn-end' : 'manual',
    fsIsolation: hs.reduce<FsIsolation>(
      (acc, h) => (ISOLATION_RANK[h.fsIsolation] > ISOLATION_RANK[acc] ? h.fsIsolation : acc),
      'off',
    ),
    retryBudget: hs.length ? Math.min(...hs.map((h) => h.retryBudget)) : DEFAULT_RETRIES,
    resolvedAt: o.now,
  }
}
