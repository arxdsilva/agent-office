// Harness entity rules (docs/harness.md §1): versioned drafts, immutable published versions. Pure;
// time and ids are passed in.
import {
  HarnessDraftSchema,
  type ConflictView,
  type Enforcement,
  type HarnessDetail,
  type HarnessDraft,
  type HarnessSummary,
  type StepCheck,
  type StepCheckView,
  type StepView,
} from '@agent-office/shared'
import { ValidationError } from './errors.ts'
import { detectConflicts } from './harness-conflicts.ts'
import type { FlowStep, Harness, HarnessRule, RuleSource, ValidationGate } from './harness-types.ts'

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

/** Builds gates; `remap` collects draft gate ids that got a fresh id (template or unknown ids). */
function buildGates(
  d: Parsed,
  newId: NewId,
  known: Set<string>,
  remap: Map<string, string>,
): ValidationGate[] {
  return d.gates.map((g) => {
    const id = g.id && known.has(g.id) ? g.id : newId('gat')
    if (g.id && g.id !== id) remap.set(g.id, id)
    return gateOf(g, id)
  })
}

function gateOf(g: Parsed['gates'][number], id: string): ValidationGate {
  return {
    id,
    name: g.name,
    argv: [...g.argv],
    ...(g.subdir ? { subdir: g.subdir } : {}),
    timeoutMs: g.timeoutMs,
    required: g.required,
    ...(g.platforms ? { platforms: [...g.platforms] } : {}),
    ...(g.pinFiles ? { pinFiles: [...g.pinFiles] } : {}),
  }
}

/** Steps keep known ids; gate checks follow the gate id remap (a template's gate gets a fresh id). */
function buildSteps(
  d: Parsed,
  newId: NewId,
  known: Set<string>,
  remap: Map<string, string>,
): FlowStep[] {
  return d.steps.map((s) => ({
    id: s.id && known.has(s.id) ? s.id : newId('stp'),
    name: s.name,
    goal: s.goal,
    ...(s.instructions ? { instructions: s.instructions } : {}),
    ...(s.roles?.length ? { roles: [...s.roles] } : {}),
    exit: s.exit.map((c): StepCheck => {
      if (c.kind === 'gate') return { kind: 'gate', gateId: remap.get(c.gateId) ?? c.gateId }
      if (c.kind === 'artifact') return { kind: 'artifact', path: c.path, mustExist: c.mustExist }
      if (c.kind === 'report') return c.note ? { kind: 'report', note: c.note } : { kind: 'report' }
      return { kind: 'approval', prompt: c.prompt }
    }),
    ...(s.policies?.length ? { policies: s.policies.map((p) => ({ ...p })) } : {}),
    optional: s.optional,
  }))
}

/** `steps`/`flowMode` only when the draft has steps (older records stay unchanged). */
function flowOf(steps: FlowStep[], d: Parsed): Pick<Harness, 'steps' | 'flowMode'> {
  return steps.length ? { steps, flowMode: d.flowMode } : {}
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
  const remap = new Map<string, string>()
  const gates = buildGates(d, o.newId, new Set(), remap)
  return {
    id: o.id,
    version: 1,
    ...fields(d),
    status: 'draft',
    rules: buildRules(d, o.newId, new Map(), o.sources),
    gates,
    ...flowOf(buildSteps(d, o.newId, new Set(), remap), d),
    createdAt: o.now,
    updatedAt: o.now,
  }
}

/** Edits a draft in place; a published version opens `version + 1` as a draft. */
export function reviseHarness(h: Harness, draft: HarnessDraft, now: number, newId: NewId): Harness {
  if (h.status === 'archived') throw new ValidationError('this harness is archived')
  const d = parse(draft)
  const rules = buildRules(d, newId, new Map(h.rules.map((r) => [r.id, r])))
  const remap = new Map<string, string>()
  const gates = buildGates(d, newId, new Set(h.gates.map((g) => g.id)), remap)
  const steps = buildSteps(d, newId, new Set((h.steps ?? []).map((s) => s.id)), remap)
  return {
    id: h.id,
    version: h.status === 'published' ? h.version + 1 : h.version,
    ...fields(d),
    status: 'draft',
    rules,
    gates,
    ...flowOf(steps, d),
    createdAt: h.createdAt,
    updatedAt: now,
  }
}

export function publishHarness(h: Harness, now: number): Harness {
  if (h.status !== 'draft') throw new ValidationError(`this harness is ${h.status}`)
  if (!h.rules.length && !h.gates.length && !h.steps?.length)
    throw new ValidationError('a harness needs at least one rule, gate or step')
  const gateIds = new Set(h.gates.map((g) => g.id))
  for (const s of h.steps ?? [])
    if (s.exit.some((c) => c.kind === 'gate' && !gateIds.has(c.gateId)))
      throw new ValidationError(`step “${s.name.slice(0, 60)}” checks a gate this harness lacks`)
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
    stepCount: h.steps?.length ?? 0,
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
    ...(h.steps?.length
      ? {
          steps: h.steps.map((s, i) => toStepView(s, i, h.gates)),
          flowMode: h.flowMode ?? 'sequential',
        }
      : {}),
  }
}

export const REPORT_LABEL = 'The agent reports it done'

/** One line per exit check: the prompt, the gate name, the path, or the note. */
export function checkLabel(c: StepCheck, gates: Pick<ValidationGate, 'id' | 'name'>[]): string {
  switch (c.kind) {
    case 'approval':
      return c.prompt
    case 'gate':
      return gates.find((g) => g.id === c.gateId)?.name ?? c.gateId
    case 'artifact':
      return c.mustExist === false ? `${c.path} (must not exist)` : c.path
    case 'report':
      return c.note || REPORT_LABEL
  }
}

export function toStepView(
  s: FlowStep,
  index: number,
  gates: Pick<ValidationGate, 'id' | 'name'>[],
): StepView {
  return {
    id: s.id,
    index,
    name: s.name,
    goal: s.goal,
    ...(s.instructions ? { instructions: s.instructions } : {}),
    ...(s.roles?.length ? { roles: [...s.roles] } : {}),
    exit: s.exit.map((c): StepCheckView => {
      const label = checkLabel(c, gates)
      if (c.kind === 'gate') return { kind: c.kind, label, gateId: c.gateId }
      if (c.kind === 'artifact')
        return { kind: c.kind, label, path: c.path, mustExist: c.mustExist !== false }
      if (c.kind === 'approval') return { kind: c.kind, label, prompt: c.prompt }
      return { kind: c.kind, label }
    }),
    ...(s.policies?.length ? { policies: s.policies.map((p) => ({ ...p })) } : {}),
    optional: s.optional,
  }
}
