// Sims-style wall cutaway (graphics contract §13), pure: wall boxes from the floor plans, the hovered
// wall under a ray, the walls that hide a target from the camera, and a per-wall fader with
// hysteresis. The three.js adapter turns the fader's output into a tiny per-wall texture.
import { WALL_MODES, type WallMode } from '@agent-office/shared'
import { toWorld } from './building.ts'
import type { Manifest } from './manifest.ts'
import type { ModulePlacement, Vec2, Vec3 } from './office-types.ts'
import type { ModulePlan } from './pixel/types.ts'

export type { WallMode }

/** Up → Cutaway → Down → Up (the HUD walls button). */
export const nextWallMode = (m: WallMode): WallMode =>
  WALL_MODES[(WALL_MODES.indexOf(m) + 1) % WALL_MODES.length]!

/** Alpha of a faded wall (dithered: about 1 pixel in 12 stays). */
export const WALL_FADED = 0.08
/** Lowered walls (Down) are cut this far above the floor (m). */
export const WALL_DOWN_HEIGHT = 1.0
/** Storey height used when a plan wall has no `h` (older manifests). */
const DEFAULT_H = 3.6
/** Openings are doors: sight lines below this height pass through them. */
const DOOR_TOP = 2.1
/** The last stretch of a sight line (m) is ignored, so a wall the target stands against never counts. */
const TARGET_CLEARANCE = 0.2

export interface WallBox {
  /** Global id (1-based across the building, in placement order); the texel the shader reads. */
  id: number
  /** Placement id of the module instance. */
  module: string
  /** 1-based id inside the module's plan (the mesh `_WALLID`). */
  local: number
  /** Body centre line in world XZ. */
  a: Vec2
  b: Vec2
  thick: number
  y0: number
  h: number
  /** Direction of a→b as a three.js rotation.y. */
  yaw: number
  /** Door/gap intervals [t0, t1] in metres along a→b. */
  openings: [number, number][]
}

export interface Ray {
  o: Vec3
  d: Vec3
}

function planOf(m: Manifest, p: ModulePlacement): ModulePlan | undefined {
  return p.kind === 'wing' ? m.modules.wing.plan : m.modules[p.kind]?.plan
}

/** Each placement's first global id minus one, and the building's wall count. */
export function wallBases(
  m: Manifest,
  placements: readonly ModulePlacement[],
): { bases: Map<string, number>; total: number } {
  const bases = new Map<string, number>()
  let total = 0
  for (const p of placements) {
    const n = planOf(m, p)?.walls.length ?? 0
    if (!n) continue
    bases.set(p.id, total)
    total += n
  }
  return { bases, total }
}

export function wallBoxes(m: Manifest, placements: readonly ModulePlacement[]): WallBox[] {
  const out: WallBox[] = []
  const { bases } = wallBases(m, placements)
  for (const p of placements) {
    const plan = planOf(m, p)
    const base = bases.get(p.id)
    if (!plan || base === undefined) continue
    plan.walls.forEach((w, i) => {
      const [ax, az] = w.a
      const [bx, bz] = w.b
      const L = Math.hypot(bx - ax, bz - az) || 1
      const thick = w.thick ?? 0.15
      // The body extends to `side` of a→b: +1 is the (−dz, dx) normal (contract §11).
      const off = ((w.side ?? 1) * thick) / 2
      const nx = (-(bz - az) / L) * off
      const nz = ((bx - ax) / L) * off
      const a = toWorld({ x: ax + nx, z: az + nz }, p)
      const b = toWorld({ x: bx + nx, z: bz + nz }, p)
      out.push({
        id: base + i + 1,
        module: p.id,
        local: w.id ?? i + 1,
        a,
        b,
        thick,
        y0: 0,
        h: w.h ?? DEFAULT_H,
        yaw: Math.atan2(-(b.z - a.z), b.x - a.x),
        openings: w.openings ?? [],
      })
    })
  }
  return out
}

/**
 * Ray (o + t·d) against a wall body grown by `pad`: the [t0, t1] interval inside, or null.
 * Writes nothing; `out` is reused by the caller to stay allocation-free.
 */
