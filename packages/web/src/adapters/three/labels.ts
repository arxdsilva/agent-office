// Name tags and status bubbles (CSS2D). They follow each character's head, fade with distance
// (opaque < 12 m, hidden > 40 m) and recede when a wall is in the way (checked every 250 ms).
// The name-tag mode (low-spec plan §5.3) shows all, nearby or only the selected tag; hidden tags
// skip the occlusion test, and the CSS2D pass is skipped on frames where nothing moved.
// All text goes through textContent (PRIVACY_SECURITY rule).
import { STATUS_COLORS, type Agent } from '@agent-office/shared'
import * as THREE from 'three'
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js'
import type { LabelMode } from '../../app/graphics-types.ts'
import { labelVisible, needsOcclusion, type LabelFilter } from '../../app/labels-filter.ts'
import type { Activity } from '../../app/office-types.ts'
import type { WorldBox } from './building-view.ts'

export const FADE_NEAR = 12
export const FADE_FAR = 40
const OCCLUSION_MS = 250
const HEAD_CLEARANCE = 0.32
const OCCLUDED_OPACITY = 0.3
const LEASH = 0.06
/** Opacity of tags outside the project focus. */
const DIM_LABEL = 0.25
/** A fixture label (Project Directory) fades out beyond this distance (m). */
const FIXTURE_FAR = 90

function bubbleText(a: Agent): string {
  switch (a.status) {
    case 'tool':
      return `🔧 ${a.tool ?? 'tool'}${a.text ? ` — ${a.text}` : ''}`
    case 'thinking':
      return a.text ? `💭 ${a.text}` : '💭 …'
    case 'waiting':
      return '✔ waiting for you'
    case 'error':
      return `⚠ ${a.text || 'error'}`
    default:
      return ''
  }
}

class Label {
  readonly obj: CSS2DObject
  readonly stack = document.createElement('div')
  readonly tag = document.createElement('div')
  private name = document.createElement('span')
  private chat = document.createElement('span')
  private badge = document.createElement('span')
  private bubble = document.createElement('div')
  occluded = false
  placed = false
  private shown = ''

  constructor(id: string, onPick: (id: string) => void) {
    this.tag.className = 'tag'
    this.tag.dataset.agentId = id
    this.badge.className = 'badge'
    this.tag.append(this.name, this.chat, this.badge)
    this.tag.addEventListener('click', (e) => {
      e.stopPropagation()
      onPick(id)
    })
    this.bubble.className = 'bubble'
    // Bubble stacked above the name tag in one label, anchored at its bottom, so they never overlap.
    this.stack.className = 'label-stack'
    this.stack.append(this.bubble, this.tag)
    this.obj = new CSS2DObject(this.stack)
    this.obj.center.set(0.5, 1)
  }

  /** `call`: the capability bubble while calling or visiting (🔌 Gmail · search, 📖 run-office). */
  set(a: Agent, activity: Activity, call?: string): boolean {
    const key = `${a.name}|${a.interactive}|${a.unread}|${a.status}|${a.tool}|${a.text}|${activity}|${a.parentId}|${call}`
    if (key === this.shown) return false
    this.shown = key
    this.name.textContent = a.name
    this.chat.textContent = a.interactive ? '💬' : ''
    this.chat.title = a.interactive ? 'reads messages' : ''
    this.badge.textContent = a.unread > 0 ? `📨 ${a.unread}` : ''
    this.badge.hidden = a.unread === 0
    this.tag.dataset.activity = activity
    this.tag.dataset.status = a.status
    this.tag.classList.toggle('sub', !!a.parentId)
    const text = call ?? bubbleText(a)
    this.bubble.textContent = text
    this.bubble.style.setProperty('--status', STATUS_COLORS[a.status])
    this.bubble.hidden = text === ''
    return true
  }
}

/** A static, clickable world label (the reception's Project Directory). */
class FixtureLabel {
  readonly obj: CSS2DObject
  readonly stack = document.createElement('div')
  constructor(key: string, text: string, onPick: () => void) {
    const tag = document.createElement('div')
    tag.className = 'fixture-tag tag-like'
    tag.dataset.fixture = key
    tag.textContent = text
    tag.addEventListener('click', (e) => {
      e.stopPropagation()
      onPick()
    })
    this.stack.className = 'label-stack'
    this.stack.append(tag)
    this.obj = new CSS2DObject(this.stack)
    this.obj.center.set(0.5, 1)
  }
}

