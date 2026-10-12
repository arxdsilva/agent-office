// Small pixel effects drawn in world px: shadows, status icons, selection, the player marker,
// link beams (adapters: dashes) and page sparkles (skills and rules), furniture on its pixel box
// (atlas art or a procedural placeholder) and thin walls (16 px per metre).
import { STATUS_COLORS } from '@agent-office/shared'
import {
  WALL_FACE_PX,
  type MapObject,
  type MapWall,
  type PixelMap,
  type PxRect,
  type StatusIcon,
} from '../../app/pixel/types.ts'
import type { ViewRect } from './renderer.ts'
import type { Atlas, ObjectFrame } from './sprites.ts'

type C = CanvasRenderingContext2D

const px = (c: C, x: number, y: number, col: string, w = 1, h = 1) => {
  if (w <= 0 || h <= 0) return
  c.fillStyle = col
  c.fillRect(Math.round(x), Math.round(y), w, h)
}

/** Draws an atlas effect at (x, y) (its anchor); false when the atlas lacks it (draw procedurally). */
export function drawFx(
  c: C,
  atlas: Atlas | null,
  name: string,
  x: number,
  y: number,
  t: number,
): boolean {
  const f = atlas?.effect(name, t)
  if (!f) return false
  c.drawImage(f.image, f.x, f.y, f.w, f.h, Math.round(x) - f.ax, Math.round(y) - f.ay, f.w, f.h)
  return true
}

const ICON_FX: Record<NonNullable<StatusIcon>, string> = {
  thinking: 'thinking',
  tool: 'gear',
  waiting: 'bang',
  error: 'cross',
}
export const iconFx = (icon: NonNullable<StatusIcon>) => ICON_FX[icon]

export function drawShadow(c: C, x: number, y: number): void {
  c.fillStyle = 'rgba(0,0,0,0.22)'
  c.fillRect(Math.round(x) - 4, Math.round(y) - 1, 9, 2)
  c.fillRect(Math.round(x) - 3, Math.round(y) - 2, 7, 4)
}

/** A 9×9 bubble over the head: … thinking, ⚙ tool, ! waiting, ✖ error. */
export function drawStatusIcon(c: C, icon: StatusIcon, x: number, top: number, t: number): void {
  if (!icon) return
  const color = STATUS_COLORS[icon]
  const l = Math.round(x) - 4
  const y = Math.round(top) - 11 + (icon === 'waiting' && Math.floor(t * 3) % 2 ? -1 : 0)
  px(c, l + 1, y, '#1c1820', 7, 9)
  px(c, l, y + 1, '#1c1820', 9, 7)
  px(c, l + 1, y + 1, '#f8f6f0', 7, 7)
  px(c, l + 3, y + 9, '#1c1820', 3, 1)
  px(c, l + 4, y + 10, '#1c1820', 1, 1)
  if (icon === 'thinking') {
    const n = Math.floor(t * 3) % 4
    for (let i = 0; i < Math.max(1, n); i++) px(c, l + 2 + i * 2, y + 4, color)
  } else if (icon === 'tool') {
    px(c, l + 3, y + 2, color, 3, 5)
    px(c, l + 2, y + 3, color, 5, 3)
    px(c, l + 4, y + 4, '#f8f6f0')
  } else if (icon === 'waiting') {
    px(c, l + 4, y + 2, color, 1, 3)
    px(c, l + 4, y + 6, color)
  } else {
    for (let i = 0; i < 5; i++) {
      px(c, l + 2 + i, y + 2 + i, color)
      px(c, l + 6 - i, y + 2 + i, color)
    }
  }
}

/** A pulsing ring around the selected agent's feet. */
export function drawSelection(c: C, x: number, y: number, t: number): void {
  const col = Math.floor(t * 2) % 2 ? '#ffd166' : '#ffe8a3'
  const l = Math.round(x) - 6
  const b = Math.round(y)
  px(c, l + 2, b - 3, col, 9, 1)
  px(c, l + 2, b + 2, col, 9, 1)
  px(c, l, b - 1, col, 1, 2)
  px(c, l + 12, b - 1, col, 1, 2)
  px(c, l + 1, b - 2, col)
  px(c, l + 11, b - 2, col)
  px(c, l + 1, b + 1, col)
  px(c, l + 11, b + 1, col)
}

