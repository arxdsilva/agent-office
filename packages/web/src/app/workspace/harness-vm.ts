// Pure view models of the Harness Builder dialog (docs/harness.md): library, editor, import preview
// and the coverage table. Every string is plain text drawn with textContent.
import {
  ENFORCEMENT,
  ENFORCEMENT_CAPABILITIES,
  RULE_CATEGORIES,
  type ActionRule,
  type FlowMode,
  type GateView,
  type HarnessScope,
  type ImportStepSuggestion,
  type StepCheck,
  type StepCheckKind,
  type StepDraft,
  type StepView,
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
  /** Flow steps (0 = standards only): drawn as a "Flow" chip. */
  stepCount: number
  /** Archived cards cannot be dragged; drafts can (to arrange the library) but are rejected by targets. */
  draggable: boolean
  /** Why a drop on Applied or a project would be refused. */
  dragReason?: string
  selected: boolean
  /** One line of what it contains, shown when selected. */
  summary: string
  /** The card is the drag source (`.dragging`). */
  dragging: boolean
  /** A library card being dragged is over this one: insertion line before/after. */
  dropMark: 'before' | 'after' | null
}
export interface HarnessLibraryVM {
  heading: string
  empty: string
  items: HarnessCardVM[]
  create: ActionButtonVM
  importRules: ActionButtonVM
}

export interface LibraryCtx {
  projects: { id: string; name: string }[]
  currentProjectId: string | null
  selectedId?: string | null
  /** The current drag, for highlights that survive a re-render. */
  drag?: {
    harnessId: string
    source: 'library' | 'applied'
    over?: { kind: string; harnessId?: string; after?: boolean }
  } | null
}

