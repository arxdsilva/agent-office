// Camera (plan §4.2): damped orbit with bookmarks, focus-then-follow for the selected agent, and a
// first-person walk mode with head-bob and collision against the building's `collider` boxes.
// Library and Adapters bookmarks frame their surfaces head-on from inside the room (low-spec plan
// §B3); while one is active the orbit clamps relax so eye-level close-ups are allowed.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js'
import { toWorld } from '../../app/building.ts'
import { frameSurfaces } from '../../app/framing.ts'
import { LIB_COPY } from '../../app/library-copy.ts'
import type { Manifest } from '../../app/manifest.ts'
import type { AABB, BuildingLayout, ModulePlacement, Vec2, Vec3 } from '../../app/office-types.ts'
import { clampTarget, isTypingTarget, orbitPan, type PanInput } from '../../app/orbit-keys.ts'
import type { SurfaceRole, WorldBox } from './building-view.ts'

const EYE_HEIGHT = 1.65
const WALK_SPEED = 2.2
const SPRINT = 2.2
const RADIUS = 0.3
const BOB_AMPLITUDE = 0.015
const STEP_LENGTH = 0.7
const FOCUS_S = 0.8
const FOLLOW_DISTANCE = 6
const FOLLOW_SMOOTHING = 4
/** Orbit clamps: the default steep view, and relaxed (eye level, close) in capability rooms. */
const MAX_POLAR = Math.PI / 2.2
const RELAXED_POLAR = Math.PI / 2 + 0.15
const MIN_DISTANCE = 2.5
const RELAXED_MIN_DISTANCE = 0.5

export type Mode = 'orbit' | 'walk'

export interface Bookmark {
  id: string
  label: string
  target: THREE.Vector3
  position: THREE.Vector3
  /** A capability-room view (eye level, close): the orbit clamps relax while it's active. */
  closeUp?: boolean
  /** Library and Adapters views are grouped per provider in the view bar. */
  group?: 'library' | 'adapters'
  provider?: string
}