/** A little bobbing arrow over the player, so they're never mistaken for an agent. */
export function drawPlayerMarker(c: C, x: number, top: number, t: number): void {
  const y = Math.round(top) - 7 + (Math.floor(t * 2) % 2)
  const l = Math.round(x) - 3
  px(c, l, y, '#1c1820', 7, 1)
  px(c, l, y + 1, '#ffd23f', 7, 1)
  px(c, l + 1, y + 2, '#ffd23f', 5, 1)
  px(c, l + 2, y + 3, '#ffd23f', 3, 1)
  px(c, l + 3, y + 4, '#ffd23f', 1, 1)
}

/** A dashed pixel line (adapters) or drifting page sparkles (skills, rules) from a to b. */
export function drawBeam(
  c: C,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  color: string,
  style: 'dash' | 'particles',
  t: number,
  alpha: number,
): void {
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy)
  if (len < 1) return
  c.globalAlpha = Math.max(0, Math.min(1, alpha))
  if (style === 'dash') {
    const shift = Math.floor(t * 16) % 6
    for (let s = 0; s < len; s++) {
      if ((s + 6 - shift) % 6 >= 3) continue
      px(
        c,
        ax + (dx * s) / len,
        ay + (dy * s) / len - Math.sin((Math.PI * s) / len) * len * 0.15,
        color,
      )
    }
  } else {
    for (let i = 0; i < 6; i++) {
      const k = (t * 0.4 + i / 6) % 1
      const x = ax + dx * k
      const y = ay + dy * k - Math.sin(Math.PI * k) * len * 0.18
      px(c, x, y, '#fff7d6', 2, 2)
      px(c, x + 1, y - 1, color)
    }
  }
  c.globalAlpha = 1
}

/** Kinds drawn under everything (flat on the floor). */
export const FLAT_KINDS = new Set(['rug', 'door', 'window', 'elevator-door'])

/** The atlas art an object uses (booth lamps and elevator doors pick a named state). */
export function objectFrame(o: MapObject, atlas: Atlas | null, lit = false): ObjectFrame | null {
  const named =
    o.kind === 'booth-lamp'
      ? lit
        ? 'on'
        : 'off'
      : o.kind === 'elevator-door'
        ? 'closed'
        : undefined
  // Areas (garden beds, bleachers) use their dedicated `@area` 9-slice art when the atlas has it.
  if (o.fill === 'area' && atlas?.hasObjectVariant(o.kind, 'area'))
    return atlas.object(o.kind, o.theme, undefined, undefined, 'area')
  return atlas?.object(o.kind, o.theme, o.facing, o.orientation, named) ?? null
}

/** Px the art rises above its box (the ¾ overhang); the procedural height without art. */
export function overhangOf(o: MapObject, atlas: Atlas | null): number {
  const a = objectFrame(o, atlas)
  if (a && !a.rotated) return Math.max(0, a.ay)
  return a ? 0 : (HEIGHT[o.kind] ?? 3)
}

/** Big enough to never clip. */
const OPEN = 1e6

/**
 * Where a wall-mounted piece's art must stop (plan §1): never past the wall it backs onto. A wall
 * above the box stops the overhang at the top of that wall's face; a wall to the side stops the art
 * at the wall's far edge. Null when no wall touches the box (or the piece isn't wall-mounted).
 */
export function wallClip(o: MapObject, walls: readonly MapWall[]): PxRect | null {
  if (!o.wallMounted) return null
  const b = o.box
  const near = 3
  let x0 = -OPEN
  let y0 = -OPEN
  let x1 = OPEN
  let y1 = OPEN
  let hit = false
  for (const w of walls) {
    const r = w.box
    const overlapX = r.x < b.x + b.w && r.x + r.w > b.x
    const overlapY = r.y < b.y + b.h && r.y + r.h > b.y
    if (overlapX && Math.abs(r.y + r.h - b.y) <= near) {
      y0 = Math.max(y0, r.y - (w.face === 's' ? WALL_FACE_PX : 0))
      hit = true
    } else if (overlapY && Math.abs(r.x + r.w - b.x) <= near) {
      x0 = Math.max(x0, r.x)
      hit = true
    } else if (overlapY && Math.abs(r.x - (b.x + b.w)) <= near) {
      x1 = Math.min(x1, r.x + r.w)
      hit = true
    } else if (overlapX && Math.abs(r.y - (b.y + b.h)) <= near) {
      y1 = Math.min(y1, r.y + r.h)
      hit = true
    }
  }
  return hit ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
}

