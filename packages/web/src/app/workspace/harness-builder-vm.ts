// The Harnesses pane (`#ws-harness`, docs/harness.md §7) as one view model, composed from the pure
// parts: library + applied (with drag-and-drop state), editor, import and coverage.
import { HARNESS_COPY } from './harness-copy.ts'
import { sortLibrary, type DropContext, type HarnessDrag } from './harness-dnd.ts'
import {
  enforcementReportVM,
  harnessEditorVM,
  harnessLibraryVM,
  importPreviewVM,
  type ActionButtonVM,
  type EnforcementReportVM,
  type HarnessEditorVM,
  type HarnessLibraryVM,
  type ImportPreviewVM,
} from './harness-vm.ts'
import type { HarnessPaneTab, WorkspaceState } from './state.ts'
import type { Tone } from './types.ts'

const C = HARNESS_COPY
const A = C.applied
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
const TABS: HarnessPaneTab[] = ['library', 'editor', 'import', 'coverage']

export interface AppliedRowVM {
  id: string
  position: string
  name: string
  versionLabel: string
  statusLabel: string
  tone: Tone
  /** "Flow · 5 steps" when it has steps. */
  flowChip: string | null
  up: ActionButtonVM
  down: ActionButtonVM
  detach: ActionButtonVM
  dragging: boolean
  dropMark: 'before' | 'after' | null
  /** Briefly highlighted after an attach. */
  fresh: boolean
}

export interface HarnessBuilderVM {
  /** The pane is the current workspace view (focus moves to `#hb-title` when it appears). */
  visible: boolean
  title: string
  sub: string
  /** "Projects aren't being saved" when the vault runs in memory only. */
  banner: string | null
  tab: HarnessPaneTab
  tabs: {
    id: HarnessPaneTab
    label: string
    active: boolean
    enabled: boolean
    hint?: string
    /** "●" on the Editor tab while it has unsaved changes. */
    badge?: string
  }[]
  error: string | null
  live: string
  busy: boolean
  /** One-shot element id to focus after this render. */
  focus: string | null
  head: { create: ActionButtonVM; importStart: ActionButtonVM }
  scope: {
    label: string
    value: string | null
    options: { id: string | null; name: string; selected: boolean }[]
  }
  library: HarnessLibraryVM & {
    query: string
    searchPlaceholder: string
    hint: string
    sortHint: string | null
    noMatch: string | null
    /** An Applied row hovers the library: dropping detaches. */
    dropOver: boolean
    /** First load still running: a "Loading…" line instead of an empty flash. */
    loading: string | null
  }
  templates: {
    id: string
    name: string
    description: string
    counts: string
    /** Up to three step names, for templates that define a flow. */
    flow: string[]
    use: ActionButtonVM
  }[]
  templatesHeading: string
  applied: {
    heading: string
    note: string
    scopeSet: boolean
    noScope: string
    rows: AppliedRowVM[]
    dropzone: { text: string; over: boolean; reject: boolean }
    emptyTip: string | null
    /** "Flow: A → B" when several attached harnesses define steps. */
    flowOrder: string | null
    coverageLink: string
  }
  /** What the DOM needs to decide a drop synchronously on dragover (`dropIntent`). */
  dnd: {
    drag: HarnessDrag | null
    ctx: Omit<DropContext, 'attached'> & { attachedBy: Record<string, string[]> }
    names: Record<string, string>
    projectNames: Record<string, string>
  }
  editor: HarnessEditorVM | null
  editorEmpty: string
  editorNotice: string | null
  stale: { text: string; reload: string; keep: string } | null
  import: {
    heading: string
    intro: string
    projectName: string | null
    needProject: string
    detect: ActionButtonVM
    sources:
      | { path: string; repoLabel: string; formatLabel: string; count: string; included: boolean }[]
      | null
    noSources: string
    preview: ImportPreviewVM | null
    previewButton: ActionButtonVM
    name: string
    attach: boolean
    attachLabel: string
    nameLabel: string
    create: ActionButtonVM
  }
  coverage: {
    heading: string
    projectName: string | null
    needProject: string
    empty: string
    legend: string
    reports: (EnforcementReportVM & { start: ActionButtonVM })[]
    disabled: { provider: string; label: string; note: string }[]
  }
  confirm: { open: boolean; text: string; okLabel: string; cancelLabel: string; danger: boolean }
}

/** Attached harness ids per project: `ProjectSummary.harnessIds` (Applied order), else the list. */
export function attachedIds(s: WorkspaceState, projectId: string): string[] {
  const p = s.projects.find((x) => x.id === projectId)
  if (p?.harnessIds) return p.harnessIds
  return s.harness.list.filter((h) => h.projectIds.includes(projectId)).map((h) => h.id)
}

const matches = (q: string, h: { name: string; description?: string }): boolean => {
  const t = q.trim().toLowerCase()
  return !t || `${h.name} ${h.description ?? ''}`.toLowerCase().includes(t)
}

