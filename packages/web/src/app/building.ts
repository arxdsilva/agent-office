// Building layout: which modules go where, world anchors and the merged nav graph
// (docs/graphics-contract.md §1–§4). Pure: time comes in as `now` (ms).
import type { Manifest, ManifestNav, ModuleDef } from './manifest.ts'
import { THEME_IDS } from './manifest.ts'
import type {
  AABB,
  AnchorId,
  BuildingLayout,
  ModuleKind,
  ModulePlacement,
  NavGraph,
  ThemeId,
  Vec2,
  WingSlot,
  WorldAnchor,
} from './office-types.ts'

export interface ProviderDemand {
  provider: string
  agents: number
}

/** Bay length along +z (m). */
export const BAY_LENGTH = 18
/** Half the Main Street width (m): wings attach at x = ±3. */
export const STREET_HALF_WIDTH = 3
/** A provider that no longer needs a wing keeps it (dimmed) this long. */
export const WING_GRACE_MS = 60_000
/** The building always has at least this many bays (an empty office still has a street and gardens). */
export const MIN_BAYS = 1
/** Nodes of different modules closer than this are the same node. */
export const NAV_JOIN_EPS = 0.05
export const PINNED_THEMES: Readonly<Record<string, ThemeId>> = {
  'claude-code': 'terracotta',
  'openai-agents': 'nordic',
  langgraph: 'forest',
}

/** FNV-1a 32-bit hash (unsigned). Deterministic across runs. */
export function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export const anchorId = (placement: string, local: string): AnchorId => `${placement}/${local}`

export function parseAnchorId(id: AnchorId): { placement: string; local: string } {
  const i = id.lastIndexOf('/')
  return i < 0 ? { placement: '', local: id } : { placement: id.slice(0, i), local: id.slice(i + 1) }
}

const snap = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v)

/** Module-local point → world (translation + yaw, contract §1). */
export function toWorld(p: Vec2, at: Pick<ModulePlacement, 'position' | 'yaw'>): Vec2 {
  const c = snap(Math.cos(at.yaw))
  const s = snap(Math.sin(at.yaw))
  return { x: snap(p.x * c + p.z * s + at.position.x), z: snap(-p.x * s + p.z * c + at.position.z) }
}

/** Normalizes to (−π, π]. */
export function normalizeAngle(h: number): number {
  let a = h % (2 * Math.PI)
  if (a <= -Math.PI) a += 2 * Math.PI
  if (a > Math.PI) a -= 2 * Math.PI
  return a
}

const sidePosition = (bay: number, side: 'L' | 'R'): Vec2 => ({
  x: side === 'R' ? STREET_HALF_WIDTH : -STREET_HALF_WIDTH,
  z: BAY_LENGTH * bay + BAY_LENGTH / 2,
})
const sideYaw = (side: 'L' | 'R') => (side === 'R' ? 0 : Math.PI)

function availableThemes(m: Manifest): ThemeId[] {
  return THEME_IDS.filter((t) => m.modules.wing.themes[t])
}

/** Theme for a provider's first wing: pinned, else the first unused theme in hash order. */
function chooseTheme(provider: string, slots: WingSlot[], themes: ThemeId[]): { theme: ThemeId; signVariant: number } {
  const usage = (t: ThemeId) => new Set(slots.filter((s) => s.theme === t && s.provider !== provider).map((s) => s.provider)).size
  const pinned = PINNED_THEMES[provider]
  if (pinned && themes.includes(pinned)) return { theme: pinned, signVariant: usage(pinned) }
  const reserved = new Set(Object.values(PINNED_THEMES))
  const byHash = (a: ThemeId, b: ThemeId) => hash32(`${provider}:${a}`) - hash32(`${provider}:${b}`)
  const order = [
    ...themes.filter((t) => !reserved.has(t)).sort(byHash),
    ...themes.filter((t) => reserved.has(t)).sort(byHash),
  ]
  let best = order[0]!
  for (const t of order) if (usage(t) < usage(best)) best = t
  return { theme: best, signVariant: usage(best) }
}

/**
 * Places the atrium, one street per bay, a wing per provider (plus annexes), gardens on empty
 * sides and the end cap. Existing wings never move; freed slots are reused but never compacted.
 */
