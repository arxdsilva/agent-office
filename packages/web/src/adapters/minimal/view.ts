// Minimal mode's DOM view (docs/minimal-mode.md): a keyed patch of the live agent hierarchy.
// Nodes are rebuilt only when their hash changes and reordered only when the order changes, so an
// idle page produces no DOM mutations at all. Text only via textContent (PRIVACY_SECURITY rule).
import type { AgentNodeVM, HierarchyOpts, ProjectNodeVM } from '../../app/hierarchy-types.ts'
import { el } from '../dom/el.ts'

/** Indentation stops here; deeper levels get a "↳ depth N" label. */
const MAX_INDENT = 3
const ZOOM_MIN = 0.8
const ZOOM_MAX = 1.4
const ZOOM_STEP = 0.1

interface Entry {
  el: HTMLElement
  hash: string
  /** The rebuilt-on-change part (names, pills, task, activity, toggle). */
  head: HTMLElement
  kids: HTMLUListElement
  kidEntries: Map<string, Entry>
  fin: HTMLDetailsElement
  finSummary: HTMLElement
  finList: HTMLUListElement
  finEntries: Map<string, Entry>
}

interface ProjectEntry {
  el: HTMLElement
  hash: string
  head: HTMLElement
  roots: HTMLElement
  rootEntries: Map<string, Entry>
  unresolved: HTMLElement
  unTitle: HTMLElement
  unList: HTMLUListElement
  unEntries: Map<string, Entry>
}

function setAttr(e: Element, name: string, value: string): void {
  if (e.getAttribute(name) !== value) e.setAttribute(name, value)
}

function setText(e: Element, text: string): void {
  if (e.textContent !== text) e.textContent = text
}