export function harnessBuilderVM(s: WorkspaceState): HarnessBuilderVM {
  const h = s.harness
  const pid = h.projectId
  const projectName = pid ? (s.projects.find((p) => p.id === pid)?.name ?? null) : null
  const I = C.import
  const drag = h.drag
  const dragging = !!drag
  // While a drag is in progress the library keeps its drawn order (no re-sort under the pointer).
  const sorted = dragging ? h.list : sortLibrary(h.list, h.order)
  const shown = sorted.filter((x) => matches(h.query, x))
  const lib = harnessLibraryVM(shown, {
    projects: s.projects.map((p) => ({ id: p.id, name: p.name })),
    currentProjectId: pid,
    selectedId: h.selectedId,
    drag,
  })
  const byId = new Map(h.list.map((x) => [x.id, x]))
  const applied = pid ? attachedIds(s, pid).filter((id) => byId.has(id)) : []
  const preview = h.preview
    ? importPreviewVM(h.preview, h.selection, h.edits, {
        steps: h.importSteps,
        filter: h.importFilter,
      })
    : null
  const name = h.importName || (projectName ? I.standards(projectName) : I.defaultName)
  const target = h.confirm ? byId.get(h.confirm.harnessId) : undefined
  const confirmProject = h.confirm?.projectId ?? pid
  const here =
    (confirmProject && s.projects.find((p) => p.id === confirmProject)?.name) ||
    C.confirm.thisProject
  const k = h.confirm?.kind
  const text = !h.confirm
    ? ''
    : k === 'publish'
      ? C.confirm.publish(target?.name ?? '')
      : k === 'archive'
        ? C.confirm.archive(target?.name ?? '')
        : k === 'attach'
          ? C.confirm.attach(target?.name ?? '', here)
          : k === 'detach'
            ? C.confirm.detach(target?.name ?? '', here)
            : C.confirm.discard
  const otherFlows =
    !!h.detail &&
    !!pid &&
    applied.some((id) => id !== h.detail!.id && (byId.get(id)?.stepCount ?? 0) > 0)
  const editor = h.detail
    ? harnessEditorVM(h.detail, h.editorTab, h.coverage, {
        draft: h.draft,
        stepForm: h.stepForm,
        versions: h.versions,
        viewVersion: h.viewVersion,
        saved: h.saved,
        busy: h.busy,
        ruleEditId: h.ruleEditId,
        highlightRuleId: h.highlightRuleId,
        undo: !!h.undo,
        otherFlows,
      })
    : null
  const over = drag?.over
  const fromApplied = drag?.source === 'applied'
  const flows = applied.filter((id) => (byId.get(id)?.stepCount ?? 0) > 0)
  const attachedBy: Record<string, string[]> = {}
  for (const p of s.projects) attachedBy[p.id] = attachedIds(s, p.id)
  const appliedRows = applied.map((id, i): AppliedRowVM => {
    const x = byId.get(id)!
    return {
      id,
      position: String(i + 1),
      name: x.name,
      versionLabel: `v${x.version}`,
      statusLabel: C.status[x.status],
      tone: x.status === 'published' ? 'good' : x.status === 'draft' ? 'warn' : 'neutral',
      flowChip: x.stepCount ? A.flowChip(x.stepCount) : null,
      up: { id: 'up', label: A.up, enabled: i > 0 && !h.busy, hint: A.upLabel(x.name) },
      down: {
        id: 'down',
        label: A.down,
        enabled: i < applied.length - 1 && !h.busy,
        hint: A.downLabel(x.name),
      },
      detach: { id: 'detach', label: A.detach, enabled: !h.busy },
      dragging: fromApplied && drag!.harnessId === id,
      dropMark:
        over?.kind === 'applied-row' && over.harnessId === id && drag!.harnessId !== id
          ? over.after
            ? 'after'
            : 'before'
          : null,
      fresh: h.justAttached === id,
    }
  })
  const zoneOver = over?.kind === 'applied-zone' || over?.kind === 'applied-row'
  const zoneReject = zoneOver && drag?.source === 'library' && (drag.status !== 'published' || !pid)
  const vault = s.vault === 'memory-only'
  const editorDirty = !!editor?.dirty
  const readyIds = new Set(h.coverage.map((r) => r.provider))
  return {
    visible: s.view === 'harness',
    title: C.dialog.title,
    sub: C.dialog.sub,
    banner: vault ? C.dialog.vaultMemoryOnly : null,
    tab: h.tab,
    tabs: TABS.map((id) => ({
      id,
      label: C.dialog.tabs[id],
      active: id === h.tab,
      enabled: id !== 'import' || !!pid,
      ...(id === 'import' && !pid && { hint: C.dialog.importNeedsProject }),
      ...(id === 'editor' && editorDirty && { badge: C.dialog.dirty }),
    })),
    error: h.error,
    live: h.live,
    busy: h.busy,
    focus: h.focus,
    head: {
      create: { id: 'create', label: C.library.create, enabled: !h.busy },
      importStart: {
        id: 'import',
        label: C.library.importFromProject,
        enabled: !!pid && !h.busy,
        ...(!pid && { hint: C.library.hints.attachNeedsProject }),
      },
    },
    scope: {
      label: A.heading,
      value: pid,
      options: [
        { id: null, name: A.none, selected: !pid },
        ...s.projects
          .filter((p) => !p.archived)
          .map((p) => ({ id: p.id, name: p.name, selected: p.id === pid })),
      ],
    },
    library: {
      ...lib,
      empty: C.library.empty,
      query: h.query,
      searchPlaceholder: C.library.search,
      hint: C.library.hint,
      sortHint: lib.items.length >= 2 ? C.library.sortHint : null,
      noMatch: h.list.length && !shown.length ? C.library.noMatch : null,
      dropOver: fromApplied && (over?.kind === 'library' || over?.kind === 'library-card'),
      loading: h.listLoaded ? null : C.dialog.loading,
    },
    templates: h.templates.map((t) => {
      const steps = (t as { steps?: { name: string }[] }).steps ?? []
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        counts: `${steps.length ? `${C.library.steps(steps.length)} · ` : ''}${C.library.rules(t.ruleCount)} · ${C.library.gates(t.gateCount)}`,
        flow: steps.slice(0, 3).map((x, i) => `${i + 1}. ${x.name}`),
        use: { id: 'use', label: C.library.useTemplate, enabled: !h.busy },
      }
    }),
    templatesHeading: C.library.templatesHeading,
    applied: {
      heading: A.heading,
      note: A.note,
      scopeSet: !!pid,
      noScope: A.noScope,
      rows: appliedRows,
      dropzone: { text: A.dropzone, over: zoneOver && !zoneReject, reject: !!zoneReject },
      emptyTip: pid && !applied.length ? A.emptyTip : null,
      flowOrder: flows.length > 1 ? A.flowOrder(flows.map((id) => byId.get(id)!.name)) : null,
      coverageLink: A.coverage,
    },
    dnd: {
      drag,
      ctx: { scopeProjectId: pid, applied, library: lib.items.map((c) => c.id), attachedBy },
      names: Object.fromEntries(h.list.map((x) => [x.id, x.name])),
      projectNames: Object.fromEntries(s.projects.map((p) => [p.id, p.name])),
    },
    editor,
    editorEmpty: C.editor.empty,
    editorNotice: h.notice,
    stale: h.stale
      ? { text: C.dialog.changedElsewhere, reload: C.dialog.reload, keep: C.dialog.keepMine }
      : null,
    import: {
      heading: I.heading,
      intro: I.intro,
      projectName,
      needProject: I.needProject,
      detect: {
        id: 'detect',
        label: h.busy && !h.sources ? I.detecting : I.detect,
        enabled: !!pid && !h.busy,
      },
      sources: h.sources
        ? h.sources.map((x) => ({
            path: x.path,
            repoLabel: x.repoLabel,
            formatLabel: C.sources[x.format],
            count: plural(x.ruleCount ?? 0, 'rule', 'rules'),
            included: !h.excluded.includes(x.path),
          }))
        : null,
      noSources: I.noSources,
      preview,
      previewButton: {
        id: 'preview',
        label: I.preview,
        enabled: !!h.sources?.some((x) => !h.excluded.includes(x.path)) && !h.busy,
      },
      name,
      attach: h.importAttach,
      attachLabel: I.attachLabel,
      nameLabel: I.nameLabel,
      create: {
        id: 'create',
        label: h.busy ? I.creating : I.create,
        enabled: !!preview?.canCreate && !h.busy && !!name.trim(),
        ...(preview && !preview.canCreate && { hint: I.needSelection }),
        ...(preview && !name.trim() && { hint: I.needName }),
      },
    },
    coverage: {
      heading: C.coverage.heading,
      projectName,
      needProject: C.coverage.needProject,
      empty: C.coverage.empty,
      legend: C.coverage.legend,
      reports: h.coverage.map((r) => ({
        ...enforcementReportVM(r),
        start: {
          id: 'start',
          label: C.coverage.startSession,
          enabled: r.launch.ok,
          ...(!r.launch.ok && { hint: C.coverage.launchBlocked }),
        },
      })),
      disabled: s.providers
        .filter((p) => !p.enabled && !readyIds.has(p.id))
        .map((p) => ({ provider: p.id, label: p.label, note: C.coverage.notEnabled })),
    },
    confirm: {
      open: !!h.confirm,
      text,
      okLabel: k ? C.confirm[`${k}Ok` as 'publishOk'] : '',
      cancelLabel: C.confirm.cancel,
      danger: k === 'archive' || k === 'detach' || k === 'discard',
    },
  }
}
