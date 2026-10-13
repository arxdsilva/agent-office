// HarnessView port → `<dialog id="harness">` (docs/harness.md): Library, Editor, Import, Coverage.
// Text only via textContent. The editor saves every change through `update` (the pure draft comes
// from the view model), so what is drawn is always what the vault holds.
import {
  ENFORCEMENT,
  FS_ISOLATION,
  GATE_TRIGGERS,
  LAUNCH_POLICIES,
  RULE_CATEGORIES,
  SEVERITY,
  type HarnessDraft,
  type RuleCategory,
} from '@agent-office/shared'
import type { HarnessBuilderVM } from '../../app/workspace/harness-builder-vm.ts'
import { HARNESS_COPY } from '../../app/workspace/harness-copy.ts'
import {
  EDITOR_TABS,
  policyFromFields,
  type EditorTab,
  type EnforcementReportVM,
  type HarnessEditorVM,
} from '../../app/workspace/harness-vm.ts'
import type { HarnessDialogTab } from '../../app/workspace/state.ts'
import type { HarnessView } from '../../workspace-ports.ts'
import { el } from './el.ts'
import { Signal, badge, chip, dot, need, textButton } from './ws-kit.ts'

const C = HARNESS_COPY
const TABS: HarnessDialogTab[] = ['library', 'editor', 'import', 'coverage']

