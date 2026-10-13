// DashboardView port → `#ws-project`: the five questions about a project, each with its
// evidence, plus metric tiles and quick actions.
import type {
  ActivityFilter,
  DashboardRowVM,
  DashboardSectionVM,
  DashboardVM,
  WorkspaceAction,
} from '../../app/workspace/types.ts'
import type { DashboardView, TaskState } from '../../workspace-ports.ts'
import { el } from './el.ts'
import { Signal, activatable, badge, chip, dot, need, notice, vmButton } from './ws-kit.ts'

type SectionId = DashboardSectionVM['id']

/** Day heading from the row's `day` ('today' | 'yesterday' | ISO date). */
export function dayGroup(day: string | undefined): string {
  if (!day || day === 'today') return 'Today'
  return day === 'yesterday' ? 'Yesterday' : day
}

/** Splits "actor · 3m ago" into its parts. */
export function splitMeta(detail: string): { who: string; when: string } {
  const i = detail.lastIndexOf(' · ')
  return i < 0 ? { who: '', when: detail } : { who: detail.slice(0, i), when: detail.slice(i + 3) }
}

export function metricsOf(
  vm: DashboardVM,
): { id: string; label: string; value: string; note: string }[] {
  const m = vm.metrics
  return [
    {
      id: 'agents',
      label: 'Active agents',
      value: String(m.activeAgents),
      note: m.waiting ? `${m.waiting} waiting for you` : 'none waiting',
    },
    { id: 'sessions', label: 'Sessions', value: String(m.sessions), note: 'in this project' },
    {
      id: 'memories',
      label: 'Memories',
      value: String(m.approvedMemories),
      note: `${m.pendingMemories} pending review`,
    },
    { id: 'tasks', label: 'Open tasks', value: String(m.openTasks), note: 'open or in progress' },
  ]
}

export class DomDashboard implements DashboardView {
  private action = new Signal<[WorkspaceAction]>()
  private filter = new Signal<[ActivityFilter]>()
  private taskAdd = new Signal<[string, string]>()
  private taskState = new Signal<[string, TaskState]>()
  private taskConfirm = new Signal<[string]>()
  private root: HTMLElement

  constructor(doc: Document) {
    this.root = need(doc, 'ws-project')
  }

  onAction(fn: (a: WorkspaceAction) => void): void {
    this.action.on(fn)
  }
  onActivityFilter(fn: (f: ActivityFilter) => void): void {
    this.filter.on(fn)
  }

  onTaskAdd(fn: (projectId: string, title: string) => void): void {
    this.taskAdd.on(fn)
  }
  onTaskState(fn: (taskId: string, state: TaskState) => void): void {
    this.taskState.on(fn)
  }
  onTaskConfirm(fn: (taskId: string) => void): void {
    this.taskConfirm.on(fn)
  }

  render(vm: DashboardVM | null): void {
    // A task being typed survives the refresh that follows every change.
    const typing = this.root.ownerDocument.getElementById(
      'pd-task-input',
    ) as HTMLInputElement | null
    const draft = typing?.value ?? ''
    const hadFocus = !!typing && typing.ownerDocument.activeElement === typing
    this.draw(vm)
    const input = this.root.ownerDocument.getElementById('pd-task-input') as HTMLInputElement | null
    if (input && draft) input.value = draft
    if (input && hadFocus) input.focus()
  }

  private draw(vm: DashboardVM | null): void {
    if (!vm) {
      this.root.replaceChildren()
      return
    }
    const inner = el('div', undefined, 'ws-inner pd')
    inner.dataset.projectId = vm.projectId
    inner.append(this.hero(vm))
    if (vm.error) inner.append(notice(vm.error, 'error'))
    if (vm.loading && !vm.sections.length) inner.append(notice('Loading…', 'info'))

    if (vm.sections.length) {
      inner.append(this.metrics(vm))
      const by = (id: SectionId) => vm.sections.find((s) => s.id === id)
      const left = el('div', undefined, 'pd-col')
      const right = el('div', undefined, 'pd-col')
      for (const [col, ids] of [
        [left, ['active', 'tasks', 'knowledge'] as SectionId[]],
        [right, ['activity', 'completed'] as SectionId[]],
      ] as const) {
        for (const id of ids) {
          const s = by(id)
          if (s) col.append(this.section(s, vm))
        }
      }
      const grid = el('div', undefined, 'pd-grid')
      grid.append(left, right)
      inner.append(grid)
    }
    this.root.replaceChildren(inner)
  }

