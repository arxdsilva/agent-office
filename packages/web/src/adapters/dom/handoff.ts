// HandoffView port → `<dialog id="ho-dialog">`: continue work with another provider. The user
// previews exactly which items go into the first message and unticks what to leave out.
import type { HandoffItemVM, HandoffVM } from '../../app/workspace/types.ts'
import type { HandoffView } from '../../workspace-ports.ts'
import { el } from './el.ts'
import { Signal, chip, need, notice, openDialog, setText, syncInput, vmButton } from './ws-kit.ts'

export class DomHandoff implements HandoffView {
  private objective = new Signal<[string]>()
  private provider = new Signal<[string]>()
  private preview = new Signal()
  private toggle = new Signal<[string, boolean]>()
  private note = new Signal<[string]>()
  private launch = new Signal()
  private cancel = new Signal()

  private dialog: HTMLDialogElement
  private title = el('h2', undefined, 'dlg-title')
  private from = el('p', undefined, 'muted')
  private obj = el('textarea')
  private sel = el('select', undefined, 'select')
  private prep = el('div', undefined, 'dlg-actions')
  private previewBox = el('section', undefined, 'ho-preview')
  private noteBox = el('textarea')
  private actions = el('div', undefined, 'dlg-actions')
  private error = el('div')
  private providerKey = ''

  constructor(doc: Document) {
    this.dialog = need<HTMLDialogElement>(doc, 'ho-dialog')
    this.title.id = 'ho-title'
    this.obj.id = 'ho-objective'
    this.obj.rows = 3
    this.obj.maxLength = 2000
    this.obj.addEventListener('input', () => this.objective.emit(this.obj.value))
    this.sel.id = 'ho-provider'
    this.sel.addEventListener('change', () => this.provider.emit(this.sel.value))
    this.previewBox.id = 'ho-preview'
    this.noteBox.id = 'ho-note'
    this.noteBox.rows = 2
    this.noteBox.maxLength = 2000
    this.noteBox.addEventListener('input', () => this.note.emit(this.noteBox.value))

    const lbl = (text: string, f: string) => {
      const l = el('label', text, 'field-label')
      l.htmlFor = f
      return l
    }
    const form = el('form', undefined, 'dlg-form')
    // Header and actions stay put; only the body scrolls (the dialog is capped to the viewport).
    const body = el('div', undefined, 'dlg-body')
    body.append(
      lbl('Objective', 'ho-objective'),
      this.obj,
      lbl('Continue with', 'ho-provider'),
      this.sel,
      this.prep,
      this.previewBox,
      lbl('Note for the next agent', 'ho-note'),
      this.noteBox,
    )
    const head = el('header', undefined, 'dlg-head')
    head.append(this.title, this.from)
    form.append(head, body, this.error, this.actions)
    form.addEventListener('submit', (e) => e.preventDefault())
    this.dialog.replaceChildren(form)
    this.dialog.addEventListener('cancel', (e) => {
      e.preventDefault()
      this.cancel.emit()
    })
  }

  onObjective(fn: (t: string) => void): void {
    this.objective.on(fn)
  }
  onProvider(fn: (id: string) => void): void {
    this.provider.on(fn)
  }
  onPreview(fn: () => void): void {
    this.preview.on(fn)
  }
  onToggleItem(fn: (id: string, included: boolean) => void): void {
    this.toggle.on(fn)
  }
  onNote(fn: (n: string) => void): void {
    this.note.on(fn)
  }
  onLaunch(fn: () => void): void {
    this.launch.on(fn)
  }
  onCancel(fn: () => void): void {
    this.cancel.on(fn)
  }

  render(vm: HandoffVM): void {
    const opened = openDialog(this.dialog, vm.open)
    if (!vm.open) return
    setText(this.title, vm.heading)
    setText(this.from, vm.fromLabel)
    syncInput(this.obj, vm.objective)
    syncInput(this.noteBox, vm.note)
    if (opened) this.obj.focus()

    const key = vm.providerOptions.map((o) => `${o.id}:${o.label}`).join('|')
    if (key !== this.providerKey) {
      this.providerKey = key
      this.sel.replaceChildren(
        ...vm.providerOptions.map((o) => {
          const opt = el('option', o.label)
          opt.value = o.id
          return opt
        }),
      )
    }
    this.sel.value = vm.provider

    this.prep.replaceChildren(
      vmButton(vm.preview, 'secondary', () => this.preview.emit(), 'ho-prepare'),
    )
    this.previewBox.replaceChildren(...this.previewNodes(vm))

    const cancel = el('button', 'Cancel', 'btn')
    cancel.type = 'button'
    cancel.id = 'ho-cancel'
    cancel.addEventListener('click', () => this.cancel.emit())
    const go = vmButton(vm.launch, 'primary', () => this.launch.emit(), 'ho-launch')
    this.actions.replaceChildren(el('span', undefined, 'spacer'), cancel, go)
    this.error.replaceChildren(...(vm.error ? [notice(vm.error, 'error')] : []))
  }

  private previewNodes(vm: HandoffVM): Node[] {
    const out: Node[] = [el('h3', 'Context that will be delivered to the agent', 'mini-h')]
    if (!vm.items.length) out.push(el('p', vm.itemsEmpty, 'sec-empty muted'))
    else {
      const ul = el('ul', undefined, 'rows')
      for (const it of vm.items) ul.append(this.item(it))
      out.push(ul)
    }
    const pct =
      vm.tokens.budgetChars > 0
        ? Math.min(100, Math.round((vm.tokens.usedChars / vm.tokens.budgetChars) * 100))
        : 0
    const meter = el('div', undefined, 'meter')
    meter.setAttribute('role', 'progressbar')
    meter.setAttribute('aria-valuemin', '0')
    meter.setAttribute('aria-valuemax', '100')
    meter.setAttribute('aria-valuenow', String(pct))
    meter.setAttribute('aria-label', vm.tokens.label)
    const fill = el('span')
    fill.style.width = `${pct}%`
    meter.append(fill)
    out.push(meter, el('p', vm.tokens.label, 'muted small'))
    return out
  }

  private item(it: HandoffItemVM): HTMLLIElement {
    const li = el('li', undefined, `row${it.included ? '' : ' excluded'}`)
    li.dataset.itemId = it.id
    const cb = el('input')
    cb.type = 'checkbox'
    cb.checked = it.included
    cb.disabled = !it.toggleable
    cb.setAttribute('aria-label', `Include ${it.title}`)
    cb.addEventListener('change', () => this.toggle.emit(it.id, cb.checked))
    const main = el('div', undefined, 'row-main')
    main.append(el('div', it.title, 'row-title'), el('div', it.excerpt, 'row-detail muted'))
    const why = el('div', undefined, 'row-detail')
    for (const r of it.reasons) why.append(chip(r, 'reason'))
    if (it.excludedReason) why.append(chip(it.excludedReason, 'warn'))
    main.append(why)
    li.append(cb, main)
    return li
  }
}
