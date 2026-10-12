// Runtime validation of `manifest.json` (docs/graphics-contract.md §3, §4, §7).
// zod is not a dependency of packages/web, so this is a small hand-written validator that names the
// offending path in every error.
import type { AABB, Pose, ThemeId, Vec3 } from './office-types.ts'
import {
  FURNITURE_KINDS,
  type FurnitureKind,
  type ModulePlan,
  type PlanFurniture,
  type PlanRoom,
  type PlanWall,
  type WallKind,
} from './pixel/types.ts'

export const THEME_IDS: readonly ThemeId[] = [
  'terracotta',
  'nordic',
  'forest',
  'ocean',
  'neon',
  'brass',
]
export const POSES: readonly Pose[] = ['sit', 'stand', 'lounge']

export interface ManifestAnchor {
  x: number
  y: number
  z: number
  heading: number
  pose: Pose
  room?: string
  screen?: string
  led?: string
  approach: { x: number; z: number }
}

export interface ManifestNav {
  nodes: Record<string, { x: number; z: number; width: number }>
  edges: [string, string][]
}

export type LightmapTierName = 'full' | 'half' | 'quarter'

export interface Lightmap {
  file: string
  intensity: number
  /** Size tiers (contract §6); absent in older manifests → every tier uses `file`. */
  variants?: Partial<Record<LightmapTierName, string>>
}

export interface ModuleDef {
  file: string
  lightmap?: Lightmap
  bounds: AABB
  anchors: Record<string, ManifestAnchor>
  /** `port:*` anchors: 3D link attach points (y ≠ 0, no heading/pose/approach). */
  ports: Record<string, Vec3>
  nav: ManifestNav
  /** Floor plan for the 2D mode (contract §11); absent in older manifests. */
  plan?: ModulePlan
}

export interface WingTheme {
  file: string
  lightmap?: Lightmap
  signColor: string
  accent: string
}

export interface WingCapacity {
  desk: number
  meeting: number
  meetingSeats: number
  booth: number
  kitchen: number
  lounge: number
  /** Capability rooms (docs/capabilities.md); absent in older manifests. */
  stations?: number
  books?: number
  boards?: number
  notebooks?: number
  readingSeats?: number
}

export interface WingDef {
  themes: Partial<Record<ThemeId, WingTheme>>
  bounds: AABB
  capacity: WingCapacity
  anchors: Record<string, ManifestAnchor>
  ports: Record<string, Vec3>
  nav: ManifestNav
  /** Floor plan shared by every theme (contract §11); absent in older manifests. */
  plan?: ModulePlan
}

export interface Manifest {
  version: 1
  blender: string
  units: 'm'
  hash: string
  hdri: string
  modules: {
    atrium: ModuleDef
    street: ModuleDef
    garden: ModuleDef
    cap: ModuleDef
    wing: WingDef
  }
  character: { file: string; meta: string }
}

/** Thrown by `parseManifest`; `path` names the offending value (e.g. `modules.wing.anchors["seat:desk:1:0"].pose`). */
export class ManifestError extends Error {
  readonly path: string
  constructor(path: string, detail: string) {
    super(`manifest ${path}: ${detail}`)
    this.name = 'ManifestError'
    this.path = path
  }
}

type Obj = Record<string, unknown>
const ANCHOR_ID = /^(seat|spot|port):[a-z]+(:[A-Za-z0-9]+)*$/
const JOIN_EPS = 0.05

const key = (path: string, k: string) =>
  /^[A-Za-z_]\w*$/.test(k) ? (path ? `${path}.${k}` : k) : `${path}["${k}"]`

function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new ManifestError(path, 'expected an object')
  return v as Obj
}

function num(o: Obj, k: string, path: string): number {
  const v = o[k]
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new ManifestError(key(path, k), 'expected a finite number')
  return v
}

function str(o: Obj, k: string, path: string): string {
  const v = o[k]
  if (typeof v !== 'string' || v === '')
    throw new ManifestError(key(path, k), 'expected a non-empty string')
  return v
}