interface Flight {
  fromTarget: THREE.Vector3
  fromPos: THREE.Vector3
  toTarget: THREE.Vector3
  toPos: THREE.Vector3
  t: number
  duration: number
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const v3 = (p: Vec2, y = 0) => new THREE.Vector3(p.x, y, p.z)

/** Module-local positions of the wing's capability surfaces (role → slot → position). */
export type WingSurfaces = Map<SurfaceRole, Map<string, Vec3>>

/** Camera field of view used for framing (matches the scene camera). */
export interface FrameView {
  fovDeg: number
  aspect: number
}

const toV3 = (p: Vec3) => new THREE.Vector3(p.x, p.y, p.z)

function centroid2(points: Vec2[]): Vec2 | null {
  if (!points.length) return null
  const n = points.length
  return points.reduce((a, p) => ({ x: a.x + p.x / n, z: a.z + p.z / n }), { x: 0, z: 0 })
}

/** The farthest any of `room` lies from `from` along `dir` (xz): how far the camera may back up. */
function roomDepth(from: Vec3, to: Vec3, room: Vec3[]): number {
  let dx = to.x - from.x
  let dz = to.z - from.z
  const l = Math.hypot(dx, dz) || 1
  dx /= l
  dz /= l
  let d = 0
  for (const p of room) d = Math.max(d, (p.x - from.x) * dx + (p.z - from.z) * dz)
  return d
}

/**
 * Library and Adapters bookmarks for one wing (low-spec plan §B3), framed with `frameSurfaces`
 * from the surfaces' real positions: `library` (shelves and boards from the far side, facing the
 * door wall), `library-rules` (the boards head-on), `adapters` (all stations, down the room) and
 * `adapters-door` (stations 4–7 head-on).
 */
export function roomBookmarks(
  layout: BuildingLayout,
  p: ModulePlacement,
  surfaces: WingSurfaces,
  view: FrameView,
): Bookmark[] {
  const key = `${p.provider}:${p.annex ?? 0}`
  const name = p.label ?? p.provider ?? p.id
  const provider = p.provider ?? p.id
  const world = (v: Vec3): Vec3 => {
    const w = toWorld({ x: v.x, z: v.z }, p)
    return { x: w.x, y: v.y, z: w.z }
  }
  const pick = (role: SurfaceRole, from = 0, to = Infinity) =>
    [...(surfaces.get(role) ?? [])]
      .filter(([slot]) => Number(slot) >= from && Number(slot) <= to)
      .map(([, v]) => world(v))
  const anchors = (re: RegExp) =>
    [...layout.anchors.values()].filter((a) => a.placement === p.id && re.test(a.local))
  const books = pick('book')
  const boards = pick('board')
  const notebooks = pick('notebook')
  const stations = pick('station')
  const out: Bookmark[] = []
  const add = (
    id: string,
    label: string,
    group: 'library' | 'adapters',
    f: { position: Vec3; target: Vec3 },
  ) =>
    out.push({
      id: `${id}:${key}`,
      label: `${label} · ${name}`,
      target: toV3(f.target),
      position: toV3(f.position),
      closeUp: true,
      group,
      provider,
    })

  const reading = centroid2(anchors(/^(seat:reading|spot:shelf):/).map((a) => a.pos))
  const library = [...books, ...boards, ...notebooks]
  if (reading && books.length + boards.length) {
    const shown = [...books, ...boards]
    const c = frameSurfaces({ surfaces: shown, inside: reading, ...view, maxDist: 99 })
    const depth = roomDepth(c.target, c.position, library) - 0.5
    add(
      'library',
      LIB_COPY.views.library,
      'library',
      frameSurfaces({
        surfaces: shown,
        inside: reading,
        ...view,
        margin: 1.05,
        maxDist: Math.max(1.2, depth),
        eyeHeight: 2.7,
      }),
    )
  }
  if (reading && boards.length) {
    const c = frameSurfaces({ surfaces: boards, inside: reading, ...view, maxDist: 99 })
    add(
      'library-rules',
      LIB_COPY.views.rulesWall,
      'library',
      frameSurfaces({
        surfaces: boards,
        inside: reading,
        ...view,
        maxDist: Math.max(1.2, roomDepth(c.target, c.position, library) - 0.5),
      }),
    )
  }
  const spots = anchors(/^spot:station:/)
  if (stations.length && spots.length) {
    // Down the room's long axis, raised so both rows of stations show.
    const all = centroid2(spots.map((a) => a.pos))!
    const along = { x: all.x, z: all.z + 3 }
    const rowA = centroid2(pick('station', 0, 3))
    const rowB = centroid2(pick('station', 4, 7))
    if (rowA && rowB) {
      // The rows face each other across the room; its long axis is perpendicular to that.
      let ax = -(rowB.z - rowA.z)
      let az = rowB.x - rowA.x
      const l = Math.hypot(ax, az) || 1
      ax /= l
      az /= l
      // From the end next to the Library (the rooms' shared doorway side).
      const sign = reading && (reading.x - all.x) * ax + (reading.z - all.z) * az < 0 ? -1 : 1
      along.x = all.x + ax * sign * 3
      along.z = all.z + az * sign * 3
    }
    const c = frameSurfaces({ surfaces: stations, inside: along, ...view, maxDist: 99 })
    add(
      'adapters',
      LIB_COPY.views.adapters,
      'adapters',
      frameSurfaces({
        surfaces: stations,
        inside: along,
        ...view,
        margin: 1.0,
        maxDist: Math.max(1.2, roomDepth(c.target, c.position, stations) + 1.4),
        eyeHeight: 4.2,
      }),
    )
    // Door side, stations 4–7: the room's core column stands between the rows, so look along
    // that row from the room's end, beside the column (head-on would be blocked by it).
    const door = pick('station', 4, 7)
    if (door.length && rowB && rowA) {
      const across = { x: rowA.x - rowB.x, z: rowA.z - rowB.z }
      const w = Math.hypot(across.x, across.z) || 1
      const end = { x: along.x - all.x, z: along.z - all.z }
      const e = Math.hypot(end.x, end.z) || 1
      // A point ~1.6 m in from the stations, toward the open end of the room.
      const inside = {
        x: rowB.x + (across.x / w) * 1.6 + (end.x / e) * 4.5,
        z: rowB.z + (across.z / w) * 1.6 + (end.z / e) * 4.5,
      }
      const d = frameSurfaces({ surfaces: door, inside, ...view, maxDist: 99 })
      const reach = Math.hypot(inside.x - d.target.x, inside.z - d.target.z)
      add(
        'adapters-door',
        LIB_COPY.views.adaptersDoor,
        'adapters',
        frameSurfaces({
          surfaces: door,
          inside,
          ...view,
          minDist: reach,
          maxDist: reach,
          eyeHeight: 2.4,
        }),
      )
    }
  }
  return out
}

/**
 * Camera bookmarks for a layout: overview, atrium, Main Street, then one per wing, then the
 * capability rooms per wing. With `surfaces` (once a wing has loaded) the rooms are framed from
 * inside (§B3); before that, from the anchors (a steep view over the partitions).
 */
export function bookmarksFor(
  layout: BuildingLayout,
  manifest: Manifest,
  surfaces?: WingSurfaces | null,
  view: FrameView = { fovDeg: 45, aspect: 16 / 9 },
): Bookmark[] {
  const b = layout.bounds
  const cx = (b.minX + b.maxX) / 2
  const cz = (b.minZ + b.maxZ) / 2
  const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ)
  const out: Bookmark[] = [
    {
      id: 'overview',
      label: 'Overview',
      target: new THREE.Vector3(cx, 0, cz),
      position: new THREE.Vector3(cx + span * 0.35, span * 0.95, cz + span * 0.75),
    },
  ]
  const atrium = layout.placements.find((p) => p.kind === 'atrium')
  if (atrium) {
    const a = manifest.modules.atrium.bounds
    const c = toWorld({ x: (a.minX + a.maxX) / 2, z: (a.minZ + a.maxZ) / 2 }, atrium)
    out.push({
      id: 'atrium',
      label: 'Atrium',
      // From high above the entrance side, looking down into the atrium toward Main Street.
      target: v3({ x: c.x, z: c.z + 3 }, 0),
      position: v3({ x: c.x + 10, z: c.z - 26 }, 30),
    })
  }
  const streets = layout.placements.filter((p) => p.kind === 'street')
  if (streets.length) {
    const len = streets.length * 18
    out.push({
      id: 'street',
      label: 'Main Street',
      target: new THREE.Vector3(0, 1, len * 0.55),
      position: new THREE.Vector3(0, 5.5, -7),
    })
  }
  const w = manifest.modules.wing.bounds
  for (const p of layout.placements.filter((x) => x.kind === 'wing')) {
    const c = toWorld({ x: (w.minX + w.maxX) / 2, z: (w.minZ + w.maxZ) / 2 }, p)
    const door = toWorld({ x: 0, z: 0 }, p)
    const dir = new THREE.Vector3(door.x - c.x, 0, door.z - c.z).normalize()
    out.push({
      id: `wing:${p.provider}:${p.annex ?? 0}`,
      label: p.label ?? p.provider ?? p.id,
      target: v3(c, 0.5),
      position: v3(c, 17)
        .addScaledVector(dir, 13)
        .add(new THREE.Vector3(0, 0, -9)),
    })
  }
  // Capability rooms per wing (when the manifest has them).
  for (const p of layout.placements.filter((x) => x.kind === 'wing')) {
    const framed = surfaces ? roomBookmarks(layout, p, surfaces, view) : []
    if (framed.length) {
      out.push(...framed)
      continue
    }
    const key = `${p.provider}:${p.annex ?? 0}`
    const name = p.label ?? p.provider ?? p.id
    const rooms: [string, 'library' | 'adapters', string, RegExp][] = [
      ['adapters', 'adapters', LIB_COPY.views.adapters, /^spot:station:/],
      ['library', 'library', LIB_COPY.views.library, /^(seat:reading|spot:shelf):/],
    ]
    for (const [id, group, label, re] of rooms) {
      const b = anchorBookmark(layout, re, 9, p.id)
      if (b)
        out.push({
          ...b,
          id: `${id}:${key}`,
          label: `${label} · ${name}`,
          group,
          provider: p.provider ?? p.id,
        })
    }
  }
  return out
}

