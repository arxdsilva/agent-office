// PixelHudView port → the 2D mode's DOM overlay (plan §9):
//   #pixel-hud     room name, counts and the selected-agent chip (top-left)
//   #pixel-alerts  clickable waiting / approval / error alerts (top-right, max 4 + "+N")
//   #minimap       1 px per tile canvas with status dots; click to pan (M toggles)
//   #directory     wings → topics → agents with search and "Go there" (J toggles)
// Text goes through textContent only; colours come from the VMs (shared status palette).
import { PIXEL_COPY } from '../../app/pixel-copy.ts'
import type { DirectoryVM, MinimapVM, PixelHudVM } from '../../app/pixel/types.ts'
import type { PixelHudView } from '../../ports.ts'
import { byId, el } from './el.ts'

type DirectoryPick = { agentId?: string; viewId?: string; travel: boolean }

/** True while typing or while a modal is open: the HUD's M/J keys stay out of the way. */
function keysBlocked(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  if (e.metaKey || e.ctrlKey || e.altKey) return true
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return true
  return !!document.querySelector('dialog[open]')
}

export class DomPixelHud implements PixelHudView {
  private hud = byId<HTMLElement>('pixel-hud')
  private room = byId('ph-room')
  private counts = byId('ph-counts')
  private selected = byId('ph-selected')
  private alerts = byId<HTMLElement>('pixel-alerts')
  private minimap = byId<HTMLElement>('minimap')
  private canvas = byId<HTMLCanvasElement>('minimap-canvas')
  private directory = byId<HTMLElement>('directory')
  private search = byId<HTMLInputElement>('dir-search')
  private list = byId('dir-list')
  private shown = false
  private hasMinimap = false
  private hasDirectory = false
  private mapVM: MinimapVM | null = null

  private alertFn: (agentId: string, opensPermission: boolean) => void = () => {}
  private mapFn: (tx: number, ty: number) => void = () => {}
  private dirFn: (pick: DirectoryPick) => void = () => {}
  private searchFn: (q: string) => void = () => {}

