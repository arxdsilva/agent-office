// Night City world (graphics contract §14, docs/special-3d/world-layout.md): the special manifest
// is validated here, then its modules are placed (translation + yaw), their nav graphs merged at
// coincident nodes, and their floor plans turned into rooms and colliders. Pure.
import { anchorId, normalizeAngle, NAV_JOIN_EPS, toWorld } from '../building.ts'
import { parseInteractAnchor } from '../interactions.ts'
import type { Lightmap, ManifestAnchor, ManifestNav } from '../manifest.ts'
import type {
  AABB,
  AnchorId,
  BuildingLayout,
  InteractionKind,
  ModulePlacement,
  NavGraph,
  Pose,
  Vec2,
  Vec3,
  WorldAnchor,
} from '../office-types.ts'
import type { ModulePlan, PlanFurniture, PlanRoom, PlanWall } from '../pixel/types.ts'

export const SPECIAL_KINDS = [
  'hq-atrium',
  'command',
  'skyline',
  'department',
  'vault',
  'core',
  'archive',
  'handoff',
] as const
export type SpecialKind = (typeof SPECIAL_KINDS)[number]

export interface SpecialModuleDef {
  /** The module's .glb in `special3d/` (absent: placeholder geometry from the plan). */
  file?: string
  lightmap?: Lightmap
  bounds: AABB
  /** Interior height (m) for walls without their own `h`; default 3.2. */
  height?: number
  anchors: Record<string, ManifestAnchor>
  ports: Record<string, Vec3>
  nav: ManifestNav
  plan?: ModulePlan
  /** Where the module goes; default: hq-atrium at the origin, the rest chained north of it. */
  placement?: { x: number; z: number; yaw: number }
}

export interface SpecialManifest {
  version: 1
  set: 'special'
  hash: string
  hdri?: string
  modules: Partial<Record<SpecialKind, SpecialModuleDef>>
  character?: { file: string; meta: string }
}

export class SpecialManifestError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`special manifest ${path}: ${detail}`)
    this.name = 'SpecialManifestError'
  }
}

type Obj = Record<string, unknown>
const POSES: readonly Pose[] = ['sit', 'stand', 'lounge']
const KINDS: ReadonlySet<string> = new Set(SPECIAL_KINDS)
/** Classic grammar (contract §4) plus the special forms (§14). */
const ANCHOR_ID = new RegExp(
  [
    /^(seat|spot|port|console):[a-z]+(:[A-Za-z0-9]+)*$/,
    /^kiosk:[a-z]+(-[a-z]+)*$/,
    /^ws:\d+:\d+:\d+$/,
    /^booth:\d+$/,
    /^meet:[A-Za-z0-9]+:\d+$/,
    /^interact:[a-z]+(-[a-z]+)*:\d+$/,
    /^player:spawn$/,
  ]
    .map((r) => r.source)
    .join('|'),
)

const at = (path: string, k: string) =>
  /^[A-Za-z_]\w*$/.test(k) ? `${path}.${k}` : `${path}["${k}"]`

function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new SpecialManifestError(path, 'expected an object')
  return v as Obj
}

function num(o: Obj, k: string, path: string): number {
  const v = o[k]
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new SpecialManifestError(at(path, k), 'expected a finite number')
  return v
}

function str(o: Obj, k: string, path: string): string {
  const v = o[k]
  if (typeof v !== 'string' || !v) throw new SpecialManifestError(at(path, k), 'expected a string')
  return v
}

function bounds(v: unknown, path: string): AABB {
  const o = obj(v, path)
  return {
    minX: num(o, 'minX', path),
    maxX: num(o, 'maxX', path),
    minZ: num(o, 'minZ', path),
    maxZ: num(o, 'maxZ', path),
  }
}

