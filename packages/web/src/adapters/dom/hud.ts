import type { AgentStatus, Banner } from '@agent-office/shared'
import { COPY } from '../../app/connect-copy.ts'
import type { HudVM } from '../../app/view-models.ts'
import type { BannerView, HudView } from '../../ports.ts'
import { byId, el } from './el.ts'

/** HudView port → legend, agent count and the settings button. */
export class DomHud implements HudView {
  private labels = new Map<AgentStatus, HTMLElement>()
  private connectFn: () => void = () => {}
  private hintKey = ''

  constructor() {
    const btn = byId('connect-btn')
    btn.querySelector('.connect-label')!.textContent = COPY.hud.connectBtn
    btn.addEventListener('click', () => this.connectFn())
  }

  onConnect(fn: () => void): void {
    this.connectFn = fn
  }

  setConnectBadge(on: boolean): void {
    const btn = byId('connect-btn')
    btn.querySelector<HTMLElement>('.badge')!.hidden = !on
    btn.setAttribute('aria-label', on ? COPY.hud.connectAriaEmpty : COPY.hud.connectAria)
  }

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
    const key = `${vm.hint.text}|${vm.hint.action ?? ''}`
    if (key === this.hintKey) return
    this.hintKey = key
    const hint = byId('hud-hint')
    hint.replaceChildren(el('span', vm.hint.text))
    if (vm.hint.action === 'connect') {
      const link = el('button', COPY.hud.connect, 'link')
      link.type = 'button'
      link.addEventListener('click', () => this.connectFn())
      hint.append(' ', link)
    }
  }
}

/** BannerView port → a strip at the top (e.g. "port busy"). */
export class DomBanner implements BannerView {
  private actionFn: (a: NonNullable<Banner['action']>) => void = () => {}

  onAction(fn: (a: NonNullable<Banner['action']>) => void): void {
    this.actionFn = fn
  }

  show(b: Banner | null): void {
    const node = byId('banner')
    node.hidden = !b
    node.replaceChildren(b?.text ?? '')
    node.className = b ? `banner ${b.kind}` : 'banner'
    const action = b?.action
    if (action === 'open-connect') {
      const btn = el('button', COPY.banner.fix, 'link')
      btn.type = 'button'
      btn.addEventListener('click', () => this.actionFn(action))
      node.append(' ', btn)
    }
  }
}