function optStr(o: Obj, k: string, path: string): string | undefined {
  return o[k] === undefined ? undefined : str(o, k, path)
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

function lightmap(v: unknown, path: string): Lightmap | undefined {
  if (v === undefined) return undefined
  const o = obj(v, path)
  const lm: Lightmap = { file: str(o, 'file', path), intensity: num(o, 'intensity', path) }
  if (o.variants !== undefined) {
    const vp = `${path}.variants`
    const vo = obj(o.variants, vp)
    const variants: Partial<Record<LightmapTierName, string>> = {}
    for (const tier of ['full', 'half', 'quarter'] as const)
      if (vo[tier] !== undefined) variants[tier] = str(vo, tier, vp)
    lm.variants = variants
  }
  return lm
}

function anchor(v: unknown, path: string): ManifestAnchor {
  const o = obj(v, path)
  const pose = o.pose
  if (!POSES.includes(pose as Pose))
    throw new ManifestError(`${path}.pose`, `expected one of ${POSES.join('|')}`)
  const ap = obj(o.approach, `${path}.approach`)
  const a: ManifestAnchor = {
    x: num(o, 'x', path),
    y: num(o, 'y', path),
    z: num(o, 'z', path),
    heading: num(o, 'heading', path),
    pose: pose as Pose,
    approach: { x: num(ap, 'x', `${path}.approach`), z: num(ap, 'z', `${path}.approach`) },
  }
  for (const k of ['room', 'screen', 'led'] as const) {
    const s = optStr(o, k, path)
    if (s !== undefined) a[k] = s
  }
  return a
}

function anchors(
  v: unknown,
  path: string,
): { anchors: Record<string, ManifestAnchor>; ports: Record<string, Vec3> } {
  const o = obj(v, path)
  const out: Record<string, ManifestAnchor> = {}
  const ports: Record<string, Vec3> = {}
  for (const [id, a] of Object.entries(o)) {
    const p = key(path, id)
    if (!ANCHOR_ID.test(id))
      throw new ManifestError(p, 'anchor id must match <seat|spot|port>:<group>:<index>')
    if (id.startsWith('port:')) {
      const po = obj(a, p)
      ports[id] = { x: num(po, 'x', p), y: num(po, 'y', p), z: num(po, 'z', p) }
    } else out[id] = anchor(a, p)
  }
  return { anchors: out, ports }
}

function nav(v: unknown, path: string, connectors: [number, number][]): ManifestNav {
  const o = obj(v, path)
  const nodesPath = `${path}.nodes`
  const rawNodes = obj(o.nodes, nodesPath)
  const nodes: ManifestNav['nodes'] = {}
  for (const [id, n] of Object.entries(rawNodes)) {
    const p = key(nodesPath, id)
    const no = obj(n, p)
    const width = num(no, 'width', p)
    if (width <= 0) throw new ManifestError(`${p}.width`, 'expected a positive corridor half-width')
    nodes[id] = { x: num(no, 'x', p), z: num(no, 'z', p), width }
  }
  if (!Array.isArray(o.edges))
    throw new ManifestError(`${path}.edges`, 'expected an array of [idA, idB]')
  const edges: [string, string][] = o.edges.map((e: unknown, i: number) => {
    const ok =
      Array.isArray(e) && e.length === 2 && e.every((id) => typeof id === 'string' && id in nodes)
    if (!ok)
      throw new ManifestError(
        `${path}.edges[${i}]`,
        'expected [idA, idB] referencing existing nodes',
      )
    return [e[0], e[1]] as [string, string]
  })
  for (const [cx, cz] of connectors) {
    const found = Object.values(nodes).some((n) => Math.hypot(n.x - cx, n.z - cz) <= JOIN_EPS)
    if (!found) throw new ManifestError(nodesPath, `missing connector node at (${cx}, ${cz})`)
  }
  const unreachable = disconnected(Object.keys(nodes), edges)
  if (unreachable.length)
    throw new ManifestError(
      path,
      `graph is not connected (unreachable: ${unreachable.slice(0, 5).join(', ')})`,
    )
  return { nodes, edges }
}

/** Ids not reachable from the first node. */
function disconnected(ids: string[], edges: [string, string][]): string[] {
  if (!ids.length) return []
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const [a, b] of edges) {
    adj.get(a)!.push(b)
    adj.get(b)!.push(a)
  }
  const seen = new Set([ids[0]!])
  const stack = [ids[0]!]
  while (stack.length)
    for (const n of adj.get(stack.pop()!)!) if (!seen.has(n)) (seen.add(n), stack.push(n))
  return ids.filter((id) => !seen.has(id))
}

/** [pattern, minimum count, label] per module (contract §4). */
type Requirement = [RegExp, number, string]
const REQUIRED: Record<'wing' | 'atrium' | 'garden', Requirement[]> = {
  wing: [
    [/^seat:desk:[1-6]:[0-3]$/, 24, 'seat:desk:<1-6>:<0-3>'],
    [/^seat:meeting:A:\d+$/, 6, 'seat:meeting:A:*'],
    [/^seat:meeting:B:\d+$/, 6, 'seat:meeting:B:*'],
    [/^spot:booth:\d+$/, 4, 'spot:booth:*'],
    [/^spot:kitchen:\d+$/, 6, 'spot:kitchen:*'],
    [/^seat:lounge:\d+$/, 8, 'seat:lounge:*'],
  ],
  atrium: [
    [/^spot:reception:\d+$/, 4, 'spot:reception:*'],
    [/^spot:elevator:\d+$/, 6, 'spot:elevator:*'],
    [/^seat:cafe:\d+$/, 24, 'seat:cafe:*'],
    [/^spot:pingpong:\d+:A$/, 2, 'spot:pingpong:<table>:A'],
    [/^spot:pingpong:\d+:B$/, 2, 'spot:pingpong:<table>:B'],
  ],
  garden: [[/^spot:garden:\d+$/, 6, 'spot:garden:*']],
}

