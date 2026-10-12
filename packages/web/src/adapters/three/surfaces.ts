// Canvas drawing for the capability surfaces (plan §10.6/§10.F): adapter station screens, book
// spines (one atlas per shelf), rule boards and memory notebooks. Plain fillText only: every
// string comes from data and is never parsed as markup. Glyphs are simple vector icons, no logos.
// Text sizes follow the low-spec plan §B4 (readable from the close-up bookmarks); `scale` draws
// every canvas at half resolution on Low and Minimal (§5.3).
import * as THREE from 'three'
import type { BoardVM, BookVM, Glyph, StationVM, SurfaceSlot } from '../../app/capability-vm.ts'

/** One runtime-drawn capability surface of a module instance. */
export interface Surface {
  obj: THREE.Object3D
  mats: THREE.MeshStandardMaterial[]
  /** width / height from extras. */
  aspect: number
  /** Key of what is drawn now (redraw only on change). */
  key: string
  /** Eased glow 0..1. */
  glow: number
}

export const BOOKS_PER_SHELF = 12
const ATLAS_W = 1024
const ATLAS_H = 384
const FONT = 'system-ui, -apple-system, sans-serif'

/** Narrower glyphs where the canvas supports it (spines, notebooks). */
function condensed(c: CanvasRenderingContext2D, on: boolean): void {
  const ctx = c as CanvasRenderingContext2D & { fontStretch?: string }
  if ('fontStretch' in ctx) ctx.fontStretch = on ? 'condensed' : 'normal'
}

/** Relative luminance (0–1) of a #rrggbb colour. */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace('#', '').slice(0, 6), 16)
  if (!Number.isFinite(n)) return 0
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}

/** Light or dark text, whichever contrasts with the background colour. */
const inkOn = (bg: string) => (luminance(bg) > 0.3 ? '#1c1814' : '#fbf6ec')

/** A per-surface canvas texture shown on its own material copies (map + emissive map). */
export function canvasFor(sf: Surface, w: number, h: number, screen = false): THREE.CanvasTexture {
  const m0 = sf.mats[0]!
  const had = m0.userData.canvasTexture as THREE.CanvasTexture | undefined
  const img = had?.image as HTMLCanvasElement | undefined
  if (had && img && img.width === w && img.height === h) return had
  had?.dispose()
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.flipY = false
  tex.anisotropy = 4
  for (const m of sf.mats) {
    m.userData.canvasTexture = tex
    m.userData.instanceOwned = true
    m.map = tex
    m.emissiveMap = tex
    m.emissive.set(0xffffff)
    m.color.set(screen ? 0x000000 : 0xffffff)
    m.needsUpdate = true
  }
  return tex
}

export const accentOrBlue = (activeAdapters: number) => (activeAdapters ? '#5aa9ff' : '#2a3a52')

function fit(c: CanvasRenderingContext2D, text: string, max: number, weight: number, size: number) {
  let s = size
  do c.font = `${weight} ${s--}px ${FONT}`
  while (c.measureText(text).width > max && s > 8)
}

function ellipsize(c: CanvasRenderingContext2D, text: string, max: number): string {
  if (c.measureText(text).width <= max) return text
  let t = text
  while (t.length > 1 && c.measureText(`${t}…`).width > max) t = t.slice(0, -1)
  return `${t}…`
}

