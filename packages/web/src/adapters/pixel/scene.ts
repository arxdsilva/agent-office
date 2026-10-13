// SceneView port → Canvas2D pixel art (the optional 2D RPG mode, plan §2–§8). Rendering only: the
// director decides where agents go (the same plans the 3D scene gets); this draws them top-down.
// The player, camera and input live here; what the player does reaches the controller through
// the existing events (onPick, onPickCapability) and the optional onInteract.
import { STATUS_COLORS, type GraphicsQuality } from '@agent-office/shared'
import { createPacer } from '../../app/frame-pacer.ts'
import type { Effective, GraphicsStats } from '../../app/graphics-types.ts'
import type { ViewEntry } from '../../app/library-types.ts'
import { parseManifest, type Manifest } from '../../app/manifest.ts'
import { appearanceOf, type ClipTable } from '../../app/motion.ts'
import type { AgentPlan, BuildingLayout, ClipName, Link, Vec2 } from '../../app/office-types.ts'
import { PIXEL_COPY } from '../../app/pixel-copy.ts'
import {
  PX_PER_M,
  TILE_PX,
  VIEW_H,
  VIEW_W,
  type Dir4,
  type InteractTarget,
  type MapObject,
  type PixelMap,
  type PxRect,
  type TileRect,
} from '../../app/pixel/types.ts'
import {
  cameraTarget,
  escapeCancels,
  nextCameraMode,
  PLAYER_CAMERA,
  type CameraEvent,
  type CameraState,
} from '../../app/pixel/camera-mode.ts'
import { contextScreenColor } from '../../app/pixel/context-hub.ts'
import { contextHubActive, contextPulse } from '../../app/stations.ts'
import { minimapLabels } from '../../app/pixel/minimap.ts'
import { MinimapBase } from './minimap-base.ts'
import { createSimClock, type SimClock } from '../../app/sim-clock.ts'
import type { CapabilityRef, SceneAssets, SceneSurfaces, SceneView } from '../../ports.ts'
import { buildPixelMap, capabilitySlot, plansOf } from '../../app/pixel/map.ts'
import {
  interactionTarget,
  objectTargets,
  promptFor,
  slotCapability,
  type InteractObject,
} from '../../app/pixel/interact.ts'
import type { ProviderSurfaces } from '../../app/capability-vm.ts'
import { centroid } from '../../app/framing.ts'
import {
  projectRefLabel,
  projectSurfaces,
  type ProjectLibraryVM,
} from '../../app/project-library.ts'
import { dirVector, pixelToWorld, toPixel, toTile } from '../../app/pixel/project.ts'
import { roomLabel } from '../../app/pixel/rooms.ts'
import { blocked, nearestFree, playerSpeed, spawnPoint, stepPlayer } from '../../app/pixel/walk.ts'
import { PixelCamera } from './camera.ts'
import { NpcSystem, type Npc } from './characters.ts'
import {
  drawBeam,
  drawObject,
  drawPlayerMarker,
  drawSelection,
  drawShadow,
  drawSolidOverlay,
  drawStatusIcon,
  drawFx,
  drawWall,
  FLAT_KINDS,
  iconFx,
  overhangOf,
  wallClip,
} from './effects.ts'
import { declutterTags } from '../../app/pixel/tags.ts'
import { drawTag, drawText, GLYPH_H, textWidth } from './font.ts'
import { PixelInput } from './input.ts'
import { ChunkCache, flatWall, PixelRenderer, type ViewRect } from './renderer.ts'
import {
  CHAR_H,
  CHAR_W,
  CharacterSprites,
  createSpriteFoot,
  loadAtlas,
  lookKey,
  walkRate,
  type Atlas,
  type Look,
} from './sprites.ts'
import { viewsFor } from '../../app/views.ts'
import { footprintMap, regionCenter } from './fallbacks.ts'
import { PixelTiles } from './tiles.ts'

export interface PixelSceneElements {
  stage: HTMLElement
  loading: { root: HTMLElement; fill: HTMLElement; label: HTMLElement; tip: HTMLElement }
  /** The view bar (rendered by the DOM adapter from `onViews`); unused here. */
  views?: HTMLElement
}

const BACKGROUND = { dark: '#15131b', light: '#2a2733' } as const
const OPPOSITE: Record<Dir4, Dir4> = { n: 's', s: 'n', e: 'w', w: 'e' }
/** The overview's title bar (canvas text). */
const OVERVIEW_TITLE = PIXEL_COPY.overviewTitle
const debugEnabled = () => new URLSearchParams(location.search).get('debug') === '1'
/** Name tags within this many metres of the player show in 'nearby' mode (16 px per metre). */
const NEARBY_M = 4
/** How far the player stands from what they travel to (m). */
const PLACE_NEAR_M = 1
/** Alpha of agents outside the project focus. */
const DIM_ALPHA = 0.35

/** Objects considered for E/interaction around the player (m). */
const INTERACT_PREFILTER_M = 3

/** The 1 m cells a px box covers. */
const cellsOf = (b: PxRect): TileRect => {
  const tx = Math.floor(b.x / TILE_PX)
  const ty = Math.floor(b.y / TILE_PX)
  return {
    tx,
    ty,
    tw: Math.max(1, Math.ceil((b.x + b.w) / TILE_PX) - tx),
    th: Math.max(1, Math.ceil((b.y + b.h) / TILE_PX) - ty),
  }
}

/** The player's place survives mode switches within a session (plan §6). */
let savedPlayer: { pos: Vec2; dir: Dir4 } | null = null

interface Player {
  pos: Vec2
  dir: Dir4
  moving: boolean
  animT: number
  look: Look
  key: string
  /** Click-to-walk destination (straight line, stops when blocked). */
  goal: Vec2 | null
}

