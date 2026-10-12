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
  TILE_M,
  type Dir4,
  type InteractTarget,
  type MapObject,
  type PixelMap,
} from '../../app/pixel/types.ts'
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
import { dirVector, pixelToWorld, toPixel, toTile } from '../../app/pixel/project.ts'
import { roomLabel } from '../../app/pixel/rooms.ts'
import {
  blocked,
  nearestFree,
  spawnPoint,
  SPRINT_SPEED,
  stepPlayer,
  WALK_SPEED,
} from '../../app/pixel/walk.ts'
import { PixelCamera } from './camera.ts'
import { NpcSystem, type Npc } from './characters.ts'
import {
  drawBeam,
  drawObject,
  drawPlayerMarker,
  drawSelection,
  drawShadow,
  drawStatusIcon,
  drawFx,
  FLAT_KINDS,
  iconFx,
} from './effects.ts'
import { declutterTags } from '../../app/pixel/tags.ts'
import { drawTag, drawText, GLYPH_H, textWidth } from './font.ts'
import { PixelInput } from './input.ts'
import { ChunkCache, PixelRenderer, type ViewRect } from './renderer.ts'
import {
  CHAR_H,
  CHAR_W,
  CharacterSprites,
  loadAtlas,
  lookKey,
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
const debugEnabled = () => new URLSearchParams(location.search).get('debug') === '1'

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
  private chunks = new ChunkCache(this.tiles)
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
  private gfx: Effective | null = null
  private theme: 'light' | 'dark' = 'dark'
  private links: Link[] = []
  private surfaces: SceneSurfaces | null = null
  private highlighted: string | null = null
  private selected: string | null = null
  private followId: string | null = null
  private pan: Vec2 | null = null
  private focusObject: string | null = null
  private hoverObject: string | null = null
  private hoverAgent: string | null = null
  private lastTalked: string | null = null
  /** Desk seat anchor → the desk object in front of it (status monitor colour). */
  private deskOf = new Map<string, string>()
  private litBooths = new Set<string>()
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
      zoom: (d) => {
        if (this.camera.overview) return
        this.camera.setZoom(this.camera.zoom + d)
      },
      click: (x, y) => this.click(x, y),
      hover: (x, y) => this.hoverAt(x, y),
      leave: () => this.setHover(null, null, 0, 0),
      moved: () => this.stopCameraOverrides(),
    })
    const on = (t: EventTarget, type: string, fn: () => void) => {
      t.addEventListener(type, fn)
      this.off.push(() => t.removeEventListener(type, fn))
    }
    on(window, 'resize', () => this.renderer.resize())
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
    const speed = this.input.run ? SPRINT_SPEED : WALK_SPEED
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
        p.pos = stepPlayer(
          map,
          p.pos,
          dirVector(p.dir),
          WALK_SPEED,
          Math.min(dt, left / WALK_SPEED),
        )
        if (p.pos.x === before.x && p.pos.z === before.z) p.goal = null
      }
    }
    const moved = before.x !== p.pos.x || before.z !== p.pos.z
    if (moved) {
      for (const n of this.npcs.npcs.values()) n.faceOverride = null
      p.animT += dt
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
    const follow = this.followId ? this.npcs.npcs.get(this.followId) : undefined
    const at = follow ? follow.motion.pos : (this.pan ?? this.player.pos)
    const o = toPixel(at, map)
    this.camera.target(o.px, o.py)
    this.camera.update(dt)
  }

  private stopCameraOverrides(): void {
    this.followId = null
    this.pan = null
    if (this.camera.overview) this.camera.overview = false
    this.currentView = null
  }

  // ── Drawing ──
  private view(): ViewRect {
    const m = this.map
    const w = m ? m.widthTiles * TILE_M * PX_PER_M : 480
    const h = m ? m.heightTiles * TILE_M * PX_PER_M : 270
    return this.camera.view(this.renderer.scale, w, h)
  }

  private draw(): void {
    const r = this.renderer
    const c = r.ctx
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
    this.drawn = this.chunks.draw(c, 'base', v)
    const inView = (x: number, y: number, m = 32) =>
      x > v.x - m && x < v.x + v.w + m && y > v.y - m && y < v.y + v.h + m
    // Desk monitors show the seated agent's status colour.
    const monitors = new Map<string, string>()
    this.litBooths.clear()
    for (const n of this.npcs.npcs.values()) {
      const t = n.plan.intent.target
      const desk = t.includes('/seat:desk:') ? this.deskOf.get(t) : undefined
      if (desk) monitors.set(desk, STATUS_COLORS[n.plan.agent.status])
      // A booth lamp lights while a waiting agent occupies the booth.
      if (n.plan.intent.activity === 'booth' && this.layout) {
        const a = this.layout.anchors.get(t)
        if (a) {
          const tt = toTile(a.pos, map)
          this.litBooths.add(tt.tx + ',' + tt.ty)
        }
      }
    }
    type D = { y: number; draw: () => void }
    const list: D[] = []
    for (const ob of map.objects) {
      const x = ob.rect.tx * 16
      const y = ob.rect.ty * 16
      if (!inView(x, y)) continue
      const hl = ob.id === this.focusObject || ob.id === this.hoverObject
      const lit = ob.kind === 'booth-lamp' && this.litBooths.has(ob.rect.tx + ',' + ob.rect.ty)
      list.push({
        y: FLAT_KINDS.has(ob.kind) ? -1e9 : ob.sortY,
        draw: () => drawObject(c, ob, monitors.get(ob.id) ?? null, hl, lit, this.atlas),
      })
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
          c.globalAlpha = m.opacity * f.alpha
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
        const t = p.moving ? p.animT * (this.input.run ? SPRINT_SPEED / WALK_SPEED : 1) : this.time
        const f = this.sprites.frame(p.look, p.key, p.dir, p.moving ? 'walk' : 'idle', t)
        c.drawImage(f.canvas, Math.round(pp.px) - f.ax, Math.round(pp.py) - f.ay)
      },
    })
    list.sort((a, b) => a.y - b.y)
    for (const d of list) d.draw()
    this.drawn += list.length + this.chunks.draw(c, 'overhead', v)
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
      // Tags never overlap: selected and hovered first, then the nearest to the player.
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
          })),
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
        const text = promptFor(target.target)
        drawTag(c, text, t.px, t.py - CHAR_H - 14, { bg: 'rgba(255,210,63,0.92)', fg: '#1c1820' })
      }
      if (!drawFx(c, this.atlas, 'marker', pp.px, pp.py - CHAR_H, this.time))
        drawPlayerMarker(c, pp.px, pp.py - CHAR_H, this.time)
    }
    r.screen()
    if (map.key.startsWith('footprint|'))
      drawText(c, PIXEL_COPY.missingPlan, 4, 262, 'rgba(244,241,234,0.7)')
    if (over) drawText(c, PIXEL_COPY.overview, 4, 4, '#f4f1ea')
    r.end()
  }

  private showTag(n: Npc): boolean {
    if (n.id === this.selected || n.id === this.hoverAgent) return true
    const mode = this.gfx?.labels.mode ?? 'nearby'
    if (mode === 'all') return true
    if (mode === 'selected') return false
    const reach = Math.min(this.gfx?.labels.nearbyM ?? 2.5, 2.5)
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
    return {
      x: map.originM.x + (ob.rect.tx + ob.rect.tw / 2) * TILE_M,
      z: map.originM.z + (ob.rect.ty + ob.rect.th / 2) * TILE_M,
    }
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
    const near = this.interactObjects(map).filter(
      (o) =>
        o.box.maxX > px.x - 2 &&
        o.box.minX < px.x + 2 &&
        o.box.maxZ > px.z - 2 &&
        o.box.minZ < px.z + 2,
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

  private escape(): void {
    if (this.followId || this.pan || this.camera.overview) return this.stopCameraOverrides()
    this.pickFn(null)
  }

  private toggleOverview(): void {
    this.camera.overview = !this.camera.overview
    this.currentView = this.camera.overview ? 'overview' : null
    this.emitViews()
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

  private objectAt(wx: number, wy: number): MapObject | null {
    const map = this.map
    if (!map) return null
    const tx = Math.floor(wx / 16)
    const ty = Math.floor(wy / 16)
    return (
      map.objects.find(
        (o) =>
          tx >= o.rect.tx &&
          ty >= o.rect.ty &&
          tx < o.rect.tx + o.rect.tw &&
          ty < o.rect.ty + o.rect.th &&
          this.objectTarget(o),
      ) ?? null
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
    this.pickFn(null)
    if (this.camera.overview) return
    // Click on the floor: walk there (straight, 4 directions; capped at 60 m).
    const goal = pixelToWorld(w.x, w.y, map)
    if (
      !blocked(map, goal) &&
      Math.hypot(goal.x - this.player.pos.x, goal.z - this.player.pos.z) <= 60
    ) {
      this.player.goal = goal
      this.stopCameraOverrides()
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
      const at = { x: p.x + v.x * 0.8, z: p.z + v.z * 0.8 }
      if (!blocked(map, at)) {
        this.player.pos = at
        this.player.dir = OPPOSITE[d]
        this.player.goal = null
        this.stopCameraOverrides()
        return
      }
    }
    this.player.pos = nearestFree(map, p)
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
      ? buildPixelMap(layout, plans, this.tiles, this.map ?? undefined)
      : footprintMap(layout, this.manifest, this.tiles)
    this.updateResolver()
    if (this.map === map || this.map?.key === map.key) return
    this.map = map
    this.mapDesks(map, layout)
    this.chunks.setMap(map)
    this.spawn()
    this.emitViews()
  }

  direct(plans: Map<string, AgentPlan>, departed: string[]): void {
    this.npcs.direct(plans, departed, this.clock.now())
  }

  setLinks(links: Link[]): void {
    this.links = this.gfx?.links === 'off' ? [] : links
  }

  setSurfaces(s: SceneSurfaces): void {
    this.surfaces = s
    this.updateResolver()
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
    this.followId = null
    this.pan = this.centerOf(ob, this.map)
  }

  highlightLinks(capabilityId: string | null): void {
    this.highlighted = capabilityId
  }

  select(id: string | null): void {
    this.selected = id
    if (!id || !this.map) return
    // Bring an off-screen agent into view (until the player moves).
    const n = this.npcs.npcs.get(id)
    if (!n) return
    const v = this.view()
    const { px, py } = toPixel(n.motion.pos, this.map)
    if (px < v.x || py < v.y || px > v.x + v.w || py > v.y + v.h) this.followId = id
  }

  setQuality(_q: GraphicsQuality): void {
    // The 2D view has no quality levers; `setGraphics` carries the frame limit and labels.
  }

  onPick(fn: (id: string | null) => void): void {
    this.pickFn = fn
  }

  goTo(viewId: string): void {
    if (viewId === 'overview') {
      this.camera.overview = true
    } else {
      const c = this.layout && regionCenter(this.layout, viewId)
      if (!c) return
      this.camera.overview = false
      this.followId = null
      this.pan = c
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
    this.followId = agentId
    if (agentId) this.pan = null
  }

  travelTo(target: { agentId?: string; viewId?: string }): void {
    if (target.agentId) {
      const n = this.npcs.npcs.get(target.agentId)
      if (n) this.placeNear(n.motion.pos)
    } else if (target.viewId && this.layout && this.map) {
      const c = regionCenter(this.layout, target.viewId)
      if (c) {
        this.player.pos = nearestFree(this.map, c)
        this.stopCameraOverrides()
      }
    }
  }

  /** Where the player stands in world metres (minimap), at most 4 Hz and only when its tile changes. */
  onPlayerMove(fn: (pos: { x: number; z: number }) => void): void {
    this.playerMoveFn = fn
    this.lastTile = ''
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
          zoom: this.camera.zoom,
          overview: this.camera.overview,
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
        this.stopCameraOverrides()
        return true
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