  private hero(vm: DashboardVM): HTMLElement {
    const hero = el('header', undefined, 'pd-hero card')
    const sw = el('span', undefined, 'pd-swatch')
    sw.style.background = vm.color
    sw.textContent = [...vm.name.trim()][0]?.toUpperCase() ?? ''
    hero.style.setProperty('--pd-color', vm.color)
    sw.setAttribute('aria-hidden', 'true')
    const titles = el('div', undefined, 'pd-titles')
    titles.append(el('h1', vm.name, 'pane-title'))
    if (vm.subtitle) titles.append(el('p', vm.subtitle, 'pane-sub muted'))
    const top = el('div', undefined, 'pd-hero-top')
    top.append(sw, titles)
    if (vm.repos.length) {
      const repos = el('ul', undefined, 'pd-repos')
      for (const r of vm.repos) {
        const li = el('li')
        li.append(chip(`⎇ ${r}`, 'repo'))
        repos.append(li)
      }
      top.append(repos)
    }
    if (vm.providers.length) {
      const prov = el('ul', undefined, 'pd-repos')
      for (const p of vm.providers) {
        const li = el('li')
        li.append(chip(p.label, 'provider'))
        prov.append(li)
      }
      top.append(prov)
    }
    const actions = el('div', undefined, 'pd-actions')
    actions.id = 'pd-actions'
    actions.setAttribute('role', 'group')
    actions.setAttribute('aria-label', 'Quick actions')
    vm.actions.forEach((b, i) =>
      actions.append(
        vmButton(
          b,
          i === 0 ? 'primary' : 'secondary',
          (a) => a && this.action.emit(a),
          `pd-act-${b.id}`,
        ),
      ),
    )
    hero.append(top, actions)
    return hero
  }

  private metrics(vm: DashboardVM): HTMLElement {
    const ul = el('ul', undefined, 'pd-metrics')
    for (const m of metricsOf(vm)) {
      const li = el('li', undefined, 'metric card')
      li.id = `pd-m-${m.id}`
      li.append(
        el('span', m.label, 'metric-label'),
        el('strong', m.value, 'metric-value'),
        el('span', m.note, 'metric-note muted'),
      )
      ul.append(li)
    }
    return ul
  }

  private section(s: DashboardSectionVM, vm: DashboardVM): HTMLElement {
    const sec = el('section', undefined, `pd-sec card pd-${s.id}`)
    sec.id = `pd-${s.id}`
    sec.setAttribute('aria-labelledby', `pd-${s.id}-h`)
    const head = el('div', undefined, 'sec-head')
    const h = el('h2', s.heading, 'sec-title')
    h.id = `pd-${s.id}-h`
    head.append(h)
    if (s.rows.length) head.append(el('span', String(s.rows.length), 'sec-count'))
    sec.append(head)
    if (s.id === 'activity') sec.append(this.filters(vm))
    if (s.id === 'tasks') sec.append(this.taskForm(vm))

    if (!s.rows.length) {
      sec.append(el('p', s.empty, 'sec-empty muted'))
      return sec
    }
    if (s.id === 'activity') sec.append(this.timeline(s.rows))
    else {
      const ul = el('ul', undefined, 'rows')
      for (const r of s.rows) ul.append(this.row(r, s.id))
      sec.append(ul)
    }
    return sec
  }

