// HarnessView port → the `#ws-harness` pane (docs/harness.md §7): Library + Applied (drag and drop),
// Editor (Overview · Flow · Rules · Gates · Providers · Import · History), Import, Coverage.
// Text only via textContent. Every decision lives in app/workspace (harness-dnd, harness-vm): this
// adapter translates DOM events into port calls and draws the view model.
import {
  ENFORCEMENT,
  FLOW_MODES,
  FS_ISOLATION,
  GATE_TRIGGERS,
  HARNESS_SCOPES,
  LAUNCH_POLICIES,
  PROVIDER_IDS,
  RULE_CATEGORIES,
  SEVERITY,
  STEP_CHECK_KINDS,
  type Enforcement,
  type HarnessDraft,
  type HarnessStatus,
  type RuleCategory,
  type RuleDraft,
  type StepCheckKind,
} from '@agent-office/shared'
import type { HarnessBuilderVM } from '../../app/workspace/harness-builder-vm.ts'
import { HARNESS_COPY } from '../../app/workspace/harness-copy.ts'
import {
  HARNESS_MIME,
  accepts,
  dropIntent,
  insertionIndex,
  type DragSource,
  type DropTarget,
} from '../../app/workspace/harness-dnd.ts'
import {
  EDITOR_TABS,
  emptyCheck,
  emptyPolicy,
  gateFromFields,
  ruleFieldsFrom,
  ruleFromFields,
  type CheckFields,
  type EditorTab,
  type EnforcementReportVM,
  type GateFields,
  type HarnessEditorVM,
  type PolicyFields,
  type StepFormVM,
} from '../../app/workspace/harness-vm.ts'
import type { HarnessPaneTab } from '../../app/workspace/state.ts'
import type { HarnessCardAction, HarnessView } from '../../workspace-ports.ts'
import { el } from './el.ts'
import { Signal, badge, chip, dot, need, textButton } from './ws-kit.ts'

const C = HARNESS_COPY
const TABS: HarnessPaneTab[] = ['library', 'editor', 'import', 'coverage']
/** Local (in-pane) reorder drags: flow steps and import step suggestions. */
const STEP_MIME = 'application/x-agent-office-step'

function field(label: string, input: HTMLElement, id: string, help?: string): HTMLElement {
  const wrap = el('div', undefined, 'hb-field')
  const l = el('label', label, 'field-label')
  l.htmlFor = id
  input.id = id
  wrap.append(l, input)
  if (help) wrap.append(el('p', help, 'muted small'))
  return wrap
}
function select(
  options: [string, string][],
  value: string,
  on: (v: string) => void,
  disabled = false,
) {
  const s = el('select', undefined, 'select')
  for (const [v, label] of options) {
    const o = el('option', label)
    o.value = v
    o.selected = v === value
    s.append(o)
  }
  s.disabled = disabled
  s.addEventListener('change', () => on(s.value))
  return s
}
function textInput(value: string, on: (v: string) => void, max: number, disabled = false) {
  const i = el('input', undefined, 'search-input')
  i.type = 'text'
  i.value = value
  i.maxLength = max
  i.disabled = disabled
  i.addEventListener('change', () => on(i.value))
  return i
}
function textArea(value: string, on: (v: string) => void, max: number, disabled = false) {
  const t = el('textarea')
  t.value = value
  t.rows = 2
  t.maxLength = max
  t.disabled = disabled
  t.addEventListener('change', () => on(t.value))
  return t
}
function check(checked: boolean, on: (v: boolean) => void, disabled = false) {
  const i = el('input')
  i.type = 'checkbox'
  i.checked = checked
  i.disabled = disabled
  i.addEventListener('change', () => on(i.checked))
  return i
}
/** A radio group as a fieldset with an id (`#hb-f-launch`, `#hb-r-enf`, …). */
function radios(
  id: string,
  legend: string,
  options: [string, string][],
  value: string,
  on: (v: string) => void,
  disabled = false,
): HTMLFieldSetElement {
  const fs = el('fieldset', undefined, 'hb-radios')
  fs.id = id
  fs.append(el('legend', legend, 'field-label'))
  for (const [v, label] of options) {
    const l = el('label', undefined, 'row')
    const r = el('input')
    r.type = 'radio'
    r.name = id
    r.value = v
    r.checked = v === value
    r.disabled = disabled
    r.addEventListener('change', () => r.checked && on(v))
    l.append(r, ` ${label}`)
    fs.append(l)
  }
  return fs
}
const split = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

/** Everything drag-related is stripped: a drag only patches classes, never rebuilds the DOM. */
function structureKey(vm: HarnessBuilderVM): string {
  return JSON.stringify(vm, (k, v) =>
    k === 'dnd' ||
    k === 'dragging' ||
    k === 'dropMark' ||
    k === 'dropOver' ||
    k === 'live' ||
    k === 'focus' ||
    (k === 'dropzone' && typeof v === 'object')
      ? undefined
      : v,
  )
}

export class DomHarnessPane implements HarnessView {
  private tab = new Signal<[HarnessPaneTab]>()
  private editorTab = new Signal<[EditorTab]>()
  private create = new Signal()
  private template = new Signal<[string]>()
  private card = new Signal<[string, HarnessCardAction]>()
  private confirm = new Signal()
  private confirmCancel = new Signal()
  private save = new Signal<[string, HarnessDraft]>()
  private draft = new Signal<[HarnessDraft]>()
  private discard = new Signal()
  private stale = new Signal<['reload' | 'keep']>()
  private version = new Signal<[number | null]>()
  private scope = new Signal<[string | null]>()
  private search = new Signal<[string]>()
  private drag = new Signal<
    [{ harnessId: string; source: DragSource; status: HarnessStatus } | null]
  >()
  private dragOver = new Signal<[DropTarget | null]>()
  private attachTo = new Signal<[string, string, string[] | undefined]>()
  private reorderApplied = new Signal<[string, string[]]>()
  private moveApplied = new Signal<[string, string, 'up' | 'down']>()
  private reorderLibrary = new Signal<[string[]]>()
  private stepEdit = new Signal<[number | null]>()
  private stepForm = new Signal<[Parameters<Parameters<HarnessView['onStepForm']>[0]>[0]]>()
  private stepSubmit = new Signal()
  private stepRemove = new Signal<[number]>()
  private stepMove = new Signal<[number, number]>()
  private ruleEdit = new Signal<[string | null]>()
  private ruleRemove = new Signal<[number]>()
  private undo = new Signal()
  private goToRule = new Signal<[string]>()
  private startSession = new Signal<[string]>()
  private importStart = new Signal()
  private detect = new Signal()
  private preview = new Signal()
  private toggleSource = new Signal<[string, boolean]>()
  private toggleCand = new Signal<[string, boolean]>()
  private selectGroup = new Signal<[string, boolean]>()
  private importFilter = new Signal<[RuleCategory | null]>()
  private toggleGate = new Signal<[string, boolean]>()
  private toggleStep = new Signal<[string, boolean]>()
  private stepCheck = new Signal<[string, StepCheckKind]>()
  private moveImportStep = new Signal<[string, number]>()
  private editCand = new Signal<Parameters<Parameters<HarnessView['onEditCandidate']>[0]>>()
  private importName = new Signal<[string]>()
  private importAttach = new Signal<[boolean]>()
  private commit = new Signal()

  private root: HTMLElement
  private panelsEl: HTMLElement
  private confirmDialog: HTMLDialogElement
  private tabButtons = new Map<HarnessPaneTab, HTMLButtonElement>()
  private panels = new Map<HarnessPaneTab, HTMLElement>()
  private createBtn: HTMLButtonElement
  private importBtn: HTMLButtonElement
  private vm: HarnessBuilderVM | null = null
  private lastStructure = ''
  private wasVisible = false
  private confirmReturn: HTMLElement | null = null
  /** The last drop target reported (dragover fires continuously; only changes are emitted). */
  private lastOver = ''
  /** A local reorder drag (flow step or import step suggestion). */
  private local: { kind: 'step' | 'cand'; key: string; index: number } | null = null
  private gateEdit: number | null = null

