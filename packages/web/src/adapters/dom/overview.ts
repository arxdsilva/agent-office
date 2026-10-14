// OverviewView port → `#ws-overview`: what needs the user's attention across every project.
import type { OverviewCardVM, OverviewVM, WorkspaceAction } from '../../app/workspace/types.ts'
import type { OverviewView } from '../../workspace-ports.ts'
import type { OverviewApprovalVM } from '../../app/workspace/overview-vm.ts'
import { el } from './el.ts'
import { Signal, dot, need, notice, textButton, vmButton } from './ws-kit.ts'

export class DomOverview implements OverviewView {
  private action = new Signal<[WorkspaceAction]>()
  private root: HTMLElement

  constructor(doc: Document) {
    this.root = need(doc, 'ws-overview')
  }

  onAction(fn: (a: WorkspaceAction) => void): void {
    this.action.on(fn)
  }

  render(vm: OverviewVM): void {
    const inner = el('div', undefined, 'ws-inner')
    inner.append(el('h1', vm.heading, 'pane-title'))
    if (vm.error) inner.append(notice(vm.error, 'error'))
    if (vm.loading) inner.append(notice('Loading…', 'info'))

    if (vm.noProjects) {
      const hero = el('div', undefined, 'hero card')
      hero.append(
        el('div', '▣', 'hero-ico'),
        el('p', vm.noProjectsText, 'hero-text'),
        vmButton(vm.createProject, 'primary large', (a) => a && this.action.emit(a), 'ov-create'),
      )
      inner.append(hero)
    }

    const grid = el('div', undefined, 'ov-grid')
    for (const s of vm.sections) {
      const sec = el('section', undefined, `ov-section ov-${s.id} card`)
      sec.id = `ov-${s.id}`
      const head = el('div', undefined, 'sec-head')
      head.append(el('h2', s.heading, 'sec-title'))
      if (s.items.length) head.append(el('span', String(s.items.length), 'sec-count'))
      sec.append(head)
      if (!s.items.length) sec.append(el('p', s.empty, 'sec-empty muted'))
      else {
        const ul = el('ul', undefined, 'cards')
        for (const c of s.items) ul.append(this.card(c))
        sec.append(ul)
      }
      grid.append(sec)
    }
    inner.append(grid)
    this.root.replaceChildren(inner)
  }

  private card(c: OverviewCardVM): HTMLLIElement {
    const li = el('li', undefined, `item-card ${`tone-${c.tone}`}`)
    li.dataset.cardId = c.id
    const flow = c as Partial<OverviewApprovalVM>
    if (flow.stepId && flow.agentId) {
      li.classList.add('ov-approval')
      li.dataset.agentId = flow.agentId
      li.dataset.stepId = flow.stepId
    }
    const body = el('div', undefined, 'item-body')
    const title = el('div', undefined, 'item-title')
    title.append(dot(c.tone), el('span', c.title))
    body.append(title, el('p', c.detail, 'item-detail muted'))
    li.append(body)
    if (flow.approve) {
      const a = flow.approve.action
      const approve = textButton(flow.approve.label, 'small primary', () => this.action.emit(a))
      approve.dataset.action = 'approve'
      li.append(approve)
    }
    if (c.action) {
      const a = c.action
      li.append(textButton(c.actionLabel ?? 'Open', 'small', () => this.action.emit(a)))
    }
    return li
  }
}