export function planBuilding(
  demand: ProviderDemand[],
  manifest: Manifest,
  prev: BuildingLayout | undefined,
  now: number,
): BuildingLayout {
  const perWing = Math.max(1, manifest.modules.wing.capacity.desk)
  const needed = new Map<string, number>()
  for (const { provider, agents } of demand) needed.set(provider, (needed.get(provider) ?? 0) + agents)
  for (const [p, n] of needed) needed.set(p, n > 0 ? Math.ceil(n / perWing) : 0)

  const slots: WingSlot[] = []
  for (const s of prev?.slots ?? []) {
    const active = s.annex < (needed.get(s.provider) ?? 0)
    if (active) slots.push({ ...s, lastNeeded: now })
    else if (now - s.lastNeeded < WING_GRACE_MS) slots.push({ ...s })
  }

  const themes = availableThemes(manifest)
  for (const provider of [...needed.keys()].sort()) {
    for (let annex = 0; annex < needed.get(provider)!; annex++) {
      if (slots.some((s) => s.provider === provider && s.annex === annex)) continue
      const own = slots.find((s) => s.provider === provider)
      const look = own ? { theme: own.theme, signVariant: own.signVariant } : chooseTheme(provider, slots, themes)
      let index = 0
      while (slots.some((s) => s.index === index)) index++
      slots.push({ index, provider, annex, ...look, lastNeeded: now })
    }
  }
  slots.sort((a, b) => a.index - b.index)

  const placements = placeModules(slots, needed)
  const key = placements
    .map(
      (p) =>
        `${p.id}@${p.position.x},${p.position.z},${p.yaw}` +
        (p.theme ? `#${p.theme}.${p.signVariant}` : '') +
        (p.dimmed ? '~' : ''),
    )
    .join('|')
  const wingsByProvider = new Map<string, string[]>()
  for (const p of placements)
    if (p.kind === 'wing') wingsByProvider.set(p.provider!, [...(wingsByProvider.get(p.provider!) ?? []), p.id])
  for (const ids of wingsByProvider.values()) ids.sort((a, b) => annexOf(a) - annexOf(b))

  if (prev && prev.key === key) return { ...prev, placements, wingsByProvider, slots }
  const { anchors, nav } = buildWorld(placements, manifest)
  return { placements, anchors, nav, bounds: worldBounds(placements, manifest), wingsByProvider, key, slots }
}

const annexOf = (placementId: string) => Number(placementId.slice(placementId.lastIndexOf(':') + 1))

function placeModules(slots: WingSlot[], needed: Map<string, number>): ModulePlacement[] {
  const maxIndex = slots.reduce((m, s) => Math.max(m, s.index), -1)
  const bays = Math.max(MIN_BAYS, Math.ceil((maxIndex + 1) / 2))
  const out: ModulePlacement[] = [{ id: 'atrium', kind: 'atrium', position: { x: 0, z: 0 }, yaw: 0 }]
  for (let bay = 0; bay < bays; bay++) {
    out.push({ id: `street:${bay}`, kind: 'street', bay, position: { x: 0, z: BAY_LENGTH * bay }, yaw: 0 })
    for (const side of ['R', 'L'] as const) {
      const index = bay * 2 + (side === 'R' ? 0 : 1)
      const s = slots.find((x) => x.index === index)
      const base = { bay, side, position: sidePosition(bay, side), yaw: sideYaw(side) }
      if (!s) {
        out.push({ id: `garden:${bay}:${side}`, kind: 'garden', ...base })
        continue
      }
      const w: ModulePlacement = {
        id: `wing:${s.provider}:${s.annex}`,
        kind: 'wing',
        theme: s.theme,
        provider: s.provider,
        annex: s.annex,
        ...base,
        label: s.annex ? `${s.provider} · ${s.annex + 1}` : s.provider,
        signVariant: s.signVariant,
      }
      if (s.annex >= (needed.get(s.provider) ?? 0)) w.dimmed = true
      out.push(w)
    }
  }
  out.push({ id: 'cap', kind: 'cap', position: { x: 0, z: BAY_LENGTH * bays }, yaw: 0 })
  return out
}

function moduleOf(kind: ModuleKind, m: Manifest): Pick<ModuleDef, 'anchors' | 'nav' | 'bounds'> {
  return kind === 'wing' ? m.modules.wing : m.modules[kind]
}

