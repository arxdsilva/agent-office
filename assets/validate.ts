// Node-side validation of the built 3D assets against docs/graphics-contract.md (CI gate).
// Pure checks (manifest shape, anchors, nav, character metadata, budgets) plus one IO orchestrator,
// validateAssets(dir), that reads manifest.json and every file it references.
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { Logger, NodeIO, type Document, type Node, type Primitive } from '@gltf-transform/core'
import { ALL_EXTENSIONS, type InstancedMesh } from '@gltf-transform/extensions'
import validator from 'gltf-validator'
import { MeshoptDecoder } from 'meshoptimizer'

// ── Contract constants ──────────────────────────────────────────────────────────────────────────
export const MB = 1024 * 1024
/** Contract §9: everything under packages/web/public/assets. */
export const TOTAL_MAX_BYTES = 55 * MB
export const THEMES = ['terracotta', 'nordic', 'forest', 'ocean', 'neon', 'brass'] as const
export const SINGLE_MODULES = ['atrium', 'street', 'garden', 'cap'] as const
export type ModuleKind = (typeof SINGLE_MODULES)[number] | 'wing'

export interface Budget {
  maxBytes: number
  maxTriangles?: number
}
/** Contract §9. Triangles are counted as rendered: every scene node × its GPU instances. */
export const BUDGETS: Record<ModuleKind | 'character', Budget> = {
  atrium: { maxBytes: 12 * MB, maxTriangles: 250_000 },
  wing: { maxBytes: 6 * MB, maxTriangles: 190_000 },
  street: { maxBytes: 3 * MB, maxTriangles: 60_000 },
  garden: { maxBytes: 3 * MB, maxTriangles: 60_000 },
  cap: { maxBytes: 3 * MB, maxTriangles: 60_000 },
  character: { maxBytes: 1.5 * MB },
}
/** Contract §8: the base body with every accessory, prop and LOD hidden. */
export const CHARACTER_BASE_MAX_TRIANGLES = 8_000

export const CLIPS = [
  'Idle',
  'Walk',
  'TurnL90',
  'TurnR90',
  'SitDown',
  'StandUp',
  'SitIdle',
  'SitType',
  'SitThink',
  'SitTalk',
  'SitLaptop',
  'StandTalk',
  'PhoneCall',
  'DrinkCoffee',
  'LoungeSit',
  'PingPong',
  'Wave',
  'HeadScratch',
  'ElevatorIn',
  'StandInteract',
  'SitRead',
  'ShelfPick',
] as const
export const CHARACTER_MATERIALS = ['skin', 'shirt', 'pants', 'hair', 'shoes', 'eyes', 'badge']
export const BONES = [
  'root',
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  ...['shoulder', 'upperarm', 'forearm', 'hand', 'thigh', 'shin', 'foot', 'toe'].flatMap((b) => [
    `${b}.L`,
    `${b}.R`,
  ]),
  'prop.R',
]
export const ACCESSORIES = ['hairA', 'hairB', 'hairC', 'hairD', 'glasses', 'headset', 'badge']
export const PROPS = ['laptop', 'cup', 'phone', 'paddle', 'book']
export const ROLES = [
  'screen',
  'led',
  'sign',
  'elevatorDoor',
  'ceiling',
  'collider',
  'baked',
  // Capability rooms (contract §5) and glass (§9b)
  'station',
  'book',
  'board',
  'notebook',
  'glass',
]
export const POSES = ['sit', 'stand', 'lounge']