/** Bookmark looking at the centroid of the anchors matching `pattern` (e.g. /seat:meeting:A:/). */
export function anchorBookmark(
  layout: BuildingLayout,
  pattern: RegExp,
  distance = 7,
  placement?: string,
): Bookmark | null {
  const hits = [...layout.anchors.values()].filter(
    (a) => pattern.test(a.local) && (!placement || a.placement === placement),
  )
  if (!hits.length) return null
  const first = hits[0]!.placement
  const same = hits.filter((a) => a.placement === first)
  const c = same.reduce(
    (s, a) => ({ x: s.x + a.pos.x / same.length, z: s.z + a.pos.z / same.length }),
    {
      x: 0,
      z: 0,
    },
  )
  const p = layout.placements.find((x) => x.id === first) as ModulePlacement | undefined
  // Look from the module's door side (street) so walls behind the room frame the shot.
  const door = p ? toWorld({ x: 0, z: 0 }, p) : { x: c.x, z: c.z + 1 }
  const dir = new THREE.Vector3(door.x - c.x, 0, door.z - c.z)
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1)
  dir.normalize()
  return {
    id: `anchors:${pattern.source}`,
    label: pattern.source,
    // Steep enough to see into a walled room over its partitions (walls are 3.6 m).
    target: v3(c, 0.6),
    position: v3(c, distance * 1.15).addScaledVector(dir, distance * 0.5),
  }
}

