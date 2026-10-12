// PixelHudView port → the 2D mode's DOM overlay (plan §9):
//   #pixel-hud     room name, counts, the selected-agent chip (top-left), the M/J toggles and the
//                  zoom control (#pixel-zoom: − ⌂ +, plus the R run hint / "Run: on")
//   #pixel-alerts  clickable waiting / approval / error alerts (top-right, max 4 + "+N")
//   #minimap       a 320×280 map: the scene's base image (rooms, walls, furniture), the camera
//                  viewport, agents in status colours, you, wing/room labels and a legend.
//                  Click pans the camera there; shift-click travels the player (M toggles)
//   #directory     wings → topics → agents with search and "Go there" (J toggles)
// Text goes through textContent only; colours come from the VMs (shared status palette).
import { PIXEL_COPY } from '../../app/pixel-copy.ts'
import type { DirectoryVM, MinimapVM, PixelHudVM } from '../../app/pixel/types.ts'
import type { PixelHudView } from '../../ports.ts'
import { drawText, GLYPH_H, textWidth } from '../pixel/font.ts'
import { byId, el } from './el.ts'

/** The minimap canvas in CSS px; the map is fitted inside (letterboxed). */
export const MINIMAP_W = 320
export const MINIMAP_H = 280
const LEGEND: { kind: string; mark: string; text: string }[] = [
  { kind: 'working', mark: '●', text: 'working' },
  { kind: 'waiting', mark: '!', text: 'waiting' },
  { kind: 'error', mark: '✖', text: 'error' },
  { kind: 'you', mark: '■', text: 'you' },
]

