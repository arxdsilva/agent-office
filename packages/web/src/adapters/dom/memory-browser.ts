// MemoryView port → `#ws-memory`: review, edit, supersede and merge shared memory with its
// provenance. Agent-proposed items are labelled and never become active without approval.
import {
  MEMORY_KINDS,
  MEMORY_SCOPES,
  type MemoryKind,
  type MemoryScope,
} from '@agent-office/shared'
import type {
  BadgeVM,
  MemoryDetailVM,
  MemoryFilterKey,
  MemoryRowVM,
  MemoryVM,
} from '../../app/workspace/types.ts'
import type { MemoryDraftFields, MemoryView } from '../../workspace-ports.ts'
import { el } from './el.ts'
import {
  Signal,
  activatable,
  badge,
  need,
  notice,
  setText,
  syncInput,
  textButton,
  vmButton,
} from './ws-kit.ts'

type Mode = 'view' | 'edit' | 'supersede' | 'merge'

export class DomMemoryBrowser implements MemoryView {
  private select = new Signal<[string]>()
  private scope = new Signal<[string]>()
  private filter = new Signal<[MemoryFilterKey]>()
  private search = new Signal<[string]>()
  private check = new Signal<[string]>()
  private approve = new Signal<[string]>()
  private reject = new Signal<[string]>()
  private edit = new Signal<[string, Partial<MemoryDraftFields>]>()
  private supersede = new Signal<[string, MemoryDraftFields]>()
  private merge = new Signal<[MemoryDraftFields]>()

  private root: HTMLElement
  private heading = el('h1', undefined, 'pane-title')
  private input = el('input', undefined, 'search-input')
  private scopes = el('div', undefined, 'filters')
  private filters = el('div', undefined, 'filters')
  private status = el('div', undefined, 'sv-status')
  private list = el('ul', undefined, 'rows mem-rows')
  private detail = el('div', undefined, 'mem-detail-body')
  private mode: Mode = 'view'
  private modeFor = ''
  private draft: MemoryDraftFields = { title: '', body: '', kind: 'note', scope: 'project' }

  constructor(doc: Document) {
    this.root = need(doc, 'ws-memory')
    this.list.id = 'mem-list'
    this.detail.id = 'mem-detail'
    this.input.id = 'mem-search'
    this.input.type = 'search'
    this.input.autocomplete = 'off'
    this.input.spellcheck = false
    this.input.addEventListener('input', () => this.search.emit(this.input.value))
    const left = el('aside', undefined, 'sv-left card')
    left.append(this.heading, this.input, this.scopes, this.filters, this.status, this.list)
    const right = el('section', undefined, 'sv-right card')
    right.append(this.detail)
    const inner = el('div', undefined, 'ws-inner split')
    inner.append(left, right)
    this.root.replaceChildren(inner)
  }

  onSelect(fn: (id: string) => void): void {
    this.select.on(fn)
  }
  onScope(fn: (s: string) => void): void {
    this.scope.on(fn)
  }
  onFilter(fn: (f: MemoryFilterKey) => void): void {
    this.filter.on(fn)
  }
  onSearch(fn: (q: string) => void): void {
    this.search.on(fn)
  }
  onToggleCheck(fn: (id: string) => void): void {
    this.check.on(fn)
  }
  onApprove(fn: (id: string) => void): void {
    this.approve.on(fn)
  }
  onReject(fn: (id: string) => void): void {
    this.reject.on(fn)
  }
  onEdit(fn: (id: string, patch: Partial<MemoryDraftFields>) => void): void {
    this.edit.on(fn)
  }
  onSupersede(fn: (id: string, replacement: MemoryDraftFields) => void): void {
    this.supersede.on(fn)
  }
  onMerge(fn: (into: MemoryDraftFields) => void): void {
    this.merge.on(fn)
  }

