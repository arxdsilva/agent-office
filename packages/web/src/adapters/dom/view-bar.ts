// ViewBarView → `#views`: camera bookmark buttons. Grouped entries (Library, Adapters) collapse
// into one button: a plain button for a single entry, else a provider menu (§B4, L3). Button
// classes and `data-view` ids match the buttons the scene used to render, so specs keep working.
import { LIB_COPY } from '../../app/library-copy.ts'
import type { ViewEntry } from '../../app/library-types.ts'
import type { ViewBarView } from '../../ports.ts'
import { byId, el } from './el.ts'
import { openMenu, type MenuGroup } from './menu.ts'

type Group = NonNullable<ViewEntry['group']>
const GROUP_LABEL: Record<Group, string> = {
  library: LIB_COPY.views.library,
  adapters: LIB_COPY.views.adapters,
}

export class DomViewBar implements ViewBarView {
  private root = byId('views')
  private pickFn: (viewId: string) => void = () => {}
  private key = ''

  onPick(fn: (viewId: string) => void): void {
    this.pickFn = fn
  }

  render(views: ViewEntry[]): void {
    const key = JSON.stringify(views)
    if (key === this.key) return
    this.key = key
    // Grouped entries become one button at the place of the group's first entry.
    const slots: (ViewEntry | { group: Group; entries: ViewEntry[] })[] = []
    const groups = new Map<Group, ViewEntry[]>()
    for (const v of views) {
      if (!v.group) {
        slots.push(v)
        continue
      }
      let list = groups.get(v.group)
      if (!list) {
        groups.set(v.group, (list = []))
        slots.push({ group: v.group, entries: list })
      }
      list.push(v)
    }
    this.root.replaceChildren(
      ...slots.map((s) => ('entries' in s ? this.groupButton(s.group, s.entries) : this.button(s))),
    )
  }

  private button(v: ViewEntry): HTMLButtonElement {
    const b = viewButton(v.id, v.label, !!v.active)
    b.addEventListener('click', () => this.pickFn(v.id))
    return b
  }

  private groupButton(group: Group, entries: ViewEntry[]): HTMLButtonElement {
    const b = viewButton(
      group,
      GROUP_LABEL[group],
      entries.some((e) => e.active),
    )
    const only = entries.length === 1 ? entries[0]! : null
    if (only) {
      b.title = only.provider ?? only.label
      b.addEventListener('click', () => this.pickFn(only.id))
      return b
    }
    b.classList.add('has-menu')
    b.setAttribute('aria-haspopup', 'menu')
    b.setAttribute('aria-expanded', 'false')
    b.addEventListener('click', () =>
      openMenu(b, menuGroups(entries), (id) => this.pickFn(id), { label: GROUP_LABEL[group] }),
    )
    return b
  }
}

function viewButton(id: string, label: string, active: boolean): HTMLButtonElement {
  const b = el('button', label, 'view-btn')
  b.type = 'button'
  b.dataset.view = id
  if (active) b.setAttribute('aria-current', 'true')
  return b
}

/**
 * One item per provider ("claude-code · langgraph · …"). Providers with several views (Library and
 * Rules wall) get their own headed section listing the view labels.
 */
function menuGroups(entries: ViewEntry[]): MenuGroup[] {
  const byProvider = new Map<string, ViewEntry[]>()
  for (const e of entries) {
    const p = e.provider ?? e.label
    byProvider.set(p, [...(byProvider.get(p) ?? []), e])
  }
  const single = [...byProvider.values()].every((l) => l.length === 1)
  if (single)
    return [
      {
        items: entries.map((e) => ({
          id: e.id,
          label: e.provider ?? e.label,
          checked: !!e.active,
        })),
      },
    ]
  return [...byProvider].map(([provider, list]) => ({
    label: provider,
    items: list.map((e) => ({ id: e.id, label: e.label, checked: !!e.active })),
  }))
}
