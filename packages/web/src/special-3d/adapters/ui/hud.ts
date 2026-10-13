// The Night City HUD (`#special-hud`, created here; styles in styles/special.css): project, active
// and waiting counts, location, the selected agent and the interaction prompt (app/special/
// hud-vm.ts), the camera/map/directory/settings buttons, a minimap (M) and an agent directory (J).
// Text only through textContent; removed on dispose.
import { STATUS_COLORS, type AgentStatus } from '@agent-office/shared'
import { el } from '../../../adapters/dom/el.ts'
import { SPECIAL_COPY } from '../../../app/special/copy.ts'
import type { SpecialHudVM } from '../../../app/special/hud-vm.ts'
import type { AABB, Vec2 } from '../../../app/office-types.ts'

export interface MapData {
  bounds: AABB
  rooms: { name: string; rect: AABB }[]
  agents: { id: string; pos: Vec2; status: AgentStatus }[]
  player: { pos: Vec2; heading: number } | null
}

export interface DirectoryEntry {
  id: string
  name: string
  status: AgentStatus
}

export class SpecialHud {
  readonly root = el('section', undefined, 'nc-hud')
  private project = el('strong', '', 'nc-project')
  private active = el('span', '', 'nc-count')
  private waiting = el('span', '', 'nc-count nc-waiting')
  private location = el('span', '', 'nc-location')
  private selected = el('p', '', 'nc-selected')
  private prompt = el('p', '', 'nc-prompt')
  private cameraBtn = el('button', '', 'nc-btn')
  private mapBtn = el('button', 'Map · M', 'nc-btn')
  private dirBtn = el('button', 'Directory · J', 'nc-btn')
  private settingsBtn = el('button', '⚙', 'nc-btn nc-icon')
  private map = el('section', undefined, 'nc-map nc-card')
  private canvas = el('canvas')
  private directory = el('section', undefined, 'nc-directory nc-card')
  private list = el('ul')
  private key = ''
  private dirKey = ''
  onCamera: () => void = () => {}
  onSettings: () => void = () => {}
  onPickAgent: (id: string) => void = () => {}

  constructor(parent: HTMLElement) {
    this.root.id = 'special-hud'
    this.root.setAttribute('aria-label', SPECIAL_COPY.mode)
    const status = el('div', undefined, 'nc-card nc-status')
    const row = (label: string, value: HTMLElement) => {
      const d = el('div', undefined, 'nc-row')
      d.append(el('span', label, 'nc-label'), value)
      return d
    }
    status.append(
      row(SPECIAL_COPY.hud.project, this.project),
      row(SPECIAL_COPY.hud.active, this.active),
      row(SPECIAL_COPY.hud.waiting, this.waiting),
      row(SPECIAL_COPY.hud.location, this.location),
    )
    this.active.dataset.special = 'active'
    this.waiting.dataset.special = 'waiting'
    const tools = el('div', undefined, 'nc-tools')
    for (const b of [this.cameraBtn, this.mapBtn, this.dirBtn, this.settingsBtn]) b.type = 'button'
    this.cameraBtn.dataset.action = 'camera'
    this.mapBtn.dataset.action = 'map'
    this.dirBtn.dataset.action = 'directory'
    this.settingsBtn.dataset.action = 'settings'
    this.settingsBtn.setAttribute('aria-label', SPECIAL_COPY.hud.settings)
    this.settingsBtn.title = SPECIAL_COPY.hud.settings
    tools.append(this.cameraBtn, this.mapBtn, this.dirBtn, this.settingsBtn)
    this.cameraBtn.addEventListener('click', () => this.onCamera())
    this.settingsBtn.addEventListener('click', () => this.onSettings())
    this.mapBtn.addEventListener('click', () => this.toggleMap())
    this.dirBtn.addEventListener('click', () => this.toggleDirectory())
    this.selected.hidden = true
    this.prompt.hidden = true
    this.prompt.setAttribute('role', 'status')
    this.map.hidden = true
    this.map.append(el('h2', 'Map', 'nc-h'), this.canvas)
    this.canvas.width = 280
    this.canvas.height = 220
    this.directory.hidden = true
    this.directory.append(el('h2', 'Directory', 'nc-h'), this.list)
    const keys = el('p', SPECIAL_COPY.hud.keys, 'nc-keys')
    this.root.append(status, tools, this.selected, this.prompt, this.map, this.directory, keys)
    parent.append(this.root)
  }