/** Contract §4: required anchor counts per module (by id prefix). */
export const REQUIRED_ANCHORS: Partial<Record<ModuleKind, [prefix: string, count: number][]>> = {
  wing: [
    ['seat:desk:', 24],
    ...[1, 2, 3, 4, 5, 6].map((p): [string, number] => [`seat:desk:${p}:`, 4]),
    ['seat:meeting:A:', 6],
    ['seat:meeting:B:', 6],
    ['spot:booth:', 4],
    ['spot:kitchen:', 6],
    ['seat:lounge:', 8],
    // Capability rooms (contract §4): Adapters + Library, and link attach points.
    ['spot:station:', 8],
    ['seat:reading:', 4],
    ['spot:shelf:', 2],
    ['port:desk:', 24],
    ['port:station:', 8],
    ['port:book:', 24],
    ['port:board:', 6],
    ['port:notebook:', 8],
  ],
  atrium: [
    ['spot:reception:', 4],
    ['spot:elevator:', 6],
    ['seat:cafe:', 24],
    ['spot:pingpong:', 4],
  ],
  garden: [['spot:garden:', 6]],
}
/** Contract §3: nodes (module-local) that stitch modules together after placement. */
export const CONNECTORS: Record<ModuleKind, [number, number][]> = {
  atrium: [[0, 0]],
  street: [
    [0, 0],
    [3, 9],
    [-3, 9],
    [0, 18],
  ],
  wing: [[0, 0]],
  garden: [[0, 0]],
  cap: [[0, 0]],
}
export const MERGE_EPS = 0.05

// ── Manifest types (validated loosely, then trusted) ────────────────────────────────────────────
export interface Vec2 {
  x: number
  z: number
}
export interface AnchorJson {
  x: number
  y: number
  z: number
  heading: number
  pose: string
  approach: Vec2
  room?: string
  screen?: string
  led?: string
}
export interface NavJson {
  nodes: Record<string, { x: number; z: number; width: number }>
  edges: [string, string][]
}
export interface Lightmap {
  file: string
  intensity: number
}
export interface ModuleJson {
  file: string
  lightmap?: Lightmap
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }
  anchors: Record<string, AnchorJson>
  nav: NavJson
}
export interface ThemeJson {
  file: string
  lightmap: Lightmap
  signColor: string
  accent: string
}
export interface WingJson extends Omit<ModuleJson, 'file' | 'lightmap'> {
  themes: Record<string, ThemeJson>
  capacity: Record<string, number>
}
export interface Manifest {
  version: 1
  blender: string
  units: 'm'
  hash: string
  hdri: string
  modules: Record<(typeof SINGLE_MODULES)[number], ModuleJson> & { wing: WingJson }
  character: { file: string; meta: string }
}
export interface ClipMeta {
  duration: number
  loop: boolean
  speed?: number
  footPlants?: number[]
}
export interface CharacterMeta {
  height: number
  seatHeight: number
  loungeSeatHeight: number
  clips: Record<string, ClipMeta>
}

// ── Small helpers ───────────────────────────────────────────────────────────────────────────────
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const HEX = /^#[0-9a-fA-F]{6}$/
const ANCHOR_ID = /^(seat|spot|port):[a-z]+(:[A-Za-z0-9]+){1,2}$/

/** A file reference relative to the assets dir; never absolute or escaping it. */
export function isSafeRef(ref: unknown, ext?: RegExp): ref is string {
  if (!isStr(ref) || ref.startsWith('/') || ref.includes('\\') || ref.includes('\0')) return false
  const n = normalize(ref)
  if (n.startsWith('..')) return false
  return ext ? ext.test(ref) : true
}

// ── Manifest shape ──────────────────────────────────────────────────────────────────────────────
function checkLightmap(path: string, v: unknown, out: string[]) {
  if (!isObj(v)) return void out.push(`${path}: missing lightmap { file, intensity }`)
  if (!isSafeRef(v.file, /\.png$/i)) out.push(`${path}.file: must be a relative .png path`)
  if (!isNum(v.intensity) || v.intensity <= 0) out.push(`${path}.intensity: must be > 0`)
}

function checkBounds(path: string, v: unknown, out: string[]) {
  if (!isObj(v) || !['minX', 'maxX', 'minZ', 'maxZ'].every((k) => isNum(v[k])))
    return void out.push(`${path}: bounds must have numeric minX, maxX, minZ, maxZ`)
  if ((v.minX as number) >= (v.maxX as number) || (v.minZ as number) >= (v.maxZ as number))
    out.push(`${path}: bounds are empty`)
}