export function harnessLibraryVM(summaries: HarnessSummary[], ctx: LibraryCtx): HarnessLibraryVM {
  const names = new Map(ctx.projects.map((p) => [p.id, p.name]))
  const cur = ctx.currentProjectId
  const drag = ctx.drag ?? null
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
      counts: `${s.stepCount ? `${L.steps(s.stepCount)} · ` : ''}${L.rules(s.ruleCount)} · ${L.gates(s.gateCount)}`,
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
      stepCount: s.stepCount ?? 0,
      draggable: !archived,
      ...(s.status === 'draft' && { dragReason: L.dragDraft }),
      ...(archived && { dragReason: L.hints.archived }),
      selected: ctx.selectedId === s.id,
      summary: L.summary(s.stepCount ?? 0, s.ruleCount, s.gateCount),
      dragging: drag?.source === 'library' && drag.harnessId === s.id,
      dropMark:
        drag?.source === 'library' &&
        drag.over?.kind === 'library-card' &&
        drag.over.harnessId === s.id &&
        drag.harnessId !== s.id
          ? drag.over.after
            ? 'after'
            : 'before'
          : null,
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
export const EDITOR_TABS = [
  'overview',
  'flow',
  'rules',
  'gates',
  'providers',
  'import',
  'history',
] as const
export type EditorTab = (typeof EDITOR_TABS)[number]

export interface RuleRowVM {
  /** The rule id, or `new-<index>` for a rule added since the last save. */
  id: string
  index: number
  name: string
  text: string
  category: RuleCategory
  enforcement: Enforcement
  enforcementLabel: string
  severity: string
  severityLabel: string
  coverageLabel?: string
  policySummary?: string
  sourceLabel?: string
  /** `title` of the source chip: hash and import time. */
  sourceTitle?: string
  /** "Go to rule" from a conflict highlights it. */
  highlighted?: boolean
}
export interface GateRowVM {
  id: string
  name: string
  command: string
  required: boolean
  requiredLabel: string
  details: string
}
export interface StepRowVM {
  /** The step id, or `new-<index>` before the first save. */
  key: string
  index: number
  /** "1", "2", … */
  position: string
  name: string
  goal: string
  checks: { kind: StepCheckKind; label: string }[]
  roles: string
  optional: boolean
  up: boolean
  down: boolean
}
export interface StepCheckRowVM {
  kind: StepCheckKind
  kindOptions: { value: StepCheckKind; label: string }[]
  prompt: string
  gateId: string
  path: string
  mustExist: boolean
  note: string
  error?: string
}
export interface StepFormVM {
  heading: string
  okLabel: string
  name: string
  goal: string
  goalCount: string
  instructions: string
  instructionsCount: string
  roles: string
  optional: boolean
  checks: StepCheckRowVM[]
  canAddCheck: boolean
  gateOptions: { id: string; name: string }[]
  noGates: string
  policies: PolicyFields[]
  errors: Partial<Record<'name' | 'goal' | 'checks', string>>
  policyErrors: Record<number, string>
}
export interface VersionRowVM {
  version: number
  text: string
  current: boolean
  viewing: boolean
}
export interface HarnessEditorVM {
  id: string
  title: string
  versionLabel: string
  status: HarnessDetail['status']
  statusLabel: string
  /** Archived harnesses (and old versions being viewed) are read-only. */
  editable: boolean
  /** The harness as edited (unsaved changes included); Save sends it through `update`. */
  draft: HarnessDraft
  /** The draft differs from the stored harness. */
  dirty: boolean
  /** How many top-level fields changed (Discard confirms when > 1). */
  changed: number
  save: ActionButtonVM
  discard: ActionButtonVM
  /** Draft only. */
  publish: ActionButtonVM | null
  saveHint: string
  tabs: { id: EditorTab; label: string; active: boolean }[]
  tab: EditorTab
  overview: { label: string; value: string }[]
  scope: HarnessScope
  scopeHelp: string
  /** Shown only when the harness has steps. */
  flowMode: FlowMode | null
  conflicts: { kindLabel: string; text: string; ruleNames: string[]; ruleIds: string[] }[]
  noConflicts: string
  rules: { category: RuleCategory; label: string; count: number; rules: RuleRowVM[] }[]
  ruleEdit: RuleRowVM | null
  gates: GateRowVM[]
  providers: EnforcementReportVM[]
  providersNote: string
  sources: { label: string; path: string; repoLabel: string; rules: number }[]
  importEmpty: string
  flow: {
    steps: StepRowVM[]
    empty: string
    form: StepFormVM | null
    addStep: ActionButtonVM
    modeOptions: { value: FlowMode; label: string; active: boolean }[]
    preview: string[]
    /** Another attached harness also has steps. */
    warning: string | null
  }
  history: {
    items: VersionRowVM[]
    empty: string
    /** "Viewing v2 (published)…" while an old version is shown. */
    banner: string | null
  }
  /** "Undo" after a rule or step removal (5 s). */
  undo: boolean
}

function ruleRow(r: RuleDraft, i: number, view: HarnessRuleView | undefined): RuleRowVM {
  const enforcement = r.enforcement
  const severity = r.severity ?? 'required'
  return {
    id: r.id ?? `new-${i}`,
    index: i,
    name: r.name,
    text: r.text,
    category: r.category,
    enforcement,
    enforcementLabel: C.enforcement[enforcement],
    severity,
    severityLabel: C.severity[severity],
    ...(view?.coverage && { coverageLabel: COVERAGE_WORD[view.coverage] }),
    ...(r.policy && enforcement === 'runtime-policy' && { policySummary: policySummary(r.policy) }),
    ...(view?.source && {
      sourceLabel: `${C.sources[view.source.format]} · ${view.source.path}`,
      sourceTitle: `${view.source.hash} · ${new Date(view.source.importedAt).toISOString()}`,
    }),
  }
}

/** One check in words: `Approval: "Outline approved"`, `Gate: Check`, `File: docs/x.md`. */
export function checkLabel(
  c: StepCheck | StepDraft['exit'][number],
  gates: { id?: string; name: string }[],
): string {
  const F = C.flow.check
  switch (c.kind) {
    case 'approval':
      return F.approval(c.prompt)
    case 'gate':
      return F.gate(gates.find((g) => g.id === c.gateId)?.name ?? c.gateId)
    case 'artifact':
      return F.artifact(c.path, c.mustExist ?? true)
    case 'report':
      return F.report(c.note)
  }
}

/** The text agents receive for the flow, as lines (a client-side render of the draft). */
export function flowPreview(d: HarnessDraft): string[] {
  const steps = d.steps ?? []
  if (!steps.length) return []
  const gates = d.gates ?? []
  const mode = d.flowMode ?? 'sequential'
  const out = [C.flow.previewHead(d.name, mode)]
  steps.forEach((s, i) => {
    const exit = s.exit.map((c) => checkLabel(c, gates)).join('; ')
    out.push(`${i + 1}. ${s.name} — ${s.goal} ${C.flow.previewExit(exit)}`)
    if (s.instructions) out.push(`   ${s.instructions}`)
  })
  return out
}

const STRIP = (o: unknown): string => JSON.stringify(o ?? null)
/** Top-level draft fields that differ (name, rules, steps, …). */
export function changedFields(a: HarnessDraft, b: HarnessDraft): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof HarnessDraft>
  return [...keys].filter((k) => STRIP(a[k]) !== STRIP(b[k]))
}