function requireCounts(ids: string[], reqs: Requirement[], path: string) {
  for (const [re, min, label] of reqs) {
    const n = ids.filter((id) => re.test(id)).length
    if (n < min)
      throw new ManifestError(path, `expected at least ${min} ${label} anchors, found ${n}`)
  }
}

/** Anchors and ports the capability rooms need, for the capacities a manifest declares. */
function capabilityRooms(c: WingCapacity): Requirement[] {
  const out: Requirement[] = []
  if (c.stations !== undefined)
    out.push(
      [/^spot:station:\d+$/, c.stations, 'spot:station:*'],
      [/^port:station:\d+$/, c.stations, 'port:station:*'],
      [/^port:desk:[1-6]:[0-3]$/, c.desk, 'port:desk:<pod>:<i>'],
    )
  if (c.books !== undefined)
    out.push([/^port:book:\d+$/, c.books, 'port:book:*'], [/^spot:shelf:\d+$/, 2, 'spot:shelf:*'])
  if (c.boards !== undefined) out.push([/^port:board:\d+$/, c.boards, 'port:board:*'])
  if (c.notebooks !== undefined) out.push([/^port:notebook:\d+$/, c.notebooks, 'port:notebook:*'])
  if (c.readingSeats !== undefined)
    out.push([/^seat:reading:\d+$/, c.readingSeats, 'seat:reading:*'])
  return out
}

const CONNECTORS: Record<'atrium' | 'street' | 'garden' | 'cap' | 'wing', [number, number][]> = {
  atrium: [[0, 0]],
  street: [
    [0, 0],
    [3, 9],
    [-3, 9],
    [0, 18],
  ],
  garden: [[0, 0]],
  cap: [[0, 0]],
  wing: [[0, 0]],
}

const WALL_KINDS: readonly WallKind[] = ['solid', 'glass', 'curtain']

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new ManifestError(path, 'expected an array')
  return v
}

function nums(v: unknown, n: number, path: string): number[] {
  const ok =
    Array.isArray(v) &&
    v.length === n &&
    v.every((x) => typeof x === 'number' && Number.isFinite(x))
  if (!ok) throw new ManifestError(path, `expected ${n} finite numbers`)
  return [...(v as number[])]
}

/** The optional floor plan (contract §11), validated with paths like the rest. */
function plan(v: unknown, path: string): ModulePlan | undefined {
  if (v === undefined) return undefined
  const o = obj(v, path)
  const rooms = arr(o.rooms, `${path}.rooms`).map((r, i): PlanRoom => {
    const p = `${path}.rooms[${i}]`
    const ro = obj(r, p)
    if (typeof ro.name !== 'string') throw new ManifestError(`${p}.name`, 'expected a string')
    const room: PlanRoom = {
      id: str(ro, 'id', p),
      name: ro.name,
      rect: nums(ro.rect, 4, `${p}.rect`) as PlanRoom['rect'],
    }
    const floor = optStr(ro, 'floor', p)
    if (floor !== undefined) room.floor = floor
    return room
  })
  const walls = arr(o.walls, `${path}.walls`).map((w, i): PlanWall => {
    const p = `${path}.walls[${i}]`
    const wo = obj(w, p)
    if (!WALL_KINDS.includes(wo.kind as WallKind))
      throw new ManifestError(`${p}.kind`, `expected one of ${WALL_KINDS.join('|')}`)
    const wall: PlanWall = {
      a: nums(wo.a, 2, `${p}.a`) as [number, number],
      b: nums(wo.b, 2, `${p}.b`) as [number, number],
      kind: wo.kind as WallKind,
    }
    if (wo.openings !== undefined)
      wall.openings = arr(wo.openings, `${p}.openings`).map(
        (x, j) => nums(x, 2, `${p}.openings[${j}]`) as [number, number],
      )
    return wall
  })
  const furniture = arr(o.furniture, `${path}.furniture`).map((f, i): PlanFurniture => {
    const p = `${path}.furniture[${i}]`
    const fo = obj(f, p)
    if (!FURNITURE_KINDS.includes(fo.kind as FurnitureKind))
      throw new ManifestError(`${p}.kind`, 'unknown furniture kind')
    const item: PlanFurniture = {
      kind: fo.kind as FurnitureKind,
      x: num(fo, 'x', p),
      z: num(fo, 'z', p),
      w: num(fo, 'w', p),
      d: num(fo, 'd', p),
      yaw: num(fo, 'yaw', p),
    }
    const ref = optStr(fo, 'ref', p)
    if (ref !== undefined) item.ref = ref
    return item
  })
  return { rooms, walls, furniture }
}

