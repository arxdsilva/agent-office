// LibraryView → `<aside id="library">`, the left drawer listing a provider's skills, rules, memory
// and adapters (low-spec plan §B2). Rows are a listbox: ↑/↓ move (also from the search box), Enter
// opens, Esc closes. Decisions (filtering, counts, sorting, empty texts) come from the LibraryVM.
import { LIB_COPY } from '../../app/library-copy.ts'
import type { LibraryRowVM, LibrarySort, LibraryTab, LibraryVM } from '../../app/library-types.ts'
import type { CapabilityRef, LibraryView } from '../../ports.ts'
import { byId, el } from './el.ts'

const SORTS: LibrarySort[] = ['recent', 'az', 'shelf']
const TABS: LibraryTab[] = ['skills', 'rules', 'memory', 'adapters']

export class DomLibrary implements LibraryView {
  private root = byId('library')
  private search = byId<HTMLInputElement>('lib-search')
  private provider = byId<HTMLSelectElement>('lib-provider')
  private sort = byId<HTMLSelectElement>('lib-sort')
  private tabs = byId('lib-tabs')
  private rows = byId('lib-rows')
  private closeFn: () => void = () => {}
  private providerFn: (p: string) => void = () => {}
  private tabFn: (t: LibraryTab) => void = () => {}
  private searchFn: (q: string) => void = () => {}
  private sortFn: (s: LibrarySort) => void = () => {}
  private pickFn: (ref: CapabilityRef) => void = () => {}
  /** Option elements in list order (shelf rows, then overflow) with their refs. */
  private options: { node: HTMLElement; ref: CapabilityRef }[] = []
  /** Row nodes by capability id, reused while the row's data is unchanged (agents update often). */
  private rowCache = new Map<string, { key: string; node: HTMLElement }>()
  private overflowGroup: { key: string; node: HTMLElement } | null = null
  private tabsKey = ''
  /** Keyboard cursor: the active option's capability id. */
  private active: string | null = null
  private focusKey = ''