export function checkAnchor(path: string, id: string, a: unknown): string[] {
  const out: string[] = []
  const at = `${path}["${id}"]`
  if (!ANCHOR_ID.test(id)) out.push(`${at}: id must match <seat|spot|port>:<group>:<index>[:<sub>]`)
  if (!isObj(a)) return [...out, `${at}: must be an object`]
  // Ports are 3D link attach points (contract §4): only a position, y may be off the floor.
  if (id.startsWith('port:')) {
    for (const k of ['x', 'y', 'z']) if (!isNum(a[k])) out.push(`${at}.${k}: not a number`)
    return out
  }
  for (const k of ['x', 'y', 'z', 'heading']) if (!isNum(a[k])) out.push(`${at}.${k}: not a number`)
  if (isNum(a.y) && Math.abs(a.y) > 1e-6) out.push(`${at}.y: anchors sit on the floor (y = 0)`)
  if (!POSES.includes(a.pose as string)) out.push(`${at}.pose: unknown pose "${String(a.pose)}"`)
  if (!isObj(a.approach) || !isNum(a.approach.x) || !isNum(a.approach.z))
    out.push(`${at}.approach: must be { x, z }`)
  for (const k of ['room', 'screen', 'led'])
    if (a[k] !== undefined && !isStr(a[k])) out.push(`${at}.${k}: must be a string`)
  return out
}

function checkNavShape(path: string, v: unknown, out: string[]) {
  if (!isObj(v) || !isObj(v.nodes) || !Array.isArray(v.edges))
    return void out.push(`${path}: nav must be { nodes: {…}, edges: [[a, b], …] }`)
  for (const [id, n] of Object.entries(v.nodes))
    if (!isObj(n) || !isNum(n.x) || !isNum(n.z) || !isNum(n.width) || n.width <= 0)
      out.push(`${path}.nodes["${id}"]: must be { x, z, width > 0 }`)
  v.edges.forEach((e, i) => {
    if (!Array.isArray(e) || e.length !== 2 || !isStr(e[0]) || !isStr(e[1]))
      out.push(`${path}.edges[${i}]: must be [idA, idB]`)
  })
}

function checkModuleShape(path: string, v: unknown, out: string[], needsFile: boolean) {
  if (!isObj(v)) return void out.push(`${path}: missing`)
  if (needsFile && !isSafeRef(v.file, /\.glb$/i))
    out.push(`${path}.file: must be a relative .glb path`)
  if (v.lightmap !== undefined) checkLightmap(`${path}.lightmap`, v.lightmap, out)
  checkBounds(`${path}.bounds`, v.bounds, out)
  if (!isObj(v.anchors)) out.push(`${path}.anchors: must be an object`)
  else
    for (const [id, a] of Object.entries(v.anchors))
      out.push(...checkAnchor(`${path}.anchors`, id, a))
  checkNavShape(`${path}.nav`, v.nav, out)
}

/** Structural validation of manifest.json (contract §7). Errors name the offending path. */
export function checkManifest(m: unknown): string[] {
  const out: string[] = []
  if (!isObj(m)) return ['manifest: must be a JSON object']
  if (m.version !== 1) out.push(`manifest.version: expected 1, got ${JSON.stringify(m.version)}`)
  if (m.units !== 'm') out.push('manifest.units: must be "m"')
  if (!isStr(m.blender) || !/^5\.2(\.|$)/.test(m.blender))
    out.push('manifest.blender: must be a Blender 5.2.x version')
  if (!isStr(m.hash)) out.push('manifest.hash: missing build-input hash')
  if (!isSafeRef(m.hdri, /\.hdr$/i)) out.push('manifest.hdri: must be a relative .hdr path')
  if (!isObj(m.modules)) return [...out, 'manifest.modules: missing']
  for (const k of SINGLE_MODULES) checkModuleShape(`manifest.modules.${k}`, m.modules[k], out, true)
  if (isObj(m.modules.atrium) && m.modules.atrium.lightmap === undefined)
    out.push('manifest.modules.atrium.lightmap: the atrium must be baked')
  const wing = m.modules.wing
  checkModuleShape('manifest.modules.wing', wing, out, false)
  if (isObj(wing)) {
    if (!isObj(wing.themes)) out.push('manifest.modules.wing.themes: missing')
    else
      for (const t of THEMES) {
        const th = wing.themes[t]
        const at = `manifest.modules.wing.themes.${t}`
        if (!isObj(th)) {
          out.push(`${at}: missing theme`)
          continue
        }
        if (!isSafeRef(th.file, /\.glb$/i)) out.push(`${at}.file: must be a relative .glb path`)
        checkLightmap(`${at}.lightmap`, th.lightmap, out)
        for (const k of ['signColor', 'accent'])
          if (!HEX.test(String(th[k]))) out.push(`${at}.${k}: must be #RRGGBB`)
      }
    if (!isObj(wing.capacity)) out.push('manifest.modules.wing.capacity: missing')
  }
  if (!isObj(m.character)) out.push('manifest.character: missing')
  else {
    if (!isSafeRef(m.character.file, /\.glb$/i))
      out.push('manifest.character.file: must be a relative .glb path')
    if (!isSafeRef(m.character.meta, /\.json$/i))
      out.push('manifest.character.meta: must be a relative .json path')
  }
  return out
}