export interface EditorOpts {
  /** Unsaved edits; absent = the stored harness. */
  draft?: HarnessDraft | null
  stepForm?: StepForm | null
  versions?: HarnessDetail[] | null
  /** An older version shown read-only. */
  viewVersion?: number | null
  saved?: boolean
  busy?: boolean
  ruleEditId?: string | null
  highlightRuleId?: string | null
  undo?: boolean
  /** Another attached harness also defines steps. */
  otherFlows?: boolean
}

export function harnessEditorVM(
  d0: HarnessDetail,
  tab: EditorTab = 'overview',
  coverage: EnforcementReportView[] = [],
  o: EditorOpts = {},
): HarnessEditorVM {
  const O = C.overview
  const E = C.editor
  const old = o.viewVersion ? o.versions?.find((v) => v.version === o.viewVersion) : undefined
  const d = old ?? d0
  const base = draftFromDetail(d)
  const draft = !old && o.draft ? o.draft : base
  const changed = old ? [] : changedFields(draft, base)
  const dirty = changed.length > 0
  const editable = d0.status !== 'archived' && !old
  const busy = !!o.busy
  const views = new Map(d.rules.map((r) => [r.id, r]))
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
  const rules = draft.rules ?? []
  const rows = rules.map((r, i) => {
    const row = ruleRow(r, i, r.id ? views.get(r.id) : undefined)
    return o.highlightRuleId && row.id === o.highlightRuleId ? { ...row, highlighted: true } : row
  })
  const gates = draft.gates ?? []
  const steps = draft.steps ?? []
  const scope = draft.scope ?? 'project'
  return {
    id: d0.id,
    title: draft.name,
    versionLabel: `v${d.version}`,
    status: d.status,
    statusLabel: C.status[d.status],
    editable,
    draft,
    dirty,
    changed: changed.length,
    save: {
      id: 'save',
      label: o.saved && !dirty ? E.saved : E.save,
      enabled: dirty && editable && !busy,
      ...(d0.status === 'published' && { hint: E.saveHint }),
    },
    discard: { id: 'discard', label: E.discard, enabled: dirty && !busy },
    publish:
      d0.status === 'draft' && !old
        ? {
            id: 'publish',
            label: E.publish,
            enabled: !busy && !dirty,
            ...(dirty && { hint: E.saveHint }),
          }
        : null,
    saveHint: E.saveHint,
    tabs: EDITOR_TABS.map((id) => ({ id, label: C.dialog.editorTabs[id], active: id === tab })),
    tab,
    overview: [
      { label: O.scope, value: C.scope[scope] },
      { label: O.launch, value: C.launchPolicy[draft.launchPolicy ?? 'advisory'] },
      { label: O.trigger, value: C.gateTrigger[draft.gateTrigger ?? 'manual'] },
      { label: O.isolation, value: C.fsIsolation[draft.fsIsolation ?? 'off'] },
      { label: O.retries, value: String(draft.retryBudget ?? 2) },
      {
        label: O.counts,
        value: `${steps.length ? `${C.library.steps(steps.length)} · ` : ''}${C.library.rules(rules.length)} · ${C.library.gates(gates.length)}`,
      },
    ],
    scope,
    scopeHelp: E.scopeHelp[scope],
    flowMode: steps.length ? (draft.flowMode ?? 'sequential') : null,
    conflicts: d.conflicts.map((c) => ({
      kindLabel: O.conflictKind[c.kind],
      text: c.text,
      ruleNames: c.ruleIds.map((id) => nameOf.get(id) ?? id),
      ruleIds: c.ruleIds,
    })),
    noConflicts: O.noConflicts,
    rules: RULE_CATEGORIES.flatMap((category) => {
      const list = rows.filter((r) => r.category === category)
      return list.length
        ? [{ category, label: C.category[category], count: list.length, rules: list }]
        : []
    }),
    ruleEdit: (o.ruleEditId && rows.find((r) => r.id === o.ruleEditId)) || null,
    gates: (old ? d.gates : gates.map((g, i): GateView => gateViewOf(g, i))).map((g) => ({
      id: g.id,
      name: g.name,
      command: g.argv.join(' '),
      required: g.required,
      requiredLabel: g.required ? E.required : E.optional,
      details: [
        E.timeout(g.timeoutMs),
        ...(g.platforms?.length ? [E.platforms(g.platforms)] : []),
        ...(g.subdir ? [`In ${g.subdir}`] : []),
        ...(g.pinFiles?.length ? [E.pinned(g.pinFiles)] : []),
      ].join(' · '),
    })),
    providers: coverage.map(enforcementReportVM),
    providersNote: E.providersNote,
    sources: [...bySource.values()],
    importEmpty: E.importEmpty,
    flow: {
      steps: steps.map((st, i) => ({
        key: st.id ?? `new-${i}`,
        index: i,
        position: String(i + 1),
        name: st.name,
        goal: st.goal,
        checks: st.exit.map((c) => ({ kind: c.kind, label: checkLabel(c, gates) })),
        roles: (st.roles ?? []).join(', '),
        optional: !!st.optional,
        up: i > 0,
        down: i < steps.length - 1,
      })),
      empty: C.flow.empty,
      form: o.stepForm ? stepFormVM(o.stepForm, gates) : null,
      addStep: {
        id: 'add-step',
        label: C.flow.addStep,
        enabled: editable && !busy && steps.length < 24 && !o.stepForm,
      },
      modeOptions: (['sequential', 'free'] as const).map((value) => ({
        value,
        label: E.flowModes[value],
        active: (draft.flowMode ?? 'sequential') === value,
      })),
      preview: flowPreview(draft),
      warning: o.otherFlows && steps.length ? C.flow.twoFlows : null,
    },
    history: {
      items: [...(o.versions ?? [])]
        .sort((a, b) => b.version - a.version)
        .map((v) => ({
          version: v.version,
          text: E.historyVersion(
            v.version,
            C.status[v.status],
            v.publishedAt ? new Date(v.publishedAt).toISOString().slice(0, 10) : '',
            `${C.library.rules(v.rules.length)} · ${C.library.gates(v.gates.length)}`,
          ),
          current: v.version === d0.version,
          viewing: v.version === o.viewVersion,
        })),
      empty: o.versions ? E.historyEmpty : C.dialog.loading,
      banner: old ? E.historyBanner(old.version, C.status[old.status]) : null,
    },
    undo: !!o.undo,
  }
}