function anchorOf(v: unknown, path: string): ManifestAnchor {
  const o = obj(v, path)
  const pose = o.pose
  if (!POSES.includes(pose as Pose))
    throw new SpecialManifestError(at(path, 'pose'), `expected one of ${POSES.join(', ')}`)
  const ap = obj(o.approach, at(path, 'approach'))
  const a: ManifestAnchor = {
    x: num(o, 'x', path),
    y: typeof o.y === 'number' ? o.y : 0,
    z: num(o, 'z', path),
    heading: num(o, 'heading', path),
    pose: pose as Pose,
    approach: { x: num(ap, 'x', at(path, 'approach')), z: num(ap, 'z', at(path, 'approach')) },
  }
  for (const k of ['room', 'screen', 'led'] as const) if (typeof o[k] === 'string') a[k] = o[k]
  return a
}

function navOf(v: unknown, path: string): ManifestNav {
  const o = obj(v, path)
  const nodesIn = obj(o.nodes, at(path, 'nodes'))
  const nodes: ManifestNav['nodes'] = {}
  for (const [id, n] of Object.entries(nodesIn)) {
    const p = at(at(path, 'nodes'), id)
    const no = obj(n, p)
    nodes[id] = { x: num(no, 'x', p), z: num(no, 'z', p), width: num(no, 'width', p) }
  }
  if (!Array.isArray(o.edges)) throw new SpecialManifestError(at(path, 'edges'), 'expected a list')
  const edges = o.edges.map((e, i) => {
    if (!Array.isArray(e) || e.length !== 2 || !nodes[e[0] as string] || !nodes[e[1] as string])
      throw new SpecialManifestError(`${at(path, 'edges')}[${i}]`, 'expected two known node ids')
    return [e[0], e[1]] as [string, string]
  })
  return { nodes, edges }
}

function moduleOf(v: unknown, path: string): SpecialModuleDef {
  const o = obj(v, path)
  const anchors: Record<string, ManifestAnchor> = {}
  const ports: Record<string, Vec3> = {}
  for (const [id, a] of Object.entries(obj(o.anchors, at(path, 'anchors')))) {
    const p = at(at(path, 'anchors'), id)
    if (!ANCHOR_ID.test(id))
      throw new SpecialManifestError(p, 'not in the anchor grammar (§4, §14)')
    if (id.startsWith('port:')) {
      const po = obj(a, p)
      ports[id] = { x: num(po, 'x', p), y: num(po, 'y', p), z: num(po, 'z', p) }
    } else anchors[id] = anchorOf(a, p)
  }
  const def: SpecialModuleDef = {
    bounds: bounds(o.bounds, at(path, 'bounds')),
    anchors,
    ports,
    nav: navOf(o.nav, at(path, 'nav')),
  }
  if (typeof o.file === 'string') def.file = o.file
  if (typeof o.height === 'number') def.height = o.height
  if (o.lightmap !== undefined) {
    const lm = obj(o.lightmap, at(path, 'lightmap'))
    def.lightmap = { ...(lm as unknown as Lightmap), file: str(lm, 'file', at(path, 'lightmap')) }
  }
  // The plan's shape is the classic floor plan (contract §11); it is drawn and collided only.
  if (o.plan !== undefined) def.plan = obj(o.plan, at(path, 'plan')) as unknown as ModulePlan
  if (o.placement !== undefined) {
    const p = obj(o.placement, at(path, 'placement'))
    const pp = at(path, 'placement')
    def.placement = { x: num(p, 'x', pp), z: num(p, 'z', pp), yaw: num(p, 'yaw', pp) }
  }
  return def
}