export class PixelScene implements SceneView {
  private renderer: PixelRenderer
  private tiles = new PixelTiles()
  private chunks = new ChunkCache(this.tiles, (c, w) => drawWall(c, w, this.atlas, 'top'))
  private sprites = new CharacterSprites()
  private npcs = new NpcSystem()
  private camera = new PixelCamera()
  private input: PixelInput
  private pacer = createPacer()
  private atlas: Atlas | null = null
  private manifest: Manifest | null = null
  private layout: BuildingLayout | null = null
  private map: PixelMap | null = null
  private clips: ClipTable = {}
  private player: Player
  private placed = false
  /** R: running is the default pace (session only). */
  private running = false
  /** Wall-mounted objects' art limits, per map. */
  private artClips = new Map<string, PxRect | null>()
  private gfx: Effective | null = null
  private theme: 'light' | 'dark' = 'dark'
  private links: Link[] = []
  private surfaces: SceneSurfaces | null = null
  /** The provider surfaces as received, and the selected project's Library over them. */
  private baseSurfaces: Map<string, ProviderSurfaces> | null = null
  private projectLibrary: ProjectLibraryVM | null = null
  private bubbles = new Map<string, string>()
  /** Project focus: agents outside it are drawn at DIM_ALPHA (null: everyone normal). */
  private focusSet: ReadonlySet<string> | null = null
  private highlighted: string | null = null
  private selected: string | null = null
  /** Camera mode (app/pixel/camera-mode.ts): player, overview, follow or pan. */
  private cam: CameraState = PLAYER_CAMERA
  private minimapBase = new MinimapBase()
  private labels: NonNullable<ReturnType<typeof minimapLabels>> = []
  private solidOverlay = false
  private focusObject: string | null = null
  private hoverObject: string | null = null
  private hoverAgent: string | null = null
  private lastTalked: string | null = null
  /** Desk seat anchor → the desk object in front of it (status monitor colour). */
  private deskOf = new Map<string, string>()
  private resolve: (placement: string, slot: string) => CapabilityRef | undefined = () => undefined
  private room = ''
  private currentView: string | null = null
  private raf = 0
  private lastT = -1
  private time = 0
  private frames = 0
  private fps = 0
  private fpsAcc = { n: 0, t: 0 }
  private drawn = 0
  private disposed = false
  private entityList = document.createElement('ul')
  private entityKey = ''
  private entityAt = 0
  private off: (() => void)[] = []
  private debugApi: object | null = null
  // Listeners
  private pickFn: (id: string | null) => void = () => {}
  private pickCapFn: (ref: CapabilityRef) => void = () => {}
  private hoverFn: (ref: CapabilityRef | null, x: number, y: number) => void = () => {}
  private viewsFn: ((v: ViewEntry[]) => void) | null = null
  private interactFn: ((t: InteractTarget) => void) | null = null
  private roomFn: (name: string) => void = () => {}
  private statsFn: (fps: number, preset: string) => void = () => {}
  private playerMoveFn: ((pos: { x: number; z: number }) => void) | null = null
  private cameraFn: ((view: TileRect) => void) | null = null
  private baseFn:
    ((img: CanvasImageSource, widthTiles: number, heightTiles: number) => void) | null = null
  private zoomFn: ((z: { level: number; levels: number; atDefault: boolean }) => void) | null = null
  private runFn: ((on: boolean) => void) | null = null
  private lastCam = ''
  private lastCamAt = -Infinity
  private lastTile = ''
  private lastTileAt = -Infinity