function gateViewOf(g: GateDraft, i: number): GateView {
  return {
    id: g.id ?? `new-${i}`,
    name: g.name,
    argv: g.argv,
    timeoutMs: g.timeoutMs ?? 600_000,
    required: g.required ?? true,
    ...(g.subdir && { subdir: g.subdir }),
    ...(g.platforms && { platforms: g.platforms }),
    ...(g.pinFiles && { pinFiles: g.pinFiles }),
  }
}

/** A stored step back into its draft form (ids kept so progress history survives). */
export function stepDraftFromView(v: StepView): StepDraft {
  return {
    id: v.id as never,
    name: v.name,
    goal: v.goal,
    ...(v.instructions && { instructions: v.instructions }),
    ...(v.roles?.length && { roles: v.roles }),
    exit: v.exit.map((c): StepCheck => {
      switch (c.kind) {
        case 'approval':
          return { kind: 'approval', prompt: c.prompt ?? c.label }
        case 'gate':
          return { kind: 'gate', gateId: (c.gateId ?? '') as never }
        case 'artifact':
          return { kind: 'artifact', path: c.path ?? c.label, mustExist: c.mustExist ?? true }
        case 'report':
          return { kind: 'report', ...(c.label && { note: c.label.slice(0, 200) }) }
      }
    }),
    ...(v.policies?.length && { policies: v.policies }),
    optional: v.optional,
  }
}

