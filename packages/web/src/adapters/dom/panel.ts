import { MAX_MESSAGE_CHARS } from '@agent-office/shared'
import type { PanelVM } from '../../app/view-models.ts'
import type { PanelView } from '../../ports.ts'
import { byId, el } from './el.ts'

/** PanelView port → the chat side panel. */
export class DomPanel implements PanelView {
  private root = byId<HTMLElement>('panel')
  private input = byId<HTMLTextAreaElement>('p-input')
  private error = byId<HTMLElement>('p-error')
  private counter = byId<HTMLElement>('p-counter')
  private renderedThread = ''
  private sendFn: (text: string) => void | Promise<void> = () => {}
  private closeFn: () => void = () => {}
  private parentFn: (id: string) => void = () => {}
  private installFn: () => void | Promise<void> = () => {}

  constructor() {
    byId('p-close').addEventListener('click', () => this.closeFn())
    byId('p-form').addEventListener('submit', (e) => {
      e.preventDefault()
      this.submit()
    })
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation() // typing must not trigger scene shortcuts
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        this.submit()
      }
      if (e.key === 'Escape') this.closeFn()
    })
    this.input.addEventListener('input', () => {
      this.counter.textContent = `${this.input.value.length}/${MAX_MESSAGE_CHARS}`
    })
  }

  onSend(fn: (text: string) => void | Promise<void>) {
    this.sendFn = fn
  }
  onClose(fn: () => void) {
    this.closeFn = fn
  }
  onSelectParent(fn: (id: string) => void) {
    this.parentFn = fn
  }
  onInstallHook(fn: () => void | Promise<void>) {
    this.installFn = fn
  }

  open(vm: PanelVM): void {
    this.root.hidden = false
    this.renderedThread = ''
    this.error.textContent = ''
    this.render(vm)
    this.input.focus()
  }

  close(): void {
    this.root.hidden = true
  }

  showError(message: string): void {
    this.error.textContent = message
  }

  clearInput(): void {
    this.input.value = ''
    this.error.textContent = ''
    this.counter.textContent = `0/${MAX_MESSAGE_CHARS}`
  }

  render(vm: PanelVM): void {
    if (this.root.hidden) return
    byId('p-name').textContent = vm.name
    byId('p-sub').textContent = vm.subtitle

    const rows: HTMLElement[] = vm.meta.flatMap(([k, v]) => [el('dt', k), el('dd', v)])
    if (vm.parent) {
      const btn = el('button', vm.parent.name)
      btn.type = 'button'
      const parentId = vm.parent.id
      btn.addEventListener('click', () => this.parentFn(parentId))
      const dd = el('dd')
      dd.append(btn)
      rows.push(el('dt', 'Parent'), dd)
    }
    byId('p-meta').replaceChildren(...rows)
    renderChips(byId('p-used'), vm.used)

    const hint = byId('p-hint')
    hint.hidden = !vm.hint
    hint.replaceChildren()
    if (vm.hint) {
      hint.append(el('span', vm.hint.text))
      if (vm.hint.action === 'install-hook') {
        const btn = el('button', 'Install Claude Code hook', 'btn')
        btn.type = 'button'
        btn.addEventListener('click', () => void this.installFn())
        hint.append(btn)
      }
    }

    const key = JSON.stringify(vm.thread.map((m) => [m.id, m.stateLabel]))
    if (key === this.renderedThread) return
    this.renderedThread = key
    const list = byId('p-thread')
    if (vm.thread.length === 0) {
      list.replaceChildren(el('li', vm.present ? 'No messages yet. Say hi 👋' : '', 'empty'))
      return
    }
    list.replaceChildren(
      ...vm.thread.map((m) => {
        const li = el('li', m.text, m.from)
        if (m.stateLabel) li.append(el('span', m.stateLabel, 'state'))
        return li
      }),
    )
    list.scrollTop = list.scrollHeight
  }

  private submit(): void {
    const text = this.input.value.trim()
    if (text) void this.sendFn(text)
  }
}

/** "Connections used" / "Skills & rules used" rows of colored chips with use counts. */
function renderChips(root: HTMLElement, used: PanelVM['used']): void {
  root.hidden = !used
  if (!used) return root.replaceChildren()
  const group = (title: string, chips: NonNullable<PanelVM['used']>['adapters']) => {
    if (!chips.length) return []
    const list = el('ul', undefined, 'chips')
    for (const c of chips) {
      const li = el('li', `${c.label} · ${c.count}`, 'chip')
      li.style.setProperty('--chip', c.color)
      li.dataset.capabilityId = c.id
      list.append(li)
    }
    return [el('h3', title), list]
  }
  root.replaceChildren(
    ...group('Connections used', used.adapters),
    ...group('Skills & rules used', used.library),
  )
}