function field(label: string, input: HTMLElement, id: string): HTMLElement {
  const wrap = el('div', undefined, 'hb-field')
  const l = el('label', label, 'field-label')
  l.htmlFor = id
  input.id = id
  wrap.append(l, input)
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
function check(checked: boolean, on: (v: boolean) => void, disabled = false) {
  const i = el('input')
  i.type = 'checkbox'
  i.checked = checked
  i.disabled = disabled
  i.addEventListener('change', () => on(i.checked))
  return i
}

export class DomHarnessBuilder implements HarnessView {
  private close = new Signal()
  private tab = new Signal<[HarnessDialogTab]>()
  private editorTab = new Signal<[EditorTab]>()
  private create = new Signal()
  private template = new Signal<[string]>()
  private card = new Signal<[string, 'edit' | 'publish' | 'archive' | 'attach' | 'detach']>()
  private confirm = new Signal()
  private confirmCancel = new Signal()
  private save = new Signal<[string, HarnessDraft]>()
  private importStart = new Signal()
  private detect = new Signal()
  private preview = new Signal()
  private toggleCand = new Signal<[string, boolean]>()
  private toggleGate = new Signal<[string, boolean]>()
  private editCand = new Signal<
    [
      string,
      {
        name?: string
        text?: string
        category?: RuleCategory
        severity?: 'required' | 'recommended'
      },
    ]
  >()
  private importName = new Signal<[string]>()
  private importAttach = new Signal<[boolean]>()
  private commit = new Signal()

  private dialog: HTMLDialogElement
  private confirmDialog: HTMLDialogElement
  private tabButtons = new Map<HarnessDialogTab, HTMLButtonElement>()
  private panels = new Map<HarnessDialogTab, HTMLElement>()
  private lastKey = ''

  constructor(private doc: Document) {
    this.dialog = need<HTMLDialogElement>(doc, 'harness')
    this.confirmDialog = need<HTMLDialogElement>(doc, 'hb-confirm')
    need(doc, 'hb-close').addEventListener('click', () => this.close.emit())
    // Typing here must not trigger scene shortcuts; Escape and Ctrl/Cmd+K stay with the workspace.
    this.dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) return
      e.stopPropagation()
    })
    this.dialog.addEventListener('cancel', (e) => {
      e.preventDefault()
      this.close.emit()
    })
    this.dialog.addEventListener('close', () => {
      if (this.lastKey) this.close.emit()
    })
    this.confirmDialog.addEventListener('cancel', (e) => {
      e.preventDefault()
      this.confirmCancel.emit()
    })
    need(doc, 'hb-confirm-ok').addEventListener('click', () => this.confirm.emit())
    need(doc, 'hb-confirm-cancel').addEventListener('click', () => this.confirmCancel.emit())

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
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const cur = TABS.findIndex(
        (t) => this.tabButtons.get(t)?.getAttribute('aria-selected') === 'true',
      )
      const next = TABS[(cur + (e.key === 'ArrowDown' ? 1 : TABS.length - 1)) % TABS.length]!
      this.tab.emit(next)
      this.tabButtons.get(next)?.focus()
    })
    need(doc, 'hb-panels').replaceChildren(...this.panels.values())
  }

  onClose(fn: () => void) {
    this.close.on(fn)
  }
  onTab(fn: (tab: HarnessDialogTab) => void) {
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
  onCard(fn: (id: string, a: 'edit' | 'publish' | 'archive' | 'attach' | 'detach') => void) {
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
  onImportStart(fn: () => void) {
    this.importStart.on(fn)
  }
  onDetect(fn: () => void) {
    this.detect.on(fn)
  }
  onPreview(fn: () => void) {
    this.preview.on(fn)
  }
  onToggleCandidate(fn: (tempId: string, on: boolean) => void) {
    this.toggleCand.on(fn)
  }
  onToggleGate(fn: (tempId: string, on: boolean) => void) {
    this.toggleGate.on(fn)
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
    if (!vm.open) {
      this.lastKey = ''
      if (this.confirmDialog.open) this.confirmDialog.close()
      if (this.dialog.open) this.dialog.close()
      return
    }
    const key = JSON.stringify(vm)
    if (key === this.lastKey) return
    this.lastKey = key
    const focusKey = (this.doc.activeElement as HTMLElement | null)?.dataset?.fk
    need(this.doc, 'hb-title').textContent = vm.title
    need(this.doc, 'hb-sub').textContent = vm.sub
    need(this.doc, 'hb-close').setAttribute('aria-label', vm.closeLabel)
    need(this.doc, 'hb-error').textContent = vm.error ?? ''
    for (const t of vm.tabs) {
      const b = this.tabButtons.get(t.id)!
      b.replaceChildren(el('span', t.label, 'tab-label'))
      b.setAttribute('aria-selected', String(t.active))
      b.tabIndex = t.active ? 0 : -1
      this.panels.get(t.id)!.hidden = !t.active
    }
    const active = this.panels.get(vm.tab)!
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
    // The confirm.
    need(this.doc, 'hb-confirm-text').textContent = vm.confirm.text
    need(this.doc, 'hb-confirm-ok').textContent = vm.confirm.okLabel
    need(this.doc, 'hb-confirm-cancel').textContent = vm.confirm.cancelLabel
    if (!this.dialog.open) this.dialog.showModal()
    if (vm.confirm.open && !this.confirmDialog.open) this.confirmDialog.showModal()
    if (!vm.confirm.open && this.confirmDialog.open) this.confirmDialog.close()
    if (focusKey) active.querySelector<HTMLElement>(`[data-fk="${CSS.escape(focusKey)}"]`)?.focus()
  }

  // ── Library ────────────────────────────────────────────────────────────────────────────────
  private library(vm: HarnessBuilderVM): HTMLElement[] {
    const L = vm.library
    const head = el('div', undefined, 'hb-head')
    head.append(el('h3', L.heading))
    const bar = el('div', undefined, 'hb-actions')
    const create = textButton(
      L.create.label,
      'btn small primary',
      () => this.create.emit(),
      'hb-create',
    )
    create.disabled = vm.busy
    const imp = textButton(
      L.importRules.label,
      'btn small',
      () => this.importStart.emit(),
      'hb-import-start',
    )
    imp.disabled = !L.importRules.enabled
    if (L.importRules.hint) imp.title = L.importRules.hint
    bar.append(create, imp)
    head.append(bar)
    const out: HTMLElement[] = [head]
    if (!L.items.length) out.push(el('p', L.empty, 'sec-empty muted'))
    const list = el('ul', undefined, 'hb-cards')
    for (const c of L.items) {
      const li = el('li', undefined, 'hb-card card')
      li.dataset.harnessId = c.id
      li.dataset.status = c.status
      const top = el('div', undefined, 'hb-card-top')
      top.append(
        dot(c.tone),
        el('strong', c.name, 'hb-name'),
        chip(c.versionLabel, 'version'),
        badge(c.statusLabel, c.tone),
      )
      li.append(top)
      if (c.description) li.append(el('p', c.description, 'muted'))
      const meta = el('p', c.counts, 'hb-counts muted')
      li.append(meta)
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
      const actions = el('div', undefined, 'hb-actions')
      for (const a of c.actions) {
        const b = textButton(a.label, `btn small${a.id === 'archive' ? ' danger' : ''}`, () =>
          this.card.emit(c.id, a.id as 'edit'),
        )
        b.dataset.action = a.id
        b.disabled = !a.enabled || vm.busy
        if (a.hint) b.title = a.hint
        actions.append(b)
      }
      li.append(actions)
      list.append(li)
    }
    out.push(list)
    if (vm.templates.length) {
      out.push(el('h4', 'Templates'))
      const tl = el('ul', undefined, 'hb-templates')
      for (const t of vm.templates) {
        const li = el('li', undefined, 'hb-template')
        li.dataset.templateId = t.id
        const b = textButton(t.name, 'btn small', () => this.template.emit(t.id))
        b.disabled = vm.busy
        li.append(b, el('span', ` ${t.description} · ${t.counts}`, 'muted'))
        tl.append(li)
      }
      out.push(tl)
    }
    return out
  }

  // ── Editor ─────────────────────────────────────────────────────────────────────────────────
  private editor(vm: HarnessBuilderVM): HTMLElement[] {
    const e = vm.editor
    if (!e) return [el('p', vm.editorEmpty, 'sec-empty muted')]
    const head = el('div', undefined, 'hb-head')
    head.append(
      el('h3', e.title),
      chip(e.versionLabel, 'version'),
      badge(e.statusLabel, e.status === 'published' ? 'good' : 'warn'),
    )
    const sub = el('div', undefined, 'hb-subtabs')
    sub.setAttribute('role', 'tablist')
    for (const t of e.tabs) {
      const b = textButton(t.label, `hb-subtab${t.active ? ' active' : ''}`, () =>
        this.editorTab.emit(t.id),
      )
      b.setAttribute('role', 'tab')
      b.setAttribute('aria-selected', String(t.active))
      b.dataset.editorTab = t.id
      sub.append(b)
    }
    const body = el('div', undefined, 'hb-editor-body')
    switch (e.tab) {
      case 'overview':
        body.append(...this.overview(e, vm))
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
        body.append(
          ul,
          textButton(C.editor.importMore, 'btn small', () => this.importStart.emit()),
        )
        break
      }
      case 'history':
        body.append(el('p', e.history, 'muted hb-history'))
        break
    }
    return [head, sub, body]
  }

  private mutate(e: HarnessEditorVM, fn: (d: HarnessDraft) => void): void {
    const draft = structuredClone(e.draft) as HarnessDraft
    fn(draft)
    this.save.emit(e.id, draft)
  }

  private overview(e: HarnessEditorVM, vm: HarnessBuilderVM): HTMLElement[] {
    const off = !e.editable || vm.busy
    const d = e.draft
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
    const policy = select(
      LAUNCH_POLICIES.map((p) => [p, C.launchPolicy[p]]),
      d.launchPolicy ?? 'advisory',
      (v) => this.mutate(e, (x) => (x.launchPolicy = v as 'strict')),
      off,
    )
    const trigger = select(
      GATE_TRIGGERS.map((p) => [p, C.gateTrigger[p]]),
      d.gateTrigger ?? 'manual',
      (v) => this.mutate(e, (x) => (x.gateTrigger = v as 'manual')),
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
      field(C.editor.name, name, 'hb-f-name'),
      field(C.editor.description, desc, 'hb-f-desc'),
      field(C.overview.launch, policy, 'hb-f-launch'),
      field(C.overview.trigger, trigger, 'hb-f-trigger'),
      field(C.overview.isolation, iso, 'hb-f-iso'),
      field(C.overview.retries, retries, 'hb-f-retries'),
    )
    const out: HTMLElement[] = [el('p', e.saveHint, 'muted small'), grid]
    const dl = el('dl', undefined, 'hb-facts')
    for (const f of e.overview.slice(0, 1).concat(e.overview.slice(5)))
      dl.append(el('dt', f.label), el('dd', f.value))
    out.push(dl, el('h4', C.overview.conflicts))
    if (!e.conflicts.length) out.push(el('p', e.noConflicts, 'muted'))
    const ul = el('ul', undefined, 'rows hb-conflicts')
    for (const c of e.conflicts) {
      const li = el('li', undefined, 'row tone-warn')
      li.append(badge(c.kindLabel, 'warn'), el('span', ` ${c.text} (${c.ruleNames.join(' / ')})`))
      ul.append(li)
    }
    out.push(ul)
    return out
  }

  private rules(e: HarnessEditorVM, vm: HarnessBuilderVM): HTMLElement[] {
    const off = !e.editable || vm.busy
    const out: HTMLElement[] = []
    if (!e.rules.length) out.push(el('p', C.editor.noRules, 'muted'))
    for (const g of e.rules) {
      const sec = el('section', undefined, 'hb-rule-group')
      sec.dataset.category = g.category
      sec.append(el('h4', g.label))
      const ul = el('ul', undefined, 'hb-rules')
      for (const r of g.rules) {
        const li = el('li', undefined, 'hb-rule')
        li.dataset.ruleId = r.id
        const top = el('div', undefined, 'hb-rule-top')
        const name = textInput(
          r.name,
          (v) => v.trim() && this.mutate(e, (d) => this.rule(d, r.id, (x) => (x.name = v.trim()))),
          120,
          off,
        )
        name.dataset.fk = `rn-${r.id}`
        top.append(name, chip(r.enforcementLabel, 'enforcement'))
        top.append(
          select(
            SEVERITY.map((s) => [s, C.severity[s]]),
            r.severity,
            (v) => this.mutate(e, (d) => this.rule(d, r.id, (x) => (x.severity = v as 'required'))),
            off,
          ),
        )
        const rm = textButton(C.editor.removeRule, 'btn small danger', () =>
          this.mutate(e, (d) => (d.rules = (d.rules ?? []).filter((x) => x.id !== r.id))),
        )
        rm.disabled = off
        top.append(rm)
        li.append(top)
        const text = el('textarea')
        text.value = r.text
        text.rows = 2
        text.maxLength = 2000
        text.disabled = off
        text.dataset.fk = `rt-${r.id}`
        text.addEventListener(
          'change',
          () =>
            text.value.trim() &&
            this.mutate(e, (d) => this.rule(d, r.id, (x) => (x.text = text.value.trim()))),
        )
        li.append(text)
        if (r.policySummary) li.append(el('p', r.policySummary, 'hb-policy'))
        if (r.sourceLabel) li.append(el('p', r.sourceLabel, 'muted small'))
        ul.append(li)
      }
      sec.append(ul)
      out.push(sec)
    }
    out.push(this.addRuleForm(e, off))
    return out
  }

  private rule(
    d: HarnessDraft,
    id: string,
    fn: (r: NonNullable<HarnessDraft['rules']>[number]) => void,
  ) {
    const r = (d.rules ?? []).find((x) => x.id === id)
    if (r) fn(r)
  }

  private addRuleForm(e: HarnessEditorVM, off: boolean): HTMLElement {
    const form = el('form', undefined, 'hb-add')
    form.id = 'hb-add-rule'
    const name = textInput('', () => {}, 120, off)
    const text = el('textarea')
    text.rows = 2
    text.maxLength = 2000
    text.disabled = off
    const cat = select(
      RULE_CATEGORIES.map((c) => [c, C.category[c]]),
      'coding',
      () => {},
      off,
    )
    const enf = select(
      ENFORCEMENT.map((x) => [x, C.enforcement[x]]),
      'instruction',
      () => {},
      off,
    )
    const sev = select(
      SEVERITY.map((x) => [x, C.severity[x]]),
      'required',
      () => {},
      off,
    )
    const policy = el('div', undefined, 'hb-policy-fields')
    const eff = select(
      [
        ['deny', C.editor.effectDeny],
        ['ask', C.editor.effectAsk],
      ],
      'deny',
      () => {},
      off,
    )
    const tools = textInput('', () => {}, 400, off)
    const paths = textInput('', () => {}, 800, off)
    const cmds = textInput('', () => {}, 400, off)
    const hosts = textInput('', () => {}, 400, off)
    policy.append(
      field(C.editor.effect, eff, 'hb-r-effect'),
      field(C.editor.tools, tools, 'hb-r-tools'),
      field(C.editor.paths, paths, 'hb-r-paths'),
      field(C.editor.commands, cmds, 'hb-r-cmds'),
      field(C.editor.hosts, hosts, 'hb-r-hosts'),
    )
    policy.hidden = true
    enf.addEventListener('change', () => (policy.hidden = enf.value !== 'runtime-policy'))
    const err = el('p', undefined, 'error')
    const add = el('button', C.editor.addRule, 'btn small primary')
    add.type = 'submit'
    add.disabled = off
    form.append(
      field(C.editor.ruleName, name, 'hb-r-name'),
      field(C.editor.ruleText, text, 'hb-r-text'),
      cat,
      enf,
      sev,
      policy,
      err,
      add,
    )
    form.addEventListener('submit', (ev) => {
      ev.preventDefault()
      if (!name.value.trim() || !text.value.trim()) {
        err.textContent = C.editor.invalidRule
        return
      }
      this.mutate(e, (d) => {
        d.rules = [
          ...(d.rules ?? []),
          {
            name: name.value.trim(),
            text: text.value.trim(),
            category: cat.value as 'coding',
            enforcement: enf.value as 'instruction',
            severity: sev.value as 'required',
            ...(enf.value === 'runtime-policy' && {
              policy: policyFromFields({
                effect: eff.value as 'deny',
                tools: tools.value,
                paths: paths.value,
                commands: cmds.value,
                hosts: hosts.value,
              }),
            }),
          },
        ]
      })
    })
    return form
  }

  private gates(e: HarnessEditorVM, vm: HarnessBuilderVM): HTMLElement[] {
    const off = !e.editable || vm.busy
    const out: HTMLElement[] = []
    if (!e.gates.length) out.push(el('p', C.editor.noGates, 'muted'))
    const ul = el('ul', undefined, 'hb-gates')
    for (const g of e.gates) {
      const li = el('li', undefined, 'hb-gate')
      li.dataset.gateId = g.id
      li.append(el('strong', g.name), badge(g.requiredLabel, g.required ? 'good' : 'neutral'))
      li.append(el('code', g.command, 'hb-gate-cmd'), el('span', g.details, 'muted small'))
      const rm = textButton(C.editor.removeGate, 'btn small danger', () =>
        this.mutate(e, (d) => (d.gates = (d.gates ?? []).filter((x) => x.id !== g.id))),
      )
      rm.disabled = off
      li.append(rm)
      ul.append(li)
    }
    out.push(ul)
    const form = el('form', undefined, 'hb-add')
    form.id = 'hb-add-gate'
    const name = textInput('', () => {}, 80, off)
    const cmd = textInput('', () => {}, 400, off)
    const req = check(true, () => {}, off)
    const err = el('p', undefined, 'error')
    const add = el('button', C.editor.addGate, 'btn small primary')
    add.type = 'submit'
    add.disabled = off
    const reqLabel = el('label', undefined, 'row')
    reqLabel.append(req, ` ${C.editor.required}`)
    form.append(
      field(C.editor.gateName, name, 'hb-g-name'),
      field(C.editor.gateCommand, cmd, 'hb-g-cmd'),
      reqLabel,
      err,
      add,
    )
    form.addEventListener('submit', (ev) => {
      ev.preventDefault()
      const argv = cmd.value.trim().split(/\s+/).filter(Boolean)
      if (!argv.length) {
        err.textContent = C.editor.invalidCommand
        return
      }
      this.mutate(e, (d) => {
        d.gates = [
          ...(d.gates ?? []),
          { name: name.value.trim() || argv.join(' ').slice(0, 80), argv, required: req.checked },
        ]
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
        const li = el('li', undefined, 'row')
        li.append(
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
    for (const g of p.groups) {
      const sec = el('section', undefined, 'hb-cand-group')
      sec.dataset.source = g.label
      sec.append(el('h4', g.label))
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
        const top = el('div', undefined, 'hb-cand-top')
        top.append(box, name, cat, sev, chip(c.enforcementLabel, 'enforcement'))
        for (const m of c.marks) {
          const b = badge(m.label, 'warn')
          b.dataset.mark = m.kind
          top.append(b)
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
    const attach = el('label', undefined, 'row')
    const attachBox = check(I.attach, (v) => this.importAttach.emit(v))
    attach.append(attachBox, ` ${I.attachLabel}`)
    const create = textButton(I.create.label, 'btn primary', () => this.commit.emit(), 'hb-commit')
    create.disabled = !I.create.enabled
    if (I.create.hint) create.title = I.create.hint
    out.push(field(I.nameLabel, name, 'hb-import-name'), attach, create)
    return out
  }

  // ── Coverage ───────────────────────────────────────────────────────────────────────────────
  private coveragePane(vm: HarnessBuilderVM): HTMLElement[] {
    const c = vm.coverage
    const out: HTMLElement[] = [el('h3', c.heading)]
    if (!c.projectName) return [...out, el('p', c.needProject, 'sec-empty muted')]
    out.push(el('p', c.projectName, 'hb-project'))
    if (!c.reports.length) out.push(el('p', c.empty, 'muted'))
    for (const r of c.reports) out.push(this.report(r))
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

// Keep the list of editor tabs reachable for tests and the Playwright agent.
export const HARNESS_EDITOR_TABS = EDITOR_TABS
