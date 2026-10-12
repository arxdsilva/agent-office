// Small pixel effects drawn in world px: shadows, status icons, selection, the player marker,
// link beams (adapters: dashes) and page sparkles (skills and rules), plus placeholder furniture.
import { STATUS_COLORS } from '@agent-office/shared'
import { drawBounds } from '../../app/pixel/map.ts'
import { TILE_PX, type MapObject, type PixelMap, type StatusIcon } from '../../app/pixel/types.ts'
import type { ViewRect } from './renderer.ts'
import type { Atlas, ObjectFrame } from './sprites.ts'

type C = CanvasRenderingContext2D

const px = (c: C, x: number, y: number, col: string, w = 1, h = 1) => {
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

const ACCENT: Record<string, string> = {
  terracotta: '#c0623f',
  nordic: '#6f8fa8',
  forest: '#4f7f4a',
  ocean: '#3f78a8',
  neon: '#9b5bd0',
  brass: '#b08a3e',
}

/** Kinds drawn under everything (flat on the floor). */
export const FLAT_KINDS = new Set(['rug', 'door', 'window', 'elevator-door'])

/**
 * Procedural furniture until the atlas lands: a top face plus a darker front face for tall pieces
 * (the GBA ¾ look). `monitor`: a desk's status colour; `lit`: a booth lamp in use.
 */
export function drawObject(
  c: C,
  o: MapObject,
  monitor: string | null,
  highlight: boolean,
  lit = false,
  atlas: Atlas | null = null,
): void {
  const x = o.rect.tx * TILE_PX
  const y = o.rect.ty * TILE_PX
  const w = o.rect.tw * TILE_PX
  const h = o.rect.th * TILE_PX
  // Atlas art (plan §1.5), drawn by fill and clipped to the rect plus one tile of ¾ overhang, so
  // what's drawn is what blocks and wall-mounted art never crosses its wall.
  const named =
    o.kind === 'booth-lamp'
      ? lit
        ? 'on'
        : 'off'
      : o.kind === 'elevator-door'
        ? 'closed'
        : undefined
  const art = atlas?.object(o.kind, o.theme, o.facing, o.orientation, named)
  if (art) {
    const b = drawBounds(o)
    c.save()
    c.beginPath()
    c.rect(b.tx * TILE_PX, b.ty * TILE_PX, b.tw * TILE_PX, b.th * TILE_PX)
    c.clip()
    if (o.fill === 'area') drawArea(c, art, x, y, w, h)
    else if (o.fill === 'repeat') drawRepeat(c, art, x, y, w, h)
    else drawSprite(c, art, x, y, true)
    c.restore()
    if (monitor && o.kind === 'desk') px(c, x + Math.floor(w / 2) - 3, y + 3, monitor, 6, 3)
    if (highlight) {
      c.strokeStyle = '#ffd166'
      c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
    }
    return
  }
  const accent = ACCENT[o.theme ?? ''] ?? '#8a5a44'
  /** Top colour, front colour, front height (px), outline. */
  const box = (top: string, front: string, fh: number, inset = 1) => {
    px(c, x + inset - 1, y + inset - 1, '#1c1820', w - 2 * inset + 2, h - 2 * inset + 2)
    px(c, x + inset, y + inset, top, w - 2 * inset, h - 2 * inset - fh)
    if (fh > 0) px(c, x + inset, y + h - inset - fh, front, w - 2 * inset, fh)
    px(c, x + inset, y + inset, 'rgba(255,255,255,0.18)', w - 2 * inset, 1)
  }
  switch (o.kind) {
    case 'door':
    case 'window':
      break
    case 'rug':
      px(c, x + 1, y + 1, accent, w - 2, h - 2)
      c.globalAlpha = 0.35
      px(c, x + 3, y + 3, '#f4efe4', w - 6, h - 6)
      c.globalAlpha = 1
      px(c, x + 5, y + 5, accent, w - 10, h - 10)
      break
    case 'desk':
      box('#a77a4e', '#7a5536', 4)
      if (w >= 12 && h >= 10) {
        const mx = x + Math.floor(w / 2) - 5
        px(c, mx, y + 2, '#2b2b33', 10, 6)
        px(c, mx + 1, y + 3, monitor ?? '#3d4a5c', 8, 4)
      }
      break
    case 'chair':
      px(c, x + 3, y + 3, '#1c1820', w - 6, h - 6)
      px(c, x + 4, y + 4, '#4a4e5a', w - 8, h - 8)
      px(c, x + 4, y + 4, '#5e6372', w - 8, 2)
      break
    case 'meeting-table':
    case 'reading-table':
    case 'cafe-table':
    case 'island':
    case 'kitchen-counter':
    case 'reception-desk':
    case 'cafe-bar':
      box(o.kind === 'kitchen-counter' || o.kind === 'island' ? '#d9d4ca' : '#b98e60', '#7a5536', 3)
      break
    case 'booth':
      px(c, x, y, '#5f7480', w, h)
      px(c, x + 1, y + 1, 'rgba(169,205,224,0.55)', w - 2, h - 2)
      break
    case 'booth-lamp':
      px(c, x + 6, y + 6, '#1c1820', 5, 5)
      px(c, x + 7, y + 7, lit ? '#3ddc84' : '#7c8590', 3, 3)
      break
    case 'station':
      box('#2a3640', '#1f2830', 5)
      px(c, x + 3, y + 3, '#2cb6a0', Math.max(2, w - 6), 3)
      break
    case 'core-rack':
      box('#2a2a33', '#1f1f27', 6)
      for (let i = 0; i < w - 6; i += 3) px(c, x + 3 + i, y + h - 5, i % 2 ? '#2cb6a0' : '#ffd23f')
      break
    case 'bookshelf':
    case 'notebook-rack': {
      box('#6e4a2e', '#5a3b24', Math.min(10, h - 4))
      const spines = ['#c0392b', '#2f6db0', '#3f8f4a', '#d9a33a', '#7a4fa0', '#e0e0d8']
      for (let i = 0; i < w - 4; i += 2)
        px(
          c,
          x + 2 + i,
          y + h - Math.min(10, h - 4) + 1,
          spines[(i / 2 + o.rect.tx) % spines.length]!,
          1,
          Math.min(8, h - 6),
        )
      break
    }
    case 'board':
      box('#8d939b', '#6d737b', 2)
      px(c, x + 2, y + 2, '#f4f6f8', w - 4, h - 6)
      px(c, x + 4, y + 4, '#2f6db0', Math.max(2, w - 10), 1)
      break
    case 'sofa':
    case 'armchair':
    case 'beanbag':
      box(accent, '#00000000', 0)
      px(c, x + 1, y + 1, 'rgba(0,0,0,0.25)', w - 2, 4)
      break
    case 'fridge':
      box('#e6e8ea', '#c9cdd1', Math.floor(h / 2))
      break
    case 'coffee-machine':
      box('#2a2830', '#1e1c24', 4)
      px(c, x + w / 2, y + 4, '#c0392b')
      break
    case 'plant':
    case 'planter':
      px(c, x + 3, y + h - 6, '#8a5a35', w - 6, 5)
      px(c, x + 2, y + 1, '#3f7f3a', w - 4, h - 6)
      px(c, x + 4, y + 2, '#5ea352', w - 8, Math.max(1, h - 10))
      break
    case 'bench':
      box('#a77a4e', '#7a5536', 2)
      for (let i = 3; i < h - 3; i += 3) px(c, x + 2, y + i, '#8a6340', w - 4, 1)
      break
    case 'elevator':
      box('#8e959e', '#6d747d', 4)
      for (let i = 0; i < w; i += 32) px(c, x + i + 15, y + 1, '#5a6068', 1, h - 6)
      break
    case 'elevator-door':
      px(c, x + 6, y + 13, '#ffd23f', 4, 1)
      break
    case 'pingpong':
      box('#2f7a4a', '#1f5a34', 2)
      px(c, x + 1, y + Math.floor(h / 2), '#f4f6f8', w - 2, 1)
      px(c, x + Math.floor(w / 2), y + 1, '#d0d4d8', 1, h - 4)
      break
    case 'arcade':
      box('#3a2f5a', '#2a2140', 6)
      px(c, x + 3, y + 3, '#7fb2ff', w - 6, 3)
      break
    case 'led-wall':
      box('#141418', '#0c0c10', 3)
      for (let i = 4; i < w - 4; i += 4) px(c, x + i, y + 4, '#3ddc84', 2, 2)
      break
    case 'tv':
      box('#1e1c24', '#141218', 2)
      px(c, x + 2, y + 2, monitor ?? '#2f3a4a', w - 4, Math.max(1, h - 6))
      break
    case 'sign':
      px(c, x + 2, y + h / 2 - 2, '#1c1820', w - 4, 5)
      px(c, x + 3, y + h / 2 - 1, accent, w - 6, 3)
      break
    default:
      box('#8a7a66', '#6a5c4c', 3)
  }
  if (highlight) {
    c.strokeStyle = '#ffd166'
    c.lineWidth = 1
    c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
  }
}

/** The art's footprint inside its frame (unrotated source pixels, without the ¾ overhang). */
const footSrc = (a: ObjectFrame) => {
  const [fw, fh] = a.rotated ? [a.foot[1], a.foot[0]] : a.foot
  return {
    sx: a.x + a.ax,
    sy: a.y + a.ay,
    sw: Math.min(fw * TILE_PX, a.w - a.ax),
    sh: Math.min(fh * TILE_PX, a.h - a.ay),
  }
}

/** One copy of the art with its footprint at (x, y); `overhang` adds the ¾ part above it. */
function drawSprite(c: C, a: ObjectFrame, x: number, y: number, overhang: boolean): void {
  const { sx, sy, sw, sh } = footSrc(a)
  if (a.rotated) {
    // Only `s` art for a vertical piece: the footprint turned 90° clockwise.
    c.save()
    c.translate(x + sh, y)
    c.rotate(Math.PI / 2)
    c.drawImage(a.image, sx, sy, sw, sh, 0, 0, sw, sh)
    c.restore()
  } else if (overhang) c.drawImage(a.image, a.x, a.y, a.w, a.h, x - a.ax, y - a.ay, a.w, a.h)
  else c.drawImage(a.image, sx, sy, sw, sh, x, y, sw, sh)
}

/** A strip: the art repeated along the rect's long axis (the last copy is cropped by the clip). */
function drawRepeat(c: C, a: ObjectFrame, x: number, y: number, w: number, h: number): void {
  const step = (h > w ? a.foot[1] : a.foot[0]) * TILE_PX
  if (step <= 0) return
  if (h > w) for (let k = 0; k * step < h; k++) drawSprite(c, a, x, y + k * step, k === 0)
  else for (let k = 0; k * step < w; k++) drawSprite(c, a, x + k * step, y, true)
}

/** An area: a 9-slice of the art's footprint stretched over the whole rect (pool, bleachers…). */
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

/** Debug (`__aoDebug.pixelSolid(true)`): the solid grid in translucent red over the visible map. */
export function drawSolidOverlay(c: C, map: PixelMap, v: ViewRect): void {
  c.fillStyle = 'rgba(255,40,40,0.4)'
  const x0 = Math.max(0, Math.floor(v.x / TILE_PX))
  const y0 = Math.max(0, Math.floor(v.y / TILE_PX))
  const x1 = Math.min(map.widthTiles, Math.ceil((v.x + v.w) / TILE_PX))
  const y1 = Math.min(map.heightTiles, Math.ceil((v.y + v.h) / TILE_PX))
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      if (map.solid[y * map.widthTiles + x]) c.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX)
}