/**
 * One piece of furniture on its box (map px): atlas art with its base exactly on `box` and its
 * overhang above (strips repeat along the long axis, areas 9-slice), else a procedural block.
 * `monitor`: a desk's status colour; `lit`: a booth lamp in use; `clip`: `wallClip`'s limit.
 */
export function drawObject(
  c: C,
  o: MapObject,
  monitor: string | null,
  highlight: boolean,
  lit = false,
  atlas: Atlas | null = null,
  clip: PxRect | null = null,
): void {
  const { x, y, w, h } = o.box
  const art = objectFrame(o, atlas, lit)
  if (art) {
    const up = art.rotated ? 0 : Math.max(0, art.ay)
    // Strips and areas never spill sideways or below their box; fixed art is drawn to size.
    const bounded = o.fill === 'repeat' || o.fill === 'area'
    const limit = bounded ? { x, y: y - (o.fill === 'area' ? 0 : up), w, h: h + up } : null
    const cl = limit && clip ? intersect(limit, clip) : (limit ?? clip)
    if (cl) {
      c.save()
      c.beginPath()
      c.rect(cl.x, cl.y, cl.w, cl.h)
      c.clip()
    }
    const [bw, bh] = art.footPx
    // Longer than the art along an axis with stretch meta: keep the ends, repeat the middle.
    const longX = !!art.stretch && w > bw
    const longY = !!art.stretchY && h > bh
    if (o.fill === 'area') drawArea(c, art, x, y, w, h)
    else if (longX || longY) drawStretched(c, art, o.box, longX, longY)
    else if (o.fill === 'repeat') drawRepeat(c, art, o.box)
    else drawSprite(c, art, x + Math.round((w - bw) / 2), y + h - bh, true)
    if (cl) c.restore()
    // The desk's status screen (atlas `screen` rect; back-facing desks have none).
    if (monitor && art.screen && !longX && !longY && o.fill !== 'area') {
      const [sx, sy, sw, sh] = art.screen
      const fx = x + Math.round((w - bw) / 2) - art.ax
      const fy = y + h - bh - art.ay
      c.globalAlpha = 0.85
      px(c, fx + sx, fy + sy, monitor, sw, sh)
      c.globalAlpha = 1
    }
    if (highlight) outline(c, o.box)
    return
  }
  drawPlaceholder(c, o, monitor, lit, clip)
  if (highlight) outline(c, o.box)
}

function outline(c: C, b: PxRect): void {
  c.strokeStyle = '#ffd166'
  c.lineWidth = 1
  c.strokeRect(b.x - 0.5, b.y - 0.5, b.w + 1, b.h + 1)
}

const intersect = (a: PxRect, b: PxRect): PxRect => {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  return {
    x,
    y,
    w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x),
    h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y),
  }
}

const ACCENT: Record<string, string> = {
  terracotta: '#c0623f',
  nordic: '#6f8fa8',
  forest: '#4f7f4a',
  ocean: '#3f78a8',
  neon: '#9b5bd0',
  brass: '#b08a3e',
}

/** Procedural ¾ height (px above the box) per kind, until the atlas has the art. */
const HEIGHT: Partial<Record<string, number>> = {
  desk: 6,
  chair: 5,
  booth: 16,
  'booth-lamp': 0,
  station: 10,
  'core-rack': 14,
  bookshelf: 16,
  'notebook-rack': 10,
  board: 12,
  tv: 10,
  sign: 6,
  'led-wall': 18,
  fridge: 14,
  'coffee-machine': 6,
  arcade: 12,
  plant: 8,
  planter: 6,
  'reception-desk': 8,
  'cafe-bar': 8,
  'kitchen-counter': 8,
  island: 6,
  sofa: 5,
  armchair: 5,
  beanbag: 3,
  rug: 0,
  door: 0,
  window: 0,
  'elevator-door': 0,
  elevator: 0,
}