/** Validates `special3d/manifest.json`; throws `SpecialManifestError` naming the bad path. */
export function parseSpecialManifest(json: unknown): SpecialManifest {
  const o = obj(json, 'manifest')
  if (o.version !== 1) throw new SpecialManifestError('version', 'expected 1')
  if (o.set !== 'special') throw new SpecialManifestError('set', "expected 'special'")
  const modulesIn = obj(o.modules, 'modules')
  const modules: SpecialManifest['modules'] = {}
  for (const [kind, def] of Object.entries(modulesIn)) {
    if (!KINDS.has(kind))
      throw new SpecialManifestError(
        at('modules', kind),
        `unknown module kind (${SPECIAL_KINDS.join(', ')})`,
      )
    modules[kind as SpecialKind] = moduleOf(def, at('modules', kind))
  }
  if (!modules['hq-atrium']) throw new SpecialManifestError('modules.hq-atrium', 'missing')
  const m: SpecialManifest = {
    version: 1,
    set: 'special',
    hash: str(o, 'hash', 'manifest'),
    modules,
  }
  if (typeof o.hdri === 'string') m.hdri = o.hdri
  if (o.character !== undefined) {
    const c = obj(o.character, 'character')
    m.character = { file: str(c, 'file', 'character'), meta: str(c, 'meta', 'character') }
  }
  return m
}

// ── The world ─────────────────────────────────────────────────────────────────────────────────
/** A world-space box (walls, furniture): collision, the spring arm and label occlusion. */
export interface Collider {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
}

export interface SpecialRoom {
  /** `<placement>/<room id>`. */
  id: string
  name: string
  placement: string
  rect: AABB
}

export interface Interactable {
  id: AnchorId
  kind: InteractionKind
  n: number
  placement: string
  pos: Vec2
  heading: number
}

export interface SpecialWorld {
  manifest: SpecialManifest
  layout: BuildingLayout
  rooms: SpecialRoom[]
  colliders: Collider[]
  interactables: Interactable[]
  spawn: { pos: Vec2; heading: number }
}

const DEFAULT_HEIGHT = 3.2
/** Footprint heights (m) by furniture kind; anything under 0.3 m never blocks. */
const TALL = new Set(['elevator', 'bookshelf', 'core-rack', 'booth', 'board', 'led-wall', 'fridge'])
const FLAT = new Set(['rug', 'sign', 'tv'])
const furnitureHeight = (f: PlanFurniture) =>
  FLAT.has(f.kind) ? 0.02 : TALL.has(f.kind) ? 2.2 : 0.9

/** AABB of local points after the placement transform. */
function worldBox(
  pts: Vec2[],
  pl: Pick<ModulePlacement, 'position' | 'yaw'>,
  y0: number,
  y1: number,
): Collider {
  const b: Collider = {
    minX: Infinity,
    maxX: -Infinity,
    minY: y0,
    maxY: y1,
    minZ: Infinity,
    maxZ: -Infinity,
  }
  for (const p of pts) {
    const w = toWorld(p, pl)
    b.minX = Math.min(b.minX, w.x)
    b.maxX = Math.max(b.maxX, w.x)
    b.minZ = Math.min(b.minZ, w.z)
    b.maxZ = Math.max(b.maxZ, w.z)
  }
  return b
}

/** One straight run of a wall between its openings (module-local), with its body offset. */
export interface WallRun {
  a: Vec2
  b: Vec2
  /** Unit normal (−dz, dx) and the body's centre offset along it (side · thick / 2). */
  normal: Vec2
  off: number
  thick: number
}

/** A plan wall split at its openings (the body as the 2D map draws it). */
export function wallRuns(w: PlanWall): WallRun[] {
  const [ax, az] = w.a
  const [bx, bz] = w.b
  const len = Math.hypot(bx - ax, bz - az)
  if (len < 1e-6) return []
  const dx = (bx - ax) / len
  const dz = (bz - az) / len
  const thick = Math.max(0.1, w.thick ?? 0.15)
  const off = w.side ? (w.side * thick) / 2 : 0
  const gaps = [...(w.openings ?? [])].sort((p, q) => p[0] - q[0])
  const spans: [number, number][] = []
  let t = 0
  for (const [g0, g1] of gaps) {
    if (g0 > t) spans.push([t, Math.min(g0, len)])
    t = Math.max(t, g1)
  }
  if (t < len) spans.push([t, len])
  return spans.map(([t0, t1]) => ({
    a: { x: ax + dx * t0, z: az + dz * t0 },
    b: { x: ax + dx * t1, z: az + dz * t1 },
    normal: { x: -dz, z: dx },
    off,
    thick,
  }))
}

