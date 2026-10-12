// A small popup menu (role=menu) anchored to a button: ↑/↓ move, Enter picks, Esc closes,
// an outside click closes. Text only via el()/textContent.
import { el } from './el.ts'

export interface MenuItem {
  id: string
  label: string
  desc?: string
  checked?: boolean
  /** Status dot: ● seen / ○ not seen yet (Use… menu). */
  dot?: { on: boolean; title: string }
  disabled?: boolean
}

export interface MenuGroup {
  label?: string
  items: MenuItem[]
}

export interface MenuOptions {
  role?: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox'
  /** Adds a filter box (the Use… menu with more than 8 entries). */
  searchable?: boolean
  /** Accessible name of the menu. */
  label?: string
}

let closeCurrent: (() => void) | null = null

/** Opens a menu under (or above) `anchor`; returns a function that closes it. */
export function openMenu(
  anchor: HTMLElement,
  groups: MenuGroup[],
  onPick: (id: string) => void,
  opts: MenuOptions = {},
): () => void {
  closeCurrent?.()
  const role = opts.role ?? 'menuitem'
  const menu = el('div', undefined, 'menu')
  menu.setAttribute('role', 'menu')
  if (opts.label) menu.setAttribute('aria-label', opts.label)

  const buttons: { btn: HTMLButtonElement; item: MenuItem; group: HTMLElement }[] = []
  const sections: HTMLElement[] = []
  for (const g of groups) {
    const section = el('div', undefined, 'menu-group')
    section.setAttribute('role', 'group')
    if (g.label) {
      const h = el('div', g.label, 'menu-heading')
      section.setAttribute('aria-label', g.label)
      section.append(h)
    }
    for (const item of g.items) {
      const btn = el('button', undefined, 'menu-item')
      btn.type = 'button'
      btn.tabIndex = -1
      btn.setAttribute('role', role)
      btn.dataset.id = item.id
      if (role !== 'menuitem') btn.setAttribute('aria-checked', String(!!item.checked))
      if (item.disabled) btn.setAttribute('aria-disabled', 'true')
      const check = el('span', item.checked ? '✓' : '', 'menu-check')
      check.setAttribute('aria-hidden', 'true')
      const text = el('span', undefined, 'menu-text')
      text.append(el('span', item.label, 'menu-label'))
      if (item.desc) text.append(el('span', item.desc, 'menu-desc'))
      btn.append(check, text)
      if (item.dot) {
        const dot = el('span', item.dot.on ? '●' : '○', `menu-dot ${item.dot.on ? 'on' : 'off'}`)
        dot.title = item.dot.title
        btn.title = item.dot.title
        btn.append(dot)
      }
      btn.addEventListener('click', () => {
        if (item.disabled) return
        close()
        onPick(item.id)
      })
      section.append(btn)
      buttons.push({ btn, item, group: section })
    }
    sections.push(section)
  }

  let search: HTMLInputElement | null = null
  if (opts.searchable) {
    search = el('input', undefined, 'menu-search')
    search.type = 'search'
    search.setAttribute('aria-label', opts.label ?? 'Filter')
    search.addEventListener('input', () => {
      const q = search!.value.trim().toLowerCase()
      for (const b of buttons) b.btn.hidden = !!q && !b.item.label.toLowerCase().includes(q)
      for (const s of sections) s.hidden = ![...s.querySelectorAll('button')].some((x) => !x.hidden)
    })
    menu.append(search)
  }
  menu.append(...sections)
  document.body.append(menu)

  // Place it next to the anchor, inside the viewport.
  const r = anchor.getBoundingClientRect()
  const h = menu.offsetHeight
  const below = r.bottom + 4 + h <= window.innerHeight
  menu.style.top = `${Math.max(4, below ? r.bottom + 4 : r.top - 4 - h)}px`
  menu.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - menu.offsetWidth - 4))}px`
  anchor.setAttribute('aria-expanded', 'true')

  const visible = () => buttons.filter((b) => !b.btn.hidden).map((b) => b.btn)
  const move = (dir: 1 | -1) => {
    const list = visible()
    if (!list.length) return
    const i = list.indexOf(document.activeElement as HTMLButtonElement)
    list[(i + dir + list.length) % list.length]!.focus()
  }
  menu.addEventListener('keydown', (e) => {
    e.stopPropagation() // keep scene shortcuts quiet
    if (e.key === 'ArrowDown') move(1)
    else if (e.key === 'ArrowUp') move(-1)
    else if (e.key === 'Escape') {
      close()
      anchor.focus()
    } else if (e.key === 'Tab') close()
    else return
    e.preventDefault()
  })
  const outside = (e: PointerEvent) => {
    const t = e.target as Node
    if (!menu.contains(t) && !anchor.contains(t)) close()
  }
  document.addEventListener('pointerdown', outside, true)

  function close() {
    if (closeCurrent !== close) return
    closeCurrent = null
    document.removeEventListener('pointerdown', outside, true)
    anchor.setAttribute('aria-expanded', 'false')
    menu.remove()
  }
  closeCurrent = close

  if (search) search.focus()
  else (buttons.find((b) => b.item.checked)?.btn ?? visible()[0])?.focus()
  return close
}
