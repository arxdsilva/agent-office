// A stand-in Night City manifest (graphics contract §14) generated in code, so the mode works
// before the Blender set lands: an atrium (~40 × 30 m, 14 m tall) facing the city and a Project
// Command Center north of it, with the same anchor grammar the real set uses. Pure data; the
// placeholder geometry (special-3d/adapters/world/placeholder.ts) is built from it.
import type { ManifestAnchor, ManifestNav } from '../../app/manifest.ts'
import type { AABB, Pose, Vec2 } from '../../app/office-types.ts'
import type { ModulePlan, PlanFurniture, PlanRoom, PlanWall } from '../../app/pixel/types.ts'
import { collidersFromPlan, type Collider } from '../../app/special/world.ts'

export const FIXTURE_HASH = 'fixture-r1'
export const ATRIUM_HEIGHT = 14
export const COMMAND_HEIGHT = 7

/** Things the placeholder draws that a floor plan can't express (heights, suspended pieces). */
export interface FixtureDecor {
  /** The giant suspended display (holo role): centre, size, facing yaw. */
  screen: { x: number; y: number; z: number; w: number; h: number; yaw: number }
  /** Skybridges: a straight deck at height y from a to b, width w. */
  bridges: { a: Vec2; b: Vec2; y: number; w: number }[]
  bonsai: Vec2[]
  /** Floor light strips (emissive lines) a → b. */
  strips: { a: Vec2; b: Vec2; color: 'cyan' | 'amber' }[]
  /** Ceiling fixtures (cyan panels) per module, local coords and ceiling height. */
  ceiling: { module: 'hq-atrium' | 'command'; at: Vec2; w: number; d: number; y: number }[]
  /** The command center's central holo (holo role). */
  holo: { x: number; z: number; r: number }
  /** Neon signs (neon role): text drawn at runtime, original. */
  neon: {
    module: 'hq-atrium' | 'command'
    at: Vec2
    y: number
    yaw: number
    text: string
    color: string
  }[]
}

type AnchorMap = Record<string, ManifestAnchor>
const R = Math.PI

function anchor(
  x: number,
  z: number,
  heading: number,
  pose: Pose,
  approach: Vec2,
  extra: Partial<ManifestAnchor> = {},
): ManifestAnchor {
  return { x, y: 0, z, heading, pose, approach, ...extra }
}
/** Approach `d` m behind the anchor (opposite its heading). */
const behind = (x: number, z: number, heading: number, d: number): Vec2 => ({
  x: x - Math.sin(heading) * d,
  z: z - Math.cos(heading) * d,
})
/** Approach `d` m in front of the anchor. */
const ahead = (x: number, z: number, heading: number, d: number): Vec2 => ({
  x: x + Math.sin(heading) * d,
  z: z + Math.cos(heading) * d,
})
const r2 = (v: number) => Math.round(v * 100) / 100

