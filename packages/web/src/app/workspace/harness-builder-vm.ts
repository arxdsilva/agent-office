// The Harness Builder dialog as one view model (docs/harness.md), composed from the pure parts.
import { HARNESS_COPY } from './harness-copy.ts'
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
import type { HarnessDialogTab, WorkspaceState } from './state.ts'

const C = HARNESS_COPY
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

// ── The whole dialog ─────────────────────────────────────────────────────────────────────────
export interface HarnessBuilderVM {
  open: boolean
  title: string
  sub: string
  closeLabel: string
  tab: HarnessDialogTab
  tabs: { id: HarnessDialogTab; label: string; active: boolean }[]
  error: string | null
  busy: boolean
  library: HarnessLibraryVM
  templates: { id: string; name: string; description: string; counts: string }[]
  editor: HarnessEditorVM | null
  editorEmpty: string
  import: {
    heading: string
    intro: string
    projectName: string | null
    needProject: string
    detect: ActionButtonVM
    sources: { path: string; repoLabel: string; formatLabel: string; count: string }[] | null
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
    reports: EnforcementReportVM[]
  }
  confirm: { open: boolean; text: string; okLabel: string; cancelLabel: string }
}

export function harnessBuilderVM(s: WorkspaceState): HarnessBuilderVM {
  const h = s.harness
  const projectName = h.projectId
    ? (s.projects.find((p) => p.id === h.projectId)?.name ?? null)
    : null
  const I = C.import
  const preview = h.preview ? importPreviewVM(h.preview, h.selection, h.edits) : null
  const name = h.importName || I.defaultName
  const target = h.confirm ? h.list.find((x) => x.id === h.confirm!.harnessId) : undefined
  const here = projectName ?? C.confirm.thisProject
  const text = !h.confirm
    ? ''
    : h.confirm.kind === 'publish'
      ? C.confirm.publish(target?.name ?? '')
      : h.confirm.kind === 'archive'
        ? C.confirm.archive(target?.name ?? '')
        : h.confirm.kind === 'attach'
          ? C.confirm.attach(target?.name ?? '', here)
          : C.confirm.detach(target?.name ?? '', here)
  return {
    open: h.open,
    title: C.dialog.title,
    sub: C.dialog.sub,
    closeLabel: C.dialog.close,
    tab: h.tab,
    tabs: (['library', 'editor', 'import', 'coverage'] as const).map((id) => ({
      id,
      label: C.dialog.tabs[id],
      active: id === h.tab,
    })),
    error: h.error,
    busy: h.busy,
    library: harnessLibraryVM(h.list, {
      projects: s.projects.map((p) => ({ id: p.id, name: p.name })),
      currentProjectId: h.projectId,
    }),
    templates: h.templates.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      counts: `${C.library.rules(t.ruleCount)} · ${C.library.gates(t.gateCount)}`,
    })),
    editor: h.detail ? harnessEditorVM(h.detail, h.editorTab, h.coverage) : null,
    editorEmpty: C.editor.empty,
    import: {
      heading: I.heading,
      intro: I.intro,
      projectName,
      needProject: I.needProject,
      detect: {
        id: 'detect',
        label: h.busy && !h.sources ? I.detecting : I.detect,
        enabled: !!h.projectId && !h.busy,
      },
      sources: h.sources
        ? h.sources.map((x) => ({
            path: x.path,
            repoLabel: x.repoLabel,
            formatLabel: C.sources[x.format],
            count: plural(x.ruleCount ?? 0, 'rule', 'rules'),
          }))
        : null,
      noSources: I.noSources,
      preview,
      previewButton: {
        id: 'preview',
        label: I.preview,
        enabled: !!h.sources?.length && !h.busy,
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
      },
    },
    coverage: {
      heading: C.coverage.heading,
      projectName,
      needProject: C.coverage.needProject,
      empty: C.coverage.empty,
      reports: h.coverage.map(enforcementReportVM),
    },
    confirm: {
      open: !!h.confirm,
      text,
      okLabel: h.confirm ? C.confirm[`${h.confirm.kind}Ok` as 'publishOk'] : '',
      cancelLabel: C.confirm.cancel,
    },
  }
}