  constructor(
    private el: PixelSceneElements,
    private clock: SimClock = createSimClock(),
  ) {
    this.renderer = new PixelRenderer(el.stage)
    const look: Look = { ...appearanceOf('player:operator'), player: true }
    this.player = {
      pos: savedPlayer ? { ...savedPlayer.pos } : { x: 0, z: 0 },
      dir: savedPlayer?.dir ?? 's',
      moving: false,
      animT: 0,
      look,
      key: lookKey(look),
      goal: null,
    }
    this.entityList.id = 'pixel-entities'
    this.entityList.hidden = true
    el.stage.append(this.entityList)
    this.input = new PixelInput(this.renderer.canvas, {
      interact: () => this.interact(),
      overview: () => this.toggleOverview(),
      escape: () => this.escape(),
      zoom: (d, x, y) => {
        if (this.cam.mode === 'overview') {
          // Wheel in: leave the overview into the normal view at the pointed spot.
          if (d > 0 && this.map) {
            const w = this.renderer.toWorldPx(x, y, this.view())
            this.setCam({ type: 'wheel-in', at: pixelToWorld(w.x, w.y, this.map) })
          }
          return
        }
        this.zoomBy(d)
      },
      zoomKey: (d) => this.zoomBy(d),
      toggleRun: () => this.setRun(!this.running),
      space: () => this.setCam({ type: 'space' }),
      click: (x, y) => this.click(x, y),
      hover: (x, y) => this.hoverAt(x, y),
      leave: () => this.setHover(null, null, 0, 0),
      moved: () => this.setCam({ type: 'move' }),
    })
    const on = (t: EventTarget, type: string, fn: () => void) => {
      t.addEventListener(type, fn)
      this.off.push(() => t.removeEventListener(type, fn))
    }
    on(window, 'resize', () => this.renderer.resize())
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.renderer.resize())
      ro.observe(this.el.stage)
      this.off.push(() => ro.disconnect())
    }
    on(document, 'visibilitychange', () => this.arm())
    if (debugEnabled()) this.installDebug()
    this.arm()
  }

  // ── Loop ──
  private limit(): number | null {
    return this.gfx ? this.gfx.fpsLimit : null
  }

  private arm(): void {
    if (this.disposed || this.raf || this.limit() === 0) return
    this.pacer.reset()
    this.raf = requestAnimationFrame((t) => this.tick(t))
  }

  private tick(t: number): void {
    this.raf = 0
    if (this.disposed) return
    if (this.limit() !== 0) this.raf = requestAnimationFrame((n) => this.tick(n))
    // Stage hidden (user left the Office): skip rendering.
    if (!(this.el.stage.clientWidth > 0 && this.el.stage.clientHeight > 0)) return
    if (!this.pacer.shouldRender(t, this.limit())) return
    const dt = this.lastT < 0 ? 0 : Math.min(0.5, (t - this.lastT) / 1000)
    this.lastT = t
    this.frames++
    this.fpsAcc.n++
    this.fpsAcc.t += dt
    if (this.fpsAcc.t >= 0.5) {
      this.fps = this.fpsAcc.n / this.fpsAcc.t
      this.fpsAcc = { n: 0, t: 0 }
      this.statsFn(Math.round(this.fps), this.gfx?.preset ?? 'high')
    }
    this.frame(dt)
  }

  private frame(rawDt: number): void {
    const dt = Math.min(rawDt, 0.1)
    this.time += rawDt
    this.npcs.update(Math.min(rawDt * this.clock.scale, 0.5), this.clips, this.clock.now())
    this.updatePlayer(dt)
    this.updateCamera(dt)
    this.draw()
    if (this.time - this.entityAt > 0.25) {
      this.entityAt = this.time
      this.renderEntityList()
    }
  }

  private updatePlayer(dt: number): void {
    const p = this.player
    const map = this.map
    if (!map) return
    const dir = this.input.direction()
    const speed = playerSpeed({ sprint: this.input.run, run: this.running })
    const before = { ...p.pos }
    if (dir) {
      p.goal = null
      p.dir = dir
      p.pos = stepPlayer(map, p.pos, dirVector(dir), speed, dt)
    } else if (p.goal) {
      const dx = p.goal.x - p.pos.x
      const dz = p.goal.z - p.pos.z
      if (Math.hypot(dx, dz) < 0.08) p.goal = null
      else {
        // Walk along the dominant axis first (4 directions, like the keys).
        const ax = Math.abs(dx) > Math.abs(dz)
        p.dir = ax ? (dx > 0 ? 'e' : 'w') : dz > 0 ? 's' : 'n'
        const left = ax ? Math.abs(dx) : Math.abs(dz)
        p.pos = stepPlayer(map, p.pos, dirVector(p.dir), speed, Math.min(dt, left / speed))
        if (p.pos.x === before.x && p.pos.z === before.z) p.goal = null
      }
    }
    const moved = before.x !== p.pos.x || before.z !== p.pos.z
    if (moved) {
      for (const n of this.npcs.npcs.values()) n.faceOverride = null
      // The walk cycle runs at the on-screen speed, so feet never slide.
      p.animT += dt * walkRate(speed)
    }
    p.moving = moved
    savedPlayer = { pos: { ...p.pos }, dir: p.dir }
    const tile = toTile(p.pos, map)
    const tk = `${tile.tx},${tile.ty}`
    if (this.playerMoveFn && tk !== this.lastTile && this.time - this.lastTileAt >= 0.25) {
      this.lastTile = tk
      this.lastTileAt = this.time
      this.playerMoveFn({ x: p.pos.x, z: p.pos.z })
    }
    const name = this.layout ? roomLabel(map, this.layout, tile) : ''
    if (name !== this.room) {
      this.room = name
      if (name) this.roomFn(name)
    }
  }

  private updateCamera(dt: number): void {
    const map = this.map
    if (!map) return
    const at = cameraTarget(this.cam, this.player.pos, (id) => {
      const n = this.npcs.npcs.get(id)
      return n && n.motion.visible ? n.motion.pos : undefined
    })
    const o = toPixel(at, map)
    this.camera.target(o.px, o.py)
    this.camera.update(dt)
    this.emitCamera(map)
  }

  /** The camera's visible tiles for the minimap viewport, at most 4 Hz and only on change. */
  private emitCamera(map: PixelMap): void {
    if (!this.cameraFn || this.time - this.lastCamAt < 0.25) return
    const v = this.view()
    const tx = Math.max(0, Math.floor(v.x / TILE_PX))
    const ty = Math.max(0, Math.floor(v.y / TILE_PX))
    const r: TileRect = {
      tx,
      ty,
      tw: Math.min(map.widthTiles, Math.ceil((v.x + v.w) / TILE_PX)) - tx,
      th: Math.min(map.heightTiles, Math.ceil((v.y + v.h) / TILE_PX)) - ty,
    }
    const k = `${r.tx},${r.ty},${r.tw},${r.th}`
    if (k === this.lastCam) return
    this.lastCam = k
    this.lastCamAt = this.time
    this.cameraFn(r)
  }

  /** Applies a camera event; the view bar's current entry follows the mode. */
  private setCam(e: CameraEvent): void {
    const before = this.cam
    this.cam = nextCameraMode(this.cam, e)
    this.camera.overview = this.cam.mode === 'overview'
    if (before === this.cam) return
    if (this.cam.mode === 'overview') this.currentView = 'overview'
    else if (before.mode === 'overview' || this.cam.mode === 'player') this.currentView = null
    if (before.mode !== this.cam.mode) this.emitViews()
  }

  // ── Drawing ──
  private view(): ViewRect {
    const r = this.renderer
    // The zoom levels follow the window's integer fit scale.
    if (this.camera.setFit(r.scale)) this.emitZoom()
    const m = this.map
    return this.camera.view(r.viewW, r.viewH, m ? m.widthPx : VIEW_W, m ? m.heightPx : VIEW_H)
  }

  // ── Zoom and run ──
  /** Steps the zoom out (−1), in (+1) or back to the default (0). */
  zoomBy(delta: -1 | 0 | 1): void {
    this.view()
    if (this.camera.zoomBy(delta)) this.emitZoom()
  }

  private emitZoom(): void {
    this.zoomFn?.(this.camera.info())
  }

  private setRun(on: boolean): void {
    if (on === this.running) return
    this.running = on
    this.runFn?.(on)
  }

  onZoom(fn: (z: { level: number; levels: number; atDefault: boolean }) => void): void {
    this.zoomFn = fn
    this.camera.setFit(this.renderer.scale)
    fn(this.camera.info())
  }

  onRun(fn: (on: boolean) => void): void {
    this.runFn = fn
    fn(this.running)
  }

  private draw(): void {
    const r = this.renderer
    const c = r.ctx
    this.sprites.nextFrame()
    r.begin(BACKGROUND[this.theme])
    const map = this.map
    if (!map) {
      r.screen()
      drawText(c, 'LOADING…', 8, 8, '#f4f1ea')
      return r.end()
    }
    const v = this.view()
    const over = this.camera.overview
    r.world(v, over)
    this.drawn = this.chunks.draw(c, v)
    const inView = (x: number, y: number, m = 32) =>
      x > v.x - m && x < v.x + v.w + m && y > v.y - m && y < v.y + v.h + m
    /** A box (plus its art's overhang above) touches the view. */
    const boxInView = (b: PxRect, up = 32) =>
      b.x < v.x + v.w && b.x + b.w > v.x && b.y - up < v.y + v.h && b.y + b.h > v.y
    // Desk monitors show the seated agent's status colour.
    const monitors = new Map<string, string>()
    const booths: { px: number; py: number }[] = []
    for (const n of this.npcs.npcs.values()) {
      const t = n.plan.intent.target
      const desk = t.includes('/seat:desk:') ? this.deskOf.get(t) : undefined
      if (desk) monitors.set(desk, STATUS_COLORS[n.plan.agent.status])
      // A booth lamp lights while a waiting agent occupies the booth.
      if (n.plan.intent.activity === 'booth' && this.layout) {
        const a = this.layout.anchors.get(t)
        if (a) booths.push(toPixel(a.pos, map))
      }
    }
    // The Context Hub's consoles and core glow on the 3D hub's signal (real MCP retrievals only).
    const hub = contextScreenColor(
      contextPulse(this.time, contextHubActive(this.surfaces?.byProvider.values() ?? [])),
    )
    type D = { y: number; draw: () => void }
    const list: D[] = []
    // Objects y-sort by their box's bottom edge (the feet line), characters by their feet.
    for (const ob of map.objects) {
      const b = ob.box
      if (!boxInView(b)) continue
      const hl = ob.id === this.focusObject || ob.id === this.hoverObject
      const lit =
        ob.kind === 'booth-lamp' &&
        booths.some(
          (q) =>
            q.px >= b.x - 8 && q.px <= b.x + b.w + 8 && q.py >= b.y - 8 && q.py <= b.y + b.h + 8,
        )
      const clip = this.artClips.get(ob.id) ?? null
      if (ob.kind === 'console' || ob.kind === 'context-core') monitors.set(ob.id, hub)
      list.push({
        // Chairs sort at their top edge so whoever sits on one is drawn over it.
        y: FLAT_KINDS.has(ob.kind) ? -1e9 : ob.kind === 'chair' ? b.y + 1 : b.y + b.h,
        draw: () => drawObject(c, ob, monitors.get(ob.id) ?? null, hl, lit, this.atlas, clip),
      })
    }
    // Walls with a ¾ face y-sort too: whoever stands behind (north of) one is hidden by its face.
    for (const w of map.walls) {
      if (flatWall(w) || !boxInView(w.box, 16)) continue
      list.push({ y: w.box.y + w.box.h, draw: () => drawWall(c, w, this.atlas) })
    }
    const visible: { n: Npc; x: number; y: number }[] = []
    for (const n of this.npcs.npcs.values()) {
      const m = n.motion
      if (!m.visible) continue
      const { px, py } = toPixel(m.pos, map)
      if (!inView(px, py)) continue
      visible.push({ n, x: px, y: py })
      list.push({
        y: py,
        draw: () => {
          if (!drawFx(c, this.atlas, 'shadow', px, py, this.time)) drawShadow(c, px, py)
          if (n.id === this.selected && !drawFx(c, this.atlas, 'select', px, py, this.time))
            drawSelection(c, px, py, this.time)
          const f = this.sprites.frame(n.look, n.key, n.dir, n.anim, n.animT, n.props, n.name)
          c.globalAlpha = m.opacity * f.alpha * this.dimAlpha(n.id)
          c.drawImage(f.canvas, Math.round(px) - f.ax, Math.round(py) - f.ay)
          c.globalAlpha = 1
        },
      })
    }
    const p = this.player
    const pp = toPixel(p.pos, map)
    list.push({
      y: pp.py,
      draw: () => {
        if (!drawFx(c, this.atlas, 'shadow', pp.px, pp.py, this.time)) drawShadow(c, pp.px, pp.py)
        const f = this.sprites.frame(
          p.look,
          p.key,
          p.dir,
          p.moving ? 'walk' : 'idle',
          p.moving ? p.animT : this.time,
        )
        c.drawImage(f.canvas, Math.round(pp.px) - f.ax, Math.round(pp.py) - f.ay)
      },
    })
    list.sort((a, b) => a.y - b.y)
    for (const d of list) d.draw()
    this.drawn += list.length
    // Links: from the agent (live position) to the capability.
    for (const l of this.links) {
      const n = this.npcs.npcs.get(l.agentId)
      if (!n || !n.motion.visible || l.opacity <= 0) continue
      const a = toPixel(n.motion.pos, map)
      const b = toPixel({ x: l.to.x, z: l.to.z }, map)
      const dim = this.highlighted && l.capabilityId !== this.highlighted ? 0.3 : 1
      drawBeam(c, a.px, a.py - 14, b.px, b.py, l.color, l.style, this.time, l.opacity * dim)
    }
    // Status icons, name tags, the interaction prompt, the player marker.
    for (const { n, x, y } of visible)
      if (n.icon && !drawFx(c, this.atlas, iconFx(n.icon), x, y - CHAR_H, this.time))
        drawStatusIcon(c, n.icon, x, y - CHAR_H, this.time)
    if (!over) {
      // Tags never overlap: selected and hovered first, then the nearest to the player. Zoomed out
      // (below 2 device px per art px), only essential tags show.
      const tagY = (n: Npc, y: number) => y - CHAR_H - (n.icon ? 12 : 1)
      const keep = declutterTags(
        visible
          .filter(({ n }) => this.showTag(n))
          .map(({ n, x, y }) => ({
            id: n.id,
            x,
            y: tagY(n, y) - GLYPH_H - 4,
            w: textWidth(n.plan.agent.name) + 4,
            h: GLYPH_H + 4,
            priority:
              (n.id === this.selected ? 1e6 : 0) +
              (n.id === this.hoverAgent ? 1e5 : 0) -
              Math.hypot(n.motion.pos.x - this.player.pos.x, n.motion.pos.z - this.player.pos.z),
            essential: this.essentialTag(n),
          })),
        this.camera.zoom,
      )
      for (const { n, x, y } of visible)
        if (keep.has(n.id)) {
          const team = n.plan.teamOf
            ? `#${appearanceOf(n.plan.teamOf).shirt.toString(16).padStart(6, '0')}`
            : undefined
          drawTag(c, n.plan.agent.name, x, tagY(n, y), team ? { accent: team } : {})
        }
      const target = this.target()
      if (target) {
        const t = toPixel(target.pos, map)
        const t0 = target.target
        const lib =
          t0.kind === 'capability' && this.projectLibrary
            ? projectRefLabel(this.projectLibrary, t0.ref.id)
            : null
        // A project surface shows its collection name and count (never a title).
        const text = lib ? `${promptFor(t0)} · ${lib}` : promptFor(t0)
        drawTag(c, text, t.px, t.py - CHAR_H - 14, { bg: 'rgba(255,210,63,0.92)', fg: '#1c1820' })
      }
      if (!drawFx(c, this.atlas, 'marker', pp.px, pp.py - CHAR_H, this.time))
        drawPlayerMarker(c, pp.px, pp.py - CHAR_H, this.time)
    }
    if (this.solidOverlay) this.drawSolid(c, map, v)
    r.screen()
    if (map.key.startsWith('footprint|'))
      drawText(c, PIXEL_COPY.missingPlan, 4, VIEW_H - 8, 'rgba(244,241,234,0.7)')
    if (over) this.drawOverview(c, map, v, visible, pp)
    else if (this.cam.mode === 'follow') this.drawPlayerArrow(c, v, pp)
    r.end()
  }

  /** World px → logical screen px (after `renderer.screen()`). */
  private toScreen(v: ViewRect, x: number, y: number): { x: number; y: number } {
    const k = v.scale / this.renderer.scale
    return { x: (x - v.x) * k, y: (y - v.y) * k }
  }

  /** The overview as a labelled floor plan: wing and room labels, big agent markers, the player. */
  private drawOverview(
    c: CanvasRenderingContext2D,
    map: PixelMap,
    v: ViewRect,
    visible: { n: Npc; x: number; y: number }[],
    pp: { px: number; py: number },
  ): void {
    const tileCentre = (tx: number, ty: number) =>
      this.toScreen(v, (tx + 0.5) * TILE_PX, (ty + 0.5) * TILE_PX)
    for (const l of this.labels) {
      const at = tileCentre(l.tx, l.ty)
      const text = l.text
      if (l.kind === 'wing') {
        const w = textWidth(text) * 2
        c.fillStyle = 'rgba(20,18,28,0.78)'
        c.fillRect(Math.round(at.x - w / 2) - 3, Math.round(at.y) - 3, w + 6, GLYPH_H * 2 + 6)
        c.save()
        c.translate(Math.round(at.x - w / 2), Math.round(at.y))
        c.scale(2, 2)
        drawText(c, text, 0, 0, '#ffd23f')
        c.restore()
      } else drawTag(c, text, at.x, at.y + GLYPH_H + 2, { bg: 'rgba(20,18,28,0.6)' })
    }
    const pulse = Math.floor(this.time * 3) % 2 === 0
    for (const { n, x, y } of visible) {
      const s = this.toScreen(v, x, y)
      const st = n.plan.agent.status
      const big = (st === 'waiting' || st === 'error') && pulse ? 6 : 4
      c.fillStyle = '#1c1820'
      c.fillRect(Math.round(s.x - big / 2) - 1, Math.round(s.y - big / 2) - 1, big + 2, big + 2)
      c.fillStyle = STATUS_COLORS[st]
      c.fillRect(Math.round(s.x - big / 2), Math.round(s.y - big / 2), big, big)
    }
    const me = this.toScreen(v, pp.px, pp.py)
    const r = pulse ? 4 : 3
    c.fillStyle = '#1c1820'
    c.fillRect(Math.round(me.x) - r - 1, Math.round(me.y) - r - 1, 2 * r + 3, 2 * r + 3)
    c.fillStyle = '#ffd23f'
    c.fillRect(Math.round(me.x) - r, Math.round(me.y) - r, 2 * r + 1, 2 * r + 1)
    drawPlayerMarker(c, me.x, me.y - r - 1, this.time)
    // Title bar.
    const title = OVERVIEW_TITLE
    c.fillStyle = 'rgba(20,18,28,0.85)'
    c.fillRect(0, 0, VIEW_W, GLYPH_H + 6)
    drawText(c, title, Math.round((VIEW_W - textWidth(title)) / 2), 3, '#f4f1ea')
  }

  /** While following an agent: an edge arrow pointing to the player when they're off-screen. */
  private drawPlayerArrow(
    c: CanvasRenderingContext2D,
    v: ViewRect,
    pp: { px: number; py: number },
  ): void {
    const s = this.toScreen(v, pp.px, pp.py - CHAR_H / 2)
    const W = VIEW_W
    const H = VIEW_H
    if (s.x >= 0 && s.y >= 0 && s.x <= W && s.y <= H) return
    const cx = W / 2
    const cy = H / 2
    const dx = s.x - cx
    const dy = s.y - cy
    const k = Math.min((W / 2 - 10) / Math.abs(dx || 1e-6), (H / 2 - 10) / Math.abs(dy || 1e-6))
    const ax = cx + dx * k
    const ay = cy + dy * k
    const a = Math.atan2(dy, dx)
    c.save()
    c.translate(Math.round(ax), Math.round(ay))
    c.rotate(a)
    c.fillStyle = '#1c1820'
    c.beginPath()
    c.moveTo(7, 0)
    c.lineTo(-5, -6)
    c.lineTo(-5, 6)
    c.closePath()
    c.fill()
    c.fillStyle = '#ffd23f'
    c.beginPath()
    c.moveTo(5, 0)
    c.lineTo(-4, -4)
    c.lineTo(-4, 4)
    c.closePath()
    c.fill()
    c.restore()
  }

  /** Debug: the solid grid in translucent red over the map (`__aoDebug.pixelSolid(true)`). */
  private drawSolid(c: CanvasRenderingContext2D, map: PixelMap, v: ViewRect): void {
    drawSolidOverlay(c, map, v)
  }

  /** Selected, hovered, waiting or error: still tagged when zoomed out (`declutterTags`). */
  private essentialTag(n: Npc): boolean {
    const st = n.plan.agent.status
    return n.id === this.selected || n.id === this.hoverAgent || st === 'waiting' || st === 'error'
  }

  private showTag(n: Npc): boolean {
    if (this.essentialTag(n)) return true
    if (this.focusSet && !this.focusSet.has(n.id)) return false
    const mode = this.gfx?.labels.mode ?? 'nearby'
    if (mode === 'all') return true
    if (mode === 'selected') return false
    const reach = Math.min(this.gfx?.labels.nearbyM ?? NEARBY_M, NEARBY_M)
    return (
      Math.hypot(n.motion.pos.x - this.player.pos.x, n.motion.pos.z - this.player.pos.z) <= reach
    )
  }

  // ── Interaction ──
  /** A capability object's ref from the current surfaces (stations, boards by slot). */
  private refOf(ob: MapObject): CapabilityRef | null {
    if (ob.interact?.kind === 'capability') return ob.interact.ref
    const slot = capabilitySlot(ob)
    return slot ? (this.resolve(slot.placement, slot.slot) ?? null) : null
  }

  private objectTarget(ob: MapObject): InteractTarget | null {
    if (ob.interact) return ob.interact
    const ref = this.refOf(ob)
    return ref ? { kind: 'capability', ref } : null
  }

  private centerOf(ob: MapObject, map: PixelMap): Vec2 {
    return pixelToWorld(ob.box.x + ob.box.w / 2, ob.box.y + ob.box.h / 2, map)
  }

  private interactObjects(map: PixelMap): InteractObject[] {
    return objectTargets(map, this.resolve, this.layout?.ports)
  }

  private target(): { target: InteractTarget; pos: Vec2 } | null {
    const map = this.map
    if (!map) return null
    const agents = [...this.npcs.npcs.values()]
      .filter((n) => n.motion.visible && !n.entity.leaving)
      .map((n) => ({
        id: n.id,
        pos: n.motion.pos,
        ...(n.plan.agent.parentId && { parentId: n.plan.agent.parentId }),
      }))
    const px = this.player.pos
    const r = INTERACT_PREFILTER_M
    const near = this.interactObjects(map).filter(
      (o) =>
        o.box.maxX > px.x - r &&
        o.box.minX < px.x + r &&
        o.box.maxZ > px.z - r &&
        o.box.minZ < px.z + r,
    )
    const hit = interactionTarget({ pos: px, facing: this.player.dir }, agents, near)
    if (!hit) return null
    if (hit.target.kind === 'agent')
      return { target: hit.target, pos: this.npcs.npcs.get(hit.id)!.motion.pos }
    const b = near.find((x) => x.id === hit.id)!.box
    return { target: hit.target, pos: { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 } }
  }

  private interact(): void {
    const hit = this.target()
    if (!hit) return
    const t = hit.target
    if (t.kind === 'agent') {
      const n = this.npcs.npcs.get(t.id)
      if (n) n.faceOverride = OPPOSITE[this.player.dir]
      this.lastTalked = t.id
    }
    this.emitInteract(t)
  }

  private emitInteract(t: InteractTarget): void {
    if (this.interactFn) return this.interactFn(t)
    if (t.kind === 'agent') this.pickFn(t.id)
    else if (t.kind === 'capability') this.pickCapFn(t.ref)
  }

  /** Esc: close the agent panel first (selection), then cancel a camera override. */
  private escape(): void {
    if (this.selected) return this.pickFn(null)
    if (escapeCancels(this.cam)) return this.setCam({ type: 'escape' })
    this.pickFn(null)
  }

  private toggleOverview(): void {
    this.setCam({ type: 'toggle-overview' })
  }

  private agentAt(wx: number, wy: number): string | null {
    const map = this.map
    if (!map) return null
    let best: { id: string; y: number } | null = null
    for (const n of this.npcs.npcs.values()) {
      if (!n.motion.visible) continue
      const { px, py } = toPixel(n.motion.pos, map)
      if (wx >= px - CHAR_W / 2 && wx < px + CHAR_W / 2 && wy >= py - CHAR_H && wy <= py + 1)
        if (!best || py > best.y) best = { id: n.id, y: py }
    }
    return best?.id ?? null
  }

  /** The interactive object drawn at a world px (its box or the art rising above it). */
  private objectAt(wx: number, wy: number): MapObject | null {
    const map = this.map
    if (!map) return null
    return (
      map.objects.find((o) => {
        const b = o.box
        if (wx < b.x || wx >= b.x + b.w || wy >= b.y + b.h) return false
        return wy >= b.y - overhangOf(o, this.atlas) && !!this.objectTarget(o)
      }) ?? null
    )
  }

  private click(clientX: number, clientY: number): void {
    const map = this.map
    if (!map) return
    const w = this.renderer.toWorldPx(clientX, clientY, this.view())
    const id = this.agentAt(w.x, w.y)
    if (id) return this.pickFn(id)
    const ob = this.objectAt(w.x, w.y)
    const t = ob && this.objectTarget(ob)
    if (t) {
      if (t.kind === 'capability') return this.pickCapFn(t.ref)
      return this.emitInteract(t)
    }
    if (this.cam.mode === 'overview') {
      // The floor in the overview: pan the normal view there.
      return this.setCam({ type: 'floor-click', at: pixelToWorld(w.x, w.y, map) })
    }
    this.pickFn(null)
    // Click on the floor: walk there (straight, 4 directions; capped at 60 m).
    const goal = pixelToWorld(w.x, w.y, map)
    if (
      !blocked(map, goal) &&
      Math.hypot(goal.x - this.player.pos.x, goal.z - this.player.pos.z) <= 60
    ) {
      this.player.goal = goal
      this.setCam({ type: 'move' })
    }
  }

  private hoverAt(clientX: number, clientY: number): void {
    if (!this.map || this.gfx?.hover === false) return this.setHover(null, null, clientX, clientY)
    const w = this.renderer.toWorldPx(clientX, clientY, this.view())
    const agent = this.agentAt(w.x, w.y)
    const ob = agent ? null : this.objectAt(w.x, w.y)
    this.setHover(agent, ob, clientX, clientY)
  }

  private setHover(agent: string | null, ob: MapObject | null, x: number, y: number): void {
    this.hoverAgent = agent
    const id = ob?.id ?? null
    this.renderer.canvas.style.cursor = agent || ob ? 'pointer' : ''
    if (id === this.hoverObject) return
    this.hoverObject = id
    const ref = ob ? this.refOf(ob) : null
    this.hoverFn(ref, x, y)
  }

  /** Puts the player next to a point, facing it (the nearest free side). */
  private placeNear(p: Vec2): void {
    const map = this.map
    if (!map) return
    for (const d of ['s', 'e', 'w', 'n'] as Dir4[]) {
      const v = dirVector(d)
      const at = { x: p.x + v.x * PLACE_NEAR_M, z: p.z + v.z * PLACE_NEAR_M }
      if (!blocked(map, at)) {
        this.player.pos = at
        this.player.dir = OPPOSITE[d]
        this.player.goal = null
        this.setCam({ type: 'travel' })
        return
      }
    }
    this.player.pos = nearestFree(map, p)
    this.setCam({ type: 'travel' })
  }

  private spawn(): void {
    const map = this.map
    const layout = this.layout
    if (!map || !layout) return
    if (!this.placed) {
      this.placed = true
      if (!savedPlayer) {
        this.player.pos = spawnPoint(map, layout)
        this.player.dir = 's'
      }
      const o = toPixel(this.player.pos, map)
      this.camera.target(o.px, o.py, true)
    }
    // A new wing never traps the player: push them to the nearest free tile.
    this.player.pos = nearestFree(map, this.player.pos)
  }

  /** Each desk seat's desk (the nearest desk object within 1.2 m), for the monitor colours. */
  private mapDesks(map: PixelMap, layout: BuildingLayout): void {
    this.deskOf.clear()
    const desks = map.objects.filter((o) => o.kind === 'desk')
    for (const a of layout.anchors.values()) {
      if (!a.local.startsWith('seat:desk:')) continue
      let best: { id: string; d: number } | null = null
      for (const o of desks) {
        const c = this.centerOf(o, map)
        const d = Math.hypot(c.x - a.pos.x, c.z - a.pos.z)
        if (d < 1.2 && (!best || d < best.d)) best = { id: o.id, d }
      }
      if (best) this.deskOf.set(a.id, best.id)
    }
  }

  private emitViews(): void {
    if (!this.viewsFn || !this.layout) return
    const id = this.currentView
    this.viewsFn(viewsFor(this.layout, { current: id }))
  }

  private renderEntityList(): void {
    const rows = [...this.npcs.npcs.values()].map((n) => [
      n.id,
      n.plan.intent.activity,
      n.anim,
      n.icon ?? '',
      n.plan.agent.status,
      n.motion.visible ? '1' : '0',
    ])
    const key = rows.map((r) => r.join('|')).join('\n')
    if (key === this.entityKey) return
    this.entityKey = key
    this.entityList.replaceChildren(
      ...rows.map(([id, activity, anim, icon, status, visible]) => {
        const li = document.createElement('li')
        li.dataset.agentId = id!
        li.dataset.activity = activity!
        li.dataset.anim = anim!
        li.dataset.icon = icon!
        li.dataset.status = status!
        li.dataset.visible = visible!
        li.textContent = this.npcs.npcs.get(id!)?.plan.agent.name ?? id!
        return li
      }),
    )
  }

  // ── SceneView ──
  async load(manifestUrl: string): Promise<SceneAssets> {
    const base = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1)
    const res = await fetch(manifestUrl)
    if (!res.ok) throw new Error(`manifest: HTTP ${res.status}`)
    const manifest = parseManifest(await res.json())
    this.manifest = manifest
    const [clips, atlas] = await Promise.all([
      fetch(`${base}${manifest.character.meta}`)
        .then((r) => (r.ok ? (r.json() as Promise<{ clips?: ClipTable }>) : {}))
        .then((j) => (j as { clips?: ClipTable }).clips ?? {})
        .catch(() => ({}) as ClipTable),
      loadAtlas(`${base}pixel/`),
    ])
    // The atlas' one-shot lengths (sit-down, stand-up, wave, elevator-in) time the director too.
    const oneShot: Partial<Record<ClipName, string>> = {
      SitDown: 'sit-down',
      StandUp: 'stand-up',
      Wave: 'wave',
      ElevatorIn: 'elevator-in',
    }
    const table: Record<string, NonNullable<ClipTable[string]>> = {
      ...(clips as Record<string, NonNullable<ClipTable[string]>>),
    }
    for (const [clip, anim] of Object.entries(oneShot)) {
      const d = atlas?.raw.clipDurations?.[anim!]
      if (d && table[clip] && !table[clip].loop) table[clip] = { ...table[clip], duration: d }
    }
    this.clips = table
    this.atlas = atlas
    this.tiles.setAtlas(atlas)
    this.sprites.setAtlas(atlas)
    this.chunks.clear()
    this.hideLoading()
    const clipDurations: SceneAssets['clipDurations'] = {}
    for (const [name, c] of Object.entries(this.clips))
      if (c && !c.loop) clipDurations[name as ClipName] = c.duration
    return { manifest, clipDurations }
  }

  private hideLoading(): void {
    const root = this.el.loading.root
    if (root.hidden) return
    root.classList.add('done')
    setTimeout(() => (root.hidden = true), 450)
  }

  setBuilding(layout: BuildingLayout): void {
    if (!this.manifest) return
    this.layout = layout
    const plans = plansOf(this.manifest)
    const map = Object.keys(plans).length
      ? buildPixelMap(
          layout,
          plans,
          this.tiles,
          this.map ?? undefined,
          this.atlas && createSpriteFoot(this.atlas),
        )
      : footprintMap(layout, this.manifest, this.tiles)
    this.updateResolver()
    if (this.map === map || this.map?.key === map.key) return
    this.map = map
    this.artClips.clear()
    for (const o of map.objects) if (o.wallMounted) this.artClips.set(o.id, wallClip(o, map.walls))
    this.mapDesks(map, layout)
    this.chunks.setMap(map)
    this.labels = minimapLabels(layout, plans, map)
    this.spawn()
    this.emitViews()
    this.emitBase()
  }

  direct(plans: Map<string, AgentPlan>, departed: string[]): void {
    this.npcs.direct(plans, departed, this.clock.now())
  }

  setLinks(links: Link[]): void {
    this.links = this.gfx?.links === 'off' ? [] : links
  }

  setSurfaces(s: SceneSurfaces): void {
    this.baseSurfaces = s.byProvider
    this.bubbles = s.bubbles
    this.applySurfaces()
  }

  /** Notebooks, shelves and boards come from the selected project's Library when there is one. */
  private applySurfaces(): void {
    if (!this.baseSurfaces) return
    const byProvider = this.projectLibrary
      ? projectSurfaces(this.baseSurfaces, this.projectLibrary)
      : this.baseSurfaces
    this.surfaces = { bubbles: this.bubbles, byProvider }
    this.updateResolver()
  }

  setProjectLibrary(vm: ProjectLibraryVM | null): void {
    this.projectLibrary = vm
    this.applySurfaces()
  }

  /** Non-focused sprites at DIM_ALPHA and the camera to the group's centroid. */
  focusAgents(ids: string[] | null, o: { dim: boolean; frame: boolean }): void {
    this.focusSet = ids && o.dim ? new Set(ids) : null
    if (!ids || !o.frame) return
    const at = centroid(
      ids.flatMap((id) => {
        const p = this.npcs.npcs.get(id)?.motion.pos
        return p ? [{ x: p.x, z: p.z }] : []
      }),
    )
    if (at) this.panTo(at)
  }

  private dimAlpha(id: string): number {
    return this.focusSet && !this.focusSet.has(id) ? DIM_ALPHA : 1
  }

  private updateResolver(): void {
    this.resolve =
      this.layout && this.surfaces
        ? slotCapability(this.layout, this.surfaces.byProvider)
        : () => undefined
  }

  onPickCapability(fn: (ref: CapabilityRef) => void): void {
    this.pickCapFn = fn
  }

  focusCapability(ref: CapabilityRef | null): void {
    this.el.stage.dataset.focus = ref ? `${ref.provider} ${ref.id}` : ''
    if (!ref || !this.map) {
      this.focusObject = null
      return
    }
    const ob = this.map.objects.find((o) => {
      const r = this.refOf(o)
      return r && r.provider === ref.provider && r.id === ref.id
    })
    if (!ob) return
    this.focusObject = ob.id
    this.setCam({ type: 'pan', at: this.centerOf(ob, this.map) })
  }

  highlightLinks(capabilityId: string | null): void {
    this.highlighted = capabilityId
  }

  select(id: string | null): void {
    this.selected = id
    if (!id || !this.map) return
    // Bring an off-screen agent into view (a pan: the next movement key returns to the player).
    if (this.cam.mode === 'overview') return
    const n = this.npcs.npcs.get(id)
    if (!n) return
    const v = this.view()
    const { px, py } = toPixel(n.motion.pos, this.map)
    if (px < v.x || py < v.y || px > v.x + v.w || py > v.y + v.h)
      this.setCam({ type: 'pan', at: { ...n.motion.pos } })
  }

  setQuality(_q: GraphicsQuality): void {
    // The 2D view has no quality levers; `setGraphics` carries the frame limit and labels.
  }

  onPick(fn: (id: string | null) => void): void {
    this.pickFn = fn
  }

  goTo(viewId: string): void {
    if (viewId === 'overview') this.setCam({ type: 'overview' })
    else {
      const c = this.layout && regionCenter(this.layout, viewId)
      if (!c) return
      this.setCam({ type: 'pan', at: c })
    }
    this.currentView = viewId
    this.emitViews()
  }

  cameraIdleMs(): number {
    return performance.now() - this.input.lastInputAt
  }

  setTheme(theme: 'light' | 'dark'): void {
    this.theme = theme
  }

  setGraphics(e: Effective): void {
    this.gfx = e
    if (e.links === 'off') this.links = []
    this.arm()
  }

  stats(): GraphicsStats {
    const bytes = this.renderer.bytes() + this.chunks.bytes() + (this.atlas?.bytes() ?? 0)
    return {
      fps: Math.round(this.fps),
      drawCalls: this.drawn,
      triangles: 0,
      textureMB: Math.round(bytes / 2 ** 20),
      geometryMB: 0,
      width: this.renderer.width,
      height: this.renderer.height,
    }
  }

  onContextLost(_fn: () => void): void {
    // A 2D context isn't lost.
  }

  onContextRestored(_fn: () => void): void {}

  onHoverSurface(fn: (ref: CapabilityRef | null, x: number, y: number) => void): void {
    this.hoverFn = fn
  }

  onViews(fn: (views: ViewEntry[]) => void): void {
    this.viewsFn = fn
    this.emitViews()
  }

  onInteract(fn: (t: InteractTarget) => void): void {
    this.interactFn = fn
  }

  setInputSuspended(on: boolean): void {
    this.input.setSuspended(on)
    if (!on) for (const n of this.npcs.npcs.values()) n.faceOverride = null
  }

  onRoom(fn: (roomName: string) => void): void {
    this.roomFn = fn
    if (this.room) fn(this.room)
  }

  follow(agentId: string | null): void {
    this.setCam({ type: 'follow', agentId })
  }

  /** Pans the camera to a world point (minimap click); a movement key returns it to the player. */
  panTo(pos: { x: number; z: number }): void {
    this.setCam({ type: 'pan', at: { x: pos.x, z: pos.z } })
  }

  travelTo(target: { agentId?: string; viewId?: string; pos?: { x: number; z: number } }): void {
    if (target.pos && this.map) {
      this.player.pos = nearestFree(this.map, target.pos)
      this.player.goal = null
      this.setCam({ type: 'travel' })
    } else if (target.agentId) {
      const n = this.npcs.npcs.get(target.agentId)
      if (n) this.placeNear(n.motion.pos)
    } else if (target.viewId && this.layout && this.map) {
      const c = regionCenter(this.layout, target.viewId)
      if (c) {
        this.player.pos = nearestFree(this.map, c)
        this.setCam({ type: 'travel' })
      }
    }
  }

  /** Where the player stands in world metres (minimap), at most 4 Hz and only when its tile changes. */
  onPlayerMove(fn: (pos: { x: number; z: number }) => void): void {
    this.playerMoveFn = fn
    this.lastTile = ''
  }

  /** The camera's visible tiles (minimap viewport), at most 4 Hz and only when they change. */
  onCamera(fn: (view: TileRect) => void): void {
    this.cameraFn = fn
    this.lastCam = ''
    this.lastCamAt = -Infinity
  }

  /** The minimap base image, sent now (when the map exists) and again whenever the map changes. */
  onMinimapBase(
    fn: (img: CanvasImageSource, widthTiles: number, heightTiles: number) => void,
  ): void {
    this.baseFn = fn
    this.emitBase(true)
  }

  private emitBase(force = false): void {
    if (!this.baseFn || !this.map) return
    const { img, changed } = this.minimapBase.render(this.map, this.atlas)
    if (changed || force) this.baseFn(img, this.map.widthTiles, this.map.heightTiles)
  }

  /** Adapter-level (main.ts): no WebGL in 2D. */
  hardwareInfo(): null {
    return null
  }

  /** Frame-rate samples (~2 Hz) for the Settings readout. */
  onFrameStats(fn: (fps: number, preset: string) => void): void {
    this.statsFn = fn
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    for (const off of this.off.splice(0)) off()
    this.input.dispose()
    this.minimapBase.dispose()
    this.chunks.dispose()
    this.tiles.dispose()
    this.sprites.clear()
    this.npcs.clear()
    this.renderer.dispose()
    this.entityList.remove()
    this.el.stage.dataset.focus = ''
    const w = window as unknown as { __aoDebug?: unknown }
    if (this.debugApi && w.__aoDebug === this.debugApi) delete w.__aoDebug
  }

  // ── Debug (AGENT_OFFICE_DEBUG=1 only) ──
  private installDebug(): void {
    const api = {
      ready: () => !!this.map,
      pixel: () => {
        const dlg = document.getElementById('dialogue')
        const open = !!dlg && !dlg.hidden
        return {
          player: { x: this.player.pos.x, z: this.player.pos.z, dir: this.player.dir },
          room: this.room,
          /** Device px per art px (the crisp zoom level). */
          zoom: this.camera.zoom,
          zoomLevel: this.camera.info(),
          pxPerMetre: PX_PER_M,
          run: this.running,
          overview: this.camera.overview,
          camera: this.cam.mode,
          following: this.cam.mode === 'follow' ? this.cam.agentId : null,
          view: (() => {
            const v = this.view()
            const m = this.map
            if (!m) return null
            const c = pixelToWorld(v.x + v.w / 2, v.y + v.h / 2, m)
            return { cx: c.x, cz: c.z, w: v.w / PX_PER_M, h: v.h / PX_PER_M }
          })(),
          /** Every map object's box (px), its 1 m cells (`rect`), orientation, fill and room. */
          objects: () =>
            (this.map?.objects ?? []).map((o) => ({
              id: o.id,
              kind: o.kind,
              box: { ...o.box },
              rect: cellsOf(o.box),
              solid: o.solid,
              ...(o.wallMounted && { wallMounted: true }),
              ...(o.room !== undefined && { room: o.room }),
              ...(o.orientation && { orientation: o.orientation }),
              ...(o.fill && { fill: o.fill }),
            })),
          rooms: () =>
            (this.map?.rooms ?? []).map((r) => ({
              id: r.id,
              name: r.name,
              box: { ...r.box },
              rect: { ...r.rect },
              placement: r.placement,
            })),
          walls: () =>
            (this.map?.walls ?? []).map((w) => ({
              box: { ...w.box },
              kind: w.kind,
              face: w.face,
            })),
          solids: () => (this.map?.solids ?? []).map((r) => ({ ...r })),
          originM: this.map ? { ...this.map.originM } : null,
          tiles: this.map ? { w: this.map.widthTiles, h: this.map.heightTiles } : null,
          entities: [...this.npcs.npcs.values()].map((n) => ({
            id: n.id,
            x: n.motion.pos.x,
            z: n.motion.pos.z,
            activity: n.plan.intent.activity,
            anim: n.anim,
            icon: n.icon,
            visible: n.motion.visible,
          })),
          dialogue: { open, agentId: open ? this.lastTalked : null },
        }
      },
      /** Places the player next to an agent or a capability object, facing it. */
      pixelGoTo: (t: { agentId?: string; object?: 'book' | 'station' }) => {
        const map = this.map
        if (!map) return false
        if (t.agentId) {
          const n = this.npcs.npcs.get(t.agentId)
          if (!n) return false
          this.placeNear(n.motion.pos)
          return true
        }
        const re = t.object === 'book' ? /\/book:\d+$/ : /\/station:\d+$/
        const hit = this.interactObjects(map).find((o) => re.test(o.id))
        if (!hit) return false
        const b = hit.box
        this.placeNear({ x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 })
        return true
      },
      /** Places the player at world metres (clamped to a free spot). */
      pixelTeleport: (x: number, z: number, dir: Dir4 = 's') => {
        if (!this.map) return false
        this.player.pos = nearestFree(this.map, { x, z })
        this.player.dir = dir
        this.player.goal = null
        this.setCam({ type: 'travel' })
        return true
      },
      /** Debug overlay: the solid grid in translucent red. */
      pixelSolid: (on: boolean) => {
        this.solidOverlay = on
        return on
      },
      views: () => (this.layout ? viewsFor(this.layout).map((v) => v.id) : []),
      bookmark: (id?: string) => (id === undefined ? this.currentView : (this.goTo(id), true)),
      focus: (agentId: string) => this.pickFn(agentId),
      frames: () => this.frames,
      graphics: () => this.gfx,
      timeScale: (n: number) => this.clock.setScale(n),
      hideHud: (hide: boolean) => document.body.classList.toggle('capture', hide),
      gpu: () => this.stats(),
      stats: () => ({
        ...this.stats(),
        sprites: this.sprites.count(),
        agents: this.npcs.npcs.size,
      }),
    }
    this.debugApi = api
    ;(window as unknown as { __aoDebug: typeof api }).__aoDebug = api
  }
}
