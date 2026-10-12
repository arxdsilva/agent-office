import type { AgentStatus } from '@agent-office/shared'
import type { HudVM } from '../../app/view-models.ts'
import type { BannerView, HudView } from '../../ports.ts'
import { byId, el } from './el.ts'

/** HudView port → legend, agent count and the settings button. */
export class DomHud implements HudView {
  private labels = new Map<AgentStatus, HTMLElement>()

  onOpenSettings(fn: () => void | Promise<void>): void {
    byId('settings-btn').addEventListener('click', () => void fn())
  }

  render(vm: HudVM): void {
    byId('count').textContent = vm.count
    const legend = byId('legend')
    for (const s of vm.statuses) {
      let label = this.labels.get(s.status)
      if (!label) {
        const swatch = el('span', undefined, 'swatch')
        swatch.style.background = s.color
        label = el('span')
        const li = el('li')
        li.append(swatch, label)
        legend.append(li)
        this.labels.set(s.status, label)
      }
      label.textContent = `${s.status} ${s.count}`
    }
  }
}

/** BannerView port → a strip at the top (e.g. "port busy"). */
export class DomBanner implements BannerView {
  show(b: { kind: 'error' | 'info'; text: string } | null): void {
    const node = byId('banner')
    node.hidden = !b
    node.textContent = b?.text ?? ''
    node.className = b ? `banner ${b.kind}` : 'banner'
  }
}
