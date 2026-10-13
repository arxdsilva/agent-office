// ShellView port → `#sidebar` (navigation, project list, management) and `#topbar` (search,
// project switcher, notifications, health), plus which workspace pane is visible.
import type { ShellVM, SidebarTarget, WorkspaceView } from '../../app/workspace/types.ts'
import type { ShellView } from '../../workspace-ports.ts'
import { el } from './el.ts'
import { Signal, dot, need, setText } from './ws-kit.ts'

const PANE: Record<WorkspaceView, string | null> = {
  office: null,
  overview: 'ws-overview',
  project: 'ws-project',
  sessions: 'ws-sessions',
  memory: 'ws-memory',
  context: 'ws-context',
}
const PANES = ['ws-overview', 'ws-project', 'ws-sessions', 'ws-memory', 'ws-context']
const ICON: Record<SidebarTarget, string> = {
  overview: '▣',
  office: '⌂',
  sessions: '☰',
  memory: '✦',
}

export class DomShell implements ShellView {
  private navigate = new Signal<[SidebarTarget]>()
  private select = new Signal<[string]>()
  private newProject = new Signal()
  private palette = new Signal()
  private newAgent = new Signal()
  private notify = new Signal()
  private health = new Signal()
  private collapse = new Signal<[boolean]>()

  private nav: HTMLElement
  private actions: HTMLElement
  private list: HTMLElement
  private empty: HTMLElement
  private heading: HTMLElement
  private newProjectBtn: HTMLButtonElement
  private searchText: HTMLElement
  private projectBtn: HTMLButtonElement
  private projectMenu: HTMLElement
  private healthBtn: HTMLButtonElement
  private notifyBtn: HTMLButtonElement
  private vault: HTMLElement
  private newSessionBtn: HTMLElement
  private navItems = new Map<SidebarTarget, HTMLButtonElement>()
  private built = false