/** Puts `nodes` in order inside `parent`, touching the DOM only where it differs. */
function reorder(parent: Element, nodes: Element[]): void {
  nodes.forEach((n, i) => {
    if (parent.children[i] !== n) parent.insertBefore(n, parent.children[i] ?? null)
  })
  while (parent.children.length > nodes.length) parent.lastElementChild!.remove()
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export interface MinimalViewOptions {
  /** Toolbar changed a hierarchy option. */
  onOpts: (opts: HierarchyOpts) => void
  /** A row was clicked (id) or the background (null). */
  onPick: (id: string | null) => void
}

export class MinimalView {
  readonly root: HTMLElement
  private toolbar: HTMLElement
  private list: HTMLElement
  private empty: HTMLElement
  private projects = new Map<string, ProjectEntry>()
  private collapsed = new Set<string>()
  private selected: string | null = null
  private zoom = 1
  private opts: HierarchyOpts = { activeOnly: false, showFinished: true }
  private last: ProjectNodeVM[] = []
  private zoomLabel: HTMLElement
  private onClick: (e: MouseEvent) => void
  private onKey: (e: KeyboardEvent) => void

  constructor(
    mount: HTMLElement,
    private cb: MinimalViewOptions,
  ) {
    this.root = el('div')
    this.root.id = 'minimal-root'
    this.toolbar = el('div', undefined, 'mm-toolbar')
    this.toolbar.id = 'minimal-toolbar'
    this.zoomLabel = el('span', '100%', 'mm-zoom-label')
    this.toolbar.append(
      this.toggle('Active only', 'activeOnly', false),
      this.toggle('Show finished', 'showFinished', true),
      this.btn('Zoom out', '−', () => this.setZoom(this.zoom - ZOOM_STEP)),
      this.zoomLabel,
      this.btn('Zoom in', '+', () => this.setZoom(this.zoom + ZOOM_STEP)),
      this.btn('Fit', 'Fit', () => {
        this.setZoom(1)
        this.root.scrollTop = 0
      }),
    )
    this.empty = el('p', 'No agents yet. They appear here as soon as they report.', 'mm-empty')
    this.list = el('div', undefined, 'mm-list')
    this.list.id = 'minimal-list'
    this.root.append(this.toolbar, this.empty, this.list)
    mount.append(this.root)
    this.onClick = (e) => {
      const t = e.target as Element | null
      if (!t || this.toolbar.contains(t) || t.closest('summary, button')) return
      const row = t.closest<HTMLElement>('[data-agent-id]')
      this.cb.onPick(row ? row.dataset.agentId! : null)
    }
    this.onKey = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      const t = e.target as HTMLElement
      if (!t.classList.contains('mm-head')) return
      const row = t.closest<HTMLElement>('[data-agent-id]')
      if (!row) return
      e.preventDefault()
      this.cb.onPick(row.dataset.agentId!)
    }
    this.root.addEventListener('click', this.onClick)
    this.root.addEventListener('keydown', this.onKey)
  }

  dispose(): void {
    this.root.removeEventListener('click', this.onClick)
    this.root.removeEventListener('keydown', this.onKey)
    this.root.remove()
  }

  get options(): HierarchyOpts {
    return this.opts
  }

  private btn(label: string, text: string, run: () => void): HTMLButtonElement {
    const b = el('button', text, 'mm-btn')
    b.type = 'button'
    b.setAttribute('aria-label', label)
    b.addEventListener('click', run)
    return b
  }

  private toggle(label: string, key: keyof HierarchyOpts, on: boolean): HTMLElement {
    const wrap = el('label', undefined, 'mm-check')
    const box = el('input')
    box.type = 'checkbox'
    box.checked = on
    box.addEventListener('change', () => {
      this.opts = { ...this.opts, [key]: box.checked }
      this.cb.onOpts(this.opts)
    })
    wrap.append(box, el('span', label))
    return wrap
  }

  private setZoom(z: number): void {
    this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 10) / 10))
    this.list.style.setProperty('zoom', String(this.zoom))
    setText(this.zoomLabel, `${Math.round(this.zoom * 100)}%`)
  }

  select(id: string | null): void {
    if (id === this.selected) return
    this.selected = id
    this.root.querySelectorAll('[aria-selected="true"]').forEach((n) => {
      n.removeAttribute('aria-selected')
    })
    if (id)
      this.root
        .querySelector(`[data-agent-id="${CSS.escape(id)}"]`)
        ?.setAttribute('aria-selected', 'true')
  }

  // ── Patch ──
  update(projects: ProjectNodeVM[]): void {
    this.last = projects
    this.empty.hidden = projects.length > 0
    const seen = new Set<string>()
    const nodes: HTMLElement[] = []
    for (const p of projects) {
      seen.add(p.id)
      let e = this.projects.get(p.id)
      if (!e) {
        e = this.makeProject(p)
        this.projects.set(p.id, e)
      }
      this.patchProject(e, p)
      nodes.push(e.el)
    }
    for (const id of [...this.projects.keys()]) if (!seen.has(id)) this.projects.delete(id)
    reorder(this.list, nodes)
  }

  private makeProject(p: ProjectNodeVM): ProjectEntry {
    const section = el('section', undefined, 'mm-project')
    section.dataset.projectId = p.id
    const head = el('header', undefined, 'mm-project-head')
    const roots = el('div', undefined, 'mm-roots')
    const unresolved = el('section', undefined, 'mm-unresolved')
    const unTitle = el('h3', undefined, 'mm-unresolved-title')
    const unList = el('ul', undefined, 'mm-children')
    unresolved.append(unTitle, unList)
    section.append(head, roots, unresolved)
    return {
      el: section,
      hash: '',
      head,
      roots,
      rootEntries: new Map(),
      unresolved,
      unTitle,
      unList,
      unEntries: new Map(),
    }
  }

  private patchProject(e: ProjectEntry, p: ProjectNodeVM): void {
    const hash = `${p.name}|${p.color}|${p.mainCount}|${p.subCount}|${p.active}`
    if (hash !== e.hash) {
      e.hash = hash
      e.el.style.setProperty('--c', p.color)
      const pill = el('span', p.active ? 'Active' : 'Idle', 'mm-pill')
      pill.dataset.active = String(p.active)
      e.head.replaceChildren(
        el('h2', p.name, 'mm-project-name'),
        el(
          'span',
          `${plural(p.mainCount, 'main agent', 'main agents')} · ${plural(p.subCount, 'subagent', 'subagents')}`,
          'mm-meta',
        ),
        pill,
      )
    }
    this.patchList(e.roots, e.rootEntries, p.roots, 'article')
    e.unresolved.hidden = p.unresolved.length === 0
    setText(e.unTitle, `Waiting for parent (${p.unresolved.length})`)
    this.patchList(e.unList, e.unEntries, p.unresolved, 'li')
  }

  private patchList(
    parent: Element,
    entries: Map<string, Entry>,
    nodes: AgentNodeVM[],
    tag: 'article' | 'li',
    finished = false,
  ): void {
    const seen = new Set<string>()
    const els: HTMLElement[] = []
    for (const n of nodes) {
      seen.add(n.id)
      let e = entries.get(n.id)
      if (!e) {
        e = this.makeAgent(tag)
        entries.set(n.id, e)
      }
      this.patchAgent(e, n, tag === 'article', finished)
      els.push(e.el)
    }
    for (const id of [...entries.keys()]) if (!seen.has(id)) entries.delete(id)
    reorder(parent, els)
  }

  private makeAgent(tag: 'article' | 'li'): Entry {
    const root = el(tag, undefined, tag === 'article' ? 'mm-agent' : 'mm-sub')
    const head = el('div', undefined, 'mm-head')
    head.tabIndex = 0
    const kids = el('ul', undefined, 'mm-children')
    const fin = el('details', undefined, 'mm-finished')
    const finSummary = el('summary')
    const finList = el('ul', undefined, 'mm-children')
    fin.append(finSummary, finList)
    root.append(head, kids, fin)
    return {
      el: root,
      hash: '',
      head,
      kids,
      kidEntries: new Map(),
      fin,
      finSummary,
      finList,
      finEntries: new Map(),
    }
  }

  private patchAgent(e: Entry, n: AgentNodeVM, main: boolean, finishedRow: boolean): void {
    const isCollapsed = this.collapsed.has(n.id)
    const hash = `${n.hash}|${n.activeChildren}|${isCollapsed}|${n.depth}|${main}`
    setAttr(e.el, 'data-agent-id', n.id)
    setAttr(e.el, 'data-lifecycle', n.lifecycle)
    if (hash !== e.hash) {
      e.hash = hash
      e.el.style.setProperty('--c', n.color)
      e.head.style.setProperty('--c', n.color)
      e.head.title = [n.name, n.provider, n.model].filter(Boolean).join(' · ')
      e.head.replaceChildren(...this.headChildren(e, n, main, isCollapsed, finishedRow))
    }
    if (this.selected === n.id) setAttr(e.el, 'aria-selected', 'true')
    const deep = n.depth > MAX_INDENT
    e.el.classList.toggle('mm-deep', deep)
    e.kids.hidden = isCollapsed || n.children.length === 0
    this.patchList(e.kids, e.kidEntries, n.children, 'li')
    e.fin.hidden = n.finished.length === 0
    setText(e.finSummary, `Recently finished (${n.finished.length})`)
    e.finList.hidden = !this.opts.showFinished
    this.patchList(e.finList, e.finEntries, n.finished, 'li', true)
  }

  private headChildren(
    e: Entry,
    n: AgentNodeVM,
    main: boolean,
    isCollapsed: boolean,
    finishedRow: boolean,
  ): HTMLElement[] {
    const top = el('div', undefined, 'mm-line')
    if (n.depth > MAX_INDENT) top.append(el('span', `↳ depth ${n.depth}`, 'mm-depth'))
    if (!main) top.append(el('span', '⑂', 'mm-fork'))
    top.append(el('span', n.name, 'mm-name'))
    const pill = el('span', n.pill, 'mm-pill')
    pill.dataset.lifecycle = n.lifecycle
    if (!main) top.append(el('span', undefined, 'mm-dot'))
    top.append(pill)
    const task = el('p', undefined, n.task === null ? 'mm-task mm-muted' : 'mm-task')
    task.textContent = main
      ? `${n.model ? `${n.model} · ` : ''}${n.task ?? 'Task not reported'}`
      : (n.task ?? 'Task not reported')
    const out: HTMLElement[] = [top, task]
    if (n.activity) out.push(el('p', n.activity, 'mm-activity'))
    if (!finishedRow && n.activeChildren > 0) {
      const t = el(
        'button',
        `${plural(n.activeChildren, 'active subagent', 'active subagents')} ${isCollapsed ? '▸' : '▾'}`,
        'mm-toggle',
      )
      t.type = 'button'
      t.setAttribute('aria-expanded', String(!isCollapsed))
      t.addEventListener('click', () => {
        if (this.collapsed.has(n.id)) this.collapsed.delete(n.id)
        else this.collapsed.add(n.id)
        this.update(this.last)
      })
      out.push(t)
    }
    void e
    return out
  }
}