  render(vm: MemoryVM): void {
    setText(this.heading, vm.heading)
    this.input.placeholder = vm.searchPlaceholder
    this.input.setAttribute('aria-label', vm.searchPlaceholder)
    syncInput(this.input, vm.query)
    this.scopes.setAttribute('aria-label', vm.scopeLabel)
    this.scopes.replaceChildren(
      ...vm.scopes.map((s) =>
        this.pill(s.label, s.active, () => this.scope.emit(s.key), { scope: s.key }),
      ),
    )
    this.filters.replaceChildren(
      ...vm.filters.map((f) =>
        this.pill(`${f.label} ${f.count}`, f.active, () => this.filter.emit(f.key), {
          filter: f.key,
        }),
      ),
    )
    const st: Node[] = []
    if (vm.error) st.push(notice(vm.error, 'error'))
    if (vm.loading) st.push(notice('Loading…', 'info'))
    this.status.replaceChildren(...st)

    if (!vm.rows.length) this.list.replaceChildren(el('li', vm.empty, 'sec-empty muted'))
    else this.list.replaceChildren(...vm.rows.map((r) => this.memRow(r)))
    this.renderDetail(vm)
  }

  private pill(
    label: string,
    active: boolean,
    run: () => void,
    data: Record<string, string>,
  ): HTMLButtonElement {
    const b = el('button', label, `filter${active ? ' active' : ''}`)
    b.type = 'button'
    Object.assign(b.dataset, data)
    b.setAttribute('aria-pressed', String(active))
    b.addEventListener('click', run)
    return b
  }

  private badges(bs: BadgeVM[]): HTMLElement {
    const w = el('span', undefined, 'badges')
    for (const b of bs) w.append(badge(b.label, b.tone))
    return w
  }

  private memRow(r: MemoryRowVM): HTMLLIElement {
    const li = el('li', undefined, `row mem-row${r.selected ? ' selected' : ''}`)
    li.dataset.memoryId = r.id
    const cb = el('input')
    cb.type = 'checkbox'
    cb.checked = r.checked
    cb.setAttribute('aria-label', `Select ${r.title} for merging`)
    cb.addEventListener('click', (e) => e.stopPropagation())
    cb.addEventListener('change', () => this.check.emit(r.id))
    const main = el('div', undefined, 'row-main')
    const title = el('div', r.title, 'row-title mem-title')
    title.title = r.title
    main.append(title, el('div', `${r.kindLabel} · ${r.scopeLabel}`, 'row-detail muted'))
    if (r.badges.length) main.append(this.badges(r.badges))
    li.append(cb, main)
    activatable(li, () => this.select.emit(r.id))
    li.removeAttribute('role')
    return li
  }

  private renderDetail(vm: MemoryVM): void {
    const d = vm.detail
    if (!d) {
      this.mode = 'view'
      this.detail.replaceChildren(el('p', vm.detailEmpty, 'sec-empty muted'))
      return
    }
    if (this.modeFor !== d.id && this.mode !== 'merge') {
      this.mode = 'view'
      this.modeFor = d.id
    }
    const head = el('header', undefined, 'sv-head')
    const t = el('div', undefined, 'sv-titles')
    t.append(el('h2', d.title, 'sec-title'), this.badges(d.badges))
    head.append(t)
    const parts: Node[] = [head]

    if (this.mode === 'view') {
      parts.push(el('p', d.body, 'mem-body'))
      parts.push(this.provenance(d))
      parts.push(this.actions(d))
    } else parts.push(this.form(d))
    this.detail.replaceChildren(...parts)
  }

  private provenance(d: MemoryDetailVM): HTMLElement {
    const box = el('section', undefined, 'prov')
    box.append(el('h3', 'Provenance', 'mini-h'))
    const ul = el('ul', undefined, 'prov-list')
    for (const line of d.provenance) ul.append(el('li', line))
    box.append(ul)
    return box
  }