export class CameraDirector {
  readonly orbit: OrbitControls
  readonly walk: PointerLockControls
  mode: Mode = 'orbit'
  onModeChange: (mode: Mode) => void = () => {}
  private keys = new Set<string>()
  private saved = { position: new THREE.Vector3(), target: new THREE.Vector3() }
  private flight: Flight | null = null
  /** A camera flight is running (debug hook: E2E waits for it to end instead of guessing a time). */
  get flying(): boolean {
    return this.flight !== null
  }
  private follow: (() => THREE.Vector3 | undefined) | null = null
  private followPos = new THREE.Vector3()
  private bobPhase = 0
  private move = new THREE.Vector3()
  private forward = new THREE.Vector3()
  private right = new THREE.Vector3()
  private side = new THREE.Vector3()
  private delta = new THREE.Vector3()
  private live = new THREE.Vector3()
  private relaxed = false
  /** Clamp state to apply when the current flight lands (restoring mid-flight would snap). */
  private relaxAfter: boolean | null = null
  /** Layout bounds: WASD panning keeps the orbit target within them (+4 m). */
  private bounds: AABB | null = null
  /** Reused per frame by the WASD pan (update() stays allocation-free). */
  private panIn: PanInput = { keys: this.keys, heading: 0, distance: 0, dt: 0, sprint: false }
  private pan = { dx: 0, dz: 0 }
  private clamped = { x: 0, z: 0 }

