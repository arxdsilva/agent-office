// TooltipView → `#tooltip`, a small label near the cursor for hovered capability surfaces (§B4).
import type { TooltipView } from '../../ports.ts'
import { byId } from './el.ts'

const OFFSET_X = 14
const OFFSET_Y = 18
const MARGIN = 8

export class DomTooltip implements TooltipView {
  private node = byId('tooltip')

  show(text: string, x: number, y: number): void {
    const n = this.node
    if (n.textContent !== text) n.textContent = text
    n.hidden = false
    // Below-right of the cursor, flipped to stay inside the window.
    const w = n.offsetWidth
    const h = n.offsetHeight
    const left = x + OFFSET_X + w + MARGIN > innerWidth ? x - OFFSET_X - w : x + OFFSET_X
    const top = y + OFFSET_Y + h + MARGIN > innerHeight ? y - OFFSET_Y - h : y + OFFSET_Y
    n.style.left = `${Math.max(MARGIN, left)}px`
    n.style.top = `${Math.max(MARGIN, top)}px`
  }

  hide(): void {
    this.node.hidden = true
  }
}