/** Top and front colours per kind (procedural). */
const COLORS: Partial<Record<string, [string, string]>> = {
  desk: ['#a77a4e', '#7a5536'],
  chair: ['#5e6372', '#4a4e5a'],
  'meeting-table': ['#b98e60', '#7a5536'],
  'reading-table': ['#b98e60', '#7a5536'],
  'cafe-table': ['#b98e60', '#7a5536'],
  'reception-desk': ['#b98e60', '#7a5536'],
  'cafe-bar': ['#b98e60', '#7a5536'],
  island: ['#d9d4ca', '#9c968c'],
  'kitchen-counter': ['#d9d4ca', '#9c968c'],
  booth: ['#a9cde0', '#5f7480'],
  station: ['#2a3640', '#1f2830'],
  'core-rack': ['#2a2a33', '#1f1f27'],
  bookshelf: ['#6e4a2e', '#5a3b24'],
  'notebook-rack': ['#6e4a2e', '#5a3b24'],
  board: ['#f4f6f8', '#8d939b'],
  fridge: ['#e6e8ea', '#c9cdd1'],
  'coffee-machine': ['#2a2830', '#1e1c24'],
  bench: ['#a77a4e', '#7a5536'],
  elevator: ['#8e959e', '#6d747d'],
  pingpong: ['#2f7a4a', '#1f5a34'],
  arcade: ['#3a2f5a', '#2a2140'],
  'led-wall': ['#141418', '#0c0c10'],
  tv: ['#2f3a4a', '#141218'],
}

/** A procedural ¾ block: the box's top face lifted by its height, the front face below it. */
function drawPlaceholder(
  c: C,
  o: MapObject,
  monitor: string | null,
  lit: boolean,
  clip: PxRect | null,
): void {
  const { x, y, w, h } = o.box
  const accent = ACCENT[o.theme ?? ''] ?? '#8a5a44'
  if (clip) {
    c.save()
    c.beginPath()
    c.rect(clip.x, clip.y, clip.w, clip.h)
    c.clip()
  }
  const H = HEIGHT[o.kind] ?? 3
  const block = (top: string, front: string) => {
    px(c, x - 1, y - H - 1, '#1c1820', w + 2, h + H + 2)
    px(c, x, y - H, top, w, h)
    px(c, x, y + h - H, front, w, H)
    px(c, x, y - H, 'rgba(255,255,255,0.18)', w, 1)
  }
  switch (o.kind) {
    case 'door':
    case 'window':
      break
    case 'rug':
      px(c, x, y, accent, w, h)
      c.globalAlpha = 0.35
      px(c, x + 2, y + 2, '#f4efe4', w - 4, h - 4)
      c.globalAlpha = 1
      px(c, x + 3, y + 3, accent, w - 6, h - 6)
      break
    case 'booth-lamp':
      px(c, x + Math.floor(w / 2) - 2, y - 2, '#1c1820', 4, 4)
      px(c, x + Math.floor(w / 2) - 1, y - 1, lit ? '#3ddc84' : '#7c8590', 2, 2)
      break
    case 'elevator-door':
      px(c, x, y, '#6d747d', w, h)
      px(c, x + Math.floor(w / 2) - 2, y, '#ffd23f', 4, 1)
      break
    case 'plant':
    case 'planter':
      px(c, x + 1, y + h - 4, '#8a5a35', w - 2, 4)
      px(c, x, y - H, '#3f7f3a', w, h + H - 3)
      px(c, x + 2, y - H + 1, '#5ea352', w - 4, Math.max(1, h + H - 7))
      break
    case 'sofa':
    case 'armchair':
    case 'beanbag':
      block(accent, '#00000040')
      px(c, x, y - H, 'rgba(0,0,0,0.25)', w, 2)
      break
    case 'sign':
      px(c, x, y - H, '#1c1820', w, H + h)
      px(c, x + 1, y - H + 1, accent, w - 2, H + h - 2)
      break
    default: {
      const [top, front] = COLORS[o.kind] ?? ['#8a7a66', '#6a5c4c']
      block(top, front)
      if (o.kind === 'desk' && w >= 10) {
        const mx = x + Math.floor(w / 2) - 4
        px(c, mx, y - H - 4, '#2b2b33', 8, 6)
        px(c, mx + 1, y - H - 3, monitor ?? '#3d4a5c', 6, 4)
      } else if (o.kind === 'bookshelf' || o.kind === 'notebook-rack') {
        const spines = ['#c0392b', '#2f6db0', '#3f8f4a', '#d9a33a', '#7a4fa0', '#e0e0d8']
        for (let i = 0; i < w - 2; i += 2)
          px(c, x + 1 + i, y + h - H + 1, spines[(i / 2 + x) % spines.length]!, 1, H - 2)
      } else if (o.kind === 'pingpong') {
        px(c, x, y - H + Math.floor(h / 2), '#f4f6f8', w, 1)
      } else if (o.kind === 'led-wall') {
        for (let i = 2; i < w - 2; i += 4) px(c, x + i, y + h - H + 3, '#3ddc84', 2, 2)
      } else if (o.kind === 'station') {
        px(c, x + 2, y + h - H + 2, '#2cb6a0', w - 4, 3)
      }
    }
  }
  if (clip) c.restore()
}