// ── Anchors ─────────────────────────────────────────────────────────────────────────────────────
export function checkAnchorCounts(kind: ModuleKind, anchors: Record<string, unknown>): string[] {
  const out: string[] = []
  const ids = Object.keys(anchors)
  for (const [prefix, count] of REQUIRED_ANCHORS[kind] ?? []) {
    const got = ids.filter((id) => id.startsWith(prefix)).length
    if (got !== count) out.push(`${kind}: expected ${count} "${prefix}*" anchors, found ${got}`)
  }
  if (kind === 'atrium') {
    // Two ping-pong tables, each with an A and a B side.
    const tables = new Map<string, Set<string>>()
    for (const id of ids) {
      const m = /^spot:pingpong:([^:]+):([AB])$/.exec(id)
      if (m) tables.set(m[1]!, (tables.get(m[1]!) ?? new Set()).add(m[2]!))
    }
    if (tables.size !== 2 || [...tables.values()].some((s) => s.size !== 2))
      out.push('atrium: expected 2 ping-pong tables with sides A and B (spot:pingpong:<t>:A|B)')
  }
  return out
}

/** The wing's declared capacity must match its anchors (contract §7). */
export function checkCapacity(capacity: Record<string, number>, anchors: Record<string, unknown>) {
  const ids = Object.keys(anchors)
  const n = (p: string) => ids.filter((id) => id.startsWith(p)).length
  const rooms = new Set(
    ids.map((id) => /^seat:meeting:([^:]+):/.exec(id)?.[1]).filter((r): r is string => !!r),
  )
  const want: Record<string, number> = {
    desk: n('seat:desk:'),
    meeting: rooms.size,
    meetingSeats: rooms.size ? Math.min(...[...rooms].map((r) => n(`seat:meeting:${r}:`))) : 0,
    booth: n('spot:booth:'),
    kitchen: n('spot:kitchen:'),
    lounge: n('seat:lounge:'),
  }
  return Object.entries(want)
    .filter(([k, v]) => capacity[k] !== v)
    .map(([k, v]) => `wing.capacity.${k}: is ${capacity[k]}, but the anchors give ${v}`)
}

// ── Navigation ──────────────────────────────────────────────────────────────────────────────────
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z)
function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const len2 = dx * dx + dz * dz
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2)) : 0
  return dist(p, { x: a.x + t * dx, z: a.z + t * dz })
}

/** Number of connected components (0 for an empty graph). */
export function components(nodes: string[], edges: [string, string][]): string[][] {
  const adj = new Map(nodes.map((n) => [n, [] as string[]]))
  for (const [a, b] of edges) {
    adj.get(a)?.push(b)
    adj.get(b)?.push(a)
  }
  const seen = new Set<string>()
  const out: string[][] = []
  for (const start of nodes) {
    if (seen.has(start)) continue
    const comp: string[] = []
    const stack = [start]
    seen.add(start)
    while (stack.length) {
      const n = stack.pop()!
      comp.push(n)
      for (const m of adj.get(n) ?? []) if (!seen.has(m)) (seen.add(m), stack.push(m))
    }
    out.push(comp)
  }
  return out
}

/** A point is on the graph if it is at a node (≤ 5 cm) or inside an edge's corridor. */
export function onGraph(p: Vec2, nav: NavJson): boolean {
  const nodes = nav.nodes
  for (const n of Object.values(nodes)) if (dist(p, n) <= MERGE_EPS) return true
  for (const [a, b] of nav.edges) {
    const na = nodes[a]
    const nb = nodes[b]
    if (na && nb && distToSegment(p, na, nb) <= Math.min(na.width, nb.width)) return true
  }
  return false
}