// ── Atrium (local = world; elevators west, curtain wall east toward the city) ──────────────────
function atrium(): { anchors: AnchorMap; plan: ModulePlan; bounds: AABB } {
  const bounds = { minX: -20, maxX: 20, minZ: -15, maxZ: 15 }
  const a: AnchorMap = {}
  const furniture: PlanFurniture[] = []
  const elevZ = [-5.4, -1.8, 1.8, 5.4]
  elevZ.forEach((z, i) => {
    furniture.push({ kind: 'elevator', x: -19.2, z, w: 2.4, d: 1.6, yaw: R / 2 })
    // Facing the doors (−x): ElevatorIn walks in, arrivals turn out.
    a[`spot:elevator:${i}`] = anchor(-17.4, z, -R / 2, 'stand', behind(-17.4, z, -R / 2, 0.6))
  })
  a['player:spawn'] = anchor(-15.6, 0, R / 2, 'stand', { x: -15, z: 0 })
  // Security gates: posts with 1.8 m lanes at z = −6, −3, 0, 3, 6.
  for (const z of [-7.5, -4.5, -1.5, 1.5, 4.5, 7.5])
    furniture.push({ kind: 'lectern', x: -13, z, w: 0.3, d: 1.2, yaw: 0 })
  furniture.push({ kind: 'reception-desk', x: -8, z: -8.2, w: 5, d: 1.2, yaw: 0 })
  a['spot:reception:0'] = anchor(-8, -6.6, R, 'stand', ahead(-8, -6.6, 0, 0.6))
  a['spot:reception:1'] = anchor(-6.6, -6.6, R, 'stand', ahead(-6.6, -6.6, 0, 0.6))
  // The Project Directory console: the interact anchor is the console's front.
  furniture.push({ kind: 'kiosk', x: -8, z: 7.6, w: 1.4, d: 0.8, yaw: R })
  a['interact:project-directory:0'] = anchor(-8, 7, R, 'stand', { x: -8, z: 6.2 })
  // Bonsai planters (amber uplight) and angular lounge seating near the curtain wall.
  for (const z of [-10, 10]) furniture.push({ kind: 'planter', x: 2, z, w: 2.4, d: 2.4, yaw: 0 })
  let lounge = 0
  for (const side of [-1, 1]) {
    const zc = 9 * side
    furniture.push({ kind: 'sofa', x: 14, z: zc + 1.5, w: 3, d: 0.9, yaw: 0 })
    furniture.push({ kind: 'sofa', x: 14, z: zc - 1.5, w: 3, d: 0.9, yaw: 0 })
    furniture.push({ kind: 'cafe-table', x: 14, z: zc, w: 2, d: 0.8, yaw: 0 })
    for (const dx of [-0.9, 0.9]) {
      a[`seat:lounge:${lounge++}`] = anchor(14 + dx, zc + 1.4, R, 'lounge', {
        x: 14 + dx,
        z: zc + 0.75,
      })
      a[`seat:lounge:${lounge++}`] = anchor(14 + dx, zc - 1.4, 0, 'lounge', {
        x: 14 + dx,
        z: zc - 0.75,
      })
    }
  }
  const walls: PlanWall[] = [
    { a: [-20, -15], b: [-20, 15], kind: 'solid', side: -1, thick: 0.3 },
    { a: [-20, -15], b: [20, -15], kind: 'solid', side: 1, thick: 0.3 },
    // North wall: the corridor to the Command Center at x ∈ [−3, 3].
    { a: [-20, 15], b: [20, 15], kind: 'solid', side: -1, thick: 0.3, openings: [[17, 23]] },
    { a: [20, -15], b: [20, 15], kind: 'curtain', side: 1, thick: 0.2 },
  ]
  const rooms: PlanRoom[] = [
    { id: 'elevators', name: 'Elevator Lobby', rect: [-20, -15, -13, 15], floor: 'stone' },
    { id: 'atrium', name: 'Meridian Atrium', rect: [-13, -15, 20, 15], floor: 'stone' },
  ]
  return { anchors: a, plan: { rooms, walls, furniture }, bounds }
}

// ── Project Command Center (local; attached north of the atrium) ────────────────────────────────
/** Department rects (local): west/east columns × three bands; d0 is nearest the entrance. */
export const DEPARTMENT_RECTS: readonly [number, number, number, number][] = [
  [-21, -13, -5, -5],
  [5, -13, 21, -5],
  [-21, -4, -5, 4],
  [5, -4, 21, 4],
  [-21, 5, -5, 13],
  [5, 5, 21, 13],
]

