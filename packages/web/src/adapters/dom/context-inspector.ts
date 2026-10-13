// InspectorView port → `#ws-context`: what an agent could get (available), what the project
// memory server retrieved for it, and what was delivered to it. Never says an agent "read" anything.
import type { InspectorEntryVM, InspectorVM } from '../../app/workspace/types.ts'
import type { InspectorView } from '../../workspace-ports.ts'
import { el } from './el.ts'
import { Signal, need, notice, textButton } from './ws-kit.ts'

export class DomContextInspector implements InspectorView {
  private refresh = new Signal()
  private agent = new Signal<[string]>()
  private root: HTMLElement

  constructor(doc: Document) {
    this.root = need(doc, 'ws-context')
  }

  onRefresh(fn: () => void): void {
    this.refresh.on(fn)
  }

  onAgent(fn: (agentId: string) => void): void {
    this.agent.on(fn)
  }

  render(vm: InspectorVM): void {
    const inner = el('div', undefined, 'ws-inner')
    const head = el('header', undefined, 'pane-head row-between')
    const titles = el('div')
    titles.append(el('h1', vm.heading, 'pane-title'))
    // The picker names the agent; never show raw agent ids.
    const sub = vm.projectName ?? ''
    if (sub) titles.append(el('p', sub, 'pane-sub muted'))
    const tools = el('div', undefined, 'ci-tools')
    if (vm.agents.length) {
      const sel = el('select', undefined, 'select')
      sel.id = 'ci-agent'
      sel.setAttribute('aria-label', vm.agentLabel)
      for (const a of vm.agents) {
        const opt = el('option', a.label)
        opt.value = a.id
        opt.selected = a.selected
        sel.append(opt)
      }
      sel.addEventListener('change', () => this.agent.emit(sel.value))
      tools.append(sel)
    }
    head.append(
      titles,
      tools,
      textButton('Refresh', 'secondary', () => this.refresh.emit(), 'ci-refresh'),
    )
    inner.append(head, el('p', vm.note, 'note-line muted'))
    if (vm.error) inner.append(notice(vm.error, 'error'))
    if (vm.loading) inner.append(notice('Loading…', 'info'))

    const grid = el('div', undefined, 'ci-grid')
    const avail = this.card('ci-available', vm.available.heading)
    avail.append(el('p', vm.available.summary, 'ci-summary'))
    grid.append(
      avail,
      this.entries('ci-retrieved', vm.retrieved.heading, vm.retrieved.entries, vm.retrieved.empty),
      this.entries('ci-delivered', vm.delivered.heading, vm.delivered.entries, vm.delivered.empty),
    )
    inner.append(grid)
    this.root.replaceChildren(inner)
  }

  private card(id: string, heading: string): HTMLElement {
    const s = el('section', undefined, 'card ci-card')
    s.id = id
    s.setAttribute('aria-labelledby', `${id}-h`)
    const h = el('h2', heading, 'sec-title')
    h.id = `${id}-h`
    s.append(h)
    return s
  }

  private entries(
    id: string,
    heading: string,
    items: InspectorEntryVM[],
    empty: string,
  ): HTMLElement {
    const s = this.card(id, heading)
    if (!items.length) {
      s.append(el('p', empty, 'sec-empty muted'))
      return s
    }
    const ul = el('ul', undefined, 'rows')
    for (const e of items) {
      const li = el('li', undefined, 'row')
      li.dataset.entryId = e.id
      const main = el('div', undefined, 'row-main')
      main.append(el('div', e.title, 'row-title'), el('div', e.detail, 'row-detail muted'))
      li.append(main)
      ul.append(li)
    }
    s.append(ul)
    return s
  }
}