/** Per-module nav: edges reference nodes, one connected graph, every approach on it, connectors. */
export function checkNav(kind: ModuleKind, nav: NavJson, anchors: Record<string, AnchorJson>) {
  const out: string[] = []
  const ids = Object.keys(nav.nodes)
  nav.edges.forEach(([a, b], i) => {
    for (const id of [a, b])
      if (!(id in nav.nodes)) out.push(`${kind}.nav.edges[${i}]: unknown node "${id}"`)
  })
  const comps = components(ids, nav.edges)
  if (ids.length === 0) out.push(`${kind}.nav: has no nodes`)
  else if (comps.length > 1)
    out.push(
      `${kind}.nav: graph is not connected (${comps.length} parts; e.g. "${comps[1]![0]}" is cut off)`,
    )
  for (const [id, a] of Object.entries(anchors))
    if (a.approach && !onGraph(a.approach, nav))
      out.push(
        `${kind}.anchors["${id}"].approach: (${a.approach.x}, ${a.approach.z}) is not on the nav graph`,
      )
  for (const [x, z] of CONNECTORS[kind])
    if (!Object.values(nav.nodes).some((n) => dist(n, { x, z }) <= MERGE_EPS))
      out.push(`${kind}.nav: missing connector node at local (${x}, ${z})`)
  return out
}

/** Contract §1 placement: translation + yaw θ. */
export function place(p: Vec2, t: Vec2, yaw: number): Vec2 {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return { x: p.x * c + p.z * s + t.x, z: -p.x * s + p.z * c + t.z }
}

/**
 * Merge the nav graphs of a one-bay building (atrium, street, wing right, garden left, cap) the way
 * the runtime does (nodes ≤ 5 cm apart are one node) and report whether it is a single graph.
 */
export function checkBuildingNav(m: Manifest): string[] {
  const placed: { kind: ModuleKind; nav: NavJson; at: Vec2; yaw: number }[] = [
    { kind: 'atrium', nav: m.modules.atrium.nav, at: { x: 0, z: 0 }, yaw: 0 },
    { kind: 'street', nav: m.modules.street.nav, at: { x: 0, z: 0 }, yaw: 0 },
    { kind: 'wing', nav: m.modules.wing.nav, at: { x: 3, z: 9 }, yaw: 0 },
    { kind: 'garden', nav: m.modules.garden.nav, at: { x: -3, z: 9 }, yaw: Math.PI },
    { kind: 'cap', nav: m.modules.cap.nav, at: { x: 0, z: 18 }, yaw: 0 },
  ]
  const world: { id: string; pos: Vec2 }[] = []
  const edges: [string, string][] = []
  for (const p of placed) {
    for (const [id, n] of Object.entries(p.nav.nodes))
      world.push({ id: `${p.kind}/${id}`, pos: place(n, p.at, p.yaw) })
    for (const [a, b] of p.nav.edges) edges.push([`${p.kind}/${a}`, `${p.kind}/${b}`])
  }
  for (let i = 0; i < world.length; i++)
    for (let j = i + 1; j < world.length; j++)
      if (dist(world[i]!.pos, world[j]!.pos) <= MERGE_EPS) edges.push([world[i]!.id, world[j]!.id])
  const comps = components(
    world.map((w) => w.id),
    edges,
  )
  return comps.length > 1
    ? [
        `building nav: modules do not join into one graph (${comps.length} parts; e.g. "${comps[1]![0]}" is cut off). Check the connector nodes (contract §3).`,
      ]
    : []
}