/** The art's base inside its frame (unrotated source pixels, without the ¾ overhang). */
const footSrc = (a: ObjectFrame) => {
  const [fw, fh] = a.rotated ? [a.footPx[1], a.footPx[0]] : a.footPx
  return {
    sx: a.x + a.ax,
    sy: a.y + a.ay,
    sw: Math.min(fw, a.w - a.ax),
    sh: Math.min(fh, a.h - a.ay),
  }
}

/** One copy of the art with its base's top-left at (x, y); `overhang` adds the ¾ part above it. */
function drawSprite(c: C, a: ObjectFrame, x: number, y: number, overhang: boolean): void {
  const { sx, sy, sw, sh } = footSrc(a)
  if (a.rotated) {
    // Only `s` art for a vertical piece: the base turned 90° clockwise.
    c.save()
    c.translate(x + sh, y)
    c.rotate(Math.PI / 2)
    c.drawImage(a.image, sx, sy, sw, sh, 0, 0, sw, sh)
    c.restore()
  } else if (overhang) c.drawImage(a.image, a.x, a.y, a.w, a.h, x - a.ax, y - a.ay, a.w, a.h)
  else c.drawImage(a.image, sx, sy, sw, sh, x, y, sw, sh)
}

/** A strip: the art repeated along the box's long axis (the last copy is cropped by the clip). */
function drawRepeat(c: C, a: ObjectFrame, b: PxRect): void {
  const [bw, bh] = a.footPx
  if (b.h > b.w) {
    if (bh <= 0) return
    const x = b.x + Math.round((b.w - bw) / 2)
    for (let k = 0; k * bh < b.h; k++) drawSprite(c, a, x, b.y + k * bh, k === 0)
  } else {
    if (bw <= 0) return
    const y = b.y + b.h - bh
    for (let k = 0; k * bw < b.w; k++) drawSprite(c, a, b.x + k * bw, y, true)
  }
}

/** Source → dest spans along one axis: fixed ends, the middle repeated (the last copy cropped). */
function spans(size: number, target: number, ends: [number, number] | undefined) {
  if (!ends || target <= size) return [[0, size, 0]] as [number, number, number][]
  const [a, b] = ends
  const mid = size - a - b
  const out: [number, number, number][] = [[0, a, 0]]
  if (mid > 0)
    for (let d = a; d < target - b; d += mid) out.push([a, Math.min(mid, target - b - d), d])
  out.push([size - b, b, target - b])
  return out.filter(([, len]) => len > 0)
}

/** Art stretched along its box (`stretch` columns / `stretchY` rows): ends kept, middle repeated. */
function drawStretched(c: C, a: ObjectFrame, b: PxRect, longX: boolean, longY: boolean): void {
  const [bw, bh] = a.footPx
  const W = longX ? b.w : a.w
  const H = longY ? b.h + a.ay : a.h
  const x0 = longX ? b.x : b.x + Math.round((b.w - bw) / 2) - a.ax
  const y0 = longY ? b.y - a.ay : b.y + b.h - bh - a.ay
  for (const [sx, sw, dx] of spans(a.w, W, longX ? a.stretch : undefined))
    for (const [sy, sh, dy] of spans(a.h, H, longY ? a.stretchY : undefined))
      c.drawImage(a.image, a.x + sx, a.y + sy, sw, sh, x0 + dx, y0 + dy, sw, sh)
}

