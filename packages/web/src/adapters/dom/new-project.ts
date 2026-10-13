// NewProjectView port → `<dialog id="np-dialog">`: name a project and attach folders from the
// native picker (the renderer never sees or types absolute paths).
import type { NewProjectVM } from '../../app/workspace/types.ts'
import type { NewProjectView } from '../../workspace-ports.ts'
import { el } from './el.ts'
import { Signal, need, notice, openDialog, setText, syncInput, vmButton } from './ws-kit.ts'

export class DomNewProject implements NewProjectView {
  private name = new Signal<[string]>()
  private add = new Signal()
  private remove = new Signal<[string]>()
  private create = new Signal()
  private cancel = new Signal()

  private dialog: HTMLDialogElement
  private title = el('h2', undefined, 'dlg-title')
  private input = el('input', undefined, 'text-input')
  private folders = el('ul', undefined, 'rows np-folders')
  private actions = el('div', undefined, 'dlg-actions')
  private error = el('div')

  constructor(doc: Document) {
    this.dialog = need<HTMLDialogElement>(doc, 'np-dialog')
    this.title.id = 'np-title'
    this.input.id = 'np-name'
    this.input.type = 'text'
    this.input.maxLength = 60
    this.input.autocomplete = 'off'
    this.input.addEventListener('input', () => this.name.emit(this.input.value))
    this.folders.id = 'np-folders'
    const label = el('label', 'Name', 'field-label')
    label.htmlFor = 'np-name'
    const form = el('form', undefined, 'dlg-form')
    const body = el('div', undefined, 'dlg-body')
    body.append(label, this.input, el('span', 'Folders', 'field-label'), this.folders)
    const head = el('header', undefined, 'dlg-head')
    head.append(this.title)
    form.append(head, body, this.error, this.actions)
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      this.create.emit()
    })
    this.dialog.replaceChildren(form)
    this.dialog.addEventListener('cancel', (e) => {
      e.preventDefault()
      this.cancel.emit()
    })
  }

  onName(fn: (n: string) => void): void {
    this.name.on(fn)
  }
  onAddFolder(fn: () => void): void {
    this.add.on(fn)
  }
  onRemoveFolder(fn: (ref: string) => void): void {
    this.remove.on(fn)
  }
  onCreate(fn: () => void): void {
    this.create.on(fn)
  }
  onCancel(fn: () => void): void {
    this.cancel.on(fn)
  }

  render(vm: NewProjectVM): void {
    const opened = openDialog(this.dialog, vm.open)
    if (!vm.open) return
    setText(this.title, vm.heading)
    this.input.placeholder = vm.namePlaceholder
    syncInput(this.input, vm.name)
    if (opened) this.input.focus()

    this.folders.replaceChildren(
      ...vm.folders.map((f) => {
        const li = el('li', undefined, 'row')
        li.dataset.ref = f.ref
        const main = el('div', undefined, 'row-main')
        main.append(el('div', f.label, 'row-title'), el('div', f.hint, 'row-detail muted'))
        const rm = el('button', '✕', 'icon-btn')
        rm.type = 'button'
        rm.setAttribute('aria-label', `Remove ${f.label}`)
        rm.addEventListener('click', () => this.remove.emit(f.ref))
        li.append(main, rm)
        return li
      }),
    )
    const addBtn = vmButton(vm.addFolder, 'secondary', () => this.add.emit(), 'np-repo-add')
    const cancel = el('button', 'Cancel', 'btn')
    cancel.type = 'button'
    cancel.id = 'np-cancel'
    cancel.addEventListener('click', () => this.cancel.emit())
    const create = vmButton(vm.create, 'primary', () => {}, 'np-create')
    create.addEventListener('click', () => this.create.emit())
    const spacer = el('span', undefined, 'spacer')
    this.actions.replaceChildren(addBtn, spacer, cancel, create)
    this.error.replaceChildren(...(vm.error ? [notice(vm.error, 'error')] : []))
  }
}
