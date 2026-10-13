// Pure view models of the Harness Builder dialog (docs/harness.md): library, editor, import preview
// and the coverage table. Every string is plain text drawn with textContent.
import {
  ENFORCEMENT,
  ENFORCEMENT_CAPABILITIES,
  RULE_CATEGORIES,
  type ActionRule,
  type Coverage,
  type Enforcement,
  type EnforcementReportView,
  type GateDraft,
  type HarnessDetail,
  type HarnessDraft,
  type HarnessRuleView,
  type HarnessSummary,
  type ImportPreview,
  type RuleCategory,
  type RuleDraft,
} from '@agent-office/shared'
import { COVERAGE_WORD, HARNESS_COPY } from './harness-copy.ts'
import type { Tone } from './types.ts'

export { COVERAGE_WORD }
const C = HARNESS_COPY

export const COVERAGE_TONE: Record<Coverage, Tone> = {
  enforced: 'good',
  partial: 'warn',
  'instruction-only': 'neutral',
  unsupported: 'bad',
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export interface ActionButtonVM {
  id: string
  label: string
  enabled: boolean
  hint?: string
}

// ── Coverage ─────────────────────────────────────────────────────────────────────────────────
export interface CoverageRowVM {
  capability: string
  label: string
  level: Coverage
  word: string
  tone: Tone
  reason: string
}
export interface EnforcementReportVM {
  provider: string
  rows: CoverageRowVM[]
  launch: { ok: boolean; reasons: string[] }
  /** One line for the launch verdict. */
  launchText: string
}

export function enforcementReportVM(report: EnforcementReportView): EnforcementReportVM {
  const byCap = new Map(report.rows.map((r) => [r.capability, r]))
  // The six capabilities always show, in a fixed order; a missing row reads as unsupported.
  const rows = ENFORCEMENT_CAPABILITIES.map((capability): CoverageRowVM => {
    const r = byCap.get(capability)
    const level: Coverage = r?.level ?? 'unsupported'
    return {
      capability,
      label: C.coverage.capability[capability],
      level,
      word: COVERAGE_WORD[level],
      tone: COVERAGE_TONE[level],
      reason: r?.reason ?? '',
    }
  })
  const reasons = report.launch.ok ? [] : report.launch.reasons
  return {
    provider: report.provider,
    rows,
    launch: { ok: report.launch.ok, reasons },
    launchText: report.launch.ok ? C.coverage.launchOk : C.coverage.launchBlocked,
  }
}

// ── Library ──────────────────────────────────────────────────────────────────────────────────
export interface HarnessCardVM {
  id: string
  name: string
  description: string
  versionLabel: string
  status: HarnessSummary['status']
  statusLabel: string
  tone: Tone
  counts: string
  chips: { enforcement: Enforcement; label: string; count: number }[]
  /** Names of the projects it is attached to. */
  projects: string[]
  attachedHere: boolean
  attached: boolean
  actions: ActionButtonVM[]
}
export interface HarnessLibraryVM {
  heading: string
  empty: string
  items: HarnessCardVM[]
  create: ActionButtonVM
  importRules: ActionButtonVM
}

export function harnessLibraryVM(
  summaries: HarnessSummary[],
  ctx: { projects: { id: string; name: string }[]; currentProjectId: string | null },
): HarnessLibraryVM {
  const names = new Map(ctx.projects.map((p) => [p.id, p.name]))
  const cur = ctx.currentProjectId
  const L = C.library
  const items = summaries.map((s): HarnessCardVM => {
    const here = !!cur && s.projectIds.includes(cur)
    const archived = s.status === 'archived'
    const actions: ActionButtonVM[] = [
      { id: 'edit', label: L.actions.edit, enabled: true },
      {
        id: 'publish',
        label: L.actions.publish,
        enabled: s.status === 'draft',
        ...(s.status !== 'draft' && {
          hint: archived ? L.hints.archived : L.hints.publishNotDraft,
        }),
      },
      {
        id: 'archive',
        label: L.actions.archive,
        enabled: !archived,
        ...(archived && { hint: L.hints.archived }),
      },
    ]
    if (here) actions.push({ id: 'detach', label: L.actions.detach, enabled: true })
    else {
      const ok = !!cur && s.status === 'published'
      actions.push({
        id: 'attach',
        label: L.actions.attach,
        enabled: ok,
        ...(!ok && {
          hint: !cur
            ? L.hints.attachNeedsProject
            : archived
              ? L.hints.archived
              : L.hints.attachNeedsPublished,
        }),
      })
    }
    return {
      id: s.id,
      name: s.name,
      description: s.description ?? '',
      versionLabel: `v${s.version}`,
      status: s.status,
      statusLabel: C.status[s.status],
      tone: s.status === 'published' ? 'good' : s.status === 'draft' ? 'warn' : 'neutral',
      counts: `${L.rules(s.ruleCount)} · ${L.gates(s.gateCount)}`,
      chips: ENFORCEMENT.filter((e) => s.enforcement[e] > 0).map((e) => ({
        enforcement: e,
        label: C.enforcement[e],
        count: s.enforcement[e],
      })),
      projects: s.projectIds.flatMap((id) => {
        const n = names.get(id)
        return n ? [n] : []
      }),
      attachedHere: here,
      attached: s.projectIds.length > 0,
      actions,
    }
  })
  return {
    heading: L.heading,
    empty: L.empty,
    items,
    create: { id: 'create', label: L.create, enabled: true },
    importRules: {
      id: 'import',
      label: L.importFromProject,
      enabled: !!cur,
      ...(!cur && { hint: L.hints.attachNeedsProject }),
    },
  }
}

// ── Policy in words ──────────────────────────────────────────────────────────────────────────
const list = (xs: string[] | undefined): string => (xs ?? []).join(', ')

/** "Blocks Edit, Write on .env* (except .env.example)": what the rule does, in words. */
export function policySummary(p: ActionRule): string {
  const verb = p.effect === 'deny' ? 'Blocks' : 'Asks first for'
  const parts: string[] = []
  const tools = list(p.tools)
  const paths = list(p.paths)
  let head = tools ? `${verb} ${tools}` : ''
  if (paths) {
    const where = `${paths}${p.except?.length ? ` (except ${list(p.except)})` : ''}`
    head = head ? `${head} on ${where}` : `${verb} access to ${where}`
  }
  if (head) parts.push(head)
  const rest: string[] = []
  if (p.commands?.length) rest.push(`commands ${list(p.commands)}`)
  if (p.hosts?.length) rest.push(`hosts ${list(p.hosts)}`)
  if (rest.length) parts.push(parts.length ? rest.join(', ') : `${verb} ${rest.join(', ')}`)
  if (!parts.length)
    return p.effect === 'deny'
      ? 'Blocks every matching action'
      : 'Asks first for every matching action'
  const text = parts.join(' for ')
  return p.roles?.length ? `${text}, for ${list(p.roles)}` : text
}

const split = (s: string | undefined): string[] =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

/** The add-rule form's comma-separated fields → an `ActionRule` (empty lists are omitted). */
export function policyFromFields(f: {
  effect: 'deny' | 'ask'
  tools?: string
  paths?: string
  commands?: string
  hosts?: string
}): ActionRule {
  const out: ActionRule = { effect: f.effect }
  const tools = split(f.tools)
  const paths = split(f.paths)
  const commands = split(f.commands)
  const hosts = split(f.hosts)
  if (tools.length) out.tools = tools
  if (paths.length) out.paths = paths
  if (commands.length) out.commands = commands
  if (hosts.length) out.hosts = hosts
  return out
}

// ── Editor ───────────────────────────────────────────────────────────────────────────────────
export const EDITOR_TABS = ['overview', 'rules', 'gates', 'providers', 'import', 'history'] as const
export type EditorTab = (typeof EDITOR_TABS)[number]

export interface RuleRowVM {
  id: string
  name: string
  text: string
  enforcement: Enforcement
  enforcementLabel: string
  severity: string
  severityLabel: string
  coverageLabel?: string
  policySummary?: string
  sourceLabel?: string
}
export interface GateRowVM {
  id: string
  name: string
  command: string
  required: boolean
  requiredLabel: string
  details: string
}
export interface HarnessEditorVM {
  id: string
  title: string
  versionLabel: string
  status: HarnessDetail['status']
  statusLabel: string
  /** Archived harnesses are read-only. */
  editable: boolean
  /** The harness as a draft: the editor changes a copy of it and saves through `update`. */
  draft: HarnessDraft
  saveHint: string
  tabs: { id: EditorTab; label: string; active: boolean }[]
  tab: EditorTab
  overview: { label: string; value: string }[]
  conflicts: { kindLabel: string; text: string; ruleNames: string[] }[]
  noConflicts: string
  rules: { category: RuleCategory; label: string; rules: RuleRowVM[] }[]
  gates: GateRowVM[]
  providers: EnforcementReportVM[]
  providersNote: string
  sources: { label: string; path: string; repoLabel: string; rules: number }[]
  importEmpty: string
  history: string
}

function ruleRow(r: HarnessRuleView): RuleRowVM {
  return {
    id: r.id,
    name: r.name,
    text: r.text,
    enforcement: r.enforcement,
    enforcementLabel: C.enforcement[r.enforcement],
    severity: r.severity,
    severityLabel: C.severity[r.severity],
    ...(r.coverage && { coverageLabel: COVERAGE_WORD[r.coverage] }),
    ...(r.policy && { policySummary: policySummary(r.policy) }),
    ...(r.source && { sourceLabel: `${C.sources[r.source.format]} · ${r.source.path}` }),
  }
}

export function harnessEditorVM(
  d: HarnessDetail,
  tab: EditorTab = 'overview',
  coverage: EnforcementReportView[] = [],
): HarnessEditorVM {
  const O = C.overview
  const nameOf = new Map(d.rules.map((r) => [r.id, r.name]))
  const bySource = new Map<
    string,
    { label: string; path: string; repoLabel: string; rules: number }
  >()
  for (const r of d.rules) {
    if (!r.source) continue
    const key = `${r.source.repoLabel}\u0000${r.source.path}`
    const e = bySource.get(key)
    if (e) e.rules++
    else
      bySource.set(key, {
        label: r.source.path,
        path: r.source.path,
        repoLabel: r.source.repoLabel,
        rules: 1,
      })
  }
  return {
    id: d.id,
    title: d.name,
    versionLabel: `v${d.version}`,
    status: d.status,
    statusLabel: C.status[d.status],
    editable: d.status !== 'archived',
    draft: draftFromDetail(d),
    saveHint: C.editor.saveHint,
    tabs: EDITOR_TABS.map((id) => ({ id, label: C.dialog.editorTabs[id], active: id === tab })),
    tab,
    overview: [
      { label: O.scope, value: C.scope[d.scope] },
      { label: O.launch, value: C.launchPolicy[d.launchPolicy] },
      { label: O.trigger, value: C.gateTrigger[d.gateTrigger] },
      { label: O.isolation, value: C.fsIsolation[d.fsIsolation] },
      { label: O.retries, value: String(d.retryBudget) },
      {
        label: O.counts,
        value: `${C.library.rules(d.rules.length)} · ${C.library.gates(d.gates.length)}`,
      },
    ],
    conflicts: d.conflicts.map((c) => ({
      kindLabel: O.conflictKind[c.kind],
      text: c.text,
      ruleNames: c.ruleIds.map((id) => nameOf.get(id) ?? id),
    })),
    noConflicts: O.noConflicts,
    rules: RULE_CATEGORIES.flatMap((category) => {
      const rules = d.rules.filter((r) => r.category === category).map(ruleRow)
      return rules.length ? [{ category, label: C.category[category], rules }] : []
    }),
    gates: d.gates.map((g) => ({
      id: g.id,
      name: g.name,
      command: g.argv.join(' '),
      required: g.required,
      requiredLabel: g.required ? C.editor.required : C.editor.optional,
      details: [
        C.editor.timeout(g.timeoutMs),
        ...(g.platforms?.length ? [C.editor.platforms(g.platforms)] : []),
        ...(g.subdir ? [`In ${g.subdir}`] : []),
        ...(g.pinFiles?.length ? [C.editor.pinned(g.pinFiles)] : []),
      ].join(' · '),
    })),
    providers: coverage.map(enforcementReportVM),
    providersNote: C.editor.providersNote,
    sources: [...bySource.values()],
    importEmpty: C.editor.importEmpty,
    history: C.editor.historyStub,
  }
}

/** What `update` takes: the detail as a draft, keeping rule and gate ids (provenance, history). */
export function draftFromDetail(d: HarnessDetail): HarnessDraft {
  return {
    name: d.name,
    ...(d.description && { description: d.description }),
    scope: d.scope,
    launchPolicy: d.launchPolicy,
    gateTrigger: d.gateTrigger,
    fsIsolation: d.fsIsolation,
    retryBudget: d.retryBudget,
    rules: d.rules.map((r): RuleDraft => ({
      id: r.id,
      name: r.name,
      text: r.text,
      category: r.category,
      enforcement: r.enforcement,
      severity: r.severity,
      ...(r.policy && { policy: r.policy }),
      ...(r.appliesTo && { appliesTo: r.appliesTo }),
    })),
    gates: d.gates.map((g): GateDraft => ({
      id: g.id as never,
      name: g.name,
      argv: g.argv,
      timeoutMs: g.timeoutMs,
      required: g.required,
      ...(g.subdir && { subdir: g.subdir }),
      ...(g.platforms && { platforms: g.platforms }),
      ...(g.pinFiles && { pinFiles: g.pinFiles }),
    })),
  }
}

// ── Import preview ───────────────────────────────────────────────────────────────────────────
export interface ImportSelection {
  selected: string[]
  gates: string[]
}

/** Everything is selected except duplicates; gates are an explicit choice, never a default. */
export function defaultImportSelection(p: ImportPreview): ImportSelection {
  return { selected: p.candidates.filter((c) => !c.duplicateOf).map((c) => c.tempId), gates: [] }
}

/** What the reviewer changed per candidate; sent as `edits` on commit. */
export type CandidateEdits = Record<
  string,
  { name?: string; text?: string; category?: RuleCategory; severity?: 'required' | 'recommended' }
>

export interface ImportCandidateVM {
  tempId: string
  name: string
  text: string
  category: RuleCategory
  severity: 'required' | 'recommended'
  categoryLabel: string
  enforcementLabel: string
  severityLabel: string
  checked: boolean
  marks: { kind: 'duplicate' | 'conflict'; label: string }[]
}
export interface ImportPreviewVM {
  previewId: string
  heading: string
  sources: { path: string; repoLabel: string; formatLabel: string; count: string }[]
  groups: { label: string; candidates: ImportCandidateVM[] }[]
  gatesHeading: string
  gatesNote: string
  gates: {
    tempId: string
    name: string
    command: string
    selectable: boolean
    checked: boolean
    rejected?: string
    sourceLabel: string
  }[]
  conflicts: { text: string }[]
  totals: string
  canCreate: boolean
}

export function importPreviewVM(
  p: ImportPreview,
  sel: ImportSelection,
  edits: CandidateEdits = {},
): ImportPreviewVM {
  const I = C.import
  const chosen = new Set(sel.selected)
  const chosenGates = new Set(sel.gates)
  const order: string[] = []
  const groups = new Map<string, ImportCandidateVM[]>()
  for (const c of p.candidates) {
    const key = c.source.path
    if (!groups.has(key)) {
      groups.set(key, [])
      order.push(key)
    }
    const e = edits[c.tempId] ?? {}
    const category = e.category ?? c.category
    const severity = e.severity ?? c.severity
    groups.get(key)!.push({
      tempId: c.tempId,
      name: e.name ?? c.name,
      text: e.text ?? c.text,
      category,
      severity,
      categoryLabel: C.category[category],
      enforcementLabel: C.enforcement[c.enforcement],
      severityLabel: C.severity[severity],
      checked: chosen.has(c.tempId),
      marks: [
        ...(c.duplicateOf ? [{ kind: 'duplicate' as const, label: I.duplicate }] : []),
        ...(c.conflictsWith?.length ? [{ kind: 'conflict' as const, label: I.conflict }] : []),
      ],
    })
  }
  const nChosen = p.candidates.filter((c) => chosen.has(c.tempId)).length
  const nGates = p.gates.filter((g) => !g.rejected && chosenGates.has(g.tempId)).length
  return {
    previewId: p.previewId,
    heading: I.heading,
    sources: p.sources.map((s) => ({
      path: s.path,
      repoLabel: s.repoLabel,
      formatLabel: C.sources[s.format],
      count: plural(s.ruleCount ?? 0, 'rule', 'rules'),
    })),
    groups: order.map((label) => ({ label, candidates: groups.get(label)! })),
    gatesHeading: I.gatesHeading,
    gatesNote: I.gatesNote,
    gates: p.gates.map((g) => ({
      tempId: g.tempId,
      name: g.name,
      command: g.argv.join(' '),
      selectable: !g.rejected,
      checked: !g.rejected && chosenGates.has(g.tempId),
      ...(g.rejected && { rejected: I.rejected(g.rejected) }),
      sourceLabel: g.source.path,
    })),
    conflicts: p.conflicts.map((c) => ({ text: c.text })),
    totals: I.totals(p.totals.rules, p.totals.conflicts, nChosen),
    canCreate: nChosen + nGates > 0,
  }
}