function command(): { anchors: AnchorMap; plan: ModulePlan; bounds: AABB } {
  const bounds = { minX: -27, maxX: 27, minZ: -15, maxZ: 15 }
  const a: AnchorMap = {}
  const furniture: PlanFurniture[] = []
  const rooms: PlanRoom[] = [
    { id: 'ops', name: 'Project Command Center', rect: [-27, -15, 27, 15], floor: 'stone' },
  ]
  DEPARTMENT_RECTS.forEach(([x0, z0], d) => {
    for (let p = 1; p <= 6; p++) {
      const c = (p - 1) % 3
      const row = Math.floor((p - 1) / 3)
      const px = r2(x0 + 2.67 + c * 5.33)
      const pz = z0 + 2 + row * 4
      furniture.push({ kind: 'desk', x: px, z: pz, w: 3, d: 1.5, yaw: 0, ref: `pod:${d}:${p}` })
      for (let s = 0; s < 4; s++) {
        const dx = s % 2 ? 0.75 : -0.75
        const south = s < 2
        const x = r2(px + dx)
        const z = r2(pz + (south ? -1.05 : 1.05))
        const h = south ? 0 : R
        a[`ws:${d}:${p}:${s}`] = anchor(x, z, h, 'sit', behind(x, z, h, 0.85), {
          room: `dept-${d}`,
          screen: `ws:${d}:${p}:${s}`,
        })
      }
    }
  })
  // The central holo display; the interact anchor is the platform's front edge.
  furniture.push({ kind: 'context-core', x: 0, z: 0, w: 3, d: 3, yaw: 0 })
  a['interact:command-display:0'] = anchor(0, -1.9, 0, 'stand', { x: 0, z: -2.6 })
  // Glass meeting rooms A (west) and B (east), six seats each.
  for (const [room, sx] of [
    ['A', -1],
    ['B', 1],
  ] as const) {
    const cx = 24.5 * sx
    furniture.push({ kind: 'meeting-table', x: cx, z: 0, w: 1.4, d: 4.2, yaw: 0 })
    rooms.push({
      id: `meeting-${room}`,
      name: `Meeting Room ${room}`,
      rect: sx < 0 ? [-27, -5, -22, 5] : [22, -5, 27, 5],
    })
    ;[-1.4, 0, 1.4].forEach((z, i) => {
      a[`meet:${room}:${i}`] = anchor(cx - 1.05, z, R / 2, 'sit', { x: cx - 1.75, z })
      a[`meet:${room}:${i + 3}`] = anchor(cx + 1.05, z, -R / 2, 'sit', { x: cx + 1.75, z })
    })
  }
  // Secure comm booths on the north wall (waiting agents), front open.
  ;[-4.5, -1.5, 1.5, 4.5].forEach((x, n) => {
    a[`booth:${n}`] = anchor(
      x,
      14,
      0,
      'stand',
      { x, z: 12.6 },
      { room: `booth-${n}`, led: `booth:${n}` },
    )
  })
  rooms.push({ id: 'booths', name: 'Comm Booths', rect: [-6, 12.8, 6, 15] })
  // Provider terminal wall (south) and server racks (east/west ends).
  ;[-12, -9, 9, 12].forEach((x, n) => {
    furniture.push({ kind: 'console', x, z: -14.6, w: 1.6, d: 0.5, yaw: 0 })
    a[`spot:terminal:${n}`] = anchor(x, -13.8, R, 'stand', { x, z: -13.2 })
  })
  a['interact:provider-terminal:0'] = anchor(-10.5, -14.1, R, 'stand', { x: -10.5, z: -13.3 })
  a['interact:provider-terminal:1'] = anchor(10.5, -14.1, R, 'stand', { x: 10.5, z: -13.3 })
  for (const sx of [-1, 1])
    for (const z of [-13, -11, -9, 9, 11, 13])
      furniture.push({ kind: 'core-rack', x: 25.8 * sx, z, w: 0.9, d: 1.6, yaw: 0 })
  const walls: PlanWall[] = [
    { a: [-27, -15], b: [27, -15], kind: 'solid', side: 1, thick: 0.3, openings: [[24, 30]] },
    { a: [-27, 15], b: [27, 15], kind: 'solid', side: -1, thick: 0.3 },
    { a: [-27, -15], b: [-27, 15], kind: 'solid', side: -1, thick: 0.3 },
    { a: [27, -15], b: [27, 15], kind: 'glass', side: 1, thick: 0.2 },
    // Meeting room glass (door gaps toward the floor).
    { a: [-22, -5], b: [-22, 5], kind: 'glass', thick: 0.1, openings: [[4, 6]] },
    { a: [-27, -5], b: [-22, -5], kind: 'glass', thick: 0.1 },
    { a: [-27, 5], b: [-22, 5], kind: 'glass', thick: 0.1 },
    { a: [22, -5], b: [22, 5], kind: 'glass', thick: 0.1, openings: [[4, 6]] },
    { a: [22, -5], b: [27, -5], kind: 'glass', thick: 0.1 },
    { a: [22, 5], b: [27, 5], kind: 'glass', thick: 0.1 },
    // Booth partitions.
    ...[-6, -3, 0, 3, 6].map((x): PlanWall => ({
      a: [x, 12.9],
      b: [x, 15],
      kind: 'glass',
      thick: 0.08,
    })),
  ]
  return { anchors: a, plan: { rooms, walls, furniture }, bounds }
}