function moduleDef(v: unknown, name: 'atrium' | 'street' | 'garden' | 'cap'): ModuleDef {
  const path = `modules.${name}`
  const o = obj(v, path)
  const m: ModuleDef = {
    file: str(o, 'file', path),
    bounds: bounds(o.bounds, `${path}.bounds`),
    ...anchors(o.anchors, `${path}.anchors`),
    nav: nav(o.nav, `${path}.nav`, CONNECTORS[name]),
  }
  const lm = lightmap(o.lightmap, `${path}.lightmap`)
  if (lm) m.lightmap = lm
  const pl = plan(o.plan, `${path}.plan`)
  if (pl) m.plan = pl
  if (name === 'atrium' || name === 'garden')
    requireCounts(Object.keys(m.anchors), REQUIRED[name], `${path}.anchors`)
  return m
}

function wingDef(v: unknown): WingDef {
  const path = 'modules.wing'
  const o = obj(v, path)
  const rawThemes = obj(o.themes, `${path}.themes`)
  const themes: WingDef['themes'] = {}
  for (const [id, t] of Object.entries(rawThemes)) {
    const p = `${path}.themes.${id}`
    if (!THEME_IDS.includes(id as ThemeId))
      throw new ManifestError(p, `unknown theme (expected ${THEME_IDS.join('|')})`)
    const to = obj(t, p)
    const theme: WingTheme = {
      file: str(to, 'file', p),
      signColor: str(to, 'signColor', p),
      accent: str(to, 'accent', p),
    }
    const lm = lightmap(to.lightmap, `${p}.lightmap`)
    if (lm) theme.lightmap = lm
    themes[id as ThemeId] = theme
  }
  if (!Object.keys(themes).length)
    throw new ManifestError(`${path}.themes`, 'expected at least one theme')
  const cp = `${path}.capacity`
  const c = obj(o.capacity, cp)
  const capacity: WingCapacity = {
    desk: num(c, 'desk', cp),
    meeting: num(c, 'meeting', cp),
    meetingSeats: num(c, 'meetingSeats', cp),
    booth: num(c, 'booth', cp),
    kitchen: num(c, 'kitchen', cp),
    lounge: num(c, 'lounge', cp),
  }
  for (const k of ['stations', 'books', 'boards', 'notebooks', 'readingSeats'] as const)
    if (c[k] !== undefined) capacity[k] = num(c, k, cp)
  const a = anchors(o.anchors, `${path}.anchors`)
  const ids = [...Object.keys(a.anchors), ...Object.keys(a.ports)]
  requireCounts(ids, [...REQUIRED.wing, ...capabilityRooms(capacity)], `${path}.anchors`)
  const wing: WingDef = {
    themes,
    bounds: bounds(o.bounds, `${path}.bounds`),
    capacity,
    ...a,
    nav: nav(o.nav, `${path}.nav`, CONNECTORS.wing),
  }
  const pl = plan(o.plan, `${path}.plan`)
  if (pl) wing.plan = pl
  return wing
}

/** Validates parsed `manifest.json`. Throws `ManifestError` naming the first offending path. */
export function parseManifest(json: unknown): Manifest {
  const root = obj(json, '(root)')
  if (root.version !== 1) throw new ManifestError('version', 'expected version 1')
  if (root.units !== 'm') throw new ManifestError('units', 'expected "m"')
  const mods = obj(root.modules, 'modules')
  const need = (k: string) => {
    if (mods[k] === undefined) throw new ManifestError(`modules.${k}`, 'missing module')
    return mods[k]
  }
  const ch = obj(root.character, 'character')
  return {
    version: 1,
    blender: str(root, 'blender', ''),
    units: 'm',
    hash: str(root, 'hash', ''),
    hdri: str(root, 'hdri', ''),
    modules: {
      atrium: moduleDef(need('atrium'), 'atrium'),
      street: moduleDef(need('street'), 'street'),
      garden: moduleDef(need('garden'), 'garden'),
      cap: moduleDef(need('cap'), 'cap'),
      wing: wingDef(need('wing')),
    },
    character: { file: str(ch, 'file', 'character'), meta: str(ch, 'meta', 'character') },
  }
}