function slab(w: WallBox, o: Vec3, d: Vec3, pad: number, out: [number, number]): boolean {
  const ux = w.b.x - w.a.x
  const uz = w.b.z - w.a.z
  const L = Math.hypot(ux, uz)
  if (L < 1e-6) return false
  const cx = ux / L
  const cz = uz / L
  // Box frame: s along the wall, q across it, y up.
  const rx = o.x - w.a.x
  const rz = o.z - w.a.z
  const os = rx * cx + rz * cz
  const oq = -rx * cz + rz * cx
  const ds = d.x * cx + d.z * cz
  const dq = -d.x * cz + d.z * cx
  let t0 = -Infinity
  let t1 = Infinity
  const half = w.thick / 2 + pad
  const axes: [number, number, number, number][] = [
    [os, ds, -pad, L + pad],
    [oq, dq, -half, half],
    [o.y, d.y, w.y0 - pad, w.y0 + w.h + pad],
  ]
  for (const [p, v, lo, hi] of axes) {
    if (Math.abs(v) < 1e-12) {
      if (p < lo || p > hi) return false
      continue
    }
    let ta = (lo - p) / v
    let tb = (hi - p) / v
    if (ta > tb) [ta, tb] = [tb, ta]
    if (ta > t0) t0 = ta
    if (tb < t1) t1 = tb
    if (t0 > t1) return false
  }
  out[0] = t0
  out[1] = t1
  return true
}

const span: [number, number] = [0, 0]

/** The nearest wall the ray hits (t ≥ 0), or null. */
export function hoverWall(boxes: readonly WallBox[], ray: Ray): number | null {
  let best: number | null = null
  let bestT = Infinity
  for (const w of boxes) {
    if (!slab(w, ray.o, ray.d, 0, span) || span[1] < 0) continue
    const t = Math.max(span[0], 0)
    if (t < bestT) {
      bestT = t
      best = w.id
    }
  }
  return best
}

/** Is the point at `t` on the segment inside one of the wall's door openings? */
function throughDoor(w: WallBox, o: Vec3, d: Vec3, t: number): boolean {
  if (!w.openings.length) return false
  const y = o.y + d.y * t
  if (y > Math.min(DOOR_TOP, w.y0 + w.h)) return false
  const ux = w.b.x - w.a.x
  const uz = w.b.z - w.a.z
  const L = Math.hypot(ux, uz)
  const s = ((o.x + d.x * t - w.a.x) * ux + (o.z + d.z * t - w.a.z) * uz) / L
  for (const [t0, t1] of w.openings) if (s > t0 && s < t1) return true
  return false
}

const dir: Vec3 = { x: 0, y: 0, z: 0 }

/**
 * Walls between the camera and any target (sight-line segments, walls grown by `pad` so a line that
 * grazes a wall's edge counts). Lines through a door opening don't count.
 */
export function occluders(
  boxes: readonly WallBox[],
  cam: Vec3,
  targets: readonly Vec3[],
  pad = 0.15,
  out: Set<number> = new Set(),
): Set<number> {
  out.clear()
  for (const t of targets) {
    dir.x = t.x - cam.x
    dir.y = t.y - cam.y
    dir.z = t.z - cam.z
    const len = Math.hypot(dir.x, dir.y, dir.z)
    if (len < 1e-6) continue
    const end = Math.max(0, 1 - TARGET_CLEARANCE / len)
    for (const w of boxes) {
      if (out.has(w.id) || !slab(w, cam, dir, pad, span)) continue
      const a = Math.max(span[0], 0)
      const b = Math.min(span[1], end)
      if (a > b) continue
      if (throughDoor(w, cam, dir, (a + b) / 2)) continue
      out.add(w.id)
    }
  }
  return out
}

/** Mid-point of a wall body at half its height (debug: hover specs). */
export function wallMid(w: WallBox): Vec3 {
  return { x: (w.a.x + w.b.x) / 2, y: w.y0 + Math.min(w.h, 3) / 2, z: (w.a.z + w.b.z) / 2 }
}

export interface FaderOptions {
  fadeMs: number
  occludeInMs: number
  occludeOutMs: number
  hoverGraceMs: number
}

export const FADER_DEFAULTS: FaderOptions = {
  fadeMs: 200,
  occludeInMs: 80,
  occludeOutMs: 250,
  hoverGraceMs: 150,
}