// ── Nav: a grid over the floor that avoids colliders, plus one `ap:` node per anchor ───────────
const BODY = 0.35
function blocked(p: Vec2, boxes: Collider[], r = BODY): boolean {
  for (const c of boxes) {
    if (c.maxY < 0.3) continue
    if (p.x + r > c.minX && p.x - r < c.maxX && p.z + r > c.minZ && p.z - r < c.maxZ) return true
  }
  return false
}
function clear(a: Vec2, b: Vec2, boxes: Collider[], r = BODY): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.2))
  for (let i = 0; i <= n; i++) {
    const t = i / n
    if (blocked({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }, boxes, r)) return false
  }
  return true
}

/** Grid nodes (`g:i:j`) every `step` m inside `bounds` that are free, joined to free neighbours. */
export function gridNav(
  bounds: AABB,
  step: number,
  boxes: Collider[],
  anchors: AnchorMap,
  connectors: Vec2[] = [],
): ManifestNav {
  const nodes: ManifestNav['nodes'] = {}
  const edges: [string, string][] = []
  const at = new Map<string, Vec2>()
  const nx = Math.floor((bounds.maxX - bounds.minX) / step)
  const nz = Math.floor((bounds.maxZ - bounds.minZ) / step)
  const ox = bounds.minX + (bounds.maxX - bounds.minX - nx * step) / 2
  const oz = bounds.minZ + (bounds.maxZ - bounds.minZ - nz * step) / 2
  for (let i = 1; i < nx; i++)
    for (let j = 1; j < nz; j++) {
      const p = { x: r2(ox + i * step), z: r2(oz + j * step) }
      if (blocked(p, boxes, 0.45)) continue
      const id = `g:${i}:${j}`
      nodes[id] = { ...p, width: 0.7 }
      at.set(id, p)
    }
  for (const [id, p] of at) {
    const [, i, j] = id.split(':').map(Number) as [number, number, number]
    for (const [di, dj] of [
      [1, 0],
      [0, 1],
    ] as const) {
      const other = `g:${i + di}:${j + dj}`
      const q = at.get(other)
      if (q && clear(p, q, boxes)) edges.push([id, other])
    }
  }
  const grid = [...at]
  const link = (id: string, p: Vec2) => {
    const near = grid
      .map(([gid, g]) => ({ gid, d: Math.hypot(g.x - p.x, g.z - p.z), g }))
      .sort((u, v) => u.d - v.d)
      .slice(0, 6)
    const best = near.find((n) => clear(p, n.g, boxes, 0.2)) ?? near[0]
    if (best) edges.push([id, best.gid])
  }
  connectors.forEach((c, k) => {
    const id = `c:${k}`
    nodes[id] = { x: c.x, z: c.z, width: 1.2 }
    link(id, c)
  })
  for (const [local, an] of Object.entries(anchors)) {
    if (local === 'player:spawn' || local.startsWith('interact:')) continue
    const id = `ap:${local}`
    nodes[id] = { x: r2(an.approach.x), z: r2(an.approach.z), width: 0.5 }
    link(id, an.approach)
  }
  return { nodes, edges }
}