  render(vm: SpecialHudVM): void {
    const key = JSON.stringify(vm)
    if (key === this.key) return
    this.key = key
    this.project.textContent = vm.project
    this.active.textContent = String(vm.active)
    this.waiting.textContent = String(vm.waiting)
    this.location.textContent = vm.location
    this.location.dataset.special = 'location'
    this.cameraBtn.textContent = `${vm.camera} · F`
    this.selected.hidden = !vm.selected
    if (vm.selected) {
      this.selected.replaceChildren()
      const dot = el('span', '', 'nc-dot')
      dot.style.background = vm.selected.color
      this.selected.append(
        dot,
        el('strong', vm.selected.name),
        el('span', ` · ${vm.selected.label}`),
      )
      this.selected.dataset.agentId = vm.selected.id
    }
    this.prompt.hidden = !vm.prompt
    this.prompt.textContent = vm.prompt ?? ''
  }

  get mapOpen(): boolean {
    return !this.map.hidden
  }

  toggleMap(on = this.map.hidden): void {
    this.map.hidden = !on
  }

  toggleDirectory(on = this.directory.hidden): void {
    this.directory.hidden = !on
  }

  drawMap(d: MapData): void {
    if (this.map.hidden) return
    const g = this.canvas.getContext('2d')
    if (!g) return
    const { bounds: b } = d
    const W = this.canvas.width
    const H = this.canvas.height
    const s = Math.min((W - 16) / (b.maxX - b.minX), (H - 16) / (b.maxZ - b.minZ))
    // North (+z) up; x to the right.
    const px = (p: Vec2): [number, number] => [8 + (p.x - b.minX) * s, H - 8 - (p.z - b.minZ) * s]
    g.clearRect(0, 0, W, H)
    g.fillStyle = 'rgba(4,10,18,0.9)'
    g.fillRect(0, 0, W, H)
    g.strokeStyle = 'rgba(41,227,255,0.6)'
    g.lineWidth = 1
    for (const r of d.rooms) {
      const [x0, y0] = px({ x: r.rect.minX, z: r.rect.maxZ })
      const [x1, y1] = px({ x: r.rect.maxX, z: r.rect.minZ })
      g.strokeRect(x0, y0, x1 - x0, y1 - y0)
    }
    for (const a of d.agents) {
      const [x, y] = px(a.pos)
      g.fillStyle = STATUS_COLORS[a.status]
      g.fillRect(x - 2, y - 2, 4, 4)
    }
    if (d.player) {
      const [x, y] = px(d.player.pos)
      g.save()
      g.translate(x, y)
      g.rotate(-d.player.heading + Math.PI)
      g.fillStyle = '#ffb02e'
      g.beginPath()
      g.moveTo(0, -6)
      g.lineTo(4, 5)
      g.lineTo(-4, 5)
      g.closePath()
      g.fill()
      g.restore()
    }
  }

  renderDirectory(entries: DirectoryEntry[]): void {
    if (this.directory.hidden) return
    const key = entries.map((e) => `${e.id}|${e.name}|${e.status}`).join('\n')
    if (key === this.dirKey) return
    this.dirKey = key
    this.list.replaceChildren(
      ...entries.map((e) => {
        const li = el('li')
        const b = el('button', undefined, 'nc-dir-agent')
        b.type = 'button'
        b.dataset.agentId = e.id
        const dot = el('span', '', 'nc-dot')
        dot.style.background = STATUS_COLORS[e.status]
        b.append(dot, el('span', e.name), el('span', SPECIAL_COPY.status[e.status], 'nc-muted'))
        b.addEventListener('click', () => this.onPickAgent(e.id))
        li.append(b)
        return li
      }),
    )
  }

  dispose(): void {
    this.root.remove()
  }
}