export interface FaderInput {
  mode: WallMode
  hovered: number | null
  occluding: ReadonlySet<number>
}

export interface FaderOutput {
  /** Indexed by wall id (index 0 unused, always 1). */
  alpha: Float32Array
  /** 1 = lowered (Down), indexed by wall id. */
  lowered: Uint8Array
  /** Anything differs from the previous step (upload the texture). */
  changed: boolean
  /** Any wall faded, fading or lowered: the shaders need their cut compiled in. */
  active: boolean
}

/**
 * Per-wall alpha with a linear ease and hysteresis:
 * - Up: only the hovered wall fades; Cutaway: the hovered wall and the occluders; Down: every wall
 *   is lowered and nothing fades.
 * - Occlusion must hold `occludeInMs` before a fade starts and be gone `occludeOutMs` before it
 *   ends; a hovered wall stays faded `hoverGraceMs` after the pointer leaves.
 * Each step first eases towards the previous targets, then updates them (so a fade starts on the
 * step its condition is met). Arrays are reused: allocation-free per frame.
 */
export class WallFader {
  private n = 0
  private last = -1
  private dirty = true
  private target = new Float32Array(1)
  private occOn = new Uint8Array(1)
  private occSince = new Float64Array(1)
  private clearSince = new Float64Array(1)
  private hoverUntil = new Float64Array(1)
  private out: FaderOutput = {
    alpha: new Float32Array([1]),
    lowered: new Uint8Array(1),
    changed: false,
    active: false,
  }

  constructor(private o: FaderOptions = FADER_DEFAULTS) {}

  get total(): number {
    return this.n
  }

  /** New wall count: every wall solid, timers reset. */
  resize(n: number): void {
    this.n = n
    this.target = new Float32Array(n + 1).fill(1)
    this.occOn = new Uint8Array(n + 1)
    this.occSince = new Float64Array(n + 1).fill(NaN)
    this.clearSince = new Float64Array(n + 1).fill(NaN)
    this.hoverUntil = new Float64Array(n + 1).fill(-Infinity)
    this.out = {
      alpha: new Float32Array(n + 1).fill(1),
      lowered: new Uint8Array(n + 1),
      changed: true,
      active: false,
    }
    this.dirty = true
  }

  step(now: number, s: FaderInput): FaderOutput {
    const { alpha, lowered } = this.out
    const dt = this.last < 0 ? 0 : Math.max(0, now - this.last)
    this.last = now
    const rate = (dt * (1 - WALL_FADED)) / this.o.fadeMs
    let changed = this.dirty
    let active = false
    this.dirty = false
    const down = s.mode === 'down' ? 1 : 0
    for (let id = 1; id <= this.n; id++) {
      // 1. Ease towards the previous target.
      const a = alpha[id]!
      const goal = this.target[id]!
      if (a !== goal) {
        const next = a < goal ? Math.min(goal, a + rate) : Math.max(goal, a - rate)
        alpha[id] = Math.abs(next - goal) < 1e-4 ? goal : next
        if (alpha[id] !== a) changed = true
      }
      if (lowered[id] !== down) {
        lowered[id] = down
        changed = true
      }
      // 2. Hover grace and occlusion hysteresis.
      if (s.hovered === id) this.hoverUntil[id] = now + this.o.hoverGraceMs
      const hover = s.hovered === id || now < this.hoverUntil[id]!
      if (s.occluding.has(id)) {
        this.clearSince[id] = NaN
        if (Number.isNaN(this.occSince[id]!)) this.occSince[id] = now
        if (!this.occOn[id] && now - this.occSince[id]! >= this.o.occludeInMs) this.occOn[id] = 1
      } else {
        this.occSince[id] = NaN
        if (Number.isNaN(this.clearSince[id]!)) this.clearSince[id] = now
        if (this.occOn[id] && now - this.clearSince[id]! >= this.o.occludeOutMs) this.occOn[id] = 0
      }
      // 3. Mode rules.
      const fade =
        s.mode === 'up' ? hover : s.mode === 'cutaway' ? hover || this.occOn[id] === 1 : false
      this.target[id] = fade ? WALL_FADED : 1
      if (fade || down || alpha[id]! < 1) active = true
    }
    this.out.changed = changed
    this.out.active = active
    return this.out
  }
}