  constructor(
    private camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
  ) {
    this.orbit = new OrbitControls(camera, dom)
    this.orbit.enableDamping = true
    this.orbit.dampingFactor = 0.08
    this.orbit.minPolarAngle = 0.12
    this.orbit.maxPolarAngle = MAX_POLAR
    this.orbit.minDistance = MIN_DISTANCE
    this.orbit.maxDistance = 180
    this.orbit.screenSpacePanning = false
    this.walk = new PointerLockControls(camera, document.body)
    this.walk.addEventListener('unlock', () => this.setMode('orbit'))
    // A drag that pans stops following; rotating around the followed agent keeps it.
    this.orbit.addEventListener('start', () => {
      this.flight = null
      this.markInput()
    })
    const down = (e: KeyboardEvent) => {
      // Orbit: typing in a field, a modal dialog, or a shortcut (macOS drops the keyup of keys
      // released while ⌘ is held) never pans. Walk mode keeps its pointer-lock behaviour.
      if (
        this.mode === 'orbit' &&
        (e.metaKey ||
          e.ctrlKey ||
          e.altKey ||
          isTypingTarget(e.target as HTMLElement | null) ||
          document.querySelector('dialog[open]'))
      )
        return
      this.keys.add(e.code)
      if (this.mode === 'walk') this.markInput()
    }
    const up = (e: KeyboardEvent) => this.keys.delete(e.code)
    const blur = () => this.keys.clear()
    addEventListener('keydown', down)
    addEventListener('keyup', up)
    addEventListener('blur', blur)
    this.unbind = () => {
      removeEventListener('keydown', down)
      removeEventListener('keyup', up)
      removeEventListener('blur', blur)
    }
  }

  private unbind: () => void = () => {}

  /** Removes the window listeners and the controls' DOM listeners (2D RPG plan §11). */
  dispose(): void {
    this.unbind()
    this.orbit.dispose()
    this.walk.dispose()
    this.keys.clear()
  }

  /** When the user last moved the camera (orbit, zoom, walk, view buttons); -∞ until then. */
  private lastInputAt = -Infinity

  /** Records a user camera input (for the "don't fly while they're looking around" rule). */
  markInput(): void {
    this.lastInputAt = performance.now()
  }

  /** Milliseconds since the last user camera input (Infinity if none yet). */
  idleMs(): number {
    return performance.now() - this.lastInputAt
  }

  /** Capability-room view active: eye-level angles and close distances allowed. */
  get closeUp(): boolean {
    return this.relaxed
  }

  private setRelaxed(on: boolean): void {
    this.relaxAfter = null
    if (on === this.relaxed) return
    this.relaxed = on
    this.orbit.maxPolarAngle = on ? RELAXED_POLAR : MAX_POLAR
    this.orbit.minDistance = on ? RELAXED_MIN_DISTANCE : MIN_DISTANCE
    this.camera.near = on ? 0.05 : 0.1
    this.camera.updateProjectionMatrix()
  }

  /** Relax now when going close; tighten only once the flight lands. */
  private planRelax(closeUp: boolean): void {
    if (closeUp) this.setRelaxed(true)
    else if (this.relaxed) this.relaxAfter = false
  }

  /** Eases to a bookmark (0.8 s, ease-in-out cubic) and stops following. */
  flyTo(b: Pick<Bookmark, 'target' | 'position' | 'closeUp'>, seconds = FOCUS_S): void {
    if (this.mode === 'walk') this.exitWalk()
    this.planRelax(!!b.closeUp)
    this.follow = null
    this.flight = {
      fromTarget: this.orbit.target.clone(),
      fromPos: this.camera.position.clone(),
      toTarget: b.target.clone(),
      toPos: b.position.clone(),
      t: 0,
      duration: Math.max(0.05, seconds),
    }
  }

  /** Jumps without animation (first frame, screenshots). */
  jumpTo(b: Pick<Bookmark, 'target' | 'position' | 'closeUp'>): void {
    if (this.mode === 'walk') this.exitWalk()
    this.setRelaxed(!!b.closeUp)
    this.follow = null
    this.flight = null
    this.orbit.target.copy(b.target)
    this.camera.position.copy(b.position)
    this.orbit.update()
  }

  /** Focus on a moving point (6 m away), then keep following it smoothly until cleared. */
  focusOn(get: (() => THREE.Vector3 | undefined) | null, distance = FOLLOW_DISTANCE): void {
    this.follow = get
    const p = get?.()
    if (!get || !p) return
    if (this.mode === 'walk') this.exitWalk()
    this.planRelax(false)
    const to = p.clone().setY(Math.max(1, p.y))
    const offset = this.camera.position.clone().sub(this.orbit.target)
    offset.y = Math.max(offset.y, offset.length() * 0.45)
    offset.setLength(distance)
    this.followPos.copy(to)
    this.flight = {
      fromTarget: this.orbit.target.clone(),
      fromPos: this.camera.position.clone(),
      toTarget: to,
      toPos: to.clone().add(offset),
      t: 0,
      duration: FOCUS_S,
    }
  }