// ── Character metadata ──────────────────────────────────────────────────────────────────────────
export function checkCharacterMeta(meta: unknown): string[] {
  if (!isObj(meta)) return ['character.json: must be a JSON object']
  const out: string[] = []
  for (const k of ['height', 'seatHeight', 'loungeSeatHeight'])
    if (!isNum(meta[k]) || (meta[k] as number) <= 0) out.push(`character.json.${k}: must be > 0`)
  if (!isObj(meta.clips)) return [...out, 'character.json.clips: missing']
  for (const clip of CLIPS) {
    const c = meta.clips[clip]
    if (!isObj(c)) {
      out.push(`character.json.clips.${clip}: missing`)
      continue
    }
    if (!isNum(c.duration) || c.duration <= 0)
      out.push(`character.json.clips.${clip}.duration: must be > 0`)
    if (typeof c.loop !== 'boolean')
      out.push(`character.json.clips.${clip}.loop: must be a boolean`)
  }
  const walk = meta.clips.Walk
  if (isObj(walk)) {
    if (!isNum(walk.speed) || walk.speed <= 0)
      out.push('character.json.clips.Walk.speed: must be the authored ground speed (m/s) > 0')
    if (
      !Array.isArray(walk.footPlants) ||
      walk.footPlants.length === 0 ||
      !walk.footPlants.every((p) => isNum(p) && p >= 0 && p < 1)
    )
      out.push('character.json.clips.Walk.footPlants: must be a non-empty list of phases in [0, 1)')
    if (walk.loop !== true) out.push('character.json.clips.Walk.loop: must be true')
  }
  return out
}

// ── glb statistics ──────────────────────────────────────────────────────────────────────────────
export function primitiveTriangles(p: Primitive): number {
  const count = p.getIndices()?.getCount() ?? p.getAttribute('POSITION')?.getCount() ?? 0
  const mode = p.getMode()
  if (mode === 4) return Math.floor(count / 3) // TRIANGLES
  if (mode === 5 || mode === 6) return Math.max(0, count - 2) // STRIP, FAN
  return 0
}

export interface GlbStats {
  /** Rendered triangles: every node in the default scene × its EXT_mesh_gpu_instancing count. */
  triangles: number
  /** Same, excluding accessory, prop and LOD≥1 subtrees (the character's base body). */
  baseTriangles: number
  roles: Map<string, string[]>
  unknownRoles: string[]
  bakedWithoutUv1: string[]
  materials: string[]
  animations: string[]
  joints: string[]
  accessories: string[]
  props: { name: string; prop: string; parent: string | null }[]
}

const isVariant = (n: Node) => {
  const x = n.getExtras() as Record<string, unknown>
  return (
    !!x.accessory ||
    !!x.prop ||
    (isNum(x.lod) && x.lod >= 1) ||
    /(^|[_.-])lod[1-9]/i.test(n.getName())
  )
}

export function glbStats(doc: Document): GlbStats {
  const root = doc.getRoot()
  const s: GlbStats = {
    triangles: 0,
    baseTriangles: 0,
    roles: new Map(),
    unknownRoles: [],
    bakedWithoutUv1: [],
    materials: root.listMaterials().map((m) => m.getName()),
    animations: root.listAnimations().map((a) => a.getName()),
    joints: [...new Set(root.listSkins().flatMap((k) => k.listJoints().map((j) => j.getName())))],
    accessories: [],
    props: [],
  }
  const visit = (n: Node, inVariant: boolean) => {
    const x = n.getExtras() as Record<string, unknown>
    const variant = inVariant || isVariant(n)
    if (isStr(x.role)) {
      if (!ROLES.includes(x.role)) s.unknownRoles.push(`${n.getName()} (${x.role})`)
      s.roles.set(x.role, [...(s.roles.get(x.role) ?? []), isStr(x.ref) ? x.ref : n.getName()])
    }
    if (isStr(x.accessory)) s.accessories.push(x.accessory)
    if (isStr(x.prop))
      s.props.push({
        name: n.getName(),
        prop: x.prop,
        parent: n.getParentNode()?.getName() ?? null,
      })
    const mesh = n.getMesh()
    if (mesh) {
      const inst = n.getExtension<InstancedMesh>('EXT_mesh_gpu_instancing')
      const copies = inst?.listAttributes()[0]?.getCount() ?? 1
      const tris = mesh.listPrimitives().reduce((t, p) => t + primitiveTriangles(p), 0) * copies
      s.triangles += tris
      if (!variant) s.baseTriangles += tris
      if (x.role === 'baked' && mesh.listPrimitives().some((p) => !p.getAttribute('TEXCOORD_1')))
        s.bakedWithoutUv1.push(n.getName())
    }
    for (const c of n.listChildren()) visit(c, variant)
  }
  const scene = root.getDefaultScene() ?? root.listScenes()[0]
  for (const n of scene?.listChildren() ?? []) visit(n, false)
  return s
}

