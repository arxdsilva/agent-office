// ModeToggleView port → `#mode-toggle` in #actions: the `3D Office | 2D RPG` segmented switch
// (plan §9). A radiogroup with roving focus; arrow keys move and pick.
import { PIXEL_COPY } from '../../app/pixel-copy.ts'
import type { ViewMode } from '../../app/pixel/types.ts'
import type { ModeToggleView } from '../../ports.ts'
import { byId, el } from './el.ts'

const MODES: { mode: ViewMode; label: string }[] = [
  { mode: '3d', label: PIXEL_COPY.mode.office3d },
  { mode: 'pixel', label: PIXEL_COPY.mode.rpg2d },
]

export class DomModeToggle implements ModeToggleView {
  private root = byId('mode-toggle')
  private changeFn: (m: ViewMode) => void = () => {}
  private buttons: HTMLButtonElement[]

  constructor() {
    this.root.setAttribute('role', 'radiogroup')
    this.root.setAttribute('aria-label', PIXEL_COPY.mode.label)
    this.buttons = MODES.map(({ mode, label }) => {
      const b = el('button', label)
      b.type = 'button'
      b.setAttribute('role', 'radio')
      b.dataset.mode = mode
      b.addEventListener('click', () => this.pick(mode))
      return b
    })
    this.root.replaceChildren(...this.buttons)
    this.root.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
      e.preventDefault()
      e.stopPropagation()
      const i = this.buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true')
      const next = this.buttons[(i + 1) % this.buttons.length]!
      next.focus()
      this.pick(next.dataset.mode as ViewMode)
    })
    this.render('3d')
  }

  onChange(fn: (m: ViewMode) => void): void {
    this.changeFn = fn
  }

  render(mode: ViewMode): void {
    for (const b of this.buttons) {
      const on = b.dataset.mode === mode
      b.setAttribute('aria-checked', String(on))
      b.tabIndex = on ? 0 : -1
    }
  }

  private pick(mode: ViewMode): void {
    if (this.buttons.find((b) => b.dataset.mode === mode)?.getAttribute('aria-checked') === 'true')
      return
    // Optimistic: the controller re-renders from the saved setting.
    this.render(mode)
    this.changeFn(mode)
  }
}