  constructor() {
    byId('minimap-title').textContent = PIXEL_COPY.minimap.title
    byId('dir-title').textContent = PIXEL_COPY.directory.title
    this.search.placeholder = PIXEL_COPY.directory.search
    this.search.setAttribute('aria-label', PIXEL_COPY.directory.search)
    this.bindToggle('ph-map-btn', PIXEL_COPY.minimap.toggle, () => this.toggleMinimap())
    this.bindToggle('ph-dir-btn', PIXEL_COPY.directory.toggle, () => this.toggleDirectory())
    byId('dir-close').addEventListener('click', () => this.setDirectory(false))
    this.search.addEventListener('input', () => this.searchFn(this.search.value))
    this.directory.addEventListener('keydown', (e) => {
      // Typing in the directory never moves the player.
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        this.setDirectory(false)
      }
    })
    this.canvas.addEventListener('click', (e) => {
      const vm = this.mapVM
      if (!vm) return
      const r = this.canvas.getBoundingClientRect()
      if (!r.width || !r.height) return
      const tx = Math.floor(((e.clientX - r.left) / r.width) * vm.widthTiles)
      const ty = Math.floor(((e.clientY - r.top) / r.height) * vm.heightTiles)
      this.mapFn(clamp(tx, 0, vm.widthTiles - 1), clamp(ty, 0, vm.heightTiles - 1))
    })
    document.addEventListener('keydown', (e) => {
      if (!this.shown || e.repeat || keysBlocked(e)) return
      const k = e.key.toLowerCase()
      if (k === 'm') this.toggleMinimap()
      else if (k === 'j') this.toggleDirectory()
      else return
      e.preventDefault()
    })
  }

  onAlert(fn: (agentId: string, opensPermission: boolean) => void): void {
    this.alertFn = fn
  }
  onMinimapPick(fn: (tx: number, ty: number) => void): void {
    this.mapFn = fn
  }
  onDirectory(fn: (pick: DirectoryPick) => void): void {
    this.dirFn = fn
  }
  onDirectorySearch(fn: (q: string) => void): void {
    this.searchFn = fn
  }

  show(on: boolean): void {
    this.shown = on
    this.hud.hidden = !on
    this.alerts.hidden = !on || !this.alerts.childElementCount
    if (!on) {
      this.minimap.hidden = true
      this.directory.hidden = true
    }
  }

  render(vm: PixelHudVM): void {
    this.room.textContent = vm.room
    this.counts.replaceChildren(
      el('span', PIXEL_COPY.hud.agents(vm.counts.agents), 'ph-count'),
      count(PIXEL_COPY.hud.waiting(vm.counts.waiting), 'waiting', vm.counts.waiting),
      count(PIXEL_COPY.hud.errors(vm.counts.errors), 'error', vm.counts.errors),
    )
    if (vm.selected) {
      this.selected.textContent = vm.selected.text
      this.selected.dataset.agentId = vm.selected.id
      this.selected.hidden = false
    } else {
      this.selected.hidden = true
      delete this.selected.dataset.agentId
    }
    const items: HTMLElement[] = vm.alerts.map((a) => {
      const b = el('button', a.text, 'pixel-alert')
      b.type = 'button'
      b.dataset.kind = a.kind
      b.dataset.agentId = a.agentId
      b.addEventListener('click', () => this.alertFn(a.agentId, a.opensPermission))
      return b
    })
    if (vm.moreAlerts > 0)
      items.push(el('span', PIXEL_COPY.alerts.more(vm.moreAlerts), 'pixel-alert-more'))
    this.alerts.replaceChildren(...items)
    this.alerts.hidden = !this.shown || !items.length
  }

  renderMinimap(vm: MinimapVM | null): void {
    this.mapVM = vm
    this.hasMinimap = !!vm
    byId<HTMLButtonElement>('ph-map-btn').disabled = !vm
    if (!vm) {
      this.minimap.hidden = true
      return
    }
    if (this.minimap.hidden) return // drawn when opened
    this.draw(vm)
  }

  renderDirectory(vm: DirectoryVM | null): void {
    this.hasDirectory = !!vm
    byId<HTMLButtonElement>('ph-dir-btn').disabled = !vm
    if (!vm) {
      this.directory.hidden = true
      this.list.replaceChildren()
      return
    }
    // Never overwrite what the user is typing.
    if (document.activeElement !== this.search) this.search.value = vm.query
    this.list.replaceChildren(...vm.wings.map((w) => this.wing(w)))
    if (!vm.wings.length) this.list.append(el('li', '—', 'muted'))
  }

  // ── minimap ───────────────────────────────────────────────────────────────────────────────────
  private toggleMinimap(): void {
    if (!this.hasMinimap) return
    this.minimap.hidden = !this.minimap.hidden
    byId('ph-map-btn').setAttribute('aria-expanded', String(!this.minimap.hidden))
    if (!this.minimap.hidden && this.mapVM) this.draw(this.mapVM)
  }

  private draw(vm: MinimapVM): void {
    const c = this.canvas
    if (c.width !== vm.widthTiles || c.height !== vm.heightTiles) {
      c.width = Math.max(1, vm.widthTiles)
      c.height = Math.max(1, vm.heightTiles)
    }
    const g = c.getContext('2d')
    if (!g) return
    const css = getComputedStyle(this.minimap)
    g.fillStyle = css.getPropertyValue('--px-map-bg').trim() || '#2b2f3a'
    g.fillRect(0, 0, c.width, c.height)
    for (const d of vm.dots) {
      g.fillStyle = d.color
      g.fillRect(d.tx - 1, d.ty - 1, 3, 3)
    }
    if (vm.player) {
      g.fillStyle = css.getPropertyValue('--px-map-player').trim() || '#ffffff'
      g.fillRect(vm.player.tx - 2, vm.player.ty - 2, 5, 5)
      g.fillStyle = '#000000'
      g.fillRect(vm.player.tx - 1, vm.player.ty - 1, 3, 3)
      g.fillStyle = css.getPropertyValue('--px-map-player').trim() || '#ffffff'
      g.fillRect(vm.player.tx, vm.player.ty, 1, 1)
    }
    this.minimap.dataset.dots = String(vm.dots.length)
  }

  // ── directory ─────────────────────────────────────────────────────────────────────────────────
  private toggleDirectory(): void {
    this.setDirectory(this.directory.hidden !== false)
  }

  private setDirectory(open: boolean): void {
    if (open && !this.hasDirectory) return
    this.directory.hidden = !open
    byId('ph-dir-btn').setAttribute('aria-expanded', String(open))
    if (open) this.search.focus()
    else if (this.directory.contains(document.activeElement))
      (document.activeElement as HTMLElement).blur()
  }

  private wing(w: DirectoryVM['wings'][number]): HTMLLIElement {
    const li = el('li', undefined, 'dir-wing')
    li.dataset.view = w.viewId
    const head = el('div', undefined, 'dir-row')
    head.append(
      this.pickButton(w.label, 'dir-name dir-wing-name', { viewId: w.viewId, travel: false }),
      this.goButton({ viewId: w.viewId, travel: true }, w.label),
    )
    li.append(head)
    for (const t of w.topics) {
      const topic = el('ul', undefined, 'dir-topic')
      topic.setAttribute('aria-label', t.label)
      const title = el('li', t.label, 'dir-topic-name muted')
      topic.append(title)
      for (const a of t.agents) {
        const row = el('li', undefined, 'dir-row dir-agent')
        row.dataset.agentId = a.id
        row.dataset.status = a.status
        const name = this.pickButton(a.name, 'dir-name', { agentId: a.id, travel: false })
        name.append(el('span', a.status, 'dir-status'))
        row.append(name, this.goButton({ agentId: a.id, travel: true }, a.name))
        topic.append(row)
      }
      li.append(topic)
    }
    return li
  }

  private pickButton(text: string, cls: string, pick: DirectoryPick): HTMLButtonElement {
    const b = el('button', undefined, cls)
    b.type = 'button'
    b.append(el('span', text))
    b.addEventListener('click', () => this.dirFn(pick))
    return b
  }

  private goButton(pick: DirectoryPick, name: string): HTMLButtonElement {
    const b = el('button', PIXEL_COPY.directory.goThere, 'dir-go btn small')
    b.type = 'button'
    b.setAttribute('aria-label', `${PIXEL_COPY.directory.goThere}: ${name}`)
    b.addEventListener('click', () => {
      this.dirFn(pick)
      this.setDirectory(false)
    })
    return b
  }

  private bindToggle(id: string, label: string, fn: () => void): void {
    const b = byId<HTMLButtonElement>(id)
    b.textContent = label
    b.setAttribute('aria-expanded', 'false')
    b.addEventListener('click', fn)
  }
}

function count(text: string, kind: string, n: number): HTMLSpanElement {
  const s = el('span', text, 'ph-count')
  s.dataset.kind = kind
  if (n > 0) s.dataset.active = 'true'
  return s
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