export class Labels {
  readonly renderer = new CSS2DRenderer()
  /** Own scene, so the CSS2D pass never walks the building's scene graph. */
  private scene = new THREE.Scene()
  private group = new THREE.Group()
  private labels = new Map<string, Label>()
  private fixtures = new Map<string, FixtureLabel>()
  /** Project focus: tags of agents outside it recede (null: all normal). */
  private focus: ReadonlySet<string> | null = null
  private selected: string | null = null
  private lastOcclusion = 0
  private ray = new THREE.Ray()
  private camPos = new THREE.Vector3()
  private hit = new THREE.Vector3()
  private box = new THREE.Box3()
  private dir = new THREE.Vector3()
  private want = new THREE.Vector3()
  /** Name-tag mode and the selected agent (pure filter, low-spec plan §5.3). */
  private filter: LabelFilter = { mode: 'all', nearbyM: FADE_FAR, selected: null }
  /** Something changed since the last CSS2D pass (text, set, size, mode, selection). */
  private dirty = true
  private lastView = new THREE.Matrix4()
  private lastProj = new THREE.Matrix4()

  constructor(
    stage: HTMLElement,
    private onPick: (id: string) => void,
  ) {
    Object.assign(this.renderer.domElement.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
    })
    this.renderer.domElement.classList.add('labels')
    stage.append(this.renderer.domElement)
    this.group.name = 'labels'
    this.scene.add(this.group)
  }

  upsert(a: Agent, activity: Activity, call?: string): void {
    let l = this.labels.get(a.id)
    if (!l) {
      l = new Label(a.id, this.onPick)
      this.labels.set(a.id, l)
      this.group.add(l.obj)
      l.obj.visible = false
      // CSS2DRenderer attaches elements only once on screen; attach now so every agent's tag is in
      // the DOM (accessibility tree, E2E) even while off-screen or far away.
      l.stack.style.display = 'none'
      this.renderer.domElement.append(l.stack)
      if (a.id === this.selected) l.tag.classList.add('selected')
    }
    if (l.set(a, activity, call)) this.dirty = true
  }

  /** Name-tag mode (all · nearby within `nearbyM` · selected only). */
  setMode(mode: LabelMode, nearbyM: number): void {
    if (mode === this.filter.mode && nearbyM === this.filter.nearbyM) return
    this.filter.mode = mode
    this.filter.nearbyM = nearbyM
    this.dirty = true
  }

  /** Dims the tags of agents outside `ids` (null clears). */
  setFocus(ids: ReadonlySet<string> | null): void {
    this.focus = ids
    this.dirty = true
  }

  /** Adds, moves or (pos null) removes a clickable world label. The text goes through textContent. */
  setFixture(key: string, text: string, pos: THREE.Vector3 | null, onPick: () => void): void {
    const had = this.fixtures.get(key)
    if (!pos) {
      if (!had) return
      had.stack.remove()
      this.group.remove(had.obj)
      this.fixtures.delete(key)
      this.dirty = true
      return
    }
    const f = had ?? new FixtureLabel(key, text, onPick)
    if (!had) {
      this.fixtures.set(key, f)
      this.group.add(f.obj)
      f.stack.style.display = 'none'
      this.renderer.domElement.append(f.stack)
    }
    f.obj.position.copy(pos)
    this.dirty = true
  }

  remove(id: string): void {
    const l = this.labels.get(id)
    if (!l) return
    l.stack.remove()
    this.group.remove(l.obj)
    this.labels.delete(id)
    this.dirty = true
  }

  ids(): string[] {
    return [...this.labels.keys()]
  }

  select(id: string | null): void {
    this.labels.get(this.selected ?? '')?.tag.classList.remove('selected')
    this.selected = id
    this.filter.selected = id
    this.labels.get(id ?? '')?.tag.classList.add('selected')
    this.dirty = true
  }

  /** `headOf` gives each agent's head position (undefined = not in the world yet / gone). */
  update(
    camera: THREE.Camera,
    headOf: (id: string) => THREE.Vector3 | undefined,
    occluders: WorldBox[],
    now: number,
  ): void {
    camera.getWorldPosition(this.camPos)
    const checkOcclusion = now - this.lastOcclusion >= OCCLUSION_MS
    if (checkOcclusion) this.lastOcclusion = now
    const f = this.filter
    const far = f.mode === 'nearby' ? Math.min(f.nearbyM, FADE_FAR) : FADE_FAR
    const near = Math.min(FADE_NEAR, far * 0.6)
    let changed = this.dirty
    for (const [id, l] of this.labels) {
      const head = headOf(id)
      if (!head) {
        if (l.obj.visible) changed = true
        l.obj.visible = false
        l.placed = false
        continue
      }
      // Leash: the tag follows the head but ignores motion under LEASH (idle sway), so it stays
      // pixel-still for reading and clicking; while walking it trails by at most LEASH.
      this.want.set(head.x, head.y + HEAD_CLEARANCE, head.z)
      const p = l.obj.position
      const gap = p.distanceTo(this.want)
      if (!l.placed || gap > 3) (p.copy(this.want), (l.placed = true), (changed = true))
      else if (gap > LEASH) (p.lerp(this.want, 1 - LEASH / gap), (changed = true))
      const d = this.camPos.distanceTo(l.obj.position)
      const selected = id === this.selected
      // 'all' keeps the old 40 m horizon; 'nearby' its own radius (whichever is nearer).
      const visible = labelVisible(f, id, d) && (selected || d < far)
      if (l.obj.visible !== visible) changed = true
      l.obj.visible = visible
      if (!visible) continue
      // Only shown tags pay for the occlusion test.
      if (checkOcclusion)
        l.occluded = needsOcclusion(f, id, d) && this.blocked(l.obj.position, d, occluders)
      // Behind a wall the tag stays (clickable, so you can still find someone) but recedes.
      const fade = d <= near ? 1 : Math.max(0, 1 - (d - near) / (far - near))
      const dim = this.focus && !this.focus.has(id) ? DIM_LABEL : 1
      const opacity = selected ? 1 : fade * (l.occluded ? OCCLUDED_OPACITY : 1) * dim
      const o = opacity.toFixed(2)
      if (l.stack.style.opacity !== o) l.stack.style.opacity = o
    }
    // Fixture labels: always shown, fading out with distance.
    for (const f of this.fixtures.values()) {
      const d = this.camPos.distanceTo(f.obj.position)
      const o =
        d >= FIXTURE_FAR
          ? '0'
          : (d <= FADE_FAR ? 1 : 1 - (d - FADE_FAR) / (FIXTURE_FAR - FADE_FAR)).toFixed(2)
      if (f.stack.style.opacity !== o) ((f.stack.style.opacity = o), (changed = true))
      f.obj.visible = o !== '0'
    }
    // The CSS2D pass projects every tag; skip it when neither the view nor any tag changed.
    camera.updateMatrixWorld()
    if (
      !this.lastView.equals(camera.matrixWorld) ||
      !this.lastProj.equals((camera as THREE.PerspectiveCamera).projectionMatrix)
    ) {
      this.lastView.copy(camera.matrixWorld)
      this.lastProj.copy((camera as THREE.PerspectiveCamera).projectionMatrix)
      changed = true
    }
    if (!changed) return
    this.dirty = false
    this.renderer.render(this.scene, camera)
  }

  /** A tall collider (wall) between the camera and the label hides it. */
  private blocked(p: THREE.Vector3, d: number, occluders: WorldBox[]): boolean {
    this.dir.copy(p).sub(this.camPos).normalize()
    this.ray.set(this.camPos, this.dir)
    for (const c of occluders) {
      if (c.maxY - c.minY < 2) continue
      this.box.min.set(c.minX, c.minY, c.minZ)
      this.box.max.set(c.maxX, c.maxY, c.maxZ)
      if (this.box.containsPoint(this.camPos)) continue
      const hit = this.ray.intersectBox(this.box, this.hit)
      if (hit && hit.distanceTo(this.camPos) < d - 0.4) return true
    }
    return false
  }

  setSize(w: number, h: number): void {
    this.renderer.setSize(w, h)
    this.dirty = true
  }
}
