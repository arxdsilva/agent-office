import type { ToastView } from '../../ports.ts'
import { byId, el } from './el.ts'

const SHOW_MS = 4_000

/** ToastView port → `#toast` (role=status): a short line, optionally with one action button. */
export class DomToast implements ToastView {
  private root = byId('toast')
  private timer: ReturnType<typeof setTimeout> | undefined

  show(text: string, action?: { label: string; run: () => void }): void {
    const children: (HTMLElement | string)[] = [el('span', text)]
    if (action) {
      const btn = el('button', action.label, 'link')
      btn.type = 'button'
      btn.addEventListener('click', () => {
        this.hide()
        action.run()
      })
      children.push(' ', btn)
    }
    this.root.replaceChildren(...children)
    this.root.hidden = false
    clearTimeout(this.timer)
    // A toast with an action stays a little longer so it can be reached.
    this.timer = setTimeout(() => this.hide(), action ? SHOW_MS * 2 : SHOW_MS)
  }

  private hide(): void {
    this.root.hidden = true
  }
}
