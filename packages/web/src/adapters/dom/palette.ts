// PaletteView port → `<dialog id="palette">`: a command palette (Ctrl/Cmd+K) with arrow-key
// navigation. Also home of the pure keyboard-intent decision used by the global key handler.
import type { PaletteItemVM, PaletteVM } from '../../app/workspace/types.ts'
import type { PaletteView } from '../../workspace-ports.ts'
import { el } from './el.ts'
import { Signal, need, openDialog, setText, syncInput } from './ws-kit.ts'

export type KeyIntent = 'toggle-palette' | 'escape' | null
export interface KeyInfo {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
  /** A modal dialog that is not part of the workspace (Settings, Connect, New session) is open. */
  foreignDialogOpen: boolean
}

/** Cmd/Ctrl+K opens or closes the palette, even from another text field; Esc is offered to the controller. */
export function keyIntent(e: KeyInfo): KeyIntent {
  if (e.isComposing) return null
  if (e.foreignDialogOpen) return null
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k')
    return 'toggle-palette'
  if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) return 'escape'
  return null
}

const GROUPS: Record<PaletteItemVM['group'], string> = {
  command: 'Commands',
  project: 'Projects',
  session: 'Sessions',
  message: 'Messages',
  memory: 'Memory',
  handoff: 'Handoffs',
  agent: 'Agents',
}

export class DomPalette implements PaletteView {
  private query = new Signal<[string]>()
  private move = new Signal<[number]>()
  private choose = new Signal<[string?]>()
  private close = new Signal()

  private dialog: HTMLDialogElement
  private input = el('input', undefined, 'pal-input')
  private list = el('ul', undefined, 'pal-list')
  private status = el('p', undefined, 'pal-status muted')

  constructor(doc: Document) {
    this.dialog = need<HTMLDialogElement>(doc, 'palette')
    this.input.id = 'pal-input'
    this.input.type = 'text'
    this.input.autocomplete = 'off'
    this.input.spellcheck = false
    this.input.setAttribute('role', 'combobox')
    this.input.setAttribute('aria-expanded', 'true')
    this.input.setAttribute('aria-controls', 'pal-list')
    this.input.setAttribute('aria-autocomplete', 'list')
    this.list.id = 'pal-list'
    this.list.setAttribute('role', 'listbox')
    this.status.setAttribute('role', 'status')
    this.dialog.replaceChildren(this.input, this.list, this.status)

    this.input.addEventListener('input', () => this.query.emit(this.input.value))
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        this.move.emit(e.key === 'ArrowDown' ? 1 : -1)
      } else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        this.choose.emit()
      }
    })
    // Esc is routed through the controller (global key handler); this is the fallback.
    this.dialog.addEventListener('cancel', (e) => {
      e.preventDefault()
      this.close.emit()
    })
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.close.emit()
    })
  }

  onQuery(fn: (q: string) => void): void {
    this.query.on(fn)
  }
  onMove(fn: (delta: number) => void): void {
    this.move.on(fn)
  }
  onChoose(fn: (id?: string) => void): void {
    this.choose.on(fn)
  }
  onClose(fn: () => void): void {
    this.close.on(fn)
  }

  render(vm: PaletteVM): void {
    const opened = openDialog(this.dialog, vm.open)
    if (!vm.open) return
    this.input.placeholder = vm.placeholder
    this.input.setAttribute('aria-label', vm.placeholder)
    syncInput(this.input, vm.query)
    if (opened) this.input.focus()

    const kids: Node[] = []
    let group = ''
    let selected: HTMLElement | null = null
    for (const it of vm.items) {
      if (it.group !== group) {
        group = it.group
        const h = el('li', GROUPS[it.group], 'pal-group')
        h.setAttribute('role', 'presentation')
        kids.push(h)
      }
      const li = el('li', undefined, `pal-item${it.selected ? ' selected' : ''}`)
      li.id = `pal-${it.id.replace(/[^\w-]/g, '_')}`
      li.dataset.itemId = it.id
      li.setAttribute('role', 'option')
      li.setAttribute('aria-selected', String(it.selected))
      li.append(el('span', it.label, 'pal-label'))
      if (it.detail) li.append(el('span', it.detail, 'pal-detail muted'))
      li.addEventListener('click', () => this.choose.emit(it.id))
      if (it.selected) {
        selected = li
        this.input.setAttribute('aria-activedescendant', li.id)
      }
      kids.push(li)
    }
    if (!selected) this.input.removeAttribute('aria-activedescendant')
    this.list.replaceChildren(...kids)
    selected?.scrollIntoView?.({ block: 'nearest' })
    setText(this.status, vm.searching ? 'Searching…' : vm.items.length ? '' : vm.empty)
  }
}