/** What `update` takes: the detail as a draft, keeping rule, gate and step ids. */
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
    steps: (d.steps ?? []).map(stepDraftFromView),
    flowMode: d.flowMode ?? 'sequential',
  }
}

// ── Editor forms: steps, rules, gates (pure validation; the DOM only collects fields) ───────
export interface CheckFields {
  kind: StepCheckKind
  prompt: string
  gateId: string
  path: string
  mustExist: boolean
  note: string
}
export interface PolicyFields {
  effect: 'deny' | 'ask'
  tools: string
  paths: string
  commands: string
  hosts: string
}
/** The Flow tab's step form (`#hb-step-form`), kept in state so a push never wipes it. */
export interface StepForm {
  /** Index in the draft's steps being edited; null = a new step. */
  index: number | null
  name: string
  goal: string
  instructions: string
  roles: string
  optional: boolean
  checks: CheckFields[]
  policies: PolicyFields[]
  errors: Partial<Record<'name' | 'goal' | 'checks', string>>
  checkErrors: Record<number, string>
  policyErrors: Record<number, string>
}

export const emptyCheck = (kind: StepCheckKind = 'report'): CheckFields => ({
  kind,
  prompt: '',
  gateId: '',
  path: '',
  mustExist: true,
  note: '',
})
export const emptyPolicy = (): PolicyFields => ({
  effect: 'deny',
  tools: '',
  paths: '',
  commands: '',
  hosts: '',
})
export const newStepForm = (): StepForm => ({
  index: null,
  name: '',
  goal: '',
  instructions: '',
  roles: '',
  optional: false,
  checks: [emptyCheck()],
  policies: [],
  errors: {},
  checkErrors: {},
  policyErrors: {},
})

const listText = (xs: string[] | undefined): string => (xs ?? []).join(', ')

export function stepFormFrom(step: StepDraft, index: number): StepForm {
  return {
    ...newStepForm(),
    index,
    name: step.name,
    goal: step.goal,
    instructions: step.instructions ?? '',
    roles: listText(step.roles),
    optional: !!step.optional,
    checks: step.exit.map((c) => ({
      ...emptyCheck(c.kind),
      ...(c.kind === 'approval' && { prompt: c.prompt }),
      ...(c.kind === 'gate' && { gateId: c.gateId }),
      ...(c.kind === 'artifact' && { path: c.path, mustExist: c.mustExist ?? true }),
      ...(c.kind === 'report' && { note: c.note ?? '' }),
    })),
    policies: (step.policies ?? []).map((p) => ({
      effect: p.effect,
      tools: listText(p.tools),
      paths: listText(p.paths),
      commands: listText(p.commands),
      hosts: listText(p.hosts),
    })),
  }
}

/** Repo-relative: not absolute, no `..` segment, no home or drive prefix. */
export function isRepoRelative(path: string): boolean {
  const p = path.trim()
  if (!p || p.length > 200) return false
  if (p.startsWith('/') || p.startsWith('\\') || p.startsWith('~') || /^[a-zA-Z]:/.test(p))
    return false
  return !p.split(/[\\/]/).includes('..')
}

const hasTarget = (p: ActionRule): boolean =>
  !!(p.tools?.length || p.paths?.length || p.commands?.length || p.hosts?.length)

export type StepResult = { ok: true; step: StepDraft } | { ok: false; form: StepForm }

