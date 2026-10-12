import { COPY } from '../../app/connect-copy.ts'
import type { EmptyStateVM, EmptyTileId, Pill } from '../../app/connect-types.ts'
import type { EmptyStateView } from '../../ports.ts'
import { byId, el } from './el.ts'

export const pillEl = (p: Pill, id?: string) => {
  const span = el('span', p.text, `pill ${p.tone}`)
  if (id) span.id = id
  return span
}

/** EmptyStateView port → the `#empty` card shown over an empty office (plan §2.1). */
export class DomEmptyState implements EmptyStateView {
  private root = byId('empty')
  private key = ''
  private tileFn: (t: EmptyTileId) => void = () => {}
  private demoFn: () => void | Promise<void> = () => {}
  private dismissFn: () => void = () => {}

  onTile(fn: (t: EmptyTileId) => void) {
    this.tileFn = fn
  }
  onDemo(fn: () => void | Promise<void>) {
    this.demoFn = fn
  }
  onDismiss(fn: () => void) {
    this.dismissFn = fn
  }

  render(vm: EmptyStateVM | null): void {
    const key = JSON.stringify(vm)
    if (key === this.key) return
    this.key = key
    this.root.hidden = !vm
    if (!vm) return void this.root.replaceChildren()

    const title = el('h2', COPY.empty.title)
    title.id = 'empty-title'
    const close = el('button', '✕', 'icon-btn')
    close.type = 'button'
    close.setAttribute('aria-label', COPY.empty.dismiss)
    close.addEventListener('click', () => this.dismissFn())
    const head = el('div', undefined, 'panel-head')
    head.append(title, close)

    const tiles = el('div', undefined, 'tiles')
    for (const t of vm.tiles) {
      const tile = el('article', undefined, 'tile')
      tile.dataset.tile = t.id
      const btn = el('button', t.button, t.id === 'demo' ? 'btn' : 'btn primary')
      btn.type = 'button'
      btn.disabled = !!t.busy
      btn.addEventListener('click', () => {
        if (t.id === 'demo') void this.demoFn()
        else this.tileFn(t.id)
      })
      tile.append(el('h3', t.title), pillEl(t.pill), el('p', t.body, 'muted'), btn)
      tiles.append(tile)
    }
    this.root.replaceChildren(
      head,
      el('p', COPY.empty.lead),
      tiles,
      el('p', vm.listening, 'muted pulse'),
    )
  }
}
