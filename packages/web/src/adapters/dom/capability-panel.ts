import type { CapabilityPanelVM } from '../../app/capability-vm.ts'
import type { CapabilityPanelView } from '../../ports.ts'
import { byId, el } from './el.ts'

/** CapabilityPanelView port → the side panel for a station, book, board or notebook. */
export class DomCapabilityPanel implements CapabilityPanelView {
  private root = byId<HTMLElement>('cap-panel')
  private closeFn: () => void = () => {}
  private agentFn: (id: string) => void = () => {}
  private linksFn: (on: boolean) => void = () => {}
  private links = byId<HTMLButtonElement>('c-links')

  constructor() {
    byId('c-close').addEventListener('click', () => this.close())
    this.links.addEventListener('click', () =>
      this.linksFn(this.links.getAttribute('aria-pressed') !== 'true'),
    )
    this.root.addEventListener('keydown', (e) => e.key === 'Escape' && this.close())
  }

  onClose(fn: () => void): void {
    this.closeFn = fn
  }
  onSelectAgent(fn: (id: string) => void): void {
    this.agentFn = fn
  }
  onToggleLinks(fn: (on: boolean) => void): void {
    this.linksFn = fn
  }

  open(vm: CapabilityPanelVM): void {
    this.root.hidden = false
    this.render(vm)
  }

  close(): void {
    if (this.root.hidden) return
    this.root.hidden = true
    this.closeFn()
  }

  render(vm: CapabilityPanelVM): void {
    if (this.root.hidden) return
    this.root.dataset.capabilityId = vm.id
    byId('c-title').textContent = vm.title
    this.links.setAttribute('aria-pressed', String(vm.showLinks))
    this.links.textContent = vm.showLinks ? 'Showing only its links' : 'Show links'
    byId('c-sub').textContent = vm.subtitle
    const summary = byId('c-summary')
    summary.textContent = vm.summary
    summary.hidden = !vm.summary
    byId('c-sections').replaceChildren(
      ...vm.sections.flatMap((s) => {
        const list = el('ul', undefined, 'c-list')
        list.append(...s.items.map((i) => el('li', i)))
        return [el('h3', s.title, 'c-h'), list]
      }),
    )
    byId('c-meta').replaceChildren(...vm.meta.flatMap(([k, v]) => [el('dt', k), el('dd', v)]))
    const used = byId('c-used')
    used.replaceChildren(
      ...(vm.usedBy.length
        ? vm.usedBy.map((a) => {
            const btn = el('button', a.name, 'chip')
            btn.type = 'button'
            btn.addEventListener('click', () => this.agentFn(a.id))
            const li = el('li')
            li.append(btn)
            return li
          })
        : [el('li', 'Nobody right now', 'muted')]),
    )
  }
}