/** Validates the form; returns the step, or the form with its inline errors. */
export function stepFromForm(f: StepForm, gateIds: string[], keepId?: string): StepResult {
  const X = C.flow.errors
  const errors: StepForm['errors'] = {}
  const checkErrors: Record<number, string> = {}
  const policyErrors: Record<number, string> = {}
  const name = f.name.trim()
  const goal = f.goal.trim()
  if (!name) errors.name = X.name
  if (!goal) errors.goal = X.goal
  if (!f.checks.length) errors.checks = X.checks
  const exit: StepCheck[] = []
  f.checks.forEach((c, i) => {
    if (c.kind === 'approval') {
      if (!c.prompt.trim()) checkErrors[i] = X.prompt
      else exit.push({ kind: 'approval', prompt: c.prompt.trim().slice(0, 200) })
    } else if (c.kind === 'gate') {
      if (!gateIds.includes(c.gateId)) checkErrors[i] = X.gate
      else exit.push({ kind: 'gate', gateId: c.gateId as never })
    } else if (c.kind === 'artifact') {
      if (!isRepoRelative(c.path)) checkErrors[i] = X.path
      else exit.push({ kind: 'artifact', path: c.path.trim(), mustExist: c.mustExist })
    } else {
      const note = c.note.trim().slice(0, 200)
      exit.push({ kind: 'report', ...(note && { note }) })
    }
  })
  const policies = f.policies.map((p, i) => {
    const rule = policyFromFields(p)
    if (!hasTarget(rule)) policyErrors[i] = X.policy
    return rule
  })
  if (
    Object.keys(errors).length ||
    Object.keys(checkErrors).length ||
    Object.keys(policyErrors).length
  )
    return { ok: false, form: { ...f, errors, checkErrors, policyErrors } }
  const roles = split(f.roles)
  const instructions = f.instructions.trim().slice(0, 2000)
  return {
    ok: true,
    step: {
      ...(keepId && { id: keepId as never }),
      name: name.slice(0, 80),
      goal: goal.slice(0, 600),
      ...(instructions && { instructions }),
      ...(roles.length && { roles: roles.slice(0, 20) }),
      exit: exit.slice(0, 6),
      ...(policies.length && { policies }),
      optional: f.optional,
    },
  }
}

function stepFormVM(f: StepForm, gates: GateDraft[]): StepFormVM {
  const F = C.flow
  return {
    heading: f.index === null ? F.addStep : F.updateStep,
    okLabel: f.index === null ? F.addStep : F.updateStep,
    name: f.name,
    goal: f.goal,
    goalCount: F.count(f.goal.length, 600),
    instructions: f.instructions,
    instructionsCount: F.count(f.instructions.length, 2000),
    roles: f.roles,
    optional: f.optional,
    checks: f.checks.map((c, i) => ({
      ...c,
      kindOptions: (['approval', 'gate', 'artifact', 'report'] as const).map((value) => ({
        value,
        label: F.kinds[value],
      })),
      ...(f.checkErrors[i] && { error: f.checkErrors[i] }),
    })),
    canAddCheck: f.checks.length < 6,
    gateOptions: gates.flatMap((g) => (g.id ? [{ id: g.id, name: g.name }] : [])),
    noGates: F.noGates,
    policies: f.policies,
    errors: f.errors,
    policyErrors: f.policyErrors,
  }
}

/** The add/edit rule form (`#hb-add-rule`). */
export interface RuleFields {
  name: string
  text: string
  category: RuleCategory
  enforcement: Enforcement
  severity: 'required' | 'recommended'
  effect: 'deny' | 'ask'
  tools: string
  paths: string
  commands: string
  hosts: string
  roles: string
  runtimes: string[]
}
export function ruleFieldsFrom(r?: RuleDraft): RuleFields {
  return {
    name: r?.name ?? '',
    text: r?.text ?? '',
    category: r?.category ?? 'coding',
    enforcement: r?.enforcement ?? 'instruction',
    severity: r?.severity ?? 'required',
    effect: r?.policy?.effect ?? 'deny',
    tools: listText(r?.policy?.tools),
    paths: listText(r?.policy?.paths),
    commands: listText(r?.policy?.commands),
    hosts: listText(r?.policy?.hosts),
    roles: listText(r?.policy?.roles),
    runtimes: r?.appliesTo?.runtimes ?? [],
  }
}
export function ruleFromFields(
  f: RuleFields,
  keep?: RuleDraft,
): { ok: true; rule: RuleDraft } | { ok: false; error: string } {
  const name = f.name.trim()
  const text = f.text.trim()
  if (!name || !text) return { ok: false, error: C.editor.invalidRule }
  let policy: ActionRule | undefined
  if (f.enforcement === 'runtime-policy') {
    policy = policyFromFields(f)
    if (!hasTarget(policy)) return { ok: false, error: C.editor.policyNeedsTarget }
    const roles = split(f.roles)
    if (roles.length) policy.roles = roles
  }
  const appliesTo = f.runtimes.length
    ? { ...keep?.appliesTo, runtimes: f.runtimes as never }
    : keep?.appliesTo?.runtimes
      ? (({ runtimes: _r, ...rest }) => (Object.keys(rest).length ? rest : undefined))(
          keep.appliesTo,
        )
      : keep?.appliesTo
  return {
    ok: true,
    rule: {
      ...(keep?.id && { id: keep.id }),
      name: name.slice(0, 120),
      text: text.slice(0, 2000),
      category: f.category,
      enforcement: f.enforcement,
      severity: f.severity,
      ...(policy && { policy }),
      ...(appliesTo && { appliesTo }),
    },
  }
}