/** An area: a 9-slice of the art's base stretched over the whole box (pool, bleachers…). */
function drawArea(c: C, a: ObjectFrame, x: number, y: number, w: number, h: number): void {
  const { sx, sy, sw, sh } = footSrc(a)
  const s = Math.max(
    1,
    Math.min(4, Math.floor(sw / 3), Math.floor(sh / 3), Math.floor(w / 3), Math.floor(h / 3)),
  )
  const cols = [
    [0, s, 0, s],
    [s, sw - 2 * s, s, w - 2 * s],
    [sw - s, s, w - s, s],
  ] as const
  const rows = [
    [0, s, 0, s],
    [s, sh - 2 * s, s, h - 2 * s],
    [sh - s, s, h - s, s],
  ] as const
  for (const [u, uw, dx, dw] of cols)
    for (const [v, vh, dy, dh] of rows)
      if (uw > 0 && vh > 0 && dw > 0 && dh > 0)
        c.drawImage(a.image, sx + u, sy + v, uw, vh, x + dx, y + dy, dw, dh)
}

// ── Walls (thin: a 4 px top strip on the box, a 12 px ¾ face above south-facing runs) ──────────
const HOUSE = { W: '#f2efea', V: '#ddd6cc', U: '#b8ad9f', T: '#3a3436' }
const wallColors = (atlas: Atlas | null, theme?: string) => ({
  W: atlas?.themeColor(theme, 'W') ?? HOUSE.W,
  V: atlas?.themeColor(theme, 'V') ?? HOUSE.V,
  U: atlas?.themeColor(theme, 'U') ?? HOUSE.U,
  T: atlas?.themeColor(theme, 'T') ?? HOUSE.T,
})

const patterns = new WeakMap<Atlas, Map<string, CanvasPattern | null>>()

/** A repeating pattern of the atlas frame `name` (themed first); null when the atlas lacks it. */
function patternOf(c: C, atlas: Atlas | null, name: string, theme?: string): CanvasPattern | null {
  if (!atlas) return null
  let m = patterns.get(atlas)
  if (!m) patterns.set(atlas, (m = new Map()))
  const key = `${name}@${theme ?? ''}`
  if (m.has(key)) return m.get(key)!
  const f = atlas.tileFrame(name, theme)
  let p: CanvasPattern | null = null
  if (f && f.w > 0 && f.h > 0) {
    const cv = document.createElement('canvas')
    cv.width = f.w
    cv.height = f.h
    cv.getContext('2d')?.drawImage(f.image, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h)
    p = c.createPattern(cv, 'repeat')
  }
  m.set(key, p)
  return p
}

/** Fills a rect with an atlas pattern anchored at its top-left; false when there's no frame. */
function fillArt(c: C, atlas: Atlas | null, name: string, theme: string | undefined, r: PxRect) {
  const p = patternOf(c, atlas, name, theme)
  if (!p) return false
  p.setTransform?.(new DOMMatrix([1, 0, 0, 1, r.x, r.y]))
  c.fillStyle = p
  c.fillRect(r.x, r.y, r.w, r.h)
  return true
}

const THIN_DEFAULT = (k: 'wall' | 'glass') => ({
  topH: `${k}/thin-top-h`,
  topV: `${k}/thin-top-v`,
  post: `${k}/thin-post`,
  face: `${k}/thin-face`,
  faceL: `${k}/thin-face-l`,
  faceR: `${k}/thin-face-r`,
})
/** The thin-wall frame names for a wall kind (atlas `tileSets.thinWall`, else the defaults). */
const thinNames = (atlas: Atlas | null, kind: 'solid' | 'glass') =>
  atlas?.raw.tileSets?.thinWall?.[kind] ?? THIN_DEFAULT(kind === 'glass' ? 'glass' : 'wall')