function wallBoxes(
  w: PlanWall & { h?: number },
  pl: Pick<ModulePlacement, 'position' | 'yaw'>,
  height: number,
): Collider[] {
  const h = w.h ?? height
  return wallRuns(w).map((r) => {
    const pts: Vec2[] = []
    for (const e of [r.a, r.b])
      for (const o of [r.off - r.thick / 2, r.off + r.thick / 2])
        pts.push({ x: e.x + r.normal.x * o, z: e.z + r.normal.z * o })
    return worldBox(pts, pl, 0, h)
  })
}

function furnitureBox(f: PlanFurniture, pl: Pick<ModulePlacement, 'position' | 'yaw'>): Collider {
  // Footprint w (local x) × d (local z), rotated by yaw like three.js rotation.y.
  const c = Math.cos(f.yaw)
  const s = Math.sin(f.yaw)
  const pts: Vec2[] = []
  for (const ux of [-f.w / 2, f.w / 2])
    for (const uz of [-f.d / 2, f.d / 2])
      pts.push({ x: f.x + ux * c + uz * s, z: f.z - ux * s + uz * c })
  return worldBox(pts, pl, 0, furnitureHeight(f))
}

/** A module plan's walls (split at their openings) and furniture as world boxes. */
export function collidersFromPlan(
  plan: ModulePlan,
  pl: Pick<ModulePlacement, 'position' | 'yaw'>,
  height = DEFAULT_HEIGHT,
): Collider[] {
  return [
    ...plan.walls.flatMap((w) => wallBoxes(w, pl, height)),
    ...plan.furniture.filter((f) => !FLAT.has(f.kind)).map((f) => furnitureBox(f, pl)),
  ]
}

/** Default placements: the atrium at the origin, the skyline around it, rooms chained north. */
function placementsOf(m: SpecialManifest): ModulePlacement[] {
  const out: ModulePlacement[] = []
  let northZ = 0
  for (const kind of SPECIAL_KINDS) {
    const def = m.modules[kind]
    if (!def) continue
    let position: Vec2
    let yaw = 0
    if (def.placement)
      ((position = { x: def.placement.x, z: def.placement.z }), (yaw = def.placement.yaw))
    else if (kind === 'hq-atrium' || kind === 'skyline') position = { x: 0, z: 0 }
    else position = { x: 0, z: northZ - def.bounds.minZ }
    // `ModulePlacement.kind` is the classic union; the special kind is kept in `id`.
    out.push({ id: kind, kind: kind as unknown as ModulePlacement['kind'], position, yaw })
    if (kind !== 'skyline') northZ = Math.max(northZ, position.z + def.bounds.maxZ)
  }
  return out
}