  constructor(private doc: Document) {
    this.root = need(doc, 'ws-harness')
    this.panelsEl = need(doc, 'hb-panels')
    this.confirmDialog = need<HTMLDialogElement>(doc, 'hb-confirm')
    // Typing here must not reach scene shortcuts (the pixel HUD listens on document); Escape and
    // Ctrl/Cmd+K stay with the workspace. Ctrl/Cmd+S saves the editor.
    this.root.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey
      if (e.key === 'Escape' || (mod && e.key.toLowerCase() === 'k')) return
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        const ed = this.vm?.editor
        if (ed && this.vm?.tab === 'editor' && ed.save.enabled) this.save.emit(ed.id, ed.draft)
      }
      e.stopPropagation()
    })
    this.confirmDialog.addEventListener('cancel', (e) => {
      e.preventDefault()
      this.confirmCancel.emit()
    })
    this.confirmDialog.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target as HTMLElement).id !== 'hb-confirm-cancel') {
        e.preventDefault()
        this.confirm.emit()
      }
    })
    need(doc, 'hb-confirm-ok').addEventListener('click', () => this.confirm.emit())
    need(doc, 'hb-confirm-cancel').addEventListener('click', () => this.confirmCancel.emit())

    const head = need(doc, 'hb-head-actions')
    this.createBtn = textButton('', 'btn small primary', () => this.create.emit(), 'hb-create')
    this.importBtn = textButton('', 'btn small', () => this.importStart.emit(), 'hb-import-start')
    head.replaceChildren(this.createBtn, this.importBtn)

    const rail = need(doc, 'hb-tabs')
    for (const id of TABS) {
      const b = textButton('', 'tab', () => this.tab.emit(id), `hb-tab-${id}`)
      b.setAttribute('role', 'tab')
      b.setAttribute('aria-controls', `hb-panel-${id}`)
      b.dataset.tab = id
      this.tabButtons.set(id, b)
      rail.append(b)
      const p = el('section', undefined, 'hb-panel')
      p.id = `hb-panel-${id}`
      p.setAttribute('role', 'tabpanel')
      p.setAttribute('aria-labelledby', `hb-tab-${id}`)
      p.hidden = true
      this.panels.set(id, p)
    }
    rail.addEventListener('keydown', (e) => {
      const keys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End']
      if (!keys.includes(e.key)) return
      e.preventDefault()
      const cur = TABS.findIndex(
        (t) => this.tabButtons.get(t)?.getAttribute('aria-selected') === 'true',
      )
      const n = TABS.length
      const i =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? n - 1
            : e.key === 'ArrowDown' || e.key === 'ArrowRight'
              ? (cur + 1) % n
              : (cur + n - 1) % n
      const next = TABS[i]!
      this.tabButtons.get(next)?.focus()
      if (!this.tabButtons.get(next)?.disabled) this.tab.emit(next)
    })
    this.panelsEl.replaceChildren(...this.panels.values())
    this.installDnd()
  }

  // ── Port ───────────────────────────────────────────────────────────────────────────────────
  onTab(fn: (tab: HarnessPaneTab) => void) {
    this.tab.on(fn)
  }
  onEditorTab(fn: (tab: EditorTab) => void) {
    this.editorTab.on(fn)
  }
  onCreate(fn: () => void) {
    this.create.on(fn)
  }
  onTemplate(fn: (id: string) => void) {
    this.template.on(fn)
  }
  onCard(fn: (id: string, a: HarnessCardAction) => void) {
    this.card.on(fn)
  }
  onConfirm(fn: () => void) {
    this.confirm.on(fn)
  }
  onConfirmCancel(fn: () => void) {
    this.confirmCancel.on(fn)
  }
  onSave(fn: (id: string, draft: HarnessDraft) => void) {
    this.save.on(fn)
  }
  onDraft(fn: (draft: HarnessDraft) => void) {
    this.draft.on(fn)
  }
  onDiscard(fn: () => void) {
    this.discard.on(fn)
  }
  onStale(fn: (c: 'reload' | 'keep') => void) {
    this.stale.on(fn)
  }
  onVersion(fn: (v: number | null) => void) {
    this.version.on(fn)
  }
  onScope(fn: (projectId: string | null) => void) {
    this.scope.on(fn)
  }
  onSearch(fn: (q: string) => void) {
    this.search.on(fn)
  }
  onDrag(fn: Parameters<HarnessView['onDrag']>[0]) {
    this.drag.on(fn)
  }
  onDragOver(fn: (t: DropTarget | null) => void) {
    this.dragOver.on(fn)
  }
  onAttachTo(fn: (harnessId: string, projectId: string, ids?: string[]) => void) {
    this.attachTo.on(fn)
  }
  onReorderApplied(fn: (projectId: string, ids: string[]) => void) {
    this.reorderApplied.on(fn)
  }
  onMoveApplied(fn: (projectId: string, harnessId: string, dir: 'up' | 'down') => void) {
    this.moveApplied.on(fn)
  }
  onReorderLibrary(fn: (ids: string[]) => void) {
    this.reorderLibrary.on(fn)
  }
  onStepEdit(fn: (index: number | null) => void) {
    this.stepEdit.on(fn)
  }
  onStepForm(fn: Parameters<HarnessView['onStepForm']>[0]) {
    this.stepForm.on(fn)
  }
  onStepSubmit(fn: () => void) {
    this.stepSubmit.on(fn)
  }
  onStepRemove(fn: (i: number) => void) {
    this.stepRemove.on(fn)
  }
  onStepMove(fn: (i: number, to: number) => void) {
    this.stepMove.on(fn)
  }
  onRuleEdit(fn: (id: string | null) => void) {
    this.ruleEdit.on(fn)
  }
  onRuleRemove(fn: (i: number) => void) {
    this.ruleRemove.on(fn)
  }
  onUndo(fn: () => void) {
    this.undo.on(fn)
  }
  onGoToRule(fn: (id: string) => void) {
    this.goToRule.on(fn)
  }
  onStartSession(fn: (provider: string) => void) {
    this.startSession.on(fn)
  }
  onImportStart(fn: () => void) {
    this.importStart.on(fn)
  }
  onDetect(fn: () => void) {
    this.detect.on(fn)
  }
  onPreview(fn: () => void) {
    this.preview.on(fn)
  }
  onToggleSource(fn: (path: string, on: boolean) => void) {
    this.toggleSource.on(fn)
  }
  onToggleCandidate(fn: (tempId: string, on: boolean) => void) {
    this.toggleCand.on(fn)
  }
  onSelectGroup(fn: (path: string, on: boolean) => void) {
    this.selectGroup.on(fn)
  }
  onImportFilter(fn: (c: RuleCategory | null) => void) {
    this.importFilter.on(fn)
  }
  onToggleGate(fn: (tempId: string, on: boolean) => void) {
    this.toggleGate.on(fn)
  }
  onToggleStep(fn: (tempId: string, on: boolean) => void) {
    this.toggleStep.on(fn)
  }
  onStepCheck(fn: (tempId: string, kind: StepCheckKind) => void) {
    this.stepCheck.on(fn)
  }
  onMoveImportStep(fn: (tempId: string, to: number) => void) {
    this.moveImportStep.on(fn)
  }
  onEditCandidate(fn: Parameters<HarnessView['onEditCandidate']>[0]) {
    this.editCand.on(fn)
  }
  onImportName(fn: (name: string) => void) {
    this.importName.on(fn)
  }
  onImportAttach(fn: (attach: boolean) => void) {
    this.importAttach.on(fn)
  }
  onCommit(fn: () => void) {
    this.commit.on(fn)
  }

  // ── Render ─────────────────────────────────────────────────────────────────────────────────
  render(vm: HarnessBuilderVM): void {
    this.vm = vm
    need(this.doc, 'hb-live').textContent = vm.live
    const structure = structureKey(vm)
    if (structure !== this.lastStructure) {
      this.lastStructure = structure
      this.rebuild(vm)
    }
    this.patchDrag(vm)
    // The confirm (body level: a dialog inside a hidden pane cannot showModal()).
    if (vm.confirm.open && !this.confirmDialog.open) {
      this.confirmReturn = this.doc.activeElement as HTMLElement | null
      this.confirmDialog.showModal()
      need(this.doc, 'hb-confirm-cancel').focus()
    }
    if (!vm.confirm.open && this.confirmDialog.open) {
      this.confirmDialog.close()
      this.confirmReturn?.focus?.()
      this.confirmReturn = null
    }
    if (vm.focus) {
      const t = this.doc.getElementById(vm.focus)
      t?.focus()
      if (t instanceof HTMLInputElement) t.select()
    } else if (vm.visible && !this.wasVisible) need(this.doc, 'hb-title').focus()
    this.wasVisible = vm.visible
  }

  private rebuild(vm: HarnessBuilderVM): void {
    const focusKey = (this.doc.activeElement as HTMLElement | null)?.dataset?.fk
    need(this.doc, 'hb-title').textContent = vm.title
    const sub = need(this.doc, 'hb-sub')
    sub.textContent = vm.banner ? `${vm.sub} ${vm.banner}` : vm.sub
    sub.classList.toggle('tone-warn', !!vm.banner)
    need(this.doc, 'hb-error').textContent = vm.error ?? ''
    this.createBtn.textContent = vm.head.create.label
    this.createBtn.disabled = !vm.head.create.enabled
    this.importBtn.textContent = vm.head.importStart.label
    this.importBtn.disabled = !vm.head.importStart.enabled
    this.importBtn.title = vm.head.importStart.hint ?? ''
    for (const t of vm.tabs) {
      const b = this.tabButtons.get(t.id)!
      b.replaceChildren(el('span', t.label, 'tab-label'))
      if (t.badge) {
        const d = el('span', t.badge, 'tab-badge')
        d.setAttribute('aria-label', C.dialog.dirtyLabel)
        b.append(d)
      }
      b.setAttribute('aria-selected', String(t.active))
      b.tabIndex = t.active ? 0 : -1
      b.disabled = !t.enabled
      b.title = t.hint ?? ''
      this.panels.get(t.id)!.hidden = !t.active
    }
    const active = this.panels.get(vm.tab)!
    const scroll = active.scrollTop
    switch (vm.tab) {
      case 'library':
        active.replaceChildren(...this.library(vm))
        break
      case 'editor':
        active.replaceChildren(...this.editor(vm))
        break
      case 'import':
        active.replaceChildren(...this.importPane(vm))
        break
      case 'coverage':
        active.replaceChildren(...this.coveragePane(vm))
        break
    }
    active.scrollTop = scroll
    need(this.doc, 'hb-confirm-text').textContent = vm.confirm.text
    const ok = need(this.doc, 'hb-confirm-ok')
    ok.textContent = vm.confirm.okLabel
    ok.className = `btn ${vm.confirm.danger ? 'danger' : 'primary'}`
    need(this.doc, 'hb-confirm-cancel').textContent = vm.confirm.cancelLabel
    if (focusKey) active.querySelector<HTMLElement>(`[data-fk="${CSS.escape(focusKey)}"]`)?.focus()
    active.querySelector<HTMLElement>('.hb-rule.highlight')?.scrollIntoView?.({ block: 'nearest' })
  }

  /** Drag highlights only: classes on the existing nodes (no rebuild under the pointer). */
  private patchDrag(vm: HarnessBuilderVM): void {
    const root = this.panels.get('library')
    if (!root) return
    for (const c of vm.library.items) {
      const li = root.querySelector<HTMLElement>(`.hb-card[data-harness-id="${CSS.escape(c.id)}"]`)
      if (!li) continue
      li.classList.toggle('dragging', c.dragging)
      li.classList.toggle('hb-drop-before', c.dropMark === 'before')
      li.classList.toggle('hb-drop-after', c.dropMark === 'after')
    }
    for (const r of vm.applied.rows) {
      const li = root.querySelector<HTMLElement>(
        `.hb-applied-row[data-harness-id="${CSS.escape(r.id)}"]`,
      )
      if (!li) continue
      li.classList.toggle('dragging', r.dragging)
      li.classList.toggle('hb-drop-before', r.dropMark === 'before')
      li.classList.toggle('hb-drop-after', r.dropMark === 'after')
    }
    const zone = root.querySelector<HTMLElement>('.hb-dropzone')
    zone?.classList.toggle('drag-over', vm.applied.dropzone.over)
    zone?.classList.toggle('hb-drop-reject', vm.applied.dropzone.reject)
    root
      .querySelector<HTMLElement>('.hb-applied')
      ?.classList.toggle('drag-over', vm.applied.dropzone.over)
    root
      .querySelector<HTMLElement>('.hb-library')
      ?.classList.toggle('drag-over', vm.library.dropOver)
  }

  // ── Drag and drop (delegated on #hb-panels; decisions in harness-dnd) ─────────────────────
  private targetOf(e: DragEvent): DropTarget | null {
    const t = e.target as Element | null
    const after = (node: HTMLElement): boolean => {
      const r = node.getBoundingClientRect()
      return insertionIndex([r.top], [r.height], e.clientY) === 1
    }
    const row = t?.closest?.<HTMLElement>('.hb-applied-row[data-harness-id]')
    if (row) return { kind: 'applied-row', harnessId: row.dataset.harnessId!, after: after(row) }
    if (t?.closest?.('.hb-applied')) return { kind: 'applied-zone' }
    const card = t?.closest?.<HTMLElement>('.hb-card[data-harness-id]')
    if (card)
      return { kind: 'library-card', harnessId: card.dataset.harnessId!, after: after(card) }
    if (t?.closest?.('.hb-library')) return { kind: 'library' }
    return null
  }

  private intentOf(target: DropTarget) {
    const d = this.vm?.dnd
    if (!d) return { kind: 'none' as const }
    return dropIntent(d.drag, target, {
      ...d.ctx,
      attached: (pid) => d.ctx.attachedBy[pid] ?? [],
    })
  }

  private endDrag(): void {
    this.lastOver = ''
    this.local = null
    if (this.vm?.dnd.drag) this.drag.emit(null)
  }

  private installDnd(): void {
    const p = this.panelsEl
    p.addEventListener('dragstart', (e) => {
      const t = e.target as HTMLElement
      const dt = e.dataTransfer
      if (!dt || !this.vm) return
      const step = t.closest?.<HTMLElement>('li.hb-step[data-index], li.hb-step-cand[data-temp-id]')
      if (step) {
        this.local = step.classList.contains('hb-step')
          ? { kind: 'step', key: step.dataset.index!, index: Number(step.dataset.index) }
          : { kind: 'cand', key: step.dataset.tempId!, index: Number(step.dataset.index) }
        dt.setData(STEP_MIME, this.local.key)
        dt.effectAllowed = 'move'
        step.classList.add('dragging')
        return
      }
      const src = t.closest?.<HTMLElement>('[data-drag-source][data-harness-id]')
      if (!src || this.vm.busy) {
        if (!src) return
        e.preventDefault()
        return
      }
      const harnessId = src.dataset.harnessId!
      dt.setData(HARNESS_MIME, harnessId)
      dt.effectAllowed = 'copyMove'
      this.lastOver = ''
      this.drag.emit({
        harnessId,
        source: src.dataset.dragSource as DragSource,
        status: (src.dataset.status ?? 'published') as HarnessStatus,
      })
    })
    p.addEventListener('dragover', (e) => {
      const types = e.dataTransfer?.types ?? []
      if (types.includes(STEP_MIME) && this.local) {
        const list = (e.target as Element).closest?.(
          this.local.kind === 'step' ? '#hb-steps' : '.hb-step-cands',
        )
        if (list) e.preventDefault()
        return
      }
      if (!types.includes(HARNESS_MIME)) return
      const target = this.targetOf(e)
      const key = JSON.stringify(target)
      if (key !== this.lastOver) {
        this.lastOver = key
        this.dragOver.emit(target)
      }
      const ok = !!target && !this.vm?.busy && accepts(this.intentOf(target))
      if (e.dataTransfer) e.dataTransfer.dropEffect = ok ? 'move' : 'none'
      if (ok) e.preventDefault()
    })
    p.addEventListener('dragleave', (e) => {
      const to = e.relatedTarget as Node | null
      if (to && p.contains(to)) return
      if (this.lastOver) {
        this.lastOver = ''
        this.dragOver.emit(null)
      }
    })
    p.addEventListener('drop', (e) => {
      const types = e.dataTransfer?.types ?? []
      if (types.includes(STEP_MIME) && this.local) {
        e.preventDefault()
        this.localDrop(e)
        return
      }
      if (!types.includes(HARNESS_MIME)) return
      e.preventDefault()
      const target = this.targetOf(e)
      const vm = this.vm
      const id = vm?.dnd.drag?.harnessId ?? e.dataTransfer?.getData(HARNESS_MIME)
      const intent = target ? this.intentOf(target) : null
      this.endDrag()
      if (!vm || vm.busy || !id || !intent) return
      switch (intent.kind) {
        case 'attach':
          this.attachTo.emit(id, intent.projectId, intent.ids)
          break
        case 'reorder':
          this.reorderApplied.emit(intent.projectId, intent.ids)
          break
        case 'detach':
          this.card.emit(id, 'detach')
          break
        case 'reorder-library':
          this.reorderLibrary.emit(intent.ids)
          break
      }
    })
    p.addEventListener('dragend', () => this.endDrag())
    // A drag that ends anywhere (Esc, outside the window) clears the state too.
    this.doc.addEventListener('dragend', () => this.endDrag())
  }

  private localDrop(e: DragEvent): void {
    const l = this.local
    this.local = null
    if (!l) return
    const sel = l.kind === 'step' ? '#hb-steps > li' : '.hb-step-cands > li'
    const rows = [...this.panelsEl.querySelectorAll<HTMLElement>(sel)]
    const rects = rows.map((r) => r.getBoundingClientRect())
    const ins = insertionIndex(
      rects.map((r) => r.top),
      rects.map((r) => r.height),
      e.clientY,
    )
    const to = ins > l.index ? ins - 1 : ins
    if (to === l.index) return
    if (l.kind === 'step') this.stepMove.emit(l.index, to)
    else this.moveImportStep.emit(l.key, to)
  }

  // ── Library + Applied ──────────────────────────────────────────────────────────────────────
  private library(vm: HarnessBuilderVM): HTMLElement[] {
    const L = vm.library
    const grid = el('div', undefined, 'hb-lib-grid')
    const lib = el('section', undefined, 'hb-library')
    lib.setAttribute('aria-label', L.heading)
    const head = el('div', undefined, 'hb-head')
    head.append(el('h3', L.heading))
    if (L.sortHint) head.append(el('span', L.sortHint, 'muted small'))
    lib.append(head)
    const search = el('input', undefined, 'search-input')
    search.type = 'search'
    search.id = 'hb-search'
    search.placeholder = L.searchPlaceholder
    search.setAttribute('aria-label', L.searchPlaceholder)
    search.value = L.query
    search.dataset.fk = 'search'
    search.addEventListener('input', () => this.search.emit(search.value))
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && search.value) {
        e.preventDefault()
        e.stopPropagation()
        search.value = ''
        this.search.emit('')
      }
    })
    lib.append(search, el('p', L.hint, 'muted small hb-lib-hint'))
    if (L.loading) lib.append(el('p', L.loading, 'hb-loading muted'))
    else if (!L.items.length && !L.noMatch) {
      const empty = el('div', undefined, 'sec-empty muted')
      empty.append(el('p', L.empty))
      const row = el('div', undefined, 'hb-actions')
      row.append(
        textButton(C.library.importFromProject, 'btn small', () => this.importStart.emit()),
        textButton(C.library.create, 'btn small', () => this.create.emit()),
      )
      empty.append(row)
      lib.append(empty)
    }
    if (L.noMatch) lib.append(el('p', L.noMatch, 'muted'))
    const list = el('ul', undefined, 'hb-cards')
    for (const c of L.items) {
      const li = el(
        'li',
        undefined,
        `hb-card card${c.selected ? ' selected' : ''}${c.status === 'archived' ? ' archived' : ''}`,
      )
      li.dataset.harnessId = c.id
      li.dataset.status = c.status
      li.tabIndex = 0
      li.setAttribute('aria-roledescription', 'harness card')
      li.setAttribute('aria-selected', String(c.selected))
      li.draggable = c.draggable
      if (c.draggable) {
        li.dataset.dragSource = 'library'
        if (c.dragReason) li.title = c.dragReason
      }
      const top = el('div', undefined, 'hb-card-top')
      const grip = el('span', '⠿', 'hb-grip')
      grip.setAttribute('aria-hidden', 'true')
      top.append(
        grip,
        dot(c.tone),
        el('strong', c.name, 'hb-name'),
        chip(c.versionLabel, 'version'),
        badge(c.statusLabel, c.tone),
      )
      if (c.stepCount) top.append(chip(C.library.flowChip, 'flow'))
      li.append(top)
      if (c.description) li.append(el('p', c.description, 'muted'))
      li.append(el('p', c.counts, 'hb-counts muted'))
      const chips = el('div', undefined, 'hb-chips')
      for (const k of c.chips) {
        const x = chip(`${k.label} · ${k.count}`, 'enforcement')
        x.dataset.enforcement = k.enforcement
        chips.append(x)
      }
      li.append(chips)
      li.append(
        el(
          'p',
          c.projects.length
            ? `${C.library.attachedTo}: ${c.projects.join(', ')}`
            : C.library.notAttached,
          'hb-attached muted',
        ),
      )
      if (c.selected) {
        li.append(el('p', c.summary, 'hb-card-summary'))
        for (const a of c.actions)
          if (!a.enabled && a.hint) li.append(el('p', a.hint, 'hb-hint muted small'))
      }
      const actions = el('div', undefined, 'hb-actions')
      for (const a of c.actions) {
        const b = textButton(a.label, `btn small${a.id === 'archive' ? ' danger' : ''}`, () =>
          this.card.emit(c.id, a.id as HarnessCardAction),
        )
        b.dataset.action = a.id
        b.disabled = !a.enabled || vm.busy
        if (a.hint) b.title = a.hint
        actions.append(b)
      }
      li.append(actions)
      li.addEventListener('click', (e) => {
        if ((e.target as Element).closest('button')) return
        this.card.emit(c.id, 'select')
      })
      li.addEventListener('dblclick', (e) => {
        if (!(e.target as Element).closest('button')) this.card.emit(c.id, 'edit')
      })
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target === li) this.card.emit(c.id, 'edit')
        else if (e.key === ' ' && e.target === li) {
          e.preventDefault()
          this.card.emit(c.id, 'select')
        }
      })
      li.dataset.fk = `card-${c.id}`
      list.append(li)
    }
    lib.append(list)
    if (vm.templates.length) {
      lib.append(el('h4', vm.templatesHeading))
      const tl = el('ul', undefined, 'hb-templates')
      for (const t of vm.templates) {
        const li = el('li', undefined, 'hb-template')
        li.dataset.templateId = t.id
        li.tabIndex = 0
        const head2 = el('div', undefined, 'hb-template-top')
        head2.append(el('strong', t.name), el('span', ` ${t.description} · ${t.counts}`, 'muted'))
        const use = textButton(t.use.label, 'btn small', () => this.template.emit(t.id))
        use.dataset.action = 'use-template'
        use.disabled = !t.use.enabled
        head2.append(use)
        li.append(head2)
        if (t.flow.length) {
          const ol = el('ol', undefined, 'hb-template-flow muted small')
          for (const line of t.flow) ol.append(el('li', line))
          li.append(ol)
        }
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && e.target === li && t.use.enabled) this.template.emit(t.id)
        })
        tl.append(li)
      }
      lib.append(tl)
    }
    grid.append(lib, this.applied(vm))
    return [grid]
  }

  private applied(vm: HarnessBuilderVM): HTMLElement {
    const A = vm.applied
    const sec = el('section', undefined, 'hb-applied')
    sec.setAttribute('aria-label', A.heading)
    const head = el('div', undefined, 'hb-head')
    const scope = el('select', undefined, 'select')
    for (const o of vm.scope.options) {
      const opt = el('option', o.name)
      opt.value = o.id ?? ''
      opt.selected = o.selected
      scope.append(opt)
    }
    scope.dataset.fk = 'scope'
    scope.addEventListener('change', () => this.scope.emit(scope.value || null))
    head.append(field(vm.scope.label, scope, 'hb-scope'))
    sec.append(head)
    if (!A.scopeSet) {
      sec.append(el('p', A.noScope, 'sec-empty muted'))
      return sec
    }
    sec.append(el('p', A.note, 'hb-applied-note muted small'))
    if (A.flowOrder) sec.append(el('p', A.flowOrder, 'hb-flow-order small'))
    const ol = el('ol', undefined, 'hb-applied-list')
    for (const r of A.rows) {
      const li = el('li', undefined, `hb-applied-row${r.fresh ? ' fresh' : ''}`)
      li.dataset.harnessId = r.id
      li.dataset.dragSource = 'applied'
      li.dataset.status = 'published'
      li.draggable = !vm.busy
      li.tabIndex = -1
      const grip = el('span', '⠿', 'hb-grip')
      grip.setAttribute('aria-hidden', 'true')
      const name = textButton(r.name, 'link hb-applied-name', () => this.card.emit(r.id, 'edit'))
      li.append(
        el('span', r.position, 'hb-pos'),
        grip,
        name,
        chip(r.versionLabel, 'version'),
        badge(r.statusLabel, r.tone),
      )
      if (r.flowChip) li.append(chip(r.flowChip, 'flow'))
      const pid = vm.scope.value!
      for (const [b, dir] of [
        [r.up, 'up'],
        [r.down, 'down'],
      ] as const) {
        const btn = textButton(b.label, 'icon-btn', () => this.moveApplied.emit(pid, r.id, dir))
        btn.dataset.action = dir
        btn.disabled = !b.enabled
        btn.setAttribute('aria-label', b.hint ?? dir)
        btn.dataset.fk = `${dir}-${r.id}`
        li.append(btn)
      }
      const det = textButton(r.detach.label, 'btn small danger', () =>
        this.card.emit(r.id, 'detach'),
      )
      det.dataset.action = 'detach'
      det.disabled = !r.detach.enabled
      li.append(det)
      ol.append(li)
    }
    sec.append(ol)
    const zone = el('div', A.dropzone.text, 'hb-dropzone')
    sec.append(zone)
    if (A.emptyTip) sec.append(el('p', A.emptyTip, 'muted small'))
    const cov = textButton(A.coverageLink, 'link hb-applied-coverage', () =>
      this.tab.emit('coverage'),
    )
    sec.append(cov)
    return sec
  }

  // ── Editor ─────────────────────────────────────────────────────────────────────────────────
  private editor(vm: HarnessBuilderVM): HTMLElement[] {
    const e = vm.editor
    if (!e) return [el('p', vm.editorEmpty, 'sec-empty muted')]
    const head = el('div', undefined, 'hb-head hb-editor-head')
    const name = textButton(e.title, 'link hb-editor-name', () => {
      this.editorTab.emit('overview')
      queueMicrotask(() => this.doc.getElementById('hb-f-name')?.focus())
    })
    name.id = 'hb-editor-name'
    head.append(
      name,
      chip(e.versionLabel, 'version'),
      badge(e.statusLabel, e.status === 'published' ? 'good' : 'warn'),
    )
    const bar = el('div', undefined, 'hb-actions')
    const save = textButton(
      e.save.label,
      'btn small primary',
      () => this.save.emit(e.id, e.draft),
      'hb-save',
    )
    save.disabled = !e.save.enabled
    if (e.save.hint) save.title = e.save.hint
    const discard = textButton(
      e.discard.label,
      'btn small',
      () => this.discard.emit(),
      'hb-discard',
    )
    discard.disabled = !e.discard.enabled
    discard.hidden = !e.dirty
    bar.append(save, discard)
    if (e.publish) {
      const pub = textButton(
        e.publish.label,
        'btn small',
        () => this.card.emit(e.id, 'publish'),
        'hb-editor-publish',
      )
      pub.disabled = !e.publish.enabled
      if (e.publish.hint) pub.title = e.publish.hint
      bar.append(pub)
    }
    if (e.undo)
      bar.append(textButton(C.editor.undo, 'btn small', () => this.undo.emit(), 'hb-undo'))
    head.append(bar)
    const out: HTMLElement[] = [head]
    if (vm.editorNotice) out.push(el('p', vm.editorNotice, 'hb-notice tone-good'))
    if (vm.stale) {
      const n = el('div', undefined, 'hb-notice tone-warn hb-stale')
      n.append(
        el('span', vm.stale.text),
        textButton(vm.stale.reload, 'btn small', () => this.stale.emit('reload')),
        textButton(vm.stale.keep, 'btn small', () => this.stale.emit('keep')),
      )
      out.push(n)
    }
    if (e.history.banner) {
      const b = el('div', undefined, 'hb-notice tone-neutral')
      b.append(
        el('span', e.history.banner),
        textButton(C.editor.historyBack, 'btn small', () => this.version.emit(null)),
      )
      out.push(b)
    }
    const sub = el('div', undefined, 'hb-subtabs')
    sub.id = 'hb-subtabs'
    sub.setAttribute('role', 'tablist')
    for (const t of e.tabs) {
      const b = textButton(t.label, `hb-subtab${t.active ? ' active' : ''}`, () =>
        this.editorTab.emit(t.id),
      )
      b.setAttribute('role', 'tab')
      b.setAttribute('aria-selected', String(t.active))
      b.tabIndex = t.active ? 0 : -1
      b.dataset.editorTab = t.id
      b.dataset.fk = `sub-${t.id}`
      sub.append(b)
    }
    sub.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return
      ev.preventDefault()
      const i = EDITOR_TABS.indexOf(e.tab)
      const n = EDITOR_TABS.length
      this.editorTab.emit(EDITOR_TABS[(i + (ev.key === 'ArrowRight' ? 1 : n - 1)) % n]!)
    })
    const body = el('div', undefined, 'hb-editor-body')
    switch (e.tab) {
      case 'overview':
        body.append(...this.overview(e, vm))
        break
      case 'flow':
        body.append(...this.flow(e, vm))
        break
      case 'rules':
        body.append(...this.rules(e, vm))
        break
      case 'gates':
        body.append(...this.gates(e, vm))
        break
      case 'providers':
        body.append(el('p', e.providersNote, 'muted'))
        if (!vm.coverage.projectName) body.append(el('p', C.editor.providersNeedProject, 'muted'))
        for (const r of e.providers) body.append(this.report(r))
        body.append(el('p', vm.coverage.legend, 'hb-legend muted small'))
        break
      case 'import': {
        body.append(el('h4', C.editor.importHeading))
        if (!e.sources.length) body.append(el('p', e.importEmpty, 'muted'))
        const ul = el('ul', undefined, 'rows')
        for (const s of e.sources) {
          const li = el('li', undefined, 'row')
          li.append(el('span', `${s.repoLabel} · ${s.path}`), chip(String(s.rules), 'count'))
          ul.append(li)
        }
        const drift = textButton(
          C.editor.driftCheck,
          'btn small',
          () => this.importStart.emit(),
          'hb-drift',
        )
        drift.disabled = !vm.head.importStart.enabled
        body.append(
          ul,
          drift,
          textButton(C.editor.importMore, 'btn small', () => this.importStart.emit()),
        )
        break
      }
      case 'history': {
        const H = e.history
        if (!H.items.length) body.append(el('p', H.empty, 'muted'))
        const ul = el('ul', undefined, 'rows hb-versions')
        for (const v of H.items) {
          const li = el('li', undefined, `row hb-version${v.viewing ? ' active' : ''}`)
          li.dataset.version = String(v.version)
          li.append(el('span', v.text))
          if (!v.current) {
            const b = textButton(C.editor.historyView, 'btn small', () =>
              this.version.emit(v.version),
            )
            b.dataset.action = 'view'
            li.append(b)
          }
          ul.append(li)
        }
        body.append(ul)
        break
      }
    }
    out.push(sub, body)
    return out
  }

  /** Emits the draft with one change (unsaved until Save). */
  private mutate(e: HarnessEditorVM, fn: (d: HarnessDraft) => void): void {
    const draft = structuredClone(e.draft) as HarnessDraft
    fn(draft)
    this.draft.emit(draft)
  }

  private overview(e: HarnessEditorVM, vm: HarnessBuilderVM): HTMLElement[] {
    const off = !e.editable || vm.busy
    const d = e.draft
    const E = C.editor
    const grid = el('div', undefined, 'hb-form')
    const name = textInput(
      d.name,
      (v) => v.trim() && this.mutate(e, (x) => (x.name = v.trim())),
      80,
      off,
    )
    name.dataset.fk = 'name'
    const desc = textInput(
      d.description ?? '',
      (v) => this.mutate(e, (x) => (x.description = v.trim())),
      400,
      off,
    )
    desc.dataset.fk = 'desc'
    const scope = select(
      HARNESS_SCOPES.map((s) => [s, C.scope[s]]),
      e.scope,
      (v) => this.mutate(e, (x) => (x.scope = v as 'project')),
      off,
    )
    const iso = select(
      FS_ISOLATION.map((p) => [p, C.fsIsolation[p]]),
      d.fsIsolation ?? 'off',
      (v) => this.mutate(e, (x) => (x.fsIsolation = v as 'off')),
      off,
    )
    const retries = el('input', undefined, 'search-input')
    retries.type = 'number'
    retries.min = '0'
    retries.max = '5'
    retries.value = String(d.retryBudget ?? 2)
    retries.disabled = off
    retries.addEventListener('change', () =>
      this.mutate(
        e,
        (x) => (x.retryBudget = Math.min(5, Math.max(0, Math.round(Number(retries.value) || 0)))),
      ),
    )
    grid.append(
      field(E.name, name, 'hb-f-name'),
      field(E.description, desc, 'hb-f-desc'),
      field(E.fieldScope, scope, 'hb-f-scope', e.scopeHelp),
      radios(
        'hb-f-launch',
        C.overview.launch,
        LAUNCH_POLICIES.map((p) => [p, C.launchPolicy[p]]),
        d.launchPolicy ?? 'advisory',
        (v) => this.mutate(e, (x) => (x.launchPolicy = v as 'strict')),
        off,
      ),
      radios(
        'hb-f-trigger',
        C.overview.trigger,
        GATE_TRIGGERS.map((p) => [p, C.gateTrigger[p]]),
        d.gateTrigger ?? 'manual',
        (v) => this.mutate(e, (x) => (x.gateTrigger = v as 'manual')),
        off,
      ),
      field(C.overview.isolation, iso, 'hb-f-iso', E.isoNote),
      field(C.overview.retries, retries, 'hb-f-retries'),
    )
    if (e.flowMode) grid.append(this.modeRadios(e, off, 'hb-f-mode'))
    const out: HTMLElement[] = [el('p', e.saveHint, 'muted small'), grid]
    const dl = el('dl', undefined, 'hb-facts')
    for (const f of e.overview.slice(5)) dl.append(el('dt', f.label), el('dd', f.value))
    out.push(dl, el('h4', C.overview.conflicts))
    if (!e.conflicts.length) out.push(el('p', e.noConflicts, 'muted'))
    const ul = el('ul', undefined, 'rows hb-conflicts')
    for (const c of e.conflicts) {
      const li = el('li', undefined, 'row tone-warn')
      li.append(badge(c.kindLabel, 'warn'), el('span', ` ${c.text} (${c.ruleNames.join(' / ')})`))
      const first = c.ruleIds[0]
      if (first) li.append(textButton(E.goToRule, 'link', () => this.goToRule.emit(first)))
      ul.append(li)
    }
    out.push(ul)
    return out
  }

  private modeRadios(e: HarnessEditorVM, off: boolean, id: string): HTMLElement {
    return radios(
      id,
      C.editor.flowMode,
      FLOW_MODES.map((m) => [m, C.editor.flowModes[m]]),
      e.draft.flowMode ?? 'sequential',
      (v) => this.mutate(e, (x) => (x.flowMode = v as 'free')),
      off,
    )
  }

  // ── Flow ───────────────────────────────────────────────────────────────────────────────────
  private flow(e: HarnessEditorVM, vm: HarnessBuilderVM): HTMLElement[] {
    const F = e.flow
    const off = !e.editable || vm.busy
    const out: HTMLElement[] = []
    if (F.warning) out.push(el('p', F.warning, 'hb-notice tone-warn'))
    if (F.steps.length) out.push(this.modeRadios(e, off, 'hb-flow-mode'))
    else out.push(el('p', F.empty, 'sec-empty muted'))
    const ol = el('ol', undefined, 'hb-steps')
    ol.id = 'hb-steps'
    for (const s of F.steps) {
      const li = el('li', undefined, 'hb-step')
      li.dataset.stepId = s.key
      li.dataset.index = String(s.index)
      li.draggable = !off
      const top = el('div', undefined, 'hb-step-top')
      const grip = el('span', '⠿', 'hb-grip')
      grip.setAttribute('aria-hidden', 'true')
      top.append(el('span', s.position, 'hb-pos'), grip, el('strong', s.name))
      if (s.roles) top.append(chip(s.roles, 'roles'))
      if (s.optional) top.append(chip(C.flow.optional, 'optional'))
      li.append(top, el('p', s.goal, 'muted'))
      const checks = el('div', undefined, 'hb-step-checks')
      for (const c of s.checks) {
        const x = chip(c.label, 'check')
        x.dataset.kind = c.kind
        checks.append(x)
      }
      li.append(checks)
      const bar = el('div', undefined, 'hb-actions')
      const btns: [string, string, boolean, () => void][] = [
        ['up', C.flow.up, s.up, () => this.stepMove.emit(s.index, s.index - 1)],
        ['down', C.flow.down, s.down, () => this.stepMove.emit(s.index, s.index + 1)],
        ['edit', C.flow.edit, true, () => this.stepEdit.emit(s.index)],
        ['remove', C.flow.remove, true, () => this.stepRemove.emit(s.index)],
      ]
      for (const [id, label, on, run] of btns) {
        const b = textButton(label, `btn small${id === 'remove' ? ' danger' : ''}`, run)
        b.dataset.action = id
        b.dataset.fk = `step-${id}-${s.key}`
        b.disabled = off || !on || !!F.form
        bar.append(b)
      }
      li.append(bar)
      ol.append(li)
    }
    out.push(ol)
    if (F.form) out.push(this.stepFormEl(F.form, off))
    else {
      const add = textButton(
        F.addStep.label,
        'btn small primary',
        () => this.stepEdit.emit(null),
        'hb-add-step',
      )
      add.disabled = !F.addStep.enabled
      out.push(add)
    }
    if (F.preview.length) {
      const det = el('details', undefined, 'hb-flow-preview')
      det.id = 'hb-flow-preview'
      det.append(el('summary', C.flow.preview), el('pre', F.preview.join('\n')))
      out.push(det)
    }
    return out
  }

  private stepFormEl(f: StepFormVM, off: boolean): HTMLElement {
    const F = C.flow
    const form = el('form', undefined, 'hb-add hb-step-form')
    form.id = 'hb-step-form'
    const patch = (p: Parameters<Parameters<HarnessView['onStepForm']>[0]>[0]) =>
      this.stepForm.emit(p)
    const err = (msg?: string) => (msg ? el('p', msg, 'hb-field-error error') : null)
    const name = textInput(f.name, (v) => patch({ name: v }), 80, off)
    name.dataset.fk = 's-name'
    const goal = textArea(f.goal, (v) => patch({ goal: v }), 600, off)
    goal.dataset.fk = 's-goal'
    const instr = textArea(f.instructions, (v) => patch({ instructions: v }), 2000, off)
    instr.dataset.fk = 's-instr'
    const roles = textInput(f.roles, (v) => patch({ roles: v }), 400, off)
    roles.setAttribute('list', 'hb-roles-list')
    roles.dataset.fk = 's-roles'
    const dl = el('datalist')
    dl.id = 'hb-roles-list'
    for (const r of ['main', 'reviewer', 'tester', 'writer', 'researcher']) {
      const o = el('option')
      o.value = r
      dl.append(o)
    }
    const optional = check(f.optional, (v) => patch({ optional: v }), off)
    const optLabel = el('label', undefined, 'row')
    optLabel.append(optional, ` ${F.optionalLabel}`)
    optional.id = 'hb-s-optional'
    form.append(field(F.name, name, 'hb-s-name'))
    const nameErr = err(f.errors.name)
    if (nameErr) form.append(nameErr)
    form.append(field(F.goal, goal, 'hb-s-goal'), el('span', f.goalCount, 'muted small hb-count'))
    const goalErr = err(f.errors.goal)
    if (goalErr) form.append(goalErr)
    form.append(
      field(F.instructions, instr, 'hb-s-instr'),
      el('span', f.instructionsCount, 'muted small hb-count'),
      field(F.roles, roles, 'hb-s-roles'),
      dl,
      optLabel,
    )
    // Exit checks.
    const checks = el('fieldset', undefined, 'hb-s-checks')
    checks.id = 'hb-s-checks'
    checks.append(el('legend', F.checks, 'field-label'))
    const rows: CheckFields[] = f.checks.map(({ kind, prompt, gateId, path, mustExist, note }) => ({
      kind,
      prompt,
      gateId,
      path,
      mustExist,
      note,
    }))
    const setCheck = (i: number, p: Partial<CheckFields>) =>
      patch({ checks: rows.map((r, k) => (k === i ? { ...r, ...p } : r)) })
    const sfx = (base: string, i: number) => (i === 0 ? base : `${base}-${i}`)
    f.checks.forEach((c, i) => {
      const row = el('div', undefined, 'hb-s-check')
      row.dataset.index = String(i)
      const kind = select(
        c.kindOptions.map((o) => [o.value, o.label]),
        c.kind,
        (v) => setCheck(i, { ...emptyCheck(v as StepCheckKind) }),
        off,
      )
      kind.dataset.checkKind = c.kind
      kind.setAttribute('aria-label', F.checks)
      kind.dataset.fk = `s-kind-${i}`
      row.append(kind)
      if (c.kind === 'approval') {
        const p = textInput(c.prompt, (v) => setCheck(i, { prompt: v }), 200, off)
        p.dataset.fk = `s-prompt-${i}`
        row.append(field(F.prompt, p, sfx('hb-s-prompt', i)))
      } else if (c.kind === 'gate') {
        if (!f.gateOptions.length) row.append(el('p', f.noGates, 'muted small'))
        else {
          const g = select(
            [['', '—'], ...f.gateOptions.map((o): [string, string] => [o.id, o.name])],
            c.gateId,
            (v) => setCheck(i, { gateId: v }),
            off,
          )
          row.append(field(F.gate, g, sfx('hb-s-gate', i)))
        }
      } else if (c.kind === 'artifact') {
        const p = textInput(c.path, (v) => setCheck(i, { path: v }), 200, off)
        p.dataset.fk = `s-path-${i}`
        const must = check(c.mustExist, (v) => setCheck(i, { mustExist: v }), off)
        const ml = el('label', undefined, 'row')
        ml.append(must, ` ${F.mustExist}`)
        row.append(field(F.path, p, sfx('hb-s-path', i)), ml)
      } else {
        const n = textInput(c.note, (v) => setCheck(i, { note: v }), 200, off)
        n.dataset.fk = `s-note-${i}`
        row.append(field(F.note, n, sfx('hb-s-note', i)))
      }
      const rm = textButton(F.removeCheck, 'btn small', () =>
        patch({ checks: rows.filter((_, k) => k !== i) }),
      )
      rm.dataset.action = 'remove-check'
      rm.disabled = off
      row.append(rm)
      const e2 = err(c.error)
      if (e2) row.append(e2)
      checks.append(row)
    })
    const addCheck = textButton(
      F.addCheck,
      'btn small',
      () => patch({ checks: [...rows, emptyCheck()] }),
      'hb-s-add-check',
    )
    addCheck.disabled = off || !f.canAddCheck
    checks.append(addCheck)
    const checksErr = err(f.errors.checks)
    if (checksErr) checks.append(checksErr)
    form.append(checks)
    // Step policies.
    const pol = el('fieldset', undefined, 'hb-s-policies')
    pol.id = 'hb-s-policies'
    pol.append(el('legend', F.policies, 'field-label'))
    const prows: PolicyFields[] = f.policies.map((p) => ({ ...p }))
    const setPol = (i: number, p: Partial<PolicyFields>) =>
      patch({ policies: prows.map((r, k) => (k === i ? { ...r, ...p } : r)) })
    prows.forEach((p, i) => {
      const row = el('div', undefined, 'hb-policy-fields')
      row.dataset.index = String(i)
      row.append(
        select(
          [
            ['deny', C.editor.effectDeny],
            ['ask', C.editor.effectAsk],
          ],
          p.effect,
          (v) => setPol(i, { effect: v as 'deny' }),
          off,
        ),
      )
      for (const [k, label] of [
        ['tools', C.editor.tools],
        ['paths', C.editor.paths],
        ['commands', C.editor.commands],
        ['hosts', C.editor.hosts],
      ] as const) {
        const inp = textInput(p[k], (v) => setPol(i, { [k]: v }), 800, off)
        inp.setAttribute('aria-label', label)
        inp.placeholder = label
        row.append(inp)
      }
      const rm = textButton(F.removePolicy, 'btn small', () =>
        patch({ policies: prows.filter((_, k) => k !== i) }),
      )
      rm.disabled = off
      row.append(rm)
      const e3 = err(f.policyErrors[i])
      if (e3) row.append(e3)
      pol.append(row)
    })
    const addPol = textButton(
      F.addPolicy,
      'btn small',
      () => patch({ policies: [...prows, emptyPolicy()] }),
      'hb-s-add-policy',
    )
    addPol.disabled = off
    pol.append(addPol)
    form.append(pol)
    const ok = el('button', f.okLabel, 'btn small primary')
    ok.type = 'submit'
    ok.id = 'hb-s-ok'
    ok.disabled = off
    const cancel = textButton(C.editor.cancel, 'btn small', () => patch(null), 'hb-s-cancel')
    const bar = el('div', undefined, 'form-row end')
    bar.append(cancel, ok)
    form.append(bar)
    form.addEventListener('submit', (ev) => {
      ev.preventDefault()
      // A pending `change` (typing then pressing Enter) is flushed first by the browser.
      this.stepSubmit.emit()
    })
    return form
  }

  // ── Rules ──────────────────────────────────────────────────────────────────────────────────
  private rules(e: HarnessEditorVM, vm: HarnessBuilderVM): HTMLElement[] {
    const off = !e.editable || vm.busy
    const out: HTMLElement[] = []
    if (!e.rules.length) out.push(el('p', C.editor.noRules, 'muted'))
    const all = e.draft.rules ?? []
    for (const g of e.rules) {
      const sec = el('details', undefined, 'hb-rule-group')
      sec.open = true
      sec.dataset.category = g.category
      sec.append(el('summary', `${g.label} (${g.count})`))
      const ul = el('ul', undefined, 'hb-rules')
      g.rules.forEach((r, k) => {
        const li = el('li', undefined, `hb-rule${r.highlighted ? ' highlight' : ''}`)
        li.dataset.ruleId = r.id
        const top = el('div', undefined, 'hb-rule-top')
        top.append(
          el('strong', r.name),
          chip(r.enforcementLabel, 'enforcement'),
          chip(r.severityLabel, 'severity'),
        )
        if (r.coverageLabel) top.append(chip(r.coverageLabel, 'coverage'))
        if (r.sourceLabel) {
          const s = chip(r.sourceLabel, 'source')
          if (r.sourceTitle) s.title = r.sourceTitle
          top.append(s)
        }
        li.append(top, el('p', r.text, 'hb-rule-text'))
        if (r.policySummary) li.append(el('p', r.policySummary, 'hb-policy'))
        const bar = el('div', undefined, 'hb-actions')
        const prev = g.rules[k - 1]
        const next = g.rules[k + 1]
        const swap = (other: number) =>
          this.mutate(e, (d) => {
            const rs = d.rules ?? []
            const a = rs[r.index]!
            rs[r.index] = rs[other]!
            rs[other] = a
          })
        const btns: [string, string, boolean, () => void][] = [
          ['edit', C.editor.editRule, true, () => this.ruleEdit.emit(r.id)],
          ['remove', C.editor.removeRule, true, () => this.ruleRemove.emit(r.index)],
          ['up', C.flow.up, !!prev, () => prev && swap(prev.index)],
          ['down', C.flow.down, !!next, () => next && swap(next.index)],
        ]
        for (const [id, label, on, run] of btns) {
          const b = textButton(label, `btn small${id === 'remove' ? ' danger' : ''}`, run)
          b.dataset.action = id
          b.dataset.fk = `rule-${id}-${r.id}`
          b.disabled = off || !on
          bar.append(b)
        }
        li.append(bar)
        ul.append(li)
      })
      sec.append(ul)
      out.push(sec)
    }
    const editing = e.ruleEdit ? all[e.ruleEdit.index] : undefined
    out.push(this.ruleForm(e, off, editing, e.ruleEdit?.index ?? null))
    return out
  }

  private ruleForm(
    e: HarnessEditorVM,
    off: boolean,
    keep: RuleDraft | undefined,
    index: number | null,
  ): HTMLElement {
    const E = C.editor
    const f = ruleFieldsFrom(keep)
    const form = el('form', undefined, 'hb-add')
    form.id = 'hb-add-rule'
    const name = textInput(f.name, () => {}, 120, off)
    const text = textArea(f.text, () => {}, 2000, off)
    const cat = select(
      RULE_CATEGORIES.map((c) => [c, C.category[c]]),
      f.category,
      () => {},
      off,
    )
    let enforcement: Enforcement = f.enforcement
    const sev = select(
      SEVERITY.map((x) => [x, C.severity[x]]),
      f.severity,
      () => {},
      off,
    )
    const policy = el('div', undefined, 'hb-policy-fields')
    const eff = select(
      [
        ['deny', E.effectDeny],
        ['ask', E.effectAsk],
      ],
      f.effect,
      () => {},
      off,
    )
    const tools = textInput(f.tools, () => {}, 400, off)
    const paths = textInput(f.paths, () => {}, 800, off)
    const cmds = textInput(f.commands, () => {}, 400, off)
    const hosts = textInput(f.hosts, () => {}, 400, off)
    const roles = textInput(f.roles, () => {}, 400, off)
    policy.append(
      field(E.effect, eff, 'hb-r-effect'),
      field(E.tools, tools, 'hb-r-tools'),
      field(E.paths, paths, 'hb-r-paths'),
      field(E.commands, cmds, 'hb-r-cmds'),
      field(E.hosts, hosts, 'hb-r-hosts'),
      field(E.ruleRoles, roles, 'hb-r-roles'),
    )
    const gateHint = el('p', E.gateHint, 'muted small hb-r-gate-hint')
    const reveal = () => {
      policy.hidden = enforcement !== 'runtime-policy'
      gateHint.hidden = enforcement !== 'validation-gate'
    }
    const enf = radios(
      'hb-r-enf',
      E.ruleEnforcement,
      ENFORCEMENT.map((x) => [x, C.enforcement[x]]),
      enforcement,
      (v) => {
        enforcement = v as Enforcement
        reveal()
      },
      off,
    )
    reveal()
    const applies = el('select', undefined, 'select')
    applies.multiple = true
    for (const p of PROVIDER_IDS) {
      const o = el('option', p)
      o.value = p
      o.selected = f.runtimes.includes(p)
      applies.append(o)
    }
    applies.disabled = off
    const err = el('p', undefined, 'hb-field-error error')
    const add = el('button', keep ? E.updateRule : E.addRule, 'btn small primary')
    add.type = 'submit'
    add.disabled = off
    form.append(
      field(E.ruleName, name, 'hb-r-name'),
      field(E.ruleText, text, 'hb-r-text'),
      field(E.ruleCategory, cat, 'hb-r-cat'),
      enf,
      policy,
      gateHint,
      field(E.ruleSeverity, sev, 'hb-r-sev'),
      field(E.ruleApplies, applies, 'hb-r-applies'),
      err,
    )
    const bar = el('div', undefined, 'form-row end')
    if (keep) bar.append(textButton(E.cancel, 'btn small', () => this.ruleEdit.emit(null)))
    bar.append(add)
    form.append(bar)
    name.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        text.focus()
      }
    })
    form.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault()
        form.requestSubmit()
      }
    })
    form.addEventListener('submit', (ev) => {
      ev.preventDefault()
      const r = ruleFromFields(
        {
          name: name.value,
          text: text.value,
          category: cat.value as RuleCategory,
          enforcement,
          severity: sev.value as 'required',
          effect: eff.value as 'deny',
          tools: tools.value,
          paths: paths.value,
          commands: cmds.value,
          hosts: hosts.value,
          roles: roles.value,
          runtimes: [...applies.selectedOptions].map((o) => o.value),
        },
        keep,
      )
      if (!r.ok) {
        err.textContent = r.error
        return
      }
      this.mutate(e, (d) => {
        const rs = d.rules ?? []
        if (index !== null && keep) rs[index] = r.rule
        else rs.push(r.rule)
        d.rules = rs
      })
      if (keep) this.ruleEdit.emit(null)
    })
    return form
  }

  // ── Gates ──────────────────────────────────────────────────────────────────────────────────
  private gates(e: HarnessEditorVM, vm: HarnessBuilderVM): HTMLElement[] {
    const off = !e.editable || vm.busy
    const E = C.editor
    const out: HTMLElement[] = []
    if (!e.gates.length) out.push(el('p', E.noGates, 'muted'))
    const ul = el('ul', undefined, 'hb-gates')
    e.gates.forEach((g, i) => {
      const li = el('li', undefined, 'hb-gate')
      li.dataset.gateId = g.id
      li.append(el('strong', g.name), badge(g.requiredLabel, g.required ? 'good' : 'neutral'))
      li.append(el('code', g.command, 'hb-gate-cmd'), el('span', g.details, 'muted small'))
      const edit = textButton(C.editor.editRule, 'btn small', () => {
        this.gateEdit = i
        this.lastStructure = ''
        if (this.vm) this.render(this.vm)
      })
      edit.dataset.action = 'edit'
      edit.disabled = off
      const rm = textButton(E.removeGate, 'btn small danger', () =>
        this.mutate(e, (d) => (d.gates = (d.gates ?? []).filter((_, k) => k !== i))),
      )
      rm.dataset.action = 'remove'
      rm.disabled = off
      li.append(edit, rm)
      ul.append(li)
    })
    out.push(ul)
    const keep = this.gateEdit !== null ? e.draft.gates?.[this.gateEdit] : undefined
    if (!keep) this.gateEdit = null
    const form = el('form', undefined, 'hb-add')
    form.id = 'hb-add-gate'
    const name = textInput(keep?.name ?? '', () => {}, 80, off)
    const cmd = textInput(keep?.argv.join(' ') ?? '', () => {}, 400, off)
    const req = check(keep?.required ?? true, () => {}, off)
    req.id = 'hb-g-required'
    const timeout = select(
      [1, 5, 10, 30].map((m): [string, string] => [String(m), `${m} min`]),
      String(Math.round((keep?.timeoutMs ?? 600_000) / 60_000)),
      () => {},
      off,
    )
    const subdir = textInput(keep?.subdir ?? '', () => {}, 200, off)
    const pins = textInput((keep?.pinFiles ?? []).join(', '), () => {}, 800, off)
    const plats = el('fieldset', undefined, 'hb-radios')
    plats.id = 'hb-g-platforms'
    plats.append(el('legend', E.gatePlatforms, 'field-label'))
    const boxes: [string, HTMLInputElement][] = []
    for (const p of ['darwin', 'linux', 'win32'] as const) {
      const box = check(keep?.platforms?.includes(p) ?? false, () => {}, off)
      box.value = p
      const l = el('label', undefined, 'row')
      l.append(box, ` ${p}`)
      plats.append(l)
      boxes.push([p, box])
    }
    const err = el('p', undefined, 'hb-field-error error')
    const add = el('button', keep ? E.save : E.addGate, 'btn small primary')
    add.type = 'submit'
    add.disabled = off
    const reqLabel = el('label', undefined, 'row')
    reqLabel.append(req, ` ${E.gateRequired}`)
    form.append(
      field(E.gateName, name, 'hb-g-name'),
      field(E.gateCommand, cmd, 'hb-g-cmd', E.gateCmdHelp),
      reqLabel,
      field(E.gateTimeout, timeout, 'hb-g-timeout'),
      field(E.gateSubdir, subdir, 'hb-g-subdir'),
      field(E.gatePins, pins, 'hb-g-pins'),
      plats,
      err,
      add,
    )
    form.addEventListener('submit', (ev) => {
      ev.preventDefault()
      const fields: GateFields = {
        name: name.value,
        command: cmd.value,
        required: req.checked,
        timeoutMin: Number(timeout.value),
        subdir: subdir.value,
        pins: pins.value,
        platforms: boxes.filter(([, b]) => b.checked).map(([p]) => p as 'linux'),
      }
      const r = gateFromFields(fields)
      if (!r.ok) {
        err.textContent = r.error
        return
      }
      const at = this.gateEdit
      this.gateEdit = null
      this.mutate(e, (d) => {
        const gs = d.gates ?? []
        if (at !== null && gs[at]) gs[at] = { ...r.gate, ...(gs[at]!.id && { id: gs[at]!.id }) }
        else gs.push(r.gate)
        d.gates = gs
      })
    })
    out.push(form)
    return out
  }

  // ── Import ─────────────────────────────────────────────────────────────────────────────────
  private importPane(vm: HarnessBuilderVM): HTMLElement[] {
    const I = vm.import
    const out: HTMLElement[] = [el('h3', I.heading), el('p', I.intro, 'muted')]
    if (!I.projectName) return [...out, el('p', I.needProject, 'sec-empty muted')]
    out.push(el('p', I.projectName, 'hb-project'))
    const detect = textButton(I.detect.label, 'btn small', () => this.detect.emit(), 'hb-detect')
    detect.disabled = !I.detect.enabled
    out.push(detect)
    if (I.sources) {
      if (!I.sources.length) out.push(el('p', I.noSources, 'muted'))
      const ul = el('ul', undefined, 'rows hb-sources')
      for (const s of I.sources) {
        const li = el('li', undefined, 'row hb-source')
        li.dataset.path = s.path
        const box = check(s.included, (v) => this.toggleSource.emit(s.path, v))
        box.setAttribute('aria-label', C.import.include(s.path))
        box.dataset.fk = `src-${s.path}`
        li.append(
          box,
          chip(s.formatLabel, 'format'),
          el('span', ` ${s.repoLabel} · ${s.path}`),
          chip(s.count, 'count'),
        )
        ul.append(li)
      }
      out.push(ul)
      const pv = textButton(
        I.previewButton.label,
        'btn small primary',
        () => this.preview.emit(),
        'hb-preview',
      )
      pv.disabled = !I.previewButton.enabled
      out.push(pv)
    }
    const p = I.preview
    if (!p) return out
    out.push(el('p', p.totals, 'hb-totals'))
    for (const c of p.conflicts) out.push(el('p', `⚠ ${c.text}`, 'hb-conflict tone-warn'))
    if (p.filters.length) {
      const bar = el('div', undefined, 'hb-filters')
      bar.setAttribute('role', 'group')
      for (const f of p.filters) {
        const b = textButton(
          `${f.label} · ${f.count}`,
          `chip-btn${f.active ? ' active' : ''}`,
          () => this.importFilter.emit(f.category),
        )
        b.classList.add('hb-filter')
        b.dataset.category = f.category ?? 'all'
        b.setAttribute('aria-pressed', String(f.active))
        bar.append(b)
      }
      out.push(bar)
    }
    for (const g of p.groups) {
      const sec = el('details', undefined, 'hb-cand-group')
      sec.open = true
      sec.dataset.source = g.label
      const sum = el('summary', g.label)
      sec.append(sum)
      const bulk = el('div', undefined, 'hb-actions')
      bulk.append(
        textButton(C.import.selectAll, 'btn small', () => this.selectGroup.emit(g.label, true)),
        textButton(C.import.selectNone, 'btn small', () => this.selectGroup.emit(g.label, false)),
      )
      sec.append(bulk)
      const ul = el('ul', undefined, 'hb-cands')
      for (const c of g.candidates) {
        const li = el('li', undefined, 'hb-cand')
        li.dataset.tempId = c.tempId
        const box = check(c.checked, (v) => this.toggleCand.emit(c.tempId, v))
        box.dataset.fk = `cc-${c.tempId}`
        box.setAttribute('aria-label', c.name)
        const name = textInput(
          c.name,
          (v) => v.trim() && this.editCand.emit(c.tempId, { name: v.trim() }),
          120,
        )
        name.dataset.fk = `cn-${c.tempId}`
        const cat = select(
          RULE_CATEGORIES.map((x) => [x, C.category[x]]),
          c.category,
          (v) => this.editCand.emit(c.tempId, { category: v as RuleCategory }),
        )
        const sev = select(
          SEVERITY.map((x) => [x, C.severity[x]]),
          c.severity,
          (v) => this.editCand.emit(c.tempId, { severity: v as 'required' }),
        )
        const enf = select(
          ENFORCEMENT.map((x) => [x, C.enforcement[x]]),
          c.enforcement,
          (v) => this.editCand.emit(c.tempId, { enforcement: v as Enforcement }),
        )
        enf.setAttribute('aria-label', C.import.enforcementLabel)
        const top = el('div', undefined, 'hb-cand-top')
        top.append(box, name, cat, sev, enf)
        for (const m of c.marks) {
          const b = badge(m.label, 'warn')
          b.dataset.mark = m.kind
          top.append(b)
          if (m.compare) {
            const other = m.compare
            const cmp = textButton(C.import.compare, 'link', () => {
              const root = this.panels.get('import')!
              for (const id of [c.tempId, other]) {
                const n = root.querySelector<HTMLElement>(
                  `.hb-cand[data-temp-id="${CSS.escape(id)}"]`,
                )
                n?.classList.add('highlight')
              }
              root
                .querySelector<HTMLElement>(`.hb-cand[data-temp-id="${CSS.escape(other)}"]`)
                ?.scrollIntoView?.({ block: 'nearest' })
            })
            cmp.dataset.action = 'compare'
            top.append(cmp)
          }
        }
        li.append(top)
        const text = el('textarea')
        text.value = c.text
        text.rows = 2
        text.maxLength = 2000
        text.addEventListener(
          'change',
          () => text.value.trim() && this.editCand.emit(c.tempId, { text: text.value.trim() }),
        )
        li.append(text)
        ul.append(li)
      }
      sec.append(ul)
      out.push(sec)
    }
    if (p.steps.length) {
      out.push(el('h4', p.stepsHeading), el('p', p.stepsNote, 'muted small'))
      const ol = el('ol', undefined, 'hb-step-cands')
      p.steps.forEach((s, i) => {
        const li = el('li', undefined, 'hb-step-cand')
        li.dataset.tempId = s.tempId
        li.dataset.index = String(i)
        li.draggable = true
        const box = check(s.checked, (v) => this.toggleStep.emit(s.tempId, v))
        box.setAttribute('aria-label', s.name)
        box.dataset.fk = `cs-${s.tempId}`
        const kind = select(
          p.checkOptions.map((o) => [o.value, o.label]),
          s.check,
          (v) => this.stepCheck.emit(s.tempId, v as StepCheckKind),
        )
        kind.setAttribute('aria-label', C.import.stepCheck)
        const grip = el('span', '⠿', 'hb-grip')
        grip.setAttribute('aria-hidden', 'true')
        const up = textButton(C.flow.up, 'icon-btn', () =>
          this.moveImportStep.emit(s.tempId, i - 1),
        )
        up.dataset.action = 'up'
        up.disabled = !s.up
        const down = textButton(C.flow.down, 'icon-btn', () =>
          this.moveImportStep.emit(s.tempId, i + 1),
        )
        down.dataset.action = 'down'
        down.disabled = !s.down
        li.append(
          box,
          el('span', s.position, 'hb-pos'),
          grip,
          el('strong', ` ${s.name}`),
          el('span', ` ${s.sourceLabel}`, 'muted small'),
          kind,
          up,
          down,
        )
        ol.append(li)
      })
      out.push(ol)
    }
    if (p.gates.length) {
      out.push(el('h4', p.gatesHeading), el('p', p.gatesNote, 'muted small'))
      const ul = el('ul', undefined, 'hb-gate-cands')
      for (const g of p.gates) {
        const li = el('li', undefined, 'hb-gate-cand')
        li.dataset.tempId = g.tempId
        const box = check(g.checked, (v) => this.toggleGate.emit(g.tempId, v), !g.selectable)
        box.dataset.fk = `cg-${g.tempId}`
        box.setAttribute('aria-label', g.name)
        li.append(
          box,
          el('strong', ` ${g.name} `),
          el('code', g.command),
          el('span', ` ${g.sourceLabel}`, 'muted small'),
        )
        if (g.rejected) li.append(el('p', g.rejected, 'hb-rejected tone-bad'))
        ul.append(li)
      }
      out.push(ul)
    }
    const name = textInput(I.name, (v) => this.importName.emit(v), 80)
    name.dataset.fk = 'import-name'
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.preventDefault()
    })
    const attach = el('label', undefined, 'row')
    const attachBox = check(I.attach, (v) => this.importAttach.emit(v))
    attachBox.id = 'hb-import-attach'
    attach.append(attachBox, ` ${I.attachLabel}`)
    const create = textButton(I.create.label, 'btn primary', () => this.commit.emit(), 'hb-commit')
    create.disabled = !I.create.enabled
    if (I.create.hint) create.title = I.create.hint
    out.push(field(I.nameLabel, name, 'hb-import-name'), attach, create)
    if (I.create.hint) out.push(el('p', I.create.hint, 'hb-field-error muted small'))
    return out
  }

  // ── Coverage ───────────────────────────────────────────────────────────────────────────────
  private coveragePane(vm: HarnessBuilderVM): HTMLElement[] {
    const c = vm.coverage
    const out: HTMLElement[] = [el('h3', c.heading)]
    if (!c.projectName) return [...out, el('p', c.needProject, 'sec-empty muted')]
    out.push(el('p', c.projectName, 'hb-project'))
    if (!c.reports.length) out.push(el('p', c.empty, 'muted'))
    for (const r of c.reports) {
      const sec = this.report(r)
      const start = textButton(r.start.label, 'btn small', () => this.startSession.emit(r.provider))
      start.dataset.action = 'start'
      start.disabled = !r.start.enabled
      if (r.start.hint) start.title = r.start.hint
      sec.append(start)
      out.push(sec)
    }
    for (const d of c.disabled) {
      const sec = el('section', undefined, 'hb-report disabled')
      sec.dataset.provider = d.provider
      sec.append(el('h4', d.label), el('p', d.note, 'muted small'))
      out.push(sec)
    }
    out.push(el('p', c.legend, 'hb-legend muted small'))
    return out
  }

  private report(r: EnforcementReportVM): HTMLElement {
    const sec = el('section', undefined, 'hb-report')
    sec.dataset.provider = r.provider
    sec.append(el('h4', r.provider))
    const ul = el('ul', undefined, 'hb-coverage')
    for (const row of r.rows) {
      const li = el('li', undefined, `hb-cov tone-${row.tone}`)
      li.dataset.capability = row.capability
      li.dataset.level = row.level
      li.append(dot(row.tone), el('span', row.label, 'hb-cov-label'), badge(row.word, row.tone))
      if (row.reason) li.append(el('span', row.reason, 'muted small'))
      ul.append(li)
    }
    sec.append(ul, el('p', r.launchText, r.launch.ok ? 'muted' : 'hb-blocked tone-bad'))
    for (const why of r.launch.reasons) sec.append(el('p', why, 'small tone-bad'))
    return sec
  }
}

/** @deprecated the dialog became the pane; kept for imports that still use the old name. */
export const DomHarnessBuilder = DomHarnessPane
// Keep the list of editor tabs reachable for tests and the Playwright agent.
export const HARNESS_EDITOR_TABS = EDITOR_TABS
// Values the selects offer (reachable for the Playwright agent).
export const HARNESS_STEP_KINDS = STEP_CHECK_KINDS