  /** The layout bounds that WASD panning clamps the orbit target to (+4 m margin). */
  setBounds(b: AABB | null): void {
    this.bounds = b
  }

  get following(): boolean {
    return this.follow !== null
  }

  enterWalk(start?: THREE.Vector3): void {
    if (this.mode === 'walk') return
    this.saved.position.copy(this.camera.position)
    this.saved.target.copy(this.orbit.target)
    this.follow = null
    this.flight = null
    this.orbit.enabled = false
    const from = start ?? this.orbit.target
    const look = this.orbit.target.clone().sub(this.saved.position).setY(0)
    if (look.lengthSq() < 1e-6) look.set(0, 0, 1)
    this.camera.position.set(from.x, EYE_HEIGHT, from.z)
    this.camera.lookAt(from.x + look.x, EYE_HEIGHT, from.z + look.z)
    this.setMode('walk')
    this.walk.lock()
  }

  /** Walk mode at a given spot and heading without pointer lock (capture scripts). */
  walkAt(pos: THREE.Vector3, heading: number): void {
    if (this.mode !== 'walk') {
      this.saved.position.copy(this.camera.position)
      this.saved.target.copy(this.orbit.target)
    }
    this.follow = null
    this.flight = null
    this.orbit.enabled = false
    this.camera.position.set(pos.x, EYE_HEIGHT, pos.z)
    this.camera.lookAt(pos.x + Math.sin(heading), EYE_HEIGHT, pos.z + Math.cos(heading))
    this.setMode('walk')
  }

  exitWalk(): void {
    if (this.walk.isLocked) this.walk.unlock()
    else this.setMode('orbit')
  }

