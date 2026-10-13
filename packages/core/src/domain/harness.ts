// Harness entity rules (docs/harness.md §1): versioned drafts, immutable published versions. Pure;
// time and ids are passed in.
import {
  HarnessDraftSchema,
  type ConflictView,
  type Enforcement,
  type HarnessDetail,
  type HarnessDraft,
  type HarnessSummary,
} from '@agent-office/shared'
import { ValidationError } from './errors.ts'
import { detectConflicts } from './harness-conflicts.ts'
import type { Harness, HarnessRule, RuleSource, ValidationGate } from './harness-types.ts'

export type NewId = (prefix: string) => string

function parse(draft: HarnessDraft) {
  const r = HarnessDraftSchema.safeParse(draft)
  if (!r.success) throw new ValidationError(`invalid harness: ${r.error.issues[0]?.message ?? ''}`)
  return r.data
}

type Parsed = ReturnType<typeof parse>

function buildRules(
  d: Parsed,
  newId: NewId,
  known: Map<string, HarnessRule>,
  sources?: ReadonlyMap<string, RuleSource>,
): HarnessRule[] {
  return d.rules.map((r) => {
    if (r.enforcement === 'runtime-policy' && !r.policy)
      throw new ValidationError(`rule “${r.name.slice(0, 60)}” needs a policy`)
    const prev = r.id ? known.get(r.id) : undefined
    const preset = r.id && sources?.has(r.id) ? r.id : undefined
    const id = prev?.id ?? preset ?? newId('rul')
    const source = prev?.source ?? (preset ? sources!.get(preset) : undefined)
    return {
      id,
      name: r.name,
      text: r.text,
      category: r.category,
      enforcement: r.enforcement,
      severity: r.severity,
      ...(r.enforcement === 'runtime-policy' && r.policy ? { policy: r.policy } : {}),
      ...(r.appliesTo ? { appliesTo: r.appliesTo } : {}),
      ...(source ? { source } : {}),
    }
  })
}

function buildGates(d: Parsed, newId: NewId, known: Set<string>): ValidationGate[] {
  return d.gates.map((g) => ({
    id: g.id && known.has(g.id) ? g.id : newId('gat'),
    name: g.name,
    argv: [...g.argv],
    ...(g.subdir ? { subdir: g.subdir } : {}),
    timeoutMs: g.timeoutMs,
    required: g.required,
    ...(g.platforms ? { platforms: [...g.platforms] } : {}),
    ...(g.pinFiles ? { pinFiles: [...g.pinFiles] } : {}),
  }))
}

function fields(d: Parsed) {
  return {
    name: d.name,
    ...(d.description ? { description: d.description } : {}),
    scope: d.scope,
    launchPolicy: d.launchPolicy,
    gateTrigger: d.gateTrigger,
    fsIsolation: d.fsIsolation,
    retryBudget: d.retryBudget,
  }
}

/**
 * A new lineage at version 1. `sources` carries import provenance for rule ids the caller
 * pre-assigned (the importer); any other draft id is replaced by a fresh one.
 */
export function createHarness(
  draft: HarnessDraft,
  o: { id: string; now: number; newId: NewId; sources?: ReadonlyMap<string, RuleSource> },
): Harness {
  const d = parse(draft)
  return {
    id: o.id,
    version: 1,
    ...fields(d),
    status: 'draft',
    rules: buildRules(d, o.newId, new Map(), o.sources),
    gates: buildGates(d, o.newId, new Set()),
    createdAt: o.now,
    updatedAt: o.now,
  }
}

/** Edits a draft in place; a published version opens `version + 1` as a draft. */
export function reviseHarness(h: Harness, draft: HarnessDraft, now: number, newId: NewId): Harness {
  if (h.status === 'archived') throw new ValidationError('this harness is archived')
  const d = parse(draft)
  const rules = buildRules(d, newId, new Map(h.rules.map((r) => [r.id, r])))
  const gates = buildGates(d, newId, new Set(h.gates.map((g) => g.id)))
  return {
    id: h.id,
    version: h.status === 'published' ? h.version + 1 : h.version,
    ...fields(d),
    status: 'draft',
    rules,
    gates,
    createdAt: h.createdAt,
    updatedAt: now,
  }
}

export function publishHarness(h: Harness, now: number): Harness {
  if (h.status !== 'draft') throw new ValidationError(`this harness is ${h.status}`)
  if (!h.rules.length && !h.gates.length)
    throw new ValidationError('a harness needs at least one rule or gate')
  if (detectConflicts(h.rules).some((c) => c.kind === 'policy-opposite'))
    throw new ValidationError('resolve the policy conflicts before publishing')
  return { ...h, status: 'published', publishedAt: now, updatedAt: now }
}

export function archiveHarness(h: Harness, now: number): Harness {
  if (h.status === 'archived') throw new ValidationError('this harness is archived')
  return { ...h, status: 'archived', archivedAt: now, updatedAt: now }
}

export function toHarnessSummary(h: Harness, projectIds: string[]): HarnessSummary {
  const enforcement: Record<Enforcement, number> = {
    instruction: 0,
    'runtime-policy': 0,
    'validation-gate': 0,
  }
  for (const r of h.rules) enforcement[r.enforcement]++
  return {
    id: h.id,
    name: h.name,
    ...(h.description ? { description: h.description } : {}),
    version: h.version,
    status: h.status,
    scope: h.scope,
    launchPolicy: h.launchPolicy,
    ruleCount: h.rules.length,
    gateCount: h.gates.length,
    enforcement,
    projectIds: [...projectIds],
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
    ...(h.publishedAt !== undefined ? { publishedAt: h.publishedAt } : {}),
  }
}

export function toHarnessDetail(
  h: Harness,
  projectIds: string[],
  conflicts: ConflictView[],
): HarnessDetail {
  return {
    ...toHarnessSummary(h, projectIds),
    gateTrigger: h.gateTrigger,
    fsIsolation: h.fsIsolation,
    retryBudget: h.retryBudget,
    rules: h.rules.map((r) => ({ ...r, ...(r.source ? { source: { ...r.source } } : {}) })),
    gates: h.gates.map((g) => ({ ...g, argv: [...g.argv] })),
    conflicts,
  }
}