/** One atlas tile frame at (x, y), cropped to `within`; nothing when the atlas lacks it. */
function stamp(
  c: C,
  atlas: Atlas | null,
  name: string,
  theme: string | undefined,
  x: number,
  y: number,
  within: PxRect,
): void {
  const f = atlas?.tileFrame(name, theme)
  if (!f) return
  const w = Math.min(f.w, within.x + within.w - x)
  const h = Math.min(f.h, within.y + within.h - y)
  if (w > 0 && h > 0) c.drawImage(f.image, f.x, f.y, w, h, x, y, w, h)
}

/** Which parts of a wall to draw: its ¾ face, its top strip, or both. */
export type WallPart = 'face' | 'top' | 'all'

/**
 * A wall run (`MapWall`): the thin-wall frames (`wall|glass/thin-top-h|v`, `…/thin-face`), else
 * filled rects in the theme's wall colours. A `face: 's'` wall draws its face above its box.
 */
export function drawWall(c: C, wall: MapWall, atlas: Atlas | null, part: WallPart = 'all'): void {
  const b = wall.box
  const glass = wall.kind === 'glass'
  const names = thinNames(atlas, glass ? 'glass' : 'solid')
  const col = wallColors(atlas, wall.theme)
  if (wall.face === 's' && part !== 'top') {
    const f = { x: b.x, y: b.y - WALL_FACE_PX, w: b.w, h: WALL_FACE_PX }
    if (fillArt(c, atlas, names.face, wall.theme, f)) {
      // End caps at both ends of the run.
      stamp(c, atlas, names.faceL, wall.theme, f.x, f.y, f)
      const r = atlas?.tileFrame(names.faceR, wall.theme)
      if (r) stamp(c, atlas, names.faceR, wall.theme, f.x + f.w - r.w, f.y, f)
    } else {
      if (glass) {
        px(c, f.x, f.y, 'rgba(207,234,243,0.38)', f.w, f.h)
        px(c, f.x, f.y, '#4b7a9b', f.w, 1)
        for (let i = 3; i < f.w - 3; i += 11) {
          px(c, f.x + i, f.y + 3, 'rgba(255,255,255,0.6)', 1, 4)
          px(c, f.x + i + 1, f.y + 2, 'rgba(255,255,255,0.6)', 1, 3)
        }
      } else {
        px(c, f.x, f.y, col.T, f.w, 1)
        px(c, f.x, f.y + 1, col.W, f.w, 2)
        px(c, f.x, f.y + 3, col.V, f.w, f.h - 5)
        px(c, f.x, f.y + f.h - 2, col.U, f.w, 2)
      }
    }
  }
  if (part === 'face') return
  const horizontal = b.w >= b.h
  if (fillArt(c, atlas, horizontal ? names.topH : names.topV, wall.theme, b)) {
    // Posts at both ends (corners and door jambs), when the wall is the post's thickness.
    const post = atlas?.tileFrame(names.post, wall.theme)
    if (post && (horizontal ? post.h === b.h : post.w === b.w)) {
      stamp(c, atlas, names.post, wall.theme, b.x, b.y, b)
      if (horizontal) stamp(c, atlas, names.post, wall.theme, b.x + b.w - post.w, b.y, b)
      else stamp(c, atlas, names.post, wall.theme, b.x, b.y + b.h - post.h, b)
    }
    return
  }
  if (glass) {
    px(c, b.x, b.y, '#4b7a9b', b.w, b.h)
    px(c, b.x + 1, b.y + 1, '#8fc3da', b.w - 2, b.h - 2)
  } else {
    px(c, b.x, b.y, col.T, b.w, b.h)
    px(c, b.x + 1, b.y + 1, col.U, b.w - 2, b.h - 2)
  }
}

/** Debug (`__aoDebug.pixelSolid(true)`): every solid rect in translucent red over the visible map. */
export function drawSolidOverlay(c: C, map: PixelMap, v: ViewRect): void {
  c.fillStyle = 'rgba(255,40,40,0.4)'
  c.strokeStyle = 'rgba(255,40,40,0.9)'
  c.lineWidth = 1
  for (const r of map.solids) {
    if (r.x > v.x + v.w || r.y > v.y + v.h || r.x + r.w < v.x || r.y + r.h < v.y) continue
    c.fillRect(r.x, r.y, r.w, r.h)
    c.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(0, r.w - 1), Math.max(0, r.h - 1))
  }
}