// ── Per-file checks ─────────────────────────────────────────────────────────────────────────────
export function checkBudget(file: string, bytes: number, budget: Budget, triangles?: number) {
  const out: string[] = []
  if (bytes > budget.maxBytes)
    out.push(`${file}: ${(bytes / MB).toFixed(2)} MB exceeds the ${budget.maxBytes / MB} MB budget`)
  if (
    budget.maxTriangles !== undefined &&
    triangles !== undefined &&
    triangles > budget.maxTriangles
  )
    out.push(`${file}: ${triangles} triangles exceeds the ${budget.maxTriangles} budget`)
  return out
}

/** Building modules: known roles, lightmap UVs, and every screen/led an anchor names exists. */
export function checkModuleGlb(
  file: string,
  kind: ModuleKind,
  s: GlbStats,
  anchors: Record<string, AnchorJson>,
): string[] {
  const out: string[] = []
  for (const r of s.unknownRoles) out.push(`${file}: unknown extras.role on node ${r}`)
  for (const n of s.bakedWithoutUv1)
    out.push(`${file}: baked node "${n}" has no TEXCOORD_1 (lightmap UV)`)
  const screens = new Set(s.roles.get('screen') ?? [])
  const leds = new Set(s.roles.get('led') ?? [])
  for (const [id, a] of Object.entries(anchors)) {
    if (a.screen && !screens.has(a.screen))
      out.push(
        `${file}: anchor ${id} names screen "${a.screen}", but no node has role screen with that ref`,
      )
    if (a.led && !leds.has(a.led))
      out.push(`${file}: anchor ${id} names led "${a.led}", but no node has role led with that ref`)
  }
  if (kind === 'wing' && !s.roles.has('sign'))
    out.push(`${file}: wing has no node with role "sign"`)
  return out
}

export function checkCharacterGlb(file: string, s: GlbStats, meta?: CharacterMeta): string[] {
  const out: string[] = []
  for (const c of CLIPS)
    if (!s.animations.includes(c)) out.push(`${file}: missing animation clip "${c}"`)
  if (meta)
    for (const c of Object.keys(meta.clips))
      if (!s.animations.includes(c))
        out.push(`${file}: character.json lists clip "${c}" that the glb lacks`)
  for (const m of CHARACTER_MATERIALS)
    if (!s.materials.includes(m)) out.push(`${file}: missing material "${m}"`)
  for (const b of BONES) if (!s.joints.includes(b)) out.push(`${file}: missing bone "${b}"`)
  for (const a of s.accessories)
    if (!ACCESSORIES.includes(a)) out.push(`${file}: unknown extras.accessory "${a}"`)
  for (const p of s.props) {
    if (!PROPS.includes(p.prop)) out.push(`${file}: unknown extras.prop "${p.prop}"`)
    if (p.parent !== 'prop.R') out.push(`${file}: prop "${p.prop}" must be parented to bone prop.R`)
  }
  if (s.baseTriangles > CHARACTER_BASE_MAX_TRIANGLES)
    out.push(
      `${file}: base body has ${s.baseTriangles} triangles (budget ${CHARACTER_BASE_MAX_TRIANGLES}, accessories hidden)`,
    )
  return out
}

// ── IO orchestrator ─────────────────────────────────────────────────────────────────────────────
export interface FileReport {
  file: string
  bytes: number
  triangles?: number
}
export interface AssetReport {
  problems: string[]
  files: FileReport[]
  totalBytes: number
}

const LFS_POINTER = 'version https://git-lfs'
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

async function dirSize(dir: string): Promise<number> {
  let total = 0
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    total += e.isDirectory() ? await dirSize(p) : (await stat(p)).size
  }
  return total
}

export async function createIO(): Promise<NodeIO> {
  await MeshoptDecoder.ready
  return new NodeIO()
    .setLogger(new Logger(Logger.Verbosity.SILENT))
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
}

/**
 * Validate the assets dir (packages/web/public/assets) against the contract. Never throws for asset
 * problems: everything wrong is listed in `problems`, so CI prints the full picture at once.
 */