  update(dt: number, colliders: WorldBox[]): void {
    if (this.mode === 'orbit') return this.updateOrbit(dt)
    const sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')
    const speed = WALK_SPEED * (sprint ? SPRINT : 1)
    this.camera.getWorldDirection(this.forward)
    this.forward.y = 0
    this.forward.normalize()
    this.right.crossVectors(this.forward, this.camera.up).normalize()
    this.move.set(0, 0, 0)
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) this.move.add(this.forward)
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) this.move.sub(this.forward)
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) this.move.add(this.right)
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) this.move.sub(this.right)
    const p = this.camera.position
    if (this.move.lengthSq() > 0) {
      this.move.setLength(speed * dt)
      // Resolve per axis so you slide along walls and furniture instead of sticking.
      const x0 = p.x
      const z0 = p.z
      if (!blocked(p.x + this.move.x, p.z, colliders)) p.x += this.move.x
      if (!blocked(p.x, p.z + this.move.z, colliders)) p.z += this.move.z
      if (p.x === x0 && p.z === z0) this.doorwayAssist(p, colliders, speed * dt)
      this.bobPhase += ((speed * dt) / STEP_LENGTH) * Math.PI
    } else {
      // Settle back to eye height at the nearest step boundary.
      const k = this.bobPhase % Math.PI
      if (k > 0.02) this.bobPhase += Math.min(Math.PI - k, dt * 6)
    }
    p.y = EYE_HEIGHT + Math.abs(Math.sin(this.bobPhase)) * BOB_AMPLITUDE * 2 - BOB_AMPLITUDE
  }

  /**
   * Doorway auto-step: walking into a door jamb, look sideways (up to 0.5 m) for a gap the move
   * fits through and slide toward it, so you don't have to aim at the opening exactly.
   */
  private doorwayAssist(p: THREE.Vector3, colliders: WorldBox[], step: number): void {
    this.side.set(-this.move.z, 0, this.move.x).normalize()
    for (const off of [0.1, 0.2, 0.3, 0.4, 0.5])
      for (const sign of [1, -1]) {
        const x = p.x + this.side.x * off * sign
        const z = p.z + this.side.z * off * sign
        if (blocked(x, z, colliders) || blocked(x + this.move.x, z + this.move.z, colliders))
          continue
        const k = Math.min(off, step) * sign
        p.x += this.side.x * k
        p.z += this.side.z * k
        return
      }
  }

  private updateOrbit(dt: number): void {
    // WASD / arrows pan target and camera together; like a drag pan, it stops following.
    const panning = !this.flight && this.panStep(dt)
    if (panning) {
      this.follow = null
      this.markInput()
    }
    const live = this.follow?.()
    if (live) this.live.copy(live).setY(Math.max(1, live.y))
    if (this.flight) {
      const f = this.flight
      f.t = Math.min(1, f.t + dt / f.duration)
      const k = easeInOutCubic(f.t)
      if (live) {
        // The target keeps walking during the focus: aim at where it is now.
        this.delta.copy(this.live).sub(f.toTarget)
        f.toTarget.add(this.delta)
        f.toPos.add(this.delta)
      }
      this.orbit.target.lerpVectors(f.fromTarget, f.toTarget, k)
      this.camera.position.lerpVectors(f.fromPos, f.toPos, k)
      if (f.t >= 1) {
        this.flight = null
        this.followPos.copy(this.orbit.target)
        if (this.relaxAfter !== null) this.setRelaxed(this.relaxAfter)
      }
    } else if (live) {
      // Follow: move target and camera together, smoothed, so the view stays steady.
      const a = 1 - Math.exp(-dt * FOLLOW_SMOOTHING)
      this.delta.copy(this.live).sub(this.orbit.target).multiplyScalar(a)
      this.orbit.target.add(this.delta)
      this.camera.position.add(this.delta)
    }
    if (panning) this.applyPan()
    this.orbit.update(dt)
  }

  /** Computes this frame's WASD move into `pan`; false when no pan key is held. */
  private panStep(dt: number): boolean {
    const t = this.orbit.target
    const p = this.camera.position
    const i = this.panIn
    i.heading = Math.atan2(t.x - p.x, t.z - p.z)
    i.distance = p.distanceTo(t)
    i.dt = dt
    i.sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')
    orbitPan(i, this.pan)
    return this.pan.dx !== 0 || this.pan.dz !== 0
  }

  /** Moves target and camera by `pan`, then clamps the target to the bounds (camera follows). */
  private applyPan(): void {
    const t = this.orbit.target
    const p = this.camera.position
    let dx = this.pan.dx
    let dz = this.pan.dz
    if (this.bounds) {
      const c = this.clamped
      c.x = t.x + dx
      c.z = t.z + dz
      clampTarget(c, this.bounds, 4, c)
      dx = c.x - t.x
      dz = c.z - t.z
    }
    t.x += dx
    t.z += dz
    p.x += dx
    p.z += dz
  }

  /** Where the camera looks (for the shadow frustum). */
  focusPoint(out: THREE.Vector3): THREE.Vector3 {
    return this.mode === 'walk' ? out.copy(this.camera.position) : out.copy(this.orbit.target)
  }

  private setMode(mode: Mode): void {
    if (mode === this.mode) return
    this.mode = mode
    if (mode === 'orbit') {
      this.camera.position.copy(this.saved.position)
      this.orbit.target.copy(this.saved.target)
      this.orbit.enabled = true
    }
    this.keys.clear()
    this.onModeChange(mode)
  }
}

function blocked(x: number, z: number, colliders: WorldBox[]): boolean {
  for (const c of colliders) {
    // Only boxes at body height block (rugs and table tops below 0.3 m don't, ceilings don't).
    if (c.maxY < 0.3 || c.minY > 1.8) continue
    if (x + RADIUS > c.minX && x - RADIUS < c.maxX && z + RADIUS > c.minZ && z - RADIUS < c.maxZ)
      return true
  }
  return false
}