  constructor() {
    const close = byId('lib-close')
    close.setAttribute('aria-label', LIB_COPY.close)
    close.title = LIB_COPY.close
    close.addEventListener('click', () => this.dismiss())

    this.search.placeholder = LIB_COPY.search
    this.search.setAttribute('aria-label', LIB_COPY.search)
    this.search.setAttribute('aria-controls', 'lib-rows')
    this.search.addEventListener('input', () => this.searchFn(this.search.value))

    this.provider.setAttribute('aria-label', 'Provider')
    this.provider.addEventListener('change', () => this.providerFn(this.provider.value))

    byId('lib-sort-l').textContent = 'Sort:'
    this.sort.replaceChildren(
      ...SORTS.map((s) => {
        const o = el('option', LIB_COPY.sort[s])
        o.value = s
        return o
      }),
    )
    this.sort.addEventListener('change', () => {
      const s = SORTS.find((x) => x === this.sort.value)
      if (s) this.sortFn(s)
    })

    this.tabs.setAttribute('aria-label', LIB_COPY.views.library)
    this.tabs.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key]
      if (!step) return
      e.preventDefault()
      const list = [...this.tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      const i = list.findIndex((t) => t.getAttribute('aria-selected') === 'true')
      const next = list[(i + step + list.length) % list.length]
      next?.focus()
      next?.click()
    })

    this.root.addEventListener('keydown', (e) => this.onKey(e))
  }

  onClose(fn: () => void): void {
    this.closeFn = fn
  }
  onProvider(fn: (provider: string) => void): void {
    this.providerFn = fn
  }
  onTab(fn: (tab: LibraryTab) => void): void {
    this.tabFn = fn
  }
  onSearch(fn: (query: string) => void): void {
    this.searchFn = fn
  }
  onSort(fn: (sort: LibrarySort) => void): void {
    this.sortFn = fn
  }
  onPick(fn: (ref: CapabilityRef) => void): void {
    this.pickFn = fn
  }

  isOpen(): boolean {
    return !this.root.hidden
  }

  open(vm: LibraryVM): void {
    const wasOpen = this.isOpen()
    this.root.hidden = false
    byId('library-btn')?.setAttribute('aria-expanded', 'true')
    this.render(vm)
    if (!wasOpen) {
      this.search.focus()
      this.search.select()
    }
  }

  close(): void {
    this.root.hidden = true
    this.active = null
    this.focusKey = ''
    byId('library-btn')?.setAttribute('aria-expanded', 'false')
  }

  render(vm: LibraryVM): void {
    if (!this.isOpen()) return
    byId('lib-title').textContent = LIB_COPY.title(vm.provider)
    this.renderProviders(vm)
    if (document.activeElement !== this.search) this.search.value = vm.query
    this.sort.value = vm.sort
    this.renderTabs(vm)
    this.renderRows(vm)
    this.applyFocus(vm)
  }

  private dismiss(): void {
    this.close()
    this.closeFn()
    byId('library-btn')?.focus()
  }

  private renderProviders(vm: LibraryVM): void {
    this.provider.hidden = vm.providers.length < 2
    const key = vm.providers.join('|')
    if (this.provider.dataset.key !== key) {
      this.provider.dataset.key = key
      this.provider.replaceChildren(
        ...vm.providers.map((p) => {
          const o = el('option', p)
          o.value = p
          return o
        }),
      )
    }
    this.provider.value = vm.provider
  }

  private renderTabs(vm: LibraryVM): void {
    const tabs = [...vm.tabs].sort((a, b) => TABS.indexOf(a.id) - TABS.indexOf(b.id))
    const key = JSON.stringify([tabs, vm.tab])
    this.rows.setAttribute('aria-labelledby', `lib-tab-${vm.tab}`)
    if (key === this.tabsKey) return
    this.tabsKey = key
    this.tabs.replaceChildren(
      ...tabs.map((t) => {
        const on = t.id === vm.tab
        const b = el('button', undefined, 'lib-tab')
        b.type = 'button'
        b.id = `lib-tab-${t.id}`
        b.dataset.tab = t.id
        b.setAttribute('role', 'tab')
        b.setAttribute('aria-selected', String(on))
        b.setAttribute('aria-controls', 'lib-rows')
        b.tabIndex = on ? 0 : -1
        b.append(el('span', t.label, 'lib-tab-label'), ' ', el('span', String(t.count), 'count'))
        b.addEventListener('click', () => {
          if (t.id !== vm.tab) this.tabFn(t.id)
        })
        return b
      }),
    )
    this.rows.setAttribute('aria-labelledby', `lib-tab-${vm.tab}`)
  }

  private renderRows(vm: LibraryVM): void {
    this.options = []
    const empty = byId('lib-empty')
    const nothing = !vm.rows.length && !vm.overflow.length
    empty.hidden = !nothing || !vm.empty
    empty.textContent = nothing ? (vm.empty ?? '') : ''
    this.rows.hidden = nothing

    const seen = new Set<string>()
    const children: HTMLElement[] = vm.rows.map((r) => this.row(r, seen))
    if (vm.overflow.length) {
      const label = vm.overflowLabel ?? LIB_COPY.overflow(vm.overflow.length)
      const rows = vm.overflow.map((r) => this.row(r, seen))
      if (this.overflowGroup?.key !== label) {
        const group = el('div', undefined, 'lib-overflow')
        group.setAttribute('role', 'group')
        group.id = 'lib-overflow'
        const head = el('div', label, 'lib-group')
        head.id = 'lib-overflow-h'
        head.setAttribute('role', 'presentation')
        group.setAttribute('aria-labelledby', head.id)
        group.append(head)
        this.overflowGroup = { key: label, node: group }
      }
      const group = this.overflowGroup.node
      const head = group.firstElementChild!
      if (!sameChildren(group, [head, ...rows])) group.replaceChildren(head, ...rows)
      children.push(group)
    }
    for (const id of this.rowCache.keys()) if (!seen.has(id)) this.rowCache.delete(id)
    // Replace only when something changed, so a row under the pointer stays the same element.
    if (!sameChildren(this.rows, children)) this.rows.replaceChildren(...children)
    if (!this.options.some((o) => o.ref.id === this.active)) this.active = null
    this.markActive(false)
  }

  private row(r: LibraryRowVM, seen: Set<string>): HTMLElement {
    seen.add(r.ref.id)
    const key = JSON.stringify(r)
    const hit = this.rowCache.get(r.ref.id)
    const node = hit?.key === key ? hit.node : this.buildRow(r)
    if (hit?.key !== key) this.rowCache.set(r.ref.id, { key, node })
    node.id = `lib-opt-${this.options.length}`
    this.options.push({ node, ref: r.ref })
    return node
  }

  private buildRow(r: LibraryRowVM): HTMLElement {
    const node = el('div', undefined, 'lib-row')
    node.setAttribute('role', 'option')
    node.setAttribute('aria-selected', 'false')
    node.tabIndex = -1
    node.dataset.capabilityId = r.ref.id
    node.dataset.provider = r.ref.provider
    if (r.slot !== undefined) node.dataset.slot = String(r.slot)

    const head = el('div', undefined, 'lib-row-head')
    const icon = el('span', r.icon, 'lib-icon')
    icon.setAttribute('aria-hidden', 'true')
    head.append(icon, el('span', r.label, 'lib-label'))
    if (r.scope) head.append(el('span', LIB_COPY.scope[r.scope], `lib-scope ${r.scope}`))
    if (r.inUse) head.append(el('span', LIB_COPY.inUse, 'lib-inuse'))
    node.append(head)
    if (r.summary) node.append(el('p', r.summary, 'lib-summary'))
    node.append(el('p', r.usage, 'lib-usage muted'))
    if (r.canSee?.length)
      node.append(el('p', `${LIB_COPY.canSee}: ${r.canSee.join(' · ')}`, 'lib-cansee muted'))

    const ref = r.ref
    node.addEventListener('click', () => {
      this.active = ref.id
      this.markActive(false)
      this.pickFn(ref)
    })
    return node
  }

  /** `vm.focus`: scroll to the overflow group or a row once per new focus request. */
  private applyFocus(vm: LibraryVM): void {
    const key = `${vm.provider}|${vm.tab}|${vm.focus ?? ''}`
    if (!vm.focus || key === this.focusKey) return
    this.focusKey = key
    if (vm.focus === 'overflow') {
      document.getElementById('lib-overflow')?.scrollIntoView({ block: 'start' })
      return
    }
    const hit = this.options.find((o) => o.ref.id === vm.focus)
    if (!hit) return
    this.active = hit.ref.id
    this.markActive(false)
    hit.node.scrollIntoView({ block: 'nearest' })
  }

  private markActive(focus: boolean): void {
    let current: HTMLElement | null = null
    for (const o of this.options) {
      const on = o.ref.id === this.active
      o.node.setAttribute('aria-selected', String(on))
      o.node.classList.toggle('active', on)
      if (on) current = o.node
    }
    if (current) {
      this.search.setAttribute('aria-activedescendant', current.id)
      this.rows.setAttribute('aria-activedescendant', current.id)
      current.scrollIntoView({ block: 'nearest' })
      if (focus && document.activeElement !== this.search) current.focus()
    } else {
      this.search.removeAttribute('aria-activedescendant')
      this.rows.removeAttribute('aria-activedescendant')
    }
  }

  private onKey(e: KeyboardEvent): void {
    // Keep the scene's shortcuts (F walk, Esc deselect, WASD) quiet while the drawer has focus.
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      this.dismiss()
      return
    }
    const t = e.target as HTMLElement
    const inList = t === this.search || this.rows.contains(t)
    if (!inList) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!this.options.length) return
      const i = this.options.findIndex((o) => o.ref.id === this.active)
      const n = this.options.length
      const next =
        i < 0 ? (e.key === 'ArrowDown' ? 0 : n - 1) : (i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n
      this.active = this.options[next]!.ref.id
      this.markActive(t !== this.search)
    } else if (e.key === 'Enter') {
      const hit = this.options.find((o) => o.ref.id === this.active)
      if (!hit) return
      e.preventDefault()
      this.pickFn(hit.ref)
    }
  }
}

/** True when `parent` already holds exactly `children`, in order. */
function sameChildren(parent: Element, children: readonly Element[]): boolean {
  if (parent.children.length !== children.length) return false
  return children.every((c, i) => parent.children[i] === c)
}