export async function validateAssets(dir: string): Promise<AssetReport> {
  const report: AssetReport = { problems: [], files: [], totalBytes: 0 }
  const p = report.problems
  let manifestText: string
  try {
    manifestText = await readFile(join(dir, 'manifest.json'), 'utf8')
  } catch {
    p.push(
      `${join(dir, 'manifest.json')} is missing. Build the assets with \`make assets\` (Blender 5.2), or fetch them with \`git lfs pull\`.`,
    )
    return report
  }
  let raw: unknown
  try {
    raw = JSON.parse(manifestText)
  } catch (e) {
    p.push(`manifest.json: invalid JSON (${(e as Error).message})`)
    return report
  }
  p.push(...checkManifest(raw))
  if (p.length) return report
  const m = raw as Manifest
  const io = await createIO()

  const load = async (ref: string): Promise<Uint8Array | null> => {
    try {
      const bytes = new Uint8Array(await readFile(join(dir, ref)))
      if (new TextDecoder().decode(bytes.subarray(0, LFS_POINTER.length)) === LFS_POINTER) {
        p.push(
          `${ref}: is a Git LFS pointer, not the file. Run \`git lfs install && git lfs pull\`.`,
        )
        return null
      }
      return bytes
    } catch {
      p.push(`${ref}: referenced by manifest.json but missing`)
      return null
    }
  }

  const glb = async (ref: string, budget: Budget): Promise<GlbStats | null> => {
    const bytes = await load(ref)
    if (!bytes) return null
    const v = await validator.validateBytes(bytes, { uri: ref, maxIssues: 50 })
    if (v.issues.numErrors > 0) {
      const errs = v.issues.messages.filter((i) => i.severity === 0).slice(0, 5)
      p.push(
        `${ref}: gltf-validator found ${v.issues.numErrors} error(s): ${errs.map((i) => `${i.code} at ${i.pointer ?? '?'} (${i.message})`).join('; ')}`,
      )
    }
    let stats: GlbStats
    try {
      stats = glbStats(await io.readBinary(bytes))
    } catch (e) {
      p.push(`${ref}: could not be read (${(e as Error).message})`)
      return null
    }
    report.files.push({ file: ref, bytes: bytes.length, triangles: stats.triangles })
    p.push(...checkBudget(ref, bytes.length, budget, stats.triangles))
    return stats
  }

  const png = async (ref: string) => {
    const bytes = await load(ref)
    if (bytes && !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) p.push(`${ref}: is not a PNG file`)
  }

  // Building modules
  for (const kind of SINGLE_MODULES) {
    const mod = m.modules[kind]
    p.push(...checkAnchorCounts(kind, mod.anchors), ...checkNav(kind, mod.nav, mod.anchors))
    const s = await glb(mod.file, BUDGETS[kind])
    if (s) p.push(...checkModuleGlb(mod.file, kind, s, mod.anchors))
    if (mod.lightmap) await png(mod.lightmap.file)
  }
  const wing = m.modules.wing
  p.push(
    ...checkAnchorCounts('wing', wing.anchors),
    ...checkCapacity(wing.capacity, wing.anchors),
    ...checkNav('wing', wing.nav, wing.anchors),
  )
  for (const t of THEMES) {
    const th = wing.themes[t]!
    const s = await glb(th.file, BUDGETS.wing)
    if (s) p.push(...checkModuleGlb(th.file, 'wing', s, wing.anchors))
    await png(th.lightmap.file)
  }
  p.push(...checkBuildingNav(m))

  // Environment and character
  await load(m.hdri)
  let meta: CharacterMeta | undefined
  const metaBytes = await load(m.character.meta)
  if (metaBytes) {
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(metaBytes))
      const errs = checkCharacterMeta(parsed)
      p.push(...errs)
      if (!errs.length) meta = parsed as CharacterMeta
    } catch (e) {
      p.push(`${m.character.meta}: invalid JSON (${(e as Error).message})`)
    }
  }
  const cs = await glb(m.character.file, BUDGETS.character)
  if (cs) p.push(...checkCharacterGlb(m.character.file, cs, meta))

  report.totalBytes = await dirSize(dir)
  if (report.totalBytes > TOTAL_MAX_BYTES)
    p.push(
      `assets total ${(report.totalBytes / MB).toFixed(1)} MB exceeds the ${TOTAL_MAX_BYTES / MB} MB budget`,
    )
  return report
}