/** The add gate form (`#hb-add-gate`). */
export interface GateFields {
  name: string
  command: string
  required: boolean
  timeoutMin: number
  subdir: string
  pins: string
  platforms: ('darwin' | 'linux' | 'win32')[]
}
/** Characters a shell would interpret: gates run argv directly, so these never mean anything. */
const SHELL_CHARS = /[|&;<>$`\\()'"\n]/g
export function gateFromFields(
  f: GateFields,
): { ok: true; gate: GateDraft } | { ok: false; error: string } {
  const cmd = f.command.trim()
  if (!cmd) return { ok: false, error: C.editor.invalidCommand }
  const bad = [...new Set(cmd.match(SHELL_CHARS) ?? [])]
  if (bad.length) return { ok: false, error: C.editor.shellChars(bad.join(' ')) }
  const argv = cmd.split(/\s+/).filter(Boolean).slice(0, 32)
  const subdir = f.subdir.trim()
  if (subdir && !isRepoRelative(subdir)) return { ok: false, error: C.flow.errors.path }
  const pins = split(f.pins).slice(0, 16)
  const minutes = [1, 5, 10, 30].includes(f.timeoutMin) ? f.timeoutMin : 10
  return {
    ok: true,
    gate: {
      name: (f.name.trim() || argv.join(' ')).slice(0, 80),
      argv,
      required: f.required,
      timeoutMs: minutes * 60_000,
      ...(subdir && { subdir }),
      ...(pins.length && { pinFiles: pins }),
      ...(f.platforms.length && { platforms: f.platforms }),
    },
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

/** Step suggestions: their order (drag or ↑/↓), which are kept, and each one's exit check. */
export interface ImportSteps {
  order: string[]
  selected: string[]
  checks: Record<string, StepCheckKind>
}
/** Steps are suggestions: none is kept until the reviewer ticks it (like gates). */
export function defaultImportSteps(p: ImportPreview): ImportSteps {
  const steps = [...(p.steps ?? [])].sort((a, b) => a.index - b.index)
  return { order: steps.map((s) => s.tempId), selected: [], checks: {} }
}
/** What `importCommit` takes for steps: kept ones, in the chosen order, with their check kind. */
export function importStepsArg(s: ImportSteps): { tempId: string; check: StepCheckKind }[] {
  const keep = new Set(s.selected)
  return s.order
    .filter((id) => keep.has(id))
    .map((tempId) => ({ tempId, check: s.checks[tempId] ?? 'report' }))
}

/** What the reviewer changed per candidate; sent as `edits` on commit. */
export type CandidateEdits = Record<
  string,
  {
    name?: string
    text?: string
    category?: RuleCategory
    severity?: 'required' | 'recommended'
    enforcement?: Enforcement
  }
>

export interface ImportCandidateVM {
  tempId: string
  name: string
  text: string
  category: RuleCategory
  severity: 'required' | 'recommended'
  enforcement: Enforcement
  categoryLabel: string
  enforcementLabel: string
  severityLabel: string
  checked: boolean
  /** `compare` = the other candidate's temp id ("Compare" scrolls to it). */
  marks: { kind: 'duplicate' | 'conflict'; label: string; compare?: string }[]
}
export interface ImportStepCandVM {
  tempId: string
  position: string
  name: string
  goal: string
  sourceLabel: string
  checked: boolean
  check: StepCheckKind
  up: boolean
  down: boolean
}
export interface ImportPreviewVM {
  previewId: string
  heading: string
  sources: { path: string; repoLabel: string; formatLabel: string; count: string }[]
  groups: { label: string; allChecked: boolean; candidates: ImportCandidateVM[] }[]
  /** Category chips above the candidates; `null` = All. */
  filters: { category: RuleCategory | null; label: string; count: number; active: boolean }[]
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
  stepsHeading: string
  stepsNote: string
  steps: ImportStepCandVM[]
  checkOptions: { value: StepCheckKind; label: string }[]
  conflicts: { text: string }[]
  totals: string
  canCreate: boolean
}

export function importPreviewVM(
  p: ImportPreview,
  sel: ImportSelection,
  edits: CandidateEdits = {},
  o: { steps?: ImportSteps; filter?: RuleCategory | null } = {},
): ImportPreviewVM {
  const I = C.import
  const chosen = new Set(sel.selected)
  const chosenGates = new Set(sel.gates)
  const order: string[] = []
  const groups = new Map<string, ImportCandidateVM[]>()
  const catCount = new Map<RuleCategory, number>()
  const filter = o.filter ?? null
  for (const c of p.candidates) {
    const e = edits[c.tempId] ?? {}
    const category = e.category ?? c.category
    catCount.set(category, (catCount.get(category) ?? 0) + 1)
    if (filter && category !== filter) continue
    const key = c.source.path
    if (!groups.has(key)) {
      groups.set(key, [])
      order.push(key)
    }
    const severity = e.severity ?? c.severity
    const enforcement = e.enforcement ?? c.enforcement
    groups.get(key)!.push({
      tempId: c.tempId,
      name: e.name ?? c.name,
      text: e.text ?? c.text,
      category,
      severity,
      enforcement,
      categoryLabel: C.category[category],
      enforcementLabel: C.enforcement[enforcement],
      severityLabel: C.severity[severity],
      checked: chosen.has(c.tempId),
      marks: [
        ...(c.duplicateOf
          ? [{ kind: 'duplicate' as const, label: I.duplicate, compare: c.duplicateOf }]
          : []),
        ...(c.conflictsWith?.length
          ? [{ kind: 'conflict' as const, label: I.conflict, compare: c.conflictsWith[0]! }]
          : []),
      ],
    })
  }
  const st = o.steps ?? defaultImportSteps(p)
  const byId = new Map((p.steps ?? []).map((s) => [s.tempId, s]))
  const stepOrder = st.order.filter((id) => byId.has(id))
  const keptSteps = new Set(st.selected)
  const nChosen = p.candidates.filter((c) => chosen.has(c.tempId)).length
  const nGates = p.gates.filter((g) => !g.rejected && chosenGates.has(g.tempId)).length
  const nSteps = stepOrder.filter((id) => keptSteps.has(id)).length
  return {
    previewId: p.previewId,
    heading: I.heading,
    sources: p.sources.map((s) => ({
      path: s.path,
      repoLabel: s.repoLabel,
      formatLabel: C.sources[s.format],
      count: plural(s.ruleCount ?? 0, 'rule', 'rules'),
    })),
    groups: order.map((label) => {
      const candidates = groups.get(label)!
      return { label, allChecked: candidates.every((c) => c.checked), candidates }
    }),
    filters:
      catCount.size > 1
        ? [
            { category: null, label: I.allCategories, count: p.candidates.length, active: !filter },
            ...RULE_CATEGORIES.filter((c) => catCount.has(c)).map((category) => ({
              category,
              label: C.category[category],
              count: catCount.get(category)!,
              active: filter === category,
            })),
          ]
        : [],
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
    stepsHeading: I.stepsHeading,
    stepsNote: I.stepsNote,
    steps: stepOrder.map((id, i) => {
      const s = byId.get(id) as ImportStepSuggestion
      return {
        tempId: id,
        position: String(i + 1),
        name: s.name,
        goal: s.goal,
        sourceLabel: s.source.path,
        checked: keptSteps.has(id),
        check: st.checks[id] ?? 'report',
        up: i > 0,
        down: i < stepOrder.length - 1,
      }
    }),
    checkOptions: (['report', 'approval', 'gate', 'artifact'] as const).map((value) => ({
      value,
      label: C.flow.kinds[value],
    })),
    conflicts: p.conflicts.map((c) => ({ text: c.text })),
    totals: I.totals(p.totals.rules, p.totals.conflicts, nChosen),
    canCreate: nChosen + nGates + nSteps > 0,
  }
}