/** The zoom control's copy (kept here: the HUD owns its own small labels). */
const ZOOM_COPY = {
  group: 'Zoom',
  buttons: [
    { delta: -1, text: '−', label: 'Zoom out (-)' },
    { delta: 0, text: '⌂', label: 'Default zoom' },
    { delta: 1, text: '+', label: 'Zoom in (+)' },
  ],
  runOff: 'R: run',
  runOn: 'Run: on',
} as const

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
  private base: { img: CanvasImageSource; w: number; h: number } | null = null
  /** The fitted map inside the canvas (CSS px): offset and px per tile. */
  private fit = { ox: 0, oy: 0, k: 1 }

  private alertFn: (agentId: string, opensPermission: boolean) => void = () => {}
  private mapFn: (tx: number, ty: number, opts?: { travel?: boolean }) => void = () => {}
  private dirFn: (pick: DirectoryPick) => void = () => {}
  private searchFn: (q: string) => void = () => {}
  private zoomFn: (delta: -1 | 0 | 1) => void = () => {}
  private zoomBox: HTMLElement
  private zoomButtons = new Map<-1 | 0 | 1, HTMLButtonElement>()
  private runHint: HTMLElement

  constructor() {
    byId('minimap-title').textContent = PIXEL_COPY.minimap.title
    byId('dir-title').textContent = PIXEL_COPY.directory.title
    this.search.placeholder = PIXEL_COPY.directory.search
    this.search.setAttribute('aria-label', PIXEL_COPY.directory.search)
    this.bindToggle('ph-map-btn', PIXEL_COPY.minimap.toggle, () => this.toggleMinimap())
    this.bindToggle('ph-dir-btn', PIXEL_COPY.directory.toggle, () => this.toggleDirectory())
    byId('dir-close').addEventListener('click', () => this.setDirectory(false))
    // The zoom control sits next to the M/J toggles.
    this.zoomBox = el('span', undefined, 'ph-zoom')
    this.zoomBox.id = 'pixel-zoom'
    this.zoomBox.setAttribute('role', 'group')
    this.zoomBox.setAttribute('aria-label', ZOOM_COPY.group)
    this.zoomBox.dataset.run = 'false'
    for (const z of ZOOM_COPY.buttons) {
      const b = el('button', z.text, 'ph-tool ph-zoom-btn')
      b.type = 'button'
      b.dataset.zoom = String(z.delta)
      b.title = z.label
      b.setAttribute('aria-label', z.label)
      b.addEventListener('click', () => this.zoomFn(z.delta))
      this.zoomButtons.set(z.delta, b)
      this.zoomBox.append(b)
    }
    this.runHint = el('span', ZOOM_COPY.runOff, 'ph-run')
    this.zoomBox.append(this.runHint)
    byId('ph-dir-btn').after(this.zoomBox)
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
      // Client px → canvas CSS px → tiles (inside the letterboxed map).
      const cx = ((e.clientX - r.left) / r.width) * MINIMAP_W
      const cy = ((e.clientY - r.top) / r.height) * MINIMAP_H
      const tx = Math.floor((cx - this.fit.ox) / this.fit.k)
      const ty = Math.floor((cy - this.fit.oy) / this.fit.k)
      const at = [clamp(tx, 0, vm.widthTiles - 1), clamp(ty, 0, vm.heightTiles - 1)] as const
      if (e.shiftKey) this.mapFn(at[0], at[1], { travel: true })
      else this.mapFn(at[0], at[1])
    })
    const legend = el('ul', undefined, 'minimap-legend')
    for (const l of LEGEND) {
      const li = el('li', undefined, 'minimap-legend-item')
      li.dataset.kind = l.kind
      li.append(el('span', l.mark, 'minimap-legend-mark'), el('span', l.text))
      legend.append(li)
    }
    this.canvas.after(legend)
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
  onMinimapPick(fn: (tx: number, ty: number, opts?: { travel?: boolean }) => void): void {
    this.mapFn = fn
  }
  onDirectory(fn: (pick: DirectoryPick) => void): void {
    this.dirFn = fn
  }
  onDirectorySearch(fn: (q: string) => void): void {
    this.searchFn = fn
  }
  onZoom(fn: (delta: -1 | 0 | 1) => void): void {
    this.zoomFn = fn
  }

  /** − is disabled at the most zoomed-out level (0), + at the most zoomed-in, ⌂ at the default. */
  renderZoom(z: { level: number; levels: number; atDefault: boolean; run: boolean }): void {
    this.zoomButtons.get(-1)!.disabled = z.level <= 0
    this.zoomButtons.get(1)!.disabled = z.level >= z.levels - 1
    this.zoomButtons.get(0)!.disabled = z.atDefault
    this.zoomBox.dataset.level = String(z.level)
    this.zoomBox.dataset.run = String(z.run)
    this.runHint.textContent = z.run ? ZOOM_COPY.runOn : ZOOM_COPY.runOff
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

  /** The scene's base image (wired in main.ts; outside the PixelHudView port). */
  setBase(img: CanvasImageSource, widthTiles: number, heightTiles: number): void {
    this.base = { img, w: widthTiles, h: heightTiles }
    if (!this.minimap.hidden && this.mapVM) this.draw(this.mapVM)
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
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1))
    if (c.width !== MINIMAP_W * dpr || c.height !== MINIMAP_H * dpr) {
      c.width = MINIMAP_W * dpr
      c.height = MINIMAP_H * dpr
    }
    const g = c.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.imageSmoothingEnabled = false
    const css = getComputedStyle(this.minimap)
    const color = (v: string, d: string) => css.getPropertyValue(v).trim() || d
    g.fillStyle = color('--px-map-bg', '#2b2f3a')
    g.fillRect(0, 0, MINIMAP_W, MINIMAP_H)
    // Fit the map's aspect into the panel.
    const k = Math.min(
      MINIMAP_W / Math.max(1, vm.widthTiles),
      MINIMAP_H / Math.max(1, vm.heightTiles),
    )
    const ox = (MINIMAP_W - vm.widthTiles * k) / 2
    const oy = (MINIMAP_H - vm.heightTiles * k) / 2
    this.fit = { ox, oy, k }
    const X = (tx: number) => ox + tx * k
    const Y = (ty: number) => oy + ty * k
    if (this.base && this.base.w === vm.widthTiles && this.base.h === vm.heightTiles)
      g.drawImage(this.base.img, ox, oy, vm.widthTiles * k, vm.heightTiles * k)
    // The camera's viewport.
    if (vm.viewport) {
      const v = vm.viewport
      g.strokeStyle = 'rgba(255,255,255,0.9)'
      g.lineWidth = 1
      g.strokeRect(
        Math.round(X(v.tx)) + 0.5,
        Math.round(Y(v.ty)) + 0.5,
        Math.round(v.tw * k),
        Math.round(v.th * k),
      )
    }
    // Agents: 3×3, waiting and error 5×5 and pulsing.
    const pulse = Math.floor(performance.now() / 500) % 2 === 0
    for (const d of vm.dots) {
      const flagged = d.waiting || d.error
      const size = flagged ? (pulse ? 5 : 4) : 3
      const x = Math.round(X(d.tx + 0.5) - size / 2)
      const y = Math.round(Y(d.ty + 0.5) - size / 2)
      if (flagged) {
        g.fillStyle = '#000000'
        g.fillRect(x - 1, y - 1, size + 2, size + 2)
      }
      g.fillStyle = d.color
      g.fillRect(x, y, size, size)
    }
    // Labels in the pixel font: wings in yellow, rooms in white, on a dark backing.
    for (const l of vm.labels ?? []) {
      const w = textWidth(l.text)
      const x = Math.round(X(l.tx + 0.5) - w / 2)
      const y = Math.round(Y(l.ty + 0.5) - GLYPH_H / 2)
      g.fillStyle = 'rgba(20,18,28,0.72)'
      g.fillRect(x - 2, y - 2, w + 4, GLYPH_H + 4)
      drawText(g, l.text, x, y, l.kind === 'wing' ? '#ffd23f' : '#f4f1ea')
    }
    // You: 5×5 with an outline.
    if (vm.player) {
      const x = Math.round(X(vm.player.tx + 0.5))
      const y = Math.round(Y(vm.player.ty + 0.5))
      g.fillStyle = '#000000'
      g.fillRect(x - 3, y - 3, 7, 7)
      g.fillStyle = color('--px-map-player', '#ffffff')
      g.fillRect(x - 2, y - 2, 5, 5)
    }
    this.minimap.dataset.dots = String(vm.dots.length)
    this.minimap.dataset.labels = String(vm.labels?.length ?? 0)
    this.minimap.dataset.base = this.base ? 'true' : 'false'
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