/** Places the modules and builds anchors, merged nav, rooms, colliders and interaction points. */
export function buildSpecialWorld(m: SpecialManifest): SpecialWorld {
  const placements = placementsOf(m)
  const def = (pl: ModulePlacement) => m.modules[pl.id as SpecialKind]!
  // Nav: nodes of different modules within NAV_JOIN_EPS are one node (connectors).
  const nodes: NavGraph['nodes'] = new Map()
  const alias = new Map<string, string>()
  const owner = new Map<string, string>()
  const edges: [string, string][] = []
  for (const pl of placements) {
    const nav = def(pl).nav
    for (const [id, n] of Object.entries(nav.nodes)) {
      const wid = `${pl.id}/${id}`
      const pos = toWorld(n, pl)
      let match: string | undefined
      for (const [other, o] of nodes)
        if (
          owner.get(other) !== pl.id &&
          Math.hypot(o.pos.x - pos.x, o.pos.z - pos.z) <= NAV_JOIN_EPS
        ) {
          match = other
          break
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
    }
    for (const [a, b] of nav.edges)
      edges.push([alias.get(`${pl.id}/${a}`)!, alias.get(`${pl.id}/${b}`)!])
  }
  const adj: NavGraph['adj'] = new Map([...nodes.keys()].map((id) => [id, []]))
  for (const [a, b] of edges) {
    if (a === b || adj.get(a)!.includes(b)) continue
    adj.get(a)!.push(b)
    adj.get(b)!.push(a)
  }

  const anchors = new Map<AnchorId, WorldAnchor>()
  const ports = new Map<AnchorId, Vec3>()
  const interactables: Interactable[] = []
  const rooms: SpecialRoom[] = []
  const colliders: Collider[] = []
  let spawn: SpecialWorld['spawn'] | null = null
  let elevator: SpecialWorld['spawn'] | null = null
  const all = [...nodes.values()]
  for (const pl of placements) {
    const d = def(pl)
    const own = all.filter((n) => owner.get(n.id) === pl.id)
    for (const [local, p] of Object.entries(d.ports))
      ports.set(anchorId(pl.id, local), { ...toWorld(p, pl), y: p.y })
    for (const [local, a] of Object.entries(d.anchors)) {
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
      const pool = own.length ? own : all
      wa.navNode =
        alias.get(`${pl.id}/ap:${local}`) ?? (pool.length ? nearestId(pool, approach) : undefined)
      anchors.set(id, wa)
      const ia = parseInteractAnchor(local)
      if (ia) interactables.push({ id, ...ia, placement: pl.id, pos: wa.pos, heading: wa.heading })
      if (local === 'player:spawn') spawn = { pos: wa.pos, heading: wa.heading }
      if (!elevator && local.startsWith('spot:elevator:'))
        elevator = { pos: wa.pos, heading: wa.heading }
    }
    if (d.plan) {
      for (const r of d.plan.rooms as PlanRoom[]) {
        const [x0, z0, x1, z1] = r.rect
        const b = worldBox(
          [
            { x: x0, z: z0 },
            { x: x1, z: z1 },
          ],
          pl,
          0,
          0,
        )
        rooms.push({
          id: `${pl.id}/${r.id}`,
          name: r.name,
          placement: pl.id,
          rect: { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ },
        })
      }
      colliders.push(...collidersFromPlan(d.plan, pl, d.height ?? DEFAULT_HEIGHT))
    }
  }

  const b: AABB = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }
  for (const pl of placements) {
    if (pl.id === 'skyline') continue
    const lb = def(pl).bounds
    const w = worldBox(
      [
        { x: lb.minX, z: lb.minZ },
        { x: lb.maxX, z: lb.maxZ },
      ],
      pl,
      0,
      0,
    )
    b.minX = Math.min(b.minX, w.minX)
    b.maxX = Math.max(b.maxX, w.maxX)
    b.minZ = Math.min(b.minZ, w.minZ)
    b.maxZ = Math.max(b.maxZ, w.maxZ)
  }

  const layout: BuildingLayout = {
    placements,
    anchors,
    ports,
    nav: { nodes, adj },
    bounds: b,
    wingsByProvider: new Map(),
    key: `special:${m.hash}`,
  }
  return {
    manifest: m,
    layout,
    rooms,
    colliders,
    interactables,
    spawn: spawn ?? elevator ?? { pos: { x: 0, z: 0 }, heading: 0 },
  }
}

function nearestId(nodes: { id: string; pos: Vec2 }[], p: Vec2): string {
  let best = nodes[0]!.id
  let bestD = Infinity
  for (const n of nodes) {
    const d = Math.hypot(n.pos.x - p.x, n.pos.z - p.z)
    if (d < bestD) ((bestD = d), (best = n.id))
  }
  return best
}

/** The room a point is in (the smallest containing rect), or null outside every room. */
export function roomAt(world: Pick<SpecialWorld, 'rooms'>, p: Vec2): SpecialRoom | null {
  let best: SpecialRoom | null = null
  let area = Infinity
  for (const r of world.rooms) {
    const { minX, maxX, minZ, maxZ } = r.rect
    if (p.x < minX || p.x > maxX || p.z < minZ || p.z > maxZ) continue
    const a = (maxX - minX) * (maxZ - minZ)
    if (a < area) ((area = a), (best = r))
  }
  return best
}
