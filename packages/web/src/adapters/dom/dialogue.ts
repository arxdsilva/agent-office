// DialogueView port → `#dialogue`: the RPG dialogue box of the 2D mode (plan §8.2). Text goes
// through textContent only. Buttons are keyboard-navigable (←/→ or ↑/↓, Enter, Esc closes).
import type { DialogueAction, DialogueVM } from '../../app/pixel/types.ts'
import type { DialogueView } from '../../ports.ts'
import { byId, el } from './el.ts'

const NAV_NEXT = new Set(['ArrowRight', 'ArrowDown'])
const NAV_PREV = new Set(['ArrowLeft', 'ArrowUp'])

export class DomDialogue implements DialogueView {
  private root = byId<HTMLElement>('dialogue')
  private title = byId('dlg-title')
  private sub = byId('dlg-sub')
  private status = byId('dlg-status')
  private lines = byId('dlg-lines')
  private actions = byId('dlg-actions')
  private actionFn: (a: DialogueAction) => void = () => {}
  private closeFn: () => void = () => {}

  constructor() {
    const close = byId<HTMLButtonElement>('dlg-close')
    close.setAttribute('aria-label', 'Close')
    close.addEventListener('click', () => this.close())
    // Keys handled here never reach the 2D player input (Enter would interact again).
    this.root.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        this.close()
      } else if (NAV_NEXT.has(e.key) || NAV_PREV.has(e.key)) {
        e.preventDefault()
        this.moveFocus(NAV_NEXT.has(e.key) ? 1 : -1)
      }
    })
  }

  onAction(fn: (a: DialogueAction) => void): void {
    this.actionFn = fn
  }
  onClose(fn: () => void): void {
    this.closeFn = fn
  }

  isOpen(): boolean {
    return !this.root.hidden
  }

  open(vm: DialogueVM): void {
    this.root.hidden = false
    this.render(vm)
    this.focusable()[0]?.focus()
  }

  close(): void {
    if (this.root.hidden) return
    this.root.hidden = true
    this.closeFn()
  }

  render(vm: DialogueVM): void {
    if (this.root.hidden) return
    // Keep the focused action across re-renders (status updates arrive while it is open).
    const focused = (document.activeElement as HTMLElement | null)?.dataset.action
    if (vm.agentId) this.root.dataset.agentId = vm.agentId
    else delete this.root.dataset.agentId
    this.title.textContent = vm.title
    this.sub.textContent = vm.subtitle ?? ''
    this.sub.hidden = !vm.subtitle
    if (vm.status) {
      this.status.textContent = vm.status.label
      this.status.dataset.status = vm.status.status
      this.status.style.setProperty('--chip', vm.status.color)
      this.status.hidden = false
    } else {
      this.status.hidden = true
      delete this.status.dataset.status
    }
    this.lines.replaceChildren(...vm.lines.map((l) => el('p', l, 'dlg-line')))
    this.actions.replaceChildren(
      ...vm.actions.map((a) => {
        const b = el('button', a.label, 'dlg-action')
        b.type = 'button'
        b.dataset.action = a.id
        b.addEventListener('click', () => this.actionFn(a.id))
        return b
      }),
    )
    if (focused)
      this.actions.querySelector<HTMLElement>(`[data-action="${CSS.escape(focused)}"]`)?.focus()
  }

  private focusable(): HTMLElement[] {
    return [...this.actions.querySelectorAll<HTMLElement>('button')]
  }

  private moveFocus(step: number): void {
    const list = this.focusable()
    if (!list.length) return
    const i = list.indexOf(document.activeElement as HTMLElement)
    list[(i + step + list.length) % list.length]!.focus()
  }
}