export const FIXTURE_DECOR: FixtureDecor = {
  screen: { x: 7, y: 8.6, z: 0, w: 16, h: 6.4, yaw: -R / 2 },
  bridges: [
    { a: { x: -2, z: -15 }, b: { x: -2, z: 15 }, y: 6, w: 2.6 },
    { a: { x: 13.5, z: -15 }, b: { x: 13.5, z: 15 }, y: 10, w: 2.2 },
  ],
  bonsai: [
    { x: 2, z: -10 },
    { x: 2, z: 10 },
  ],
  strips: [
    { a: { x: -12, z: -1.2 }, b: { x: 18, z: -1.2 }, color: 'cyan' },
    { a: { x: -12, z: 1.2 }, b: { x: 18, z: 1.2 }, color: 'cyan' },
    { a: { x: 10, z: -13 }, b: { x: 18, z: -13 }, color: 'amber' },
    { a: { x: 10, z: 13 }, b: { x: 18, z: 13 }, color: 'amber' },
  ],
  ceiling: [
    ...[-12, -4, 4, 12].map((x) => ({
      module: 'hq-atrium' as const,
      at: { x, z: 0 },
      w: 1.2,
      d: 24,
      y: 13.6,
    })),
    ...[-13, 0, 13].map((x) => ({
      module: 'command' as const,
      at: { x, z: 0 },
      w: 0.8,
      d: 26,
      y: 6.7,
    })),
  ],
  holo: { x: 0, z: 0, r: 1.5 },
  neon: [
    {
      module: 'hq-atrium',
      at: { x: -8, z: -8.85 },
      y: 2.4,
      yaw: 0,
      text: 'RECEPTION',
      color: '#29e3ff',
    },
    {
      module: 'hq-atrium',
      at: { x: -19.8, z: 0 },
      y: 4.2,
      yaw: R / 2,
      text: 'MERIDIAN DYNAMICS',
      color: '#ffb02e',
    },
    {
      module: 'command',
      at: { x: 0, z: 14.8 },
      y: 3.4,
      yaw: R,
      text: 'SECURE COMMS',
      color: '#ff2bd6',
    },
    {
      module: 'command',
      at: { x: 0, z: -14.8 },
      y: 4.6,
      yaw: 0,
      text: 'PROJECT COMMAND',
      color: '#29e3ff',
    },
  ],
}

/** The fixture manifest JSON (validated by `parseSpecialManifest` like the real one). */
export function fixtureManifest(): unknown {
  const at = atrium()
  const cmd = command()
  const atBoxes = collidersFromPlan(at.plan, { position: { x: 0, z: 0 }, yaw: 0 }, ATRIUM_HEIGHT)
  const cmdBoxes = collidersFromPlan(cmd.plan, { position: { x: 0, z: 0 }, yaw: 0 }, COMMAND_HEIGHT)
  // The atrium's north door and the command center's south door meet at world (0, 15).
  const atNav = gridNav(at.bounds, 2, atBoxes, at.anchors, [{ x: 0, z: 15 }])
  const cmdNav = gridNav(cmd.bounds, 1.5, cmdBoxes, cmd.anchors, [{ x: 0, z: -15 }])
  return {
    version: 1,
    set: 'special',
    blender: 'fixture',
    units: 'm',
    hash: FIXTURE_HASH,
    modules: {
      'hq-atrium': {
        bounds: at.bounds,
        height: ATRIUM_HEIGHT,
        anchors: at.anchors,
        nav: atNav,
        plan: at.plan,
        placement: { x: 0, z: 0, yaw: 0 },
      },
      command: {
        bounds: cmd.bounds,
        height: COMMAND_HEIGHT,
        anchors: cmd.anchors,
        nav: cmdNav,
        plan: cmd.plan,
        placement: { x: 0, z: 30, yaw: 0 },
      },
      skyline: {
        bounds: { minX: -220, maxX: 220, minZ: -220, maxZ: 260 },
        anchors: {},
        nav: { nodes: {}, edges: [] },
        placement: { x: 0, z: 0, yaw: 0 },
      },
    },
  }
}
