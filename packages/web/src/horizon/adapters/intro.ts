// The Horizon first-visit intro `#horizon-intro` (settings `special.introSeen`), created here (no
// index.html edits). Text through textContent only.
import { el } from '../../adapters/dom/el.ts'
import { HORIZON_COPY } from '../../app/horizon/copy.ts'

export class HorizonIntro {
  readonly dialog = el('dialog', undefined, 'card')
  onContinue: () => void = () => {}
  onBack: () => void = () => {}

  constructor(parent: HTMLElement) {
    this.dialog.id = 'horizon-intro'
    this.dialog.setAttribute('aria-labelledby', 'horizon-intro-title')
    const h = el('h2', HORIZON_COPY.intro.title)
    h.id = 'horizon-intro-title'
    const go = el('button', HORIZON_COPY.intro.continue, 'btn primary')
    go.type = 'button'
    go.dataset.action = 'continue'
    const back = el('button', HORIZON_COPY.intro.back, 'btn')
    back.type = 'button'
    back.dataset.action = 'back'
    go.addEventListener('click', () => (this.dialog.close(), this.onContinue()))
    back.addEventListener('click', () => (this.dialog.close(), this.onBack()))
    const row = el('div', undefined, 'hz-actions')
    row.append(back, go)
    this.dialog.append(h, el('p', HORIZON_COPY.intro.body), row)
    // Keys typed in the dialog stay there (the office's shortcuts don't fire).
    this.dialog.addEventListener('keydown', (e) => e.stopPropagation())
    parent.append(this.dialog)
  }

  open(): void {
    if (!this.dialog.open) this.dialog.showModal()
  }

  dispose(): void {
    if (this.dialog.open) this.dialog.close()
    this.dialog.remove()
  }
}