  constructor(private doc: Document) {
    this.nav = need(doc, 'sb-nav')
    this.actions = need(doc, 'sb-actions')
    this.list = need(doc, 'sb-project-list')
    this.empty = need(doc, 'sb-projects-empty')
    this.heading = need(doc, 'sb-projects-h')
    this.newProjectBtn = need(doc, 'sb-new-project')
    this.searchText = need(doc, 'tb-search-text')
    this.projectBtn = need(doc, 'tb-project')
    this.projectMenu = need(doc, 'tb-project-menu')
    this.healthBtn = need(doc, 'tb-health')
    this.notifyBtn = need(doc, 'tb-notify')
    this.vault = need(doc, 'tb-vault')
    this.newSessionBtn = need(doc, 'new-session-btn')

    this.newProjectBtn.addEventListener('click', () => this.newProject.emit())
    need(doc, 'tb-search').addEventListener('click', () => this.palette.emit())
    this.healthBtn.addEventListener('click', () => this.health.emit())
    this.notifyBtn.addEventListener('click', () => this.notify.emit())
    this.projectBtn.addEventListener('click', () => this.toggleMenu())
    doc.addEventListener('click', (e) => {
      if (!this.projectMenu.hidden && !(e.target as Element)?.closest?.('.tb-project-wrap'))
        this.toggleMenu(false)
    })
    this.projectMenu.addEventListener('keydown', (e) => this.menuKey(e))
    this.projectBtn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        this.toggleMenu(true)
      }
    })
    const collapse = need<HTMLButtonElement>(doc, 'sb-collapse')
    collapse.addEventListener('click', () => this.collapse.emit(!this.isCollapsed()))
  }

  onNavigate(fn: (t: SidebarTarget) => void): void {
    this.navigate.on(fn)
  }
  onSelectProject(fn: (id: string) => void): void {
    this.select.on(fn)
  }
  onNewProject(fn: () => void): void {
    this.newProject.on(fn)
  }
  onOpenPalette(fn: () => void): void {
    this.palette.on(fn)
  }
  onNewAgent(fn: () => void): void {
    this.newAgent.on(fn)
  }
  onNotifications(fn: () => void): void {
    this.notify.on(fn)
  }
  onCollapse(fn: (collapsed: boolean) => void): void {
    this.collapse.on(fn)
  }
  onHealth(fn: () => void): void {
    this.health.on(fn)
  }

  render(vm: ShellVM): void {
    this.buildOnce(vm)
    this.setCollapsed(vm.layout.sidebarCollapsed)
    const body = this.doc.body
    body.dataset.view = vm.view
    body.dataset.stage = vm.stageVisible ? 'on' : 'off'
    const show = PANE[vm.view]
    for (const id of PANES) this.doc.getElementById(id)?.toggleAttribute('hidden', id !== show)

    for (const it of vm.sidebar) {
      const b = this.navItems.get(it.id)
      if (!b) continue
      b.classList.toggle('active', it.active)
      if (it.active) b.setAttribute('aria-current', 'page')
      else b.removeAttribute('aria-current')
      setText(b.querySelector('.sb-label')!, it.label)
      const c = b.querySelector<HTMLElement>('.sb-badge')!
      c.hidden = it.count <= 0
      setText(c, String(it.count))
      b.title = it.label
    }
    setText(this.heading, vm.projectsHeading)
    setText(this.newProjectBtn, '+')
    this.newProjectBtn.setAttribute('aria-label', vm.newProjectLabel)
    this.newProjectBtn.title = vm.newProjectLabel
    this.renderProjects(vm)

    const t = vm.topbar
    setText(this.searchText, t.searchPlaceholder)
    need(this.doc, 'tb-search').setAttribute('aria-label', t.searchPlaceholder)
    this.projectBtn.replaceChildren(
      t.currentProject ? dot('neutral', t.currentProject.color) : dot('neutral'),
      el('span', t.projectLabel, 'tb-pill-text'),
      el('span', '▾', 'tb-caret'),
    )
    this.projectBtn.setAttribute('aria-label', t.projectLabel)
    this.renderMenu(vm)

    this.healthBtn.replaceChildren(dot(t.health.tone), el('span', t.health.label, 'tb-pill-text'))
    this.healthBtn.title = t.health.detail
    this.healthBtn.className = `tb-pill tb-health tone-${t.health.tone}`

    const n = t.notifications
    this.notifyBtn.replaceChildren(
      el('span', '🔔', 'tb-bell'),
      ...(n > 0 ? [el('span', String(n), 'tb-count')] : []),
    )
    this.notifyBtn.setAttribute('aria-label', t.notificationsLabel)
    this.notifyBtn.title = t.notificationsLabel
    this.notifyBtn.classList.toggle('has-items', n > 0)

    this.vault.hidden = t.vault.status !== 'memory-only'
    this.vault.className = `tb-status tone-${t.vault.tone}`
    this.vault.replaceChildren(dot(t.vault.tone), el('span', t.vault.label))
    setText(this.newSessionBtn, t.newAgentLabel)
  }

  private buildOnce(vm: ShellVM): void {
    if (this.built) return
    this.built = true
    const search = this.item('sb-search', '⌕', vm.topbar.searchPlaceholder.split('  ')[0] ?? '')
    search.querySelector('.sb-label')!.textContent = 'Search'
    search.addEventListener('click', () => this.palette.emit())
    const agent = this.item('sb-new-agent', '＋', vm.topbar.newAgentLabel)
    agent.classList.add('primary')
    agent.addEventListener('click', () => this.newAgent.emit())
    this.actions.replaceChildren(search, agent)

    const nav: Node[] = [el('h2', 'Workspace', 'sb-heading')]
    for (const it of vm.sidebar) {
      const b = this.item(`sb-${it.id}`, ICON[it.id], it.label)
      const badge = el('span', '0', 'sb-badge')
      badge.hidden = true
      b.append(badge)
      b.addEventListener('click', () => this.navigate.emit(it.id))
      this.navItems.set(it.id, b)
      nav.push(b)
    }
    this.nav.replaceChildren(...nav)
  }

  private item(id: string, ico: string, label: string): HTMLButtonElement {
    const b = el('button', undefined, 'sb-item')
    b.type = 'button'
    b.id = id
    const i = el('span', ico, 'sb-ico')
    i.setAttribute('aria-hidden', 'true')
    b.append(i, el('span', label, 'sb-label'))
    b.title = label
    return b
  }

  private renderProjects(vm: ShellVM): void {
    const items = vm.projects.map((p) => {
      const li = el('li', undefined, `sb-proj${p.active ? ' active' : ''}`)
      li.dataset.projectId = p.projectId
      const b = el('button', undefined, 'sb-item')
      b.type = 'button'
      b.title = p.name
      if (p.active) b.setAttribute('aria-current', 'true')
      const d = dot('neutral', p.color)
      d.classList.add('sb-proj-dot')
      b.append(d, el('span', p.name, 'sb-label'))
      if (p.pending > 0) {
        const pend = el('span', undefined, 'sb-pending')
        pend.title = `${p.pending} pending review`
        pend.setAttribute('aria-label', `${p.pending} pending review`)
        b.append(pend)
      }
      b.append(el('span', String(p.count), `sb-count${p.count === 0 ? ' zero' : ''}`))
      b.addEventListener('click', () => this.select.emit(p.projectId))
      li.append(b)
      return li
    })
    this.list.replaceChildren(...items)
    this.empty.hidden = vm.projectsEmpty === null
    if (vm.projectsEmpty !== null) setText(this.empty, vm.projectsEmpty)
  }

  private renderMenu(vm: ShellVM): void {
    const mk = (label: string, color: string | null, run: () => void, current: boolean) => {
      const li = el('li', undefined, 'tb-menu-item')
      li.setAttribute('role', 'none')
      const b = el('button', undefined, current ? 'current' : '')
      b.type = 'button'
      b.setAttribute('role', 'menuitem')
      b.append(color ? dot('neutral', color) : dot('neutral'), el('span', label))
      b.addEventListener('click', () => {
        this.toggleMenu(false)
        run()
      })
      li.append(b)
      return li
    }
    const items = [
      mk(
        vm.topbar.currentProject ? 'All projects' : vm.topbar.projectLabel,
        null,
        () => this.navigate.emit('overview'),
        !vm.topbar.currentProject,
      ),
      ...vm.projects.map((p) => mk(p.name, p.color, () => this.select.emit(p.projectId), p.active)),
    ]
    this.projectMenu.replaceChildren(...items)
  }

  private toggleMenu(open?: boolean): void {
    const next = open ?? this.projectMenu.hidden
    this.projectMenu.hidden = !next
    this.projectBtn.setAttribute('aria-expanded', String(next))
    if (next) this.projectMenu.querySelector<HTMLElement>('button')?.focus()
  }

  private menuKey(e: KeyboardEvent): void {
    const btns = [...this.projectMenu.querySelectorAll<HTMLElement>('button')]
    const i = btns.indexOf(this.doc.activeElement as HTMLElement)
    if (e.key === 'ArrowDown') btns[(i + 1) % btns.length]?.focus()
    else if (e.key === 'ArrowUp') btns[(i - 1 + btns.length) % btns.length]?.focus()
    else if (e.key === 'Escape') {
      // Close only the menu; the global Esc handler leaves menus alone.
      e.stopPropagation()
      this.toggleMenu(false)
      this.projectBtn.focus()
    } else return
    e.preventDefault()
  }

  private isCollapsed = (): boolean => this.doc.body.classList.contains('sb-collapsed')

  private setCollapsed(on: boolean): void {
    this.doc.body.classList.toggle('sb-collapsed', on)
    const b = need<HTMLButtonElement>(this.doc, 'sb-collapse')
    b.setAttribute('aria-pressed', String(on))
    b.setAttribute('aria-label', on ? 'Expand the sidebar' : 'Collapse the sidebar')
    b.textContent = on ? '\u203A' : '\u2039'
  }
}