  private taskForm(vm: DashboardVM): HTMLElement {
    const form = el('form', undefined, 'pd-task-form')
    const input = el('input', undefined, 'search-input')
    input.id = 'pd-task-input'
    input.type = 'text'
    input.maxLength = 120
    input.autocomplete = 'off'
    input.placeholder = vm.taskForm.placeholder
    input.setAttribute('aria-label', vm.taskForm.placeholder)
    const add = el('button', vm.taskForm.addLabel, 'btn small')
    add.id = 'pd-task-add'
    add.type = 'submit'
    form.append(input, add)
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const title = input.value.trim()
      if (!title) return
      input.value = ''
      this.taskAdd.emit(vm.projectId, title)
    })
    return form
  }

  private taskControls(li: HTMLLIElement, r: DashboardRowVM): void {
    const t = r.task
    if (!t) return
    li.dataset.taskId = t.taskId
    const sel = el('select', undefined, 'select task-state')
    sel.setAttribute('aria-label', `State of ${r.title}`)
    for (const o of t.stateOptions) {
      const opt = el('option', o.label)
      opt.value = o.value
      opt.selected = o.value === t.state
      sel.append(opt)
    }
    sel.addEventListener('change', () => this.taskState.emit(t.taskId, sel.value as TaskState))
    const confirm = vmButton(t.confirm, 'small task-confirm', () => {})
    confirm.addEventListener('click', () => this.taskConfirm.emit(t.taskId))
    // Right-hand cluster (evidence badge, state, Confirm); it wraps under the title when narrow.
    const controls = el('div', undefined, 'task-controls')
    const evidence = li.querySelector(':scope > .badge-t')
    if (evidence) controls.append(evidence)
    controls.append(sel, confirm)
    li.append(controls)
  }

  private filters(vm: DashboardVM): HTMLElement {
    const bar = el('div', undefined, 'filters')
    bar.setAttribute('role', 'group')
    bar.setAttribute('aria-label', 'Filter the activity')
    for (const f of vm.activityFilters) {
      const b = el('button', f.label, `filter${f.active ? ' active' : ''}`)
      b.type = 'button'
      b.dataset.filter = f.id
      b.setAttribute('aria-pressed', String(f.active))
      b.addEventListener('click', () => this.filter.emit(f.id))
      bar.append(b)
    }
    return bar
  }

  private row(r: DashboardRowVM, kind: SectionId): HTMLLIElement {
    const li = el('li', undefined, `row tone-${r.tone}${r.task ? ' task-row' : ''}`)
    li.dataset.rowId = r.id
    const main = el('div', undefined, 'row-main')
    const title = el('div', undefined, 'row-title')
    title.append(dot(r.tone), el('span', r.title))
    main.append(title)
    if (r.detail) {
      const detail = el('div', undefined, 'row-detail muted')
      if (kind === 'active') {
        const [provider, ...rest] = r.detail.split(' · ')
        detail.append(chip(provider ?? '', 'provider'))
        if (rest.length) detail.append(el('span', rest.join(' · ')))
      } else detail.textContent = r.detail
      main.append(detail)
    }
    li.append(main)
    if (r.badge) {
      const warn = r.tone === 'warn'
      li.append(badge(r.badge, kind === 'active' ? 'good' : warn ? 'warn' : r.tone))
    }
    this.taskControls(li, r)
    if (r.action) {
      const a = r.action
      activatable(li, () => this.action.emit(a))
      li.classList.add('clickable')
    }
    return li
  }

  private timeline(rows: DashboardRowVM[]): HTMLElement {
    const wrap = el('div', undefined, 'timeline')
    let group = ''
    let ol: HTMLOListElement | null = null
    for (const r of rows) {
      const g = dayGroup(r.day)
      if (g !== group || !ol) {
        group = g
        wrap.append(el('h3', g, 'day'))
        ol = el('ol', undefined, 'tl')
        wrap.append(ol)
      }
      const { who, when } = splitMeta(r.detail)
      const li = el('li', undefined, `tl-item tone-${r.tone}`)
      li.dataset.rowId = r.id
      li.append(dot(r.tone))
      const body = el('div', undefined, 'tl-body')
      body.append(el('span', r.title, 'tl-title'))
      const meta = el('span', undefined, 'tl-meta muted')
      if (who) meta.append(chip(who, 'actor'))
      meta.append(el('span', when))
      body.append(meta)
      li.append(body)
      if (r.action) {
        const a = r.action
        activatable(li, () => this.action.emit(a))
        li.classList.add('clickable')
      }
      ol.append(li)
    }
    return wrap
  }
}
