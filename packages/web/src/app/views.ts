// The view bar's entries (plan §2.4), shared by the 3D and the 2D scene: atrium, Main Street,
// wings, then the Adapters and Library rooms per provider (main wing only, grouped into menus),
// then the overview. Same ids, labels and order `ThreeScene.emitViews` produced.
import { LIB_COPY } from './library-copy.ts'
import type { ViewEntry } from './library-types.ts'
import type { BuildingLayout, ModulePlacement } from './office-types.ts'

type Room = 'adapters' | 'adapters-door' | 'library' | 'library-rules'
const ROOM_LABEL: Record<Room, string> = {
  adapters: LIB_COPY.views.adapters,
  'adapters-door': LIB_COPY.views.adaptersDoor,
  library: LIB_COPY.views.library,
  'library-rules': LIB_COPY.views.rulesWall,
}
const GROUPS: [ViewEntry['group'] & string, Room[]][] = [
  ['adapters', ['adapters', 'adapters-door']],
  ['library', ['library', 'library-rules']],
]

export interface ViewsOptions {
  /** View ids that exist now (3D: its bookmarks); default: the rooms the layout's anchors and ports allow. */
  available?: ReadonlySet<string>
  /** The active view. */
  current?: string | null
}

/** Rooms a wing offers, from its anchors and ports (the framed 3D rooms need the same surfaces). */
function roomsOf(layout: BuildingLayout, p: ModulePlacement): Set<Room> {
  const locals = new Set<string>()
  for (const a of layout.anchors.values()) if (a.placement === p.id) locals.add(a.local)
  for (const id of layout.ports?.keys() ?? [])
    if (id.startsWith(`${p.id}/`)) locals.add(id.slice(p.id.length + 1))
  const has = (re: RegExp) => [...locals].some((l) => re.test(l))
  const station = (i: number) => locals.has(`port:station:${i}`)
  const reading = has(/^(seat:reading|spot:shelf):/)
  const boards = has(/^port:board:/)
  const out = new Set<Room>()
  if (has(/^port:station:/) && has(/^spot:station:/)) out.add('adapters')
  if ([4, 5, 6, 7].some(station) && [0, 1, 2, 3].some(station)) out.add('adapters-door')
  if (reading && (boards || has(/^port:book:/))) out.add('library')
  if (reading && boards) out.add('library-rules')
  return out
}

export function viewsFor(layout: BuildingLayout, opts: ViewsOptions = {}): ViewEntry[] {
  const current = opts.current ?? null
  const entry = (id: string, label: string, extra: Partial<ViewEntry> = {}): ViewEntry => ({
    id,
    label,
    ...extra,
    ...(id === current ? { active: true } : {}),
  })
  const ok = (id: string) => !opts.available || opts.available.has(id)
  const out: ViewEntry[] = []
  if (layout.placements.some((p) => p.kind === 'atrium') && ok('atrium'))
    out.push(entry('atrium', 'Atrium'))
  if (layout.placements.some((p) => p.kind === 'street') && ok('street'))
    out.push(entry('street', 'Main Street'))
  const wings = layout.placements.filter((p) => p.kind === 'wing')
  for (const p of wings) {
    const id = `wing:${p.provider}:${p.annex ?? 0}`
    if (ok(id)) out.push(entry(id, p.label ?? p.provider ?? p.id))
  }
  for (const [group, rooms] of GROUPS) {
    const rows: ViewEntry[] = []
    for (const room of rooms)
      for (const p of wings) {
        if ((p.annex ?? 0) !== 0) continue
        const id = `${room}:${p.provider}:0`
        const fits = opts.available ? opts.available.has(id) : roomsOf(layout, p).has(room)
        if (fits) rows.push(entry(id, ROOM_LABEL[room], { group, provider: p.provider ?? p.id }))
      }
    const order = [...new Set(rows.map((r) => r.provider))]
    out.push(...order.flatMap((pr) => rows.filter((r) => r.provider === pr)))
  }
  if (ok('overview')) out.push(entry('overview', 'Overview'))
  return out
}