  private actions(d: MemoryDetailVM): HTMLElement {
    const bar = el('div', undefined, 'mem-actions')
    bar.append(
      vmButton(d.actions.approve, 'primary', () => this.approve.emit(d.id), 'mem-approve'),
      vmButton(d.actions.reject, 'danger', () => this.reject.emit(d.id), 'mem-reject'),
      vmButton(d.actions.edit, 'secondary', () => this.open('edit', d), 'mem-edit'),
      vmButton(d.actions.supersede, 'secondary', () => this.open('supersede', d), 'mem-supersede'),
      vmButton(d.actions.merge, 'secondary', () => this.open('merge', d), 'mem-merge'),
    )
    if (d.scopeOptions.length) {
      const row = el('div', undefined, 'assign-row')
      const sel = el('select', undefined, 'select')
      sel.id = 'mem-scope'
      sel.setAttribute('aria-label', 'Memory scope')
      for (const o of d.scopeOptions) {
        const opt = el('option', o.label)
        opt.value = o.scope
        opt.selected = o.current
        sel.append(opt)
      }
      const go = vmButton(d.actions.scope, 'small', () => {}, 'mem-scope-btn')
      go.addEventListener('click', () => this.edit.emit(d.id, { scope: sel.value as MemoryScope }))
      row.append(el('label', 'Scope', 'muted'), sel, go)
      bar.append(row)
    }
    return bar
  }

  private open(mode: Mode, d: MemoryDetailVM): void {
    this.mode = mode
    this.modeFor = d.id
    this.draft = {
      title: mode === 'merge' ? '' : d.title,
      body: mode === 'merge' ? '' : d.body,
      kind: (MEMORY_KINDS as readonly string[]).includes(d.kind) ? (d.kind as MemoryKind) : 'note',
      scope: (MEMORY_SCOPES as readonly string[]).includes(d.scope)
        ? (d.scope as MemoryScope)
        : 'project',
    }
    this.renderDetail({ detail: d } as MemoryVM)
  }

  private form(d: MemoryDetailVM): HTMLElement {
    const f = el('form', undefined, 'mem-form')
    const heading =
      this.mode === 'edit'
        ? 'Edit memory'
        : this.mode === 'supersede'
          ? 'Replace with a new version'
          : 'Merge into one item'
    f.append(el('h3', heading, 'mini-h'))
    const title = el('input')
    title.id = 'mem-f-title'
    title.value = this.draft.title
    title.maxLength = 200
    title.placeholder = 'Title'
    title.addEventListener('input', () => (this.draft.title = title.value))
    const body = el('textarea')
    body.id = 'mem-f-body'
    body.rows = 8
    body.value = this.draft.body
    body.placeholder = 'What should agents know?'
    body.addEventListener('input', () => (this.draft.body = body.value))
    const kind = el('select', undefined, 'select')
    for (const k of MEMORY_KINDS) {
      const o = el('option', k)
      o.value = k
      o.selected = k === this.draft.kind
      kind.append(o)
    }
    kind.addEventListener('change', () => (this.draft.kind = kind.value as MemoryKind))
    const scope = el('select', undefined, 'select')
    for (const s of MEMORY_SCOPES) {
      const o = el('option', s)
      o.value = s
      o.selected = s === this.draft.scope
      scope.append(o)
    }
    scope.addEventListener('change', () => (this.draft.scope = scope.value as MemoryScope))
    const row = el('div', undefined, 'assign-row')
    row.append(el('label', 'Kind', 'muted'), kind, el('label', 'Scope', 'muted'), scope)
    const save = textButton(
      this.mode === 'edit' ? 'Save' : this.mode === 'merge' ? 'Merge' : 'Replace',
      'primary',
      () => this.submit(d),
      'mem-save',
    )
    save.type = 'submit'
    const cancel = textButton(
      'Cancel',
      'secondary',
      () => {
        this.mode = 'view'
        this.renderDetail({ detail: d } as MemoryVM)
      },
      'mem-cancel',
    )
    const bar = el('div', undefined, 'mem-actions')
    bar.append(save, cancel)
    f.append(title, body, row, bar)
    f.addEventListener('submit', (e) => {
      e.preventDefault()
      this.submit(d)
    })
    return f
  }

  private submit(d: MemoryDetailVM): void {
    const draft = { ...this.draft }
    if (!draft.title.trim() || !draft.body.trim()) return
    const mode = this.mode
    this.mode = 'view'
    if (mode === 'edit') this.edit.emit(d.id, draft)
    else if (mode === 'supersede') this.supersede.emit(d.id, draft)
    else this.merge.emit(draft)
    this.renderDetail({ detail: d } as MemoryVM)
  }
}