/** Word-wraps into at most `lines` lines (the last one ellipsized). */
function wrap(c: CanvasRenderingContext2D, text: string, max: number, lines: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${word}` : word
    if (c.measureText(next).width <= max) cur = next
    else {
      if (cur) out.push(cur)
      cur = word
      if (out.length === lines) break
    }
  }
  if (cur && out.length < lines) out.push(cur)
  if (out.length === lines) out[lines - 1] = ellipsize(c, out[lines - 1]!, max)
  return out
}

function glyph(
  c: CanvasRenderingContext2D,
  g: Glyph,
  x: number,
  y: number,
  s: number,
  color: string,
) {
  c.save()
  c.translate(x, y)
  c.scale(s / 24, s / 24)
  c.strokeStyle = color
  c.fillStyle = color
  c.lineWidth = 2
  c.lineCap = c.lineJoin = 'round'
  c.beginPath()
  switch (g) {
    case 'folder':
      ;(c.moveTo(2, 6),
        c.lineTo(9, 6),
        c.lineTo(11, 8),
        c.lineTo(22, 8),
        c.lineTo(22, 20),
        c.lineTo(2, 20))
      c.closePath()
      break
    case 'terminal':
      ;(c.rect(2, 4, 20, 16), c.moveTo(6, 9), c.lineTo(10, 12), c.lineTo(6, 15), c.moveTo(12, 16))
      c.lineTo(17, 16)
      break
    case 'globe':
      ;(c.arc(12, 12, 10, 0, Math.PI * 2), c.moveTo(2, 12), c.lineTo(22, 12))
      c.ellipse(12, 12, 4.5, 10, 0, 0, Math.PI * 2)
      break
    case 'people':
      ;(c.arc(8, 8, 3.5, 0, Math.PI * 2), c.moveTo(19.5, 9), c.arc(16, 9, 3.5, 0, Math.PI * 2))
      ;(c.moveTo(1, 21),
        c.quadraticCurveTo(8, 11, 15, 21),
        c.moveTo(13, 15),
        c.quadraticCurveTo(17, 12, 23, 20))
      break
    case 'database':
      ;(c.ellipse(12, 5, 9, 3, 0, 0, Math.PI * 2), c.moveTo(3, 5), c.lineTo(3, 19))
      ;(c.ellipse(12, 19, 9, 3, 0, Math.PI, 0, true), c.lineTo(21, 5), c.moveTo(3, 12))
      c.ellipse(12, 12, 9, 3, 0, Math.PI, 0, true)
      break
    case 'braces':
      ;(c.moveTo(9, 3), c.quadraticCurveTo(5, 3, 5, 8), c.quadraticCurveTo(5, 12, 2, 12))
      ;(c.quadraticCurveTo(5, 12, 5, 16), c.quadraticCurveTo(5, 21, 9, 21), c.moveTo(15, 3))
      ;(c.quadraticCurveTo(19, 3, 19, 8),
        c.quadraticCurveTo(19, 12, 22, 12),
        c.quadraticCurveTo(19, 12, 19, 16))
      c.quadraticCurveTo(19, 21, 15, 21)
      break
    default:
      // plug
      ;(c.moveTo(8, 2),
        c.lineTo(8, 7),
        c.moveTo(16, 2),
        c.lineTo(16, 7),
        c.moveTo(5, 7),
        c.lineTo(19, 7))
      ;(c.lineTo(19, 12),
        c.quadraticCurveTo(19, 17, 12, 17),
        c.quadraticCurveTo(5, 17, 5, 12),
        c.closePath())
      ;(c.moveTo(12, 17), c.lineTo(12, 22))
  }
  c.stroke()
  c.restore()
}

/** Holographic kiosk screen: glyph, title, subtitle, "can see", tools, live callers. */
export function drawStation(canvas: HTMLCanvasElement, vm: StationVM | undefined, accent: string) {
  const c = canvas.getContext('2d')!
  const { width: w, height: h } = canvas
  const u = w / 768
  const g = c.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, '#0d1626')
  g.addColorStop(1, '#070b13')
  c.fillStyle = g
  c.fillRect(0, 0, w, h)
  const color = vm?.color ?? accent
  c.fillStyle = color
  c.fillRect(0, 0, w, 6 * u)
  c.textBaseline = 'top'
  if (!vm) {
    c.fillStyle = 'rgba(255,255,255,0.35)'
    c.font = `500 ${30 * u}px ${FONT}`
    c.fillText('Available', 36 * u, 40 * u)
    return
  }
  glyph(c, vm.glyph, 36 * u, 34 * u, 56 * u, color)
  c.fillStyle = '#ffffff'
  fit(c, vm.title, w - 260 * u, 700, 48 * u)
  c.fillText(ellipsize(c, vm.title, w - 260 * u), 112 * u, 32 * u)
  c.fillStyle = 'rgba(255,255,255,0.7)'
  c.font = `500 ${30 * u}px ${FONT}`
  c.fillText(ellipsize(c, vm.subtitle, w - 148 * u), 112 * u, 90 * u)
  if (vm.callers) {
    c.fillStyle = color
    c.font = `600 ${28 * u}px ${FONT}`
    c.textAlign = 'right'
    c.fillText(ellipsize(c, vm.callers, 280 * u), w - 30 * u, 40 * u)
    c.textAlign = 'left'
  }
  // Body lines ≥ 28 px at the 768 px reference width (low-spec plan §B4).
  const bottom = h - 60 * u
  let y = 146 * u
  c.fillStyle = 'rgba(255,255,255,0.5)'
  c.font = `700 ${22 * u}px ${FONT}`
  if (vm.sees.length) {
    c.fillText('CAN SEE', 36 * u, y)
    y += 32 * u
    c.fillStyle = 'rgba(255,255,255,0.88)'
    c.font = `500 ${28 * u}px ${FONT}`
    for (const line of vm.sees) {
      if (y + 30 * u > bottom) break
      c.fillText(ellipsize(c, `· ${line}`, w - 72 * u), 36 * u, y)
      y += 36 * u
    }
  }
  if (vm.tools && y + 70 * u <= bottom) {
    y += 8 * u
    c.fillStyle = 'rgba(255,255,255,0.5)'
    c.font = `700 ${22 * u}px ${FONT}`
    c.fillText('TOOLS', 36 * u, y)
    y += 32 * u
    c.fillStyle = 'rgba(255,255,255,0.88)'
    c.font = `500 ${28 * u}px ${FONT}`
    const room = Math.max(1, Math.min(2, Math.floor((bottom - y) / (36 * u))))
    for (const line of wrap(c, vm.tools, w - 72 * u, room)) {
      c.fillText(line, 36 * u, y)
      y += 36 * u
    }
  }
  c.fillStyle = 'rgba(255,255,255,0.6)'
  c.font = `500 ${26 * u}px ${FONT}`
  c.fillText(
    ellipsize(c, [vm.last, vm.calls].filter(Boolean).join(' · '), w - 72 * u),
    36 * u,
    h - 48 * u,
  )
}

const SCOPE_STRIPE: Record<string, string> = {
  project: '#e8b74a',
  user: '#7fb2ff',
  plugin: '#b794f6',
}

/**
 * Redraws the shelf atlases and points every spine at its slice. `scale` < 1 draws them at a
 * lower resolution (same layout); an atlas of another size is replaced.
 */
export function drawBooks(
  atlases: THREE.CanvasTexture[],
  books: Map<string, Surface>,
  slots: (SurfaceSlot<BookVM> | undefined)[],
  accent: string,
  scale = 1,
): void {
  const shelves = Math.ceil((Math.max(...[...books.keys()].map(Number)) + 1) / BOOKS_PER_SHELF)
  const cw = Math.round(ATLAS_W * scale)
  const ch = Math.round(ATLAS_H * scale)
  for (let i = 0; i < shelves; i++) {
    const had = atlases[i]
    const img = had?.image as HTMLCanvasElement | undefined
    if (had && img && img.width === cw && img.height === ch) continue
    had?.dispose()
    const canvas = document.createElement('canvas')
    canvas.width = cw
    canvas.height = ch
    const t = new THREE.CanvasTexture(canvas)
    t.colorSpace = THREE.SRGBColorSpace
    t.flipY = false
    t.anisotropy = 4
    atlases[i] = t
  }
  const colW = ATLAS_W / BOOKS_PER_SHELF
  for (let i = 0; i < shelves; i++) {
    const c = (atlases[i]!.image as HTMLCanvasElement).getContext('2d')!
    // Draw in reference units (1024 × 384); the transform maps them to the atlas size.
    c.setTransform(cw / ATLAS_W, 0, 0, ch / ATLAS_H, 0, 0)
    c.fillStyle = '#2b2622'
    c.fillRect(0, 0, ATLAS_W, ATLAS_H)
  }
  for (const [ref, sf] of books) {
    const n = Number(ref)
    const shelf = Math.floor(n / BOOKS_PER_SHELF)
    const col = n % BOOKS_PER_SHELF
    const atlas = atlases[shelf]!
    const c = (atlas.image as HTMLCanvasElement).getContext('2d')!
    const x = col * colW
    const vm = slots[n]?.vm
    c.fillStyle = vm?.color ?? '#3a332d'
    c.fillRect(x + 2, 0, colW - 4, ATLAS_H)
    if (vm) {
      // Gilt bands top and bottom, a scope stripe, the name running down the spine.
      c.fillStyle = 'rgba(255,230,170,0.55)'
      c.fillRect(x + 2, 18, colW - 4, 4)
      c.fillRect(x + 2, ATLAS_H - 40, colW - 4, 4)
      c.fillStyle = SCOPE_STRIPE[vm.scope] ?? accent
      c.fillRect(x + 2, ATLAS_H - 28, colW - 4, 14)
      // The name runs down the whole spine between the bands: up to 56 px tall (of the 85 px
      // column), condensed, in light or dark ink by the cover colour (low-spec plan §B4).
      c.save()
      c.translate(x + colW / 2, 26)
      c.rotate(Math.PI / 2)
      c.fillStyle = inkOn(vm.color)
      c.textBaseline = 'middle'
      condensed(c, true)
      const run = ATLAS_H - 76
      fit(c, vm.title, run, 700, 56)
      c.fillText(ellipsize(c, vm.title, run), 0, 0)
      condensed(c, false)
      c.restore()
    }
    for (const m of sf.mats) {
      let t = m.userData.spineTexture as THREE.Texture | undefined
      if (!t || t.source !== atlas.source) {
        t = atlas.clone()
        t.repeat.set(1 / BOOKS_PER_SHELF, 1)
        t.offset.set(col / BOOKS_PER_SHELF, 0)
        m.userData.spineTexture = t
        m.userData.instanceOwned = true
        m.map = t
        m.emissiveMap = t
        m.emissive.set(0xffffff)
        m.color.set(0xffffff)
        m.needsUpdate = true
      }
    }
  }
  for (let i = 0; i < shelves; i++) atlases[i]!.needsUpdate = true
}

/**
 * A framed rule board: title, scope badge, summary and recent reads. Without a rule it is blank,
 * or shows `placard` (board 0 of an empty Library: "No skills or rules yet").
 */
export function drawBoard(
  canvas: HTMLCanvasElement,
  vm: BoardVM | undefined,
  accent: string,
  placard?: string,
) {
  const c = canvas.getContext('2d')!
  const { width: w, height: h } = canvas
  const u = w / 384
  c.fillStyle = '#f4efe4'
  c.fillRect(0, 0, w, h)
  c.strokeStyle = 'rgba(60,45,30,0.25)'
  c.lineWidth = 6 * u
  c.strokeRect(10 * u, 10 * u, w - 20 * u, h - 20 * u)
  if (!vm) {
    if (!placard) return
    c.fillStyle = '#6b5f52'
    c.textBaseline = 'top'
    c.font = `600 ${46 * u}px ${FONT}`
    let py = h * 0.32
    for (const line of wrap(c, placard, w - 70 * u, 4)) {
      c.fillText(line, 35 * u, py)
      py += 56 * u
    }
    return
  }
  c.textBaseline = 'top'
  let y = 34 * u
  if (vm.scope) {
    c.font = `700 ${14 * u}px ${FONT}`
    const bw = c.measureText(vm.scope).width + 18 * u
    c.fillStyle = vm.scope === 'USER' ? '#7fb2ff' : accent
    c.fillRect(28 * u, y, bw, 24 * u)
    c.fillStyle = '#ffffff'
    c.fillText(vm.scope, 37 * u, y + 5 * u)
    y += 40 * u
  }
  // Title at twice the old size, two lines at most (low-spec plan §B4).
  c.fillStyle = '#2a241d'
  fit(c, vm.title, (w - 56 * u) * 2, 700, 60 * u)
  for (const line of wrap(c, vm.title, w - 56 * u, 2)) {
    c.fillText(line, 28 * u, y)
    y += c.measureText('M').width * 1.25 + 6 * u
  }
  y += 10 * u
  c.fillStyle = '#4d443a'
  c.font = `400 ${21 * u}px ${FONT}`
  const lines = Math.max(0, Math.floor((h - 84 * u - y) / (27 * u)))
  for (const line of lines ? wrap(c, vm.summary, w - 56 * u, lines) : []) {
    c.fillText(line, 28 * u, y)
    y += 27 * u
  }
  c.fillStyle = '#7a6e60'
  c.font = `500 ${18 * u}px ${FONT}`
  c.fillText(ellipsize(c, vm.uses, w - 56 * u), 28 * u, h - 70 * u)
  c.fillText(ellipsize(c, vm.last, w - 56 * u), 28 * u, h - 46 * u)
}

/** Reference width of a notebook cover canvas; drawing is in these units. */
const NOTEBOOK_W = 128

/** A memory notebook's cover label: twice the old size, on a lighter cover (low-spec plan §B4). */
export function drawNotebook(canvas: HTMLCanvasElement, title: string | undefined, accent: string) {
  const c = canvas.getContext('2d')!
  const k = canvas.width / NOTEBOOK_W
  c.setTransform(k, 0, 0, k, 0, 0)
  const w = NOTEBOOK_W
  const h = canvas.height / k
  c.fillStyle = title ? '#5e9474' : '#3a3f3c'
  c.fillRect(0, 0, w, h)
  c.fillStyle = accent
  c.fillRect(0, 0, 10, h)
  if (!title) return
  c.fillStyle = '#f6f4ec'
  c.fillRect(16, h * 0.16, w - 24, h * 0.68)
  c.fillStyle = '#1f1e1b'
  c.textBaseline = 'top'
  condensed(c, true)
  fit(c, title, (w - 34) * 1.6, 700, 30)
  const lh = c.measureText('M').width * 1.3
  let y = h * 0.16 + 6
  for (const line of wrap(c, title, w - 34, Math.max(1, Math.floor((h * 0.68 - 8) / lh)))) {
    c.fillText(line, 22, y)
    y += lh
  }
  condensed(c, false)
}