function buildWorld(placements: ModulePlacement[], m: Manifest) {
  const nodes: NavGraph['nodes'] = new Map()
  const alias = new Map<string, string>()
  const owner = new Map<string, string>() // world node id → placement id
  const cells = new Map<string, string[]>()
  const cellOf = (p: Vec2) => [Math.floor(p.x / 0.1), Math.floor(p.z / 0.1)] as const
  const edges: [string, string][] = []

  for (const pl of placements) {
    const def = moduleOf(pl.kind, m)
    addNav(pl, def.nav)
  }

  function addNav(pl: ModulePlacement, nav: ManifestNav) {
    for (const [id, n] of Object.entries(nav.nodes)) {
      const wid = `${pl.id}/${id}`
      const pos = toWorld(n, pl)
      const [cx, cz] = cellOf(pos)
      let match: string | undefined
      for (let dx = -1; dx <= 1 && !match; dx++)
        for (let dz = -1; dz <= 1 && !match; dz++)
          for (const other of cells.get(`${cx + dx},${cz + dz}`) ?? []) {
            const o = nodes.get(other)!
            if (owner.get(other) !== pl.id && Math.hypot(o.pos.x - pos.x, o.pos.z - pos.z) <= NAV_JOIN_EPS) {
              match = other
              break
            }
          }
      if (match) {
        alias.set(wid, match)
        const o = nodes.get(match)!
        o.width = Math.max(o.width, n.width)
        continue
      }
      alias.set(wid, wid)
      owner.set(wid, pl.id)
      nodes.set(wid, { id: wid, pos, width: n.width })
      const c = `${cx},${cz}`
      cells.set(c, [...(cells.get(c) ?? []), wid])
    }
    for (const [a, b] of nav.edges) edges.push([alias.get(`${pl.id}/${a}`)!, alias.get(`${pl.id}/${b}`)!])
  }

  const adj: NavGraph['adj'] = new Map([...nodes.keys()].map((id) => [id, []]))
  for (const [a, b] of edges) {
    if (a === b || adj.get(a)!.includes(b)) continue
    adj.get(a)!.push(b)
    adj.get(b)!.push(a)
  }

  const anchors = new Map<AnchorId, WorldAnchor>()
  for (const pl of placements) {
    const def = moduleOf(pl.kind, m)
    const own = [...nodes.values()].filter((n) => owner.get(n.id) === pl.id)
    for (const [local, a] of Object.entries(def.anchors)) {
      const id = anchorId(pl.id, local)
      const approach = toWorld(a.approach, pl)
      const wa: WorldAnchor = {
        id,
        placement: pl.id,
        local,
        pos: toWorld(a, pl),
        heading: normalizeAngle(a.heading + pl.yaw),
        pose: a.pose,
        approach,
      }
      if (a.room !== undefined) wa.room = a.room
      if (a.screen !== undefined) wa.screen = a.screen
      if (a.led !== undefined) wa.led = a.led
      const ap = alias.get(`${pl.id}/ap:${local}`)
      wa.navNode = ap ?? nearest(own.length ? own : [...nodes.values()], approach)
      anchors.set(id, wa)
    }
  }
  return { anchors, nav: { nodes, adj } satisfies NavGraph }
}

function nearest(nodes: { id: string; pos: Vec2 }[], p: Vec2): string {
  let best = nodes[0]!.id
  let bestD = Infinity
  for (const n of nodes) {
    const d = Math.hypot(n.pos.x - p.x, n.pos.z - p.z)
    if (d < bestD) (bestD = d), (best = n.id)
  }
  return best
}

function worldBounds(placements: ModulePlacement[], m: Manifest): AABB {
  const b: AABB = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }
  for (const pl of placements) {
    const lb = moduleOf(pl.kind, m).bounds
    for (const x of [lb.minX, lb.maxX])
      for (const z of [lb.minZ, lb.maxZ]) {
        const w = toWorld({ x, z }, pl)
        b.minX = Math.min(b.minX, w.x)
        b.maxX = Math.max(b.maxX, w.x)
        b.minZ = Math.min(b.minZ, w.z)
        b.maxZ = Math.max(b.maxZ, w.z)
      }
  }
  return b
}
