#!/usr/bin/env node
// Pixel-art atlas build for the optional 2D RPG mode (docs/graphics-contract.md §12, docs/pixel-style.md).
//
//   node assets/pixel/build.mjs            → packages/web/public/assets/pixel/{tiles,objects,characters,effects,font,ui}.png
//                                            + frame.png (the 9-slice UI frame alone, for CSS border-image) + atlas.json
//                                            + assets/pixel/previews/*.png (4× review sheets)
//   node assets/pixel/build.mjs --no-previews
//
// Sources are text pixel grids (`.px`): one character per pixel, keys from src/palettes.json. Everything here is
// deterministic: the same sources give the same bytes (no timestamps, fixed packing order, fixed zlib settings).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '../..')
export const SRC = join(HERE, 'src')
export const OUT = join(ROOT, 'packages/web/public/assets/pixel')
export const PREVIEWS = join(HERE, 'previews')
export const BUDGET_BYTES = 2 * 1024 * 1024
export const TILE = 16
export const CHAR_W = 16
export const CHAR_H = 24
export const DIRS = ['s', 'n', 'e', 'w']

// ── Contract lists, read from the renderer's pure types so the atlas can never drift from them ──────
function constList(name) {
  const ts = readFileSync(join(ROOT, 'packages/web/src/app/pixel/types.ts'), 'utf8')
  const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(ts)
  if (!m) throw new Error(`types.ts: ${name} not found`)
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}
export const FURNITURE_KINDS = constList('FURNITURE_KINDS')
export const PIXEL_ANIMS = constList('PIXEL_ANIMS')
export const EXTRA_OBJECTS = ['door', 'window', 'booth-lamp', 'elevator-door', 'stats-board']
export const REQUIRED_EFFECTS = [
  'thinking',
  'gear',
  'bang',
  'cross',
  'sparkle',
  'page',
  'beam',
  'prompt-e',
  'booth-glow',
  'marker',
  'shadow',
  'select',
]
export const REQUIRED_TILES = [
  'floor/wood',
  'floor/parquet',
  'floor/carpet',
  'floor/tile',
  'floor/concrete',
  'floor/terrazzo',
  'floor/path',
  'floor/grass',
  'floor/elevator',
  'wall/top',
  'wall/face-hi',
  'wall/face-lo',
  'wall/window-hi',
  'wall/window-lo',
  'glass/top',
  'glass/face-hi',
  'glass/face-lo',
  'curtain/face-hi',
  'curtain/face-lo',
  'stairs/up',
  'shade/n',
  'rug/c',
  'wall/thin-top-h',
  'wall/thin-top-v',
  'wall/thin-post',
  'wall/thin-face',
  'glass/thin-top-h',
  'glass/thin-top-v',
  'glass/thin-post',
  'glass/thin-face',
]
/** Thin walls at 16 px/m (docs/pixel-style.md §Scale): 4 px tops (16 px pieces), a 12 px face, posts and face caps. */
export const THIN_WALLS = Object.fromEntries(
  ['wall', 'glass'].map((k) => [
    k === 'wall' ? 'solid' : 'glass',
    {
      topH: `${k}/thin-top-h`,
      topV: `${k}/thin-top-v`,
      post: `${k}/thin-post`,
      face: `${k}/thin-face`,
      faceL: `${k}/thin-face-l`,
      faceR: `${k}/thin-face-r`,
    },
  ]),
)
export const PX_PER_METRE = 16
/** Extra glyphs beyond ASCII 32–126. */
export const EXTRA_GLYPHS = ['·', '→', '✓', '…', '✖', '⚙', '▶', '▼', '←', '↑', '↓', '♥', '★', '•']

// ── Palettes ───────────────────────────────────────────────────────────────────────────────────────
export function loadPalettes() {
  return JSON.parse(readFileSync(join(SRC, 'palettes.json'), 'utf8'))
}
export function hexToRgba(hex) {
  if (hex == null) return [0, 0, 0, 0]
  const h = hex.replace('#', '')
  const n = (i) => parseInt(h.slice(i, i + 2), 16)
  return [n(0), n(2), n(4), h.length >= 8 ? n(6) : 255]
}
const THEME_KEYS = ['F', 'G', 'H', 'W', 'V', 'U', 'A', 'B', 'C', 'R', 'T']

// ── .px parser ─────────────────────────────────────────────────────────────────────────────────────
// Syntax:
//   # comment                       (a line whose first character is '#')
//   @frame <name> [k=v …]           starts a frame; attributes: ax, ay, ms, from, flip=x|y, dx, dy
//   @meta {json}                    metadata for the current frame
//   @glyph <char|U+XXXX|space>      font files: starts a glyph
//   rows…                           one character per pixel
// A frame with `from=` and no rows copies (and optionally flips/shifts) another frame of the same file.
export function parsePx(text, file = '<px>') {
  const frames = []
  let cur = null
  const lines = text.split(/\r?\n/)
  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '')
    const where = `${file}:${i + 1}`
    if (line === '' || line.startsWith('#')) return
    if (line.startsWith('@frame ') || line.startsWith('@glyph ')) {
      const parts = line.split(/\s+/)
      const attrs = {}
      for (const p of parts.slice(2)) {
        const eq = p.indexOf('=')
        if (eq < 0) throw new Error(`${where}: bad attribute "${p}"`)
        attrs[p.slice(0, eq)] = p.slice(eq + 1)
      }
      let name = parts[1]
      if (line.startsWith('@glyph ')) {
        name = name === 'space' ? ' ' : name.startsWith('U+') ? String.fromCodePoint(parseInt(name.slice(2), 16)) : name
        attrs.glyph = '1'
      }
      if (!name) throw new Error(`${where}: frame without a name`)
      if (frames.some((f) => f.name === name)) throw new Error(`${where}: duplicate frame "${name}"`)
      cur = { name, attrs, meta: {}, rows: [], file, line: i + 1 }
      frames.push(cur)
      return
    }
    if (line.startsWith('@meta ')) {
      if (!cur) throw new Error(`${where}: @meta before @frame`)
      try {
        Object.assign(cur.meta, JSON.parse(line.slice(6)))
      } catch (e) {
        throw new Error(`${where}: bad @meta JSON (${e.message})`)
      }
      return
    }
    if (line.startsWith('@')) throw new Error(`${where}: unknown directive "${line.split(' ')[0]}"`)
    if (!cur) throw new Error(`${where}: pixel row before @frame`)
    cur.rows.push(line)
  })
  for (const f of frames) {
    if (f.attrs.from) {
      if (f.rows.length) throw new Error(`${file}: frame "${f.name}" has both from= and rows`)
      const src = frames.find((g) => g.name === f.attrs.from)
      if (!src) throw new Error(`${file}: frame "${f.name}" copies unknown "${f.attrs.from}"`)
      if (src.attrs.from) throw new Error(`${file}: frame "${f.name}" copies a copy ("${src.name}")`)
      f.rows = transformRows(src.rows, f.attrs)
      f.meta = { ...src.meta, ...f.meta }
      const { from: _a, flip: _b, dx: _c, dy: _d, wrap: _e, edgeL: _f, edgeR: _g, edgeT: _h, edgeB: _i, ...inherited } = src.attrs
      f.attrs = { ...inherited, ...f.attrs }
      if (f.attrs.flip === 'x' && Array.isArray(f.meta.hand)) f.meta.hand = [src.rows[0].length - 1 - f.meta.hand[0], f.meta.hand[1]]
    }
    if (!f.rows.length) throw new Error(`${file}: frame "${f.name}" is empty`)
    const w = f.rows[0].length
    f.rows.forEach((r, k) => {
      if (r.length !== w)
        throw new Error(`${file}:${f.line}: frame "${f.name}" row ${k} is ${r.length} wide, expected ${w}`)
    })
    f.w = w
    f.h = f.rows.length
  }
  return frames
}

export function transformRows(rows, { flip, dx, dy, wrap, edgeL, edgeR, edgeT, edgeB } = {}) {
  let out = rows.slice()
  if (flip === 'x') out = out.map((r) => [...r].reverse().join(''))
  if (flip === 'y') out = out.slice().reverse()
  const sx = Number(dx ?? 0)
  const sy = Number(dy ?? 0)
  if (sx || sy) {
    const w = out[0].length
    const h = out.length
    const g = Array.from({ length: h }, (_, y) =>
      Array.from({ length: w }, (_, x) => {
        let yy = y - sy
        let xx = x - sx
        if (wrap) {
          yy = ((yy % h) + h) % h
          xx = ((xx % w) + w) % w
        }
        return yy >= 0 && yy < h && xx >= 0 && xx < w ? out[yy][xx] : '.'
      }).join(''),
    )
    out = g
  }
  // Edge lines (e.g. the end cap of a wall face beside a doorway): edgeL=k paints column 0 with key k.
  const paint = (r, x, k) => (r[x] === '.' ? r : r.slice(0, x) + k + r.slice(x + 1))
  if (edgeL) out = out.map((r) => paint(r, 0, edgeL))
  if (edgeR) out = out.map((r) => paint(r, r.length - 1, edgeR))
  if (edgeT) out[0] = [...out[0]].map((c) => (c === '.' ? c : edgeT)).join('')
  if (edgeB) out[out.length - 1] = [...out[out.length - 1]].map((c) => (c === '.' ? c : edgeB)).join('')
  return out
}

export function readPxDir(dir) {
  const abs = join(SRC, dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs)
    .filter((f) => f.endsWith('.px'))
    .sort()
    .flatMap((f) => parsePx(readFileSync(join(abs, f), 'utf8'), `${dir}/${f}`))
}

// ── RGBA images ────────────────────────────────────────────────────────────────────────────────────
export function image(w, h) {
  return { w, h, data: new Uint8Array(w * h * 4) }
}
export function fill(img, x0, y0, w, h, rgba) {
  for (let y = Math.max(0, y0); y < Math.min(img.h, y0 + h); y++)
    for (let x = Math.max(0, x0); x < Math.min(img.w, x0 + w); x++) img.data.set(rgba, (y * img.w + x) * 4)
}
/** Alpha-composites `src` (or a sub-rect) onto `dst`. */
export function blit(dst, src, dx, dy, { sx = 0, sy = 0, w = src.w, h = src.h, flipX = false, scale = 1, alpha = 1 } = {}) {
  for (let y = 0; y < h * scale; y++) {
    const ty = dy + y
    if (ty < 0 || ty >= dst.h) continue
    for (let x = 0; x < w * scale; x++) {
      const tx = dx + x
      if (tx < 0 || tx >= dst.w) continue
      const lx = Math.floor(x / scale)
      const ux = sx + (flipX ? w - 1 - lx : lx)
      const uy = sy + Math.floor(y / scale)
      const si = (uy * src.w + ux) * 4
      const a = (src.data[si + 3] / 255) * alpha
      if (a === 0) continue
      const di = (ty * dst.w + tx) * 4
      const da = dst.data[di + 3] / 255
      const oa = a + da * (1 - a)
      for (let c = 0; c < 3; c++)
        dst.data[di + c] = Math.round((src.data[si + c] * a + dst.data[di + c] * da * (1 - a)) / oa)
      dst.data[di + 3] = Math.round(oa * 255)
    }
  }
}
export function rowsToImage(rows, colorOf) {
  const img = image(rows[0].length, rows.length)
  rows.forEach((r, y) => {
    for (let x = 0; x < r.length; x++) {
      const c = colorOf(r[x], x, y)
      if (c) img.data.set(c, (y * img.w + x) * 4)
    }
  })
  return img
}
const isEmpty = (img) => {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i]) return false
  return true
}

// ── PNG (RGBA8, filter 0, zlib level 9: deterministic) ────────────────────────────────────────────
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
export function encodePng(img) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(img.w, 0)
  ihdr.writeUInt32BE(img.h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((img.w * 4 + 1) * img.h)
  for (let y = 0; y < img.h; y++) {
    raw[y * (img.w * 4 + 1)] = 0
    Buffer.from(img.data.buffer, img.data.byteOffset + y * img.w * 4, img.w * 4).copy(raw, y * (img.w * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9, memLevel: 9, strategy: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── Packing (shelf, deterministic) ─────────────────────────────────────────────────────────────────
export function pack(entries, width, pad = 0) {
  const sorted = entries.slice().sort((a, b) => b.img.h - a.img.h || b.img.w - a.img.w || (a.key < b.key ? -1 : 1))
  let x = 0
  let y = 0
  let rowH = 0
  for (const e of sorted) {
    if (e.img.w > width) throw new Error(`frame ${e.key} (${e.img.w}px) wider than its sheet (${width}px)`)
    if (x + e.img.w > width) {
      y += rowH + pad
      x = 0
      rowH = 0
    }
    e.x = x
    e.y = y
    x += e.img.w + pad
    rowH = Math.max(rowH, e.img.h)
  }
  const h = Math.max(8, Math.ceil((y + rowH) / 8) * 8)
  const sheet = image(width, h)
  for (const e of sorted) blit(sheet, e.img, e.x, e.y)
  return { sheet, entries: sorted }
}

// ── Colour resolvers ───────────────────────────────────────────────────────────────────────────────
function officeColor(pal, theme, where) {
  const cache = new Map()
  return (ch) => {
    if (ch === '.') return null
    if (cache.has(ch)) return cache.get(ch)
    let hex
    if (THEME_KEYS.includes(ch)) hex = pal.themes[theme ?? 'house'][ch]
    else if (ch in pal.office) hex = pal.office[ch]
    else throw new Error(`${where}: unknown palette key "${ch}"`)
    const c = hex == null ? null : hexToRgba(hex)
    cache.set(ch, c)
    return c
  }
}
const usesTheme = (rows) => rows.some((r) => [...r].some((c) => THEME_KEYS.includes(c)))
export const THEMES = ['house', 'terracotta', 'nordic', 'forest', 'ocean', 'neon', 'brass']

/** Validates every key of a frame against a palette; throws with file:line. */
export function checkKeys(frame, allowed) {
  frame.rows.forEach((r, k) => {
    for (const c of r)
      if (!allowed.has(c)) throw new Error(`${frame.file}:${frame.line}: frame "${frame.name}" row ${k}: unknown palette key "${c}"`)
  })
}

// ── Wall-top autotiling: 16 masks (bit set = connected to another wall tile: N=1 E=2 S=4 W=8) ───────
export function autotileRows(rows, mask, edge = 'k', lip = null) {
  const g = rows.map((r) => [...r])
  const n = g.length
  if (!(mask & 1)) for (let x = 0; x < n; x++) g[0][x] = edge
  if (!(mask & 4)) for (let x = 0; x < n; x++) (g[n - 1][x] = edge), lip && (g[n - 2][x] = lip)
  if (!(mask & 8)) for (let y = 0; y < n; y++) g[y][0] = edge
  if (!(mask & 2)) for (let y = 0; y < n; y++) g[y][n - 1] = edge
  return g.map((r) => r.join(''))
}

// ── Characters ─────────────────────────────────────────────────────────────────────────────────────
// Parts are authored in src/characters/*.px with the `char` palette; anims.json defines poses (which parts,
// offsets) and animations. A pose is composed per direction (w = e mirrored), then split into disjoint layers
// (body/shirt/pants/shoes) plus overlays (hair, glasses, headset, cap, jacket, badge) masked under the arms.
export const CHAR_LAYERS = [
  'body',
  'shoes',
  'pants',
  'shirt',
  'jacket',
  'badge',
  'hair-a',
  'hair-b',
  'hair-c',
  'hair-d',
  'glasses',
  'headset',
  'cap',
]
export const LAYER_RECOLOR = {
  body: 'skin',
  shoes: 'shoes',
  pants: 'pants',
  shirt: 'shirt',
  jacket: 'jacket',
  badge: 'badge',
  'hair-a': 'hair',
  'hair-b': 'hair',
  'hair-c': 'hair',
  'hair-d': 'hair',
  cap: 'outfit',
  glasses: null,
  headset: null,
}
const HEAD_OVERLAYS = ['hair-a', 'hair-b', 'hair-c', 'hair-d', 'glasses', 'headset', 'cap']
const TORSO_OVERLAYS = ['jacket', 'badge']

function partIndex(frames) {
  const m = new Map(frames.map((f) => [f.name, f]))
  return m
}
function findPart(parts, kind, name, dir, { optional = false, fallback = null } = {}) {
  const tries = [`${kind}-${name}-${dir}`, `${kind}-${name}`]
  if (fallback) tries.push(`${kind}-${fallback}-${dir}`, `${kind}-${fallback}`)
  for (const t of tries) if (parts.has(t)) return parts.get(t)
  if (optional) return null
  throw new Error(`characters: missing part ${tries[0]}`)
}

/** Outline ownership: each 'o' takes the group of the nearest non-outline pixel of the same part. */
function partGroups(part, pal) {
  const groups = pal.charGroups
  const h = part.h
  const w = part.w
  const out = Array.from({ length: h }, () => Array(w).fill(null))
  const queue = []
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = part.rows[y][x]
      if (c !== '.' && c !== 'o' && groups[c]) {
        out[y][x] = groups[c]
        queue.push([x, y])
      }
    }
  for (let qi = 0; qi < queue.length; qi++) {
    const [x, y] = queue[qi]
    for (const [ddx, ddy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ]) {
      const nx = x + ddx
      const ny = y + ddy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      if (out[ny][nx] || part.rows[ny][nx] !== 'o') continue
      out[ny][nx] = out[y][x]
      queue.push([nx, ny])
    }
  }
  return out
}

function charColor(pal, ch, where) {
  const v = pal.char[ch]
  if (v === undefined) throw new Error(`${where}: unknown character key "${ch}"`)
  if (v === null) return null
  if (typeof v === 'number') return hexToRgba(pal.recolorSource[v])
  return hexToRgba(v)
}

export function composeCharacters(pal, frames, anims) {
  const parts = partIndex(frames)
  for (const f of frames) checkKeys(f, new Set(Object.keys(pal.char)))
  const out = [] // {key, img}
  const poses = {}
  const used = new Set()
  for (const [poseName, pose] of Object.entries(anims.poses)) {
    for (const dir of DIRS) {
      const d = dir === 'w' ? 'e' : dir
      const dy = pose.dy ?? 0
      const grid = Array.from({ length: CHAR_H }, () => Array(CHAR_W).fill(null)) // {ch, group}
      const armMask = Array.from({ length: CHAR_H }, () => Array(CHAR_W).fill(false))
      const stamp = (part, ox, oy, mask = null) => {
        used.add(part.name)
        const g = partGroups(part, pal)
        for (let y = 0; y < part.h; y++)
          for (let x = 0; x < part.w; x++) {
            const ch = part.rows[y][x]
            const tx = ox + x
            const ty = oy + y
            if (ch === '.' || tx < 0 || ty < 0 || tx >= CHAR_W || ty >= CHAR_H) continue
            grid[ty][tx] = { ch, group: g[y][x] ?? 'body' }
            if (mask) mask[ty][tx] = true
          }
      }
      const body = findPart(parts, 'body', pose.body, d)
      const head = findPart(parts, 'head', pose.head ?? 'base', d, { fallback: 'base' })
      const arms = findPart(parts, 'arms', pose.arms, d)
      const armsY = 10 + dy + (pose.armsDy ?? 0) + Number(arms.attrs.oy ?? 0)
      const order = pose.headOverArms ? ['body', 'arms', 'head'] : ['body', 'head', 'arms']
      for (const o of order) {
        if (o === 'body') stamp(body, 0, 11)
        if (o === 'head') stamp(head, 0, dy)
        if (o === 'arms') stamp(arms, 0, armsY, armMask)
      }
      const key = `${poseName}-${dir}`
      const flip = dir === 'w'
      const layerImgs = {}
      for (const layer of ['body', 'shoes', 'pants', 'shirt']) {
        const img = image(CHAR_W, CHAR_H)
        for (let y = 0; y < CHAR_H; y++)
          for (let x = 0; x < CHAR_W; x++) {
            const p = grid[y][x]
            if (!p || p.group !== layer) continue
            const c = charColor(pal, p.ch, `${key}`)
            if (c) img.data.set(c, (y * CHAR_W + x) * 4)
          }
        layerImgs[layer] = img
      }
      const overlays = [...HEAD_OVERLAYS.map((n) => [n, dy]), ...TORSO_OVERLAYS.map((n) => [n, 11 + dy])]
      for (const [name, oy] of overlays) {
        const part = findPart(parts, name, pose.overlay?.[name] ?? 'base', d, { optional: true, fallback: 'base' })
        if (!part) continue
        used.add(part.name)
        const img = image(CHAR_W, CHAR_H)
        for (let y = 0; y < part.h; y++)
          for (let x = 0; x < part.w; x++) {
            const ch = part.rows[y][x]
            const tx = x
            const ty = oy + y
            if (ch === '.' || ty < 0 || ty >= CHAR_H || armMask[ty][tx]) continue
            if (pose.hideTorsoOverlays && TORSO_OVERLAYS.includes(name)) continue
            const c = charColor(pal, ch, part.name)
            if (c) img.data.set(c, (ty * CHAR_W + tx) * 4)
          }
        layerImgs[name] = img
      }
      for (const [layer, img] of Object.entries(layerImgs)) {
        if (isEmpty(img)) continue
        const final = flip ? mirror(img) : img
        out.push({ key: `char:${layer}/${key}`, img: final, ax: 8, ay: 23 })
      }
      const hand = arms.meta.hand ?? [12, 16]
      const hx = flip ? CHAR_W - 1 - hand[0] : hand[0]
      poses[key] = {
        hand: [hx, hand[1] + armsY],
        propBehind: dir === 'n',
        seated: !!pose.seated,
      }
    }
  }
  return { entries: out, poses, used }
}
function mirror(img) {
  const o = image(img.w, img.h)
  blit(o, img, 0, 0, { flipX: true })
  return o
}

// ── Build ──────────────────────────────────────────────────────────────────────────────────────────
function placeholder(w, h) {
  const img = image(w, h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      img.data.set(((x >> 2) + (y >> 2)) & 1 ? [255, 0, 255, 255] : [40, 0, 40, 255], (y * w + x) * 4)
  return img
}

export function buildAtlas({ log = () => {} } = {}) {
  const pal = loadPalettes()
  const officeKeys = new Set([...Object.keys(pal.office), ...THEME_KEYS])
  const placeholders = []
  const frames = {}
  const sheets = {}
  const atlas = {
    version: 1,
    generator: 'assets/pixel/build.mjs',
    license: 'Original work for agent-office, MIT (assets/pixel/LICENSES.md)',
    tileSize: TILE,
    pxPerMetre: PX_PER_METRE,
    sheets: {},
    frames,
    tiles: [null],
    tileIds: {},
    tileSets: {},
    objects: {},
    characters: {},
    animations: [],
    clipDurations: {},
    effects: {},
    font: {},
    ui: {},
    themes: {},
    palettes: {},
    placeholders,
  }

  // Tiles ------------------------------------------------------------------------------------------
  const tileFrames = readPxDir('tiles')
  const tileEntries = []
  const tileMeta = new Map()
  const addTile = (name, rows, meta, file) => {
    const themed = usesTheme(rows)
    for (const theme of themed ? THEMES : [null]) {
      const id = theme ? `${name}@${theme}` : name
      const img = rowsToImage(rows, officeColor(pal, theme, file))
      tileEntries.push({ key: `tile:${id}`, img, ax: 0, ay: 0 })
      tileMeta.set(id, { name, theme, ...meta })
    }
  }
  for (const f of tileFrames) {
    checkKeys(f, officeKeys)
    // Thin-wall pieces (meta "thin") are 16 px long and 4 or 12 px across; every other tile is 16×16.
    const ok = f.meta.thin ? [f.w, f.h].every((d) => [4, 12, 16].includes(d)) : f.w === TILE && f.h === TILE
    if (!ok) throw new Error(`${f.file}: tile "${f.name}" must be ${f.meta.thin ? '4, 12 or 16 px per side' : '16×16'} (is ${f.w}×${f.h})`)
    if (f.meta.autotile) {
      for (let mask = 0; mask < 16; mask++)
        addTile(`${f.name}-${mask}`, autotileRows(f.rows, mask, f.meta.edge ?? 'k', f.meta.lip ?? null), { ...f.meta, autotile: undefined, mask }, f.file)
      addTile(f.name, f.rows, { ...f.meta, autotile: undefined }, f.file)
    } else addTile(f.name, f.rows, f.meta, f.file)
  }
  for (const req of REQUIRED_TILES)
    if (![...tileMeta.values()].some((m) => m.name === req)) {
      placeholders.push(`tile:${req}`)
      tileEntries.push({ key: `tile:${req}`, img: placeholder(TILE, TILE), ax: 0, ay: 0 })
      tileMeta.set(req, { name: req, theme: null, placeholder: true })
    }
  for (const id of [...tileMeta.keys()].sort()) {
    const m = tileMeta.get(id)
    atlas.tileIds[id] = atlas.tiles.length
    atlas.tiles.push({
      id,
      name: m.name,
      theme: m.theme ?? undefined,
      frame: `tile:${id}`,
      layer: m.layer ?? (m.name.startsWith('floor/') || m.name.startsWith('rug/') || m.name.startsWith('stairs/') ? 'floor' : m.name.startsWith('shade/') ? 'walls' : 'walls'),
      solid: m.solid ?? (m.name.startsWith('wall/') || m.name.startsWith('glass/') || m.name.startsWith('curtain/')),
      mask: m.mask,
    })
  }
  // Objects ----------------------------------------------------------------------------------------
  const objFrames = readPxDir('objects')
  const objEntries = []
  const objects = {}
  for (const f of objFrames) {
    checkKeys(f, officeKeys)
    const [kind, facing = 's'] = f.name.split('@')
    // footPx: the base (footprint) in px at 16 px/m; it sits at the bottom of the frame, the rest is overhang.
    const footPx = f.meta.footPx ?? (f.meta.foot ? f.meta.foot.map((t) => t * TILE) : [f.w, TILE])
    if (footPx[1] > f.h) throw new Error(`${f.file}:${f.line}: "${f.name}" footPx ${footPx} is taller than its frame (${f.h})`)
    const foot = footPx.map((p) => Math.ceil(p / TILE))
    const ax = Number(f.attrs.ax ?? 0)
    const ay = Number(f.attrs.ay ?? f.h - footPx[1])
    const themed = usesTheme(f.rows)
    for (const theme of themed ? THEMES : [null]) {
      const id = theme ? `${f.name}@${theme}` : f.name
      objEntries.push({ key: `obj:${id}`, img: rowsToImage(f.rows, officeColor(pal, theme, f.file)), ax, ay })
    }
    const { foot: _f, footPx: _p, ...rest } = f.meta
    ;(objects[kind] ??= { variants: {} }).variants[facing] = {
      frame: `obj:${f.name}`,
      themed,
      footPx,
      foot,
      solid: rest.solid ?? true,
      sortY: rest.sortY ?? footPx[1],
      ...rest,
    }
  }
  for (const kind of [...FURNITURE_KINDS, ...EXTRA_OBJECTS])
    if (!objects[kind]) {
      placeholders.push(`obj:${kind}`)
      objEntries.push({ key: `obj:${kind}`, img: placeholder(TILE * 2, TILE * 2), ax: 0, ay: TILE })
      objects[kind] = {
        variants: { s: { frame: `obj:${kind}`, themed: false, footPx: [TILE * 2, TILE], foot: [2, 1], solid: true, sortY: TILE, placeholder: true } },
      }
    }
  atlas.objects = Object.fromEntries(Object.keys(objects).sort().map((k) => [k, objects[k]]))

  // Characters -------------------------------------------------------------------------------------
  const animsSrc = JSON.parse(readFileSync(join(SRC, 'characters/anims.json'), 'utf8'))
  const charFrames = readPxDir('characters')
  const chars = composeCharacters(pal, charFrames, animsSrc)
  const charEntries = chars.entries
  const props = charFrames.filter((f) => f.name.startsWith('prop-'))
  for (const p of props) {
    // prop-<name>-<dir>; w mirrors e.
    const name = p.name.slice(5)
    const img = rowsToImage(p.rows, (ch) => charColor(pal, ch, p.name) ?? null)
    const ax = Number(p.attrs.ax ?? Math.floor(p.w / 2))
    const ay = Number(p.attrs.ay ?? Math.floor(p.h / 2))
    charEntries.push({ key: `char:prop/${name}`, img, ax, ay })
    if (name.endsWith('-e')) charEntries.push({ key: `char:prop/${name.slice(0, -2)}-w`, img: mirror(img), ax: p.w - 1 - ax, ay })
  }
  for (const a of [...new Set([...PIXEL_ANIMS, ...Object.keys(animsSrc.anims)])]) {
    const spec = animsSrc.anims[a]
    if (!spec) {
      placeholders.push(`anim:${a}`)
      continue
    }
    let total = 0
    for (const dir of DIRS) {
      const fr = spec.frames.map(([pose, ms, extra]) => {
        const ref = `${pose}-${dir}`
        if (!chars.poses[ref]) throw new Error(`anims.json: ${a} refers to unknown pose "${pose}"`)
        return { ref, ms, ...(extra ?? {}) }
      })
      total = fr.reduce((s, f) => s + f.ms, 0)
      atlas.animations.push({ name: a, dir, loop: spec.loop !== false, frames: fr })
    }
    atlas.clipDurations[a] = Math.round(total) / 1000
  }
  atlas.characters = {
    size: [CHAR_W, CHAR_H],
    anchor: [8, 23],
    layers: CHAR_LAYERS,
    recolor: { source: pal.recolorSource, groups: LAYER_RECOLOR },
    hairStyles: { hairA: 'hair-a', hairB: 'hair-b', hairC: 'hair-c', hairD: 'hair-d' },
    player: { layers: ['cap', 'jacket'], ramps: { outfit: pal.ramps.outfit.default, jacket: pal.ramps.jacket.default } },
    poses: chars.poses,
    props: [...new Set(props.map((p) => p.name.slice(5).replace(/-(s|n|e|w)$/, '')))].sort(),
  }

  // Effects ----------------------------------------------------------------------------------------
  const fxFrames = readPxDir('effects')
  const fxEntries = []
  for (const f of fxFrames) {
    checkKeys(f, officeKeys)
    const ax = Number(f.attrs.ax ?? Math.floor(f.w / 2))
    const ay = Number(f.attrs.ay ?? f.h - 1)
    fxEntries.push({ key: `fx:${f.name}`, img: rowsToImage(f.rows, officeColor(pal, null, f.file)), ax, ay })
    const [name] = f.name.split('/')
    const e = (atlas.effects[name] ??= { loop: true, frames: [] })
    if (f.meta.loop === false) e.loop = false
    e.frames.push({ ref: `fx:${f.name}`, ms: Number(f.attrs.ms ?? 200) })
    if (f.meta.tint) e.tint = f.meta.tint
  }
  for (const req of REQUIRED_EFFECTS)
    if (!atlas.effects[req]) {
      placeholders.push(`fx:${req}`)
      fxEntries.push({ key: `fx:${req}`, img: placeholder(8, 8), ax: 4, ay: 7 })
      atlas.effects[req] = { loop: true, frames: [{ ref: `fx:${req}`, ms: 200 }] }
    }

  // Font -------------------------------------------------------------------------------------------
  const glyphs = readPxDir('font')
  const fontEntries = []
  const glyphMap = {}
  for (const g of glyphs) {
    checkKeys(g, new Set(['.', 'x']))
    if (g.h !== 7) throw new Error(`${g.file}: glyph "${g.name}" must be 7 rows`)
    const img = rowsToImage(g.rows, (c) => (c === 'x' ? [255, 255, 255, 255] : null))
    let width = 0
    for (const r of g.rows) width = Math.max(width, r.lastIndexOf('x') + 1)
    if (g.name === ' ') width = 3
    const cp = g.name.codePointAt(0)
    const key = `glyph:${cp.toString(16)}`
    fontEntries.push({ key, img, ax: 0, ay: 0 })
    glyphMap[g.name] = { frame: key, w: width, advance: width + 1 }
  }
  const wanted = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), ...EXTRA_GLYPHS]
  for (const ch of wanted)
    if (!glyphMap[ch]) {
      placeholders.push(`glyph:${ch}`)
      const key = `glyph:${ch.codePointAt(0).toString(16)}`
      fontEntries.push({ key, img: placeholder(5, 7), ax: 0, ay: 0 })
      glyphMap[ch] = { frame: key, w: 5, advance: 6 }
    }
  atlas.font = {
    cell: [5, 7],
    lineHeight: 9,
    color: '#ffffff',
    note: 'Glyphs are white on transparent: tint at runtime (source-in). Unknown characters fall back to "?".',
    glyphs: Object.fromEntries(Object.keys(glyphMap).sort().map((k) => [k, glyphMap[k]])),
  }

  // UI ---------------------------------------------------------------------------------------------
  const uiFrames = readPxDir('ui')
  const uiEntries = []
  let frameImg = null
  for (const f of uiFrames) {
    checkKeys(f, officeKeys)
    const img = rowsToImage(f.rows, officeColor(pal, null, f.file))
    uiEntries.push({ key: `ui:${f.name}`, img, ax: 0, ay: 0 })
    atlas.ui[f.name] = { frame: `ui:${f.name}`, ...f.meta }
    if (f.name === 'frame') frameImg = img
  }
  if (!frameImg) {
    placeholders.push('ui:frame')
    frameImg = placeholder(24, 24)
    uiEntries.push({ key: 'ui:frame', img: frameImg, ax: 0, ay: 0 })
    atlas.ui.frame = { frame: 'ui:frame', slice: 8 }
  }

  // Sheets -----------------------------------------------------------------------------------------
  const groups = [
    ['tiles', tileEntries, 256],
    ['objects', objEntries, 512],
    ['characters', charEntries, 512],
    ['effects', fxEntries, 256],
    ['font', fontEntries, 128],
    ['ui', uiEntries, 128],
  ]
  const files = {}
  const images = {}
  for (const [name, entries, width] of groups) {
    const keys = new Set()
    for (const e of entries) {
      if (keys.has(e.key)) throw new Error(`duplicate frame ${e.key}`)
      keys.add(e.key)
    }
    const { sheet, entries: placed } = pack(entries, width)
    for (const e of placed.slice().sort((a, b) => (a.key < b.key ? -1 : 1)))
      frames[e.key] = { sheet: name, x: e.x, y: e.y, w: e.img.w, h: e.img.h, ax: e.ax, ay: e.ay }
    files[`${name}.png`] = encodePng(sheet)
    images[name] = { sheet, placed }
    atlas.sheets[name] = { file: `${name}.png`, w: sheet.w, h: sheet.h }
  }
  files['frame.png'] = encodePng(frameImg)
  atlas.frames = Object.fromEntries(Object.keys(frames).sort().map((k) => [k, frames[k]]))
  atlas.themes = Object.fromEntries(
    THEMES.map((t) => [t, { floor: `floor/${pal.themeFloors[t]}`, colors: pal.themes[t] }]),
  )
  atlas.tileSets = {
    wallTop: { solid: 'wall/top-%mask%', glass: 'glass/top-%mask%', curtain: 'glass/top-%mask%' },
    wallFace: {
      solid: ['wall/face-hi', 'wall/face-lo'],
      glass: ['glass/face-hi', 'glass/face-lo'],
      curtain: ['curtain/face-hi', 'curtain/face-lo'],
      window: ['wall/window-hi', 'wall/window-lo'],
    },
    rug: Object.fromEntries(['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se'].map((p) => [p, `rug/${p}`])),
    thinWall: THIN_WALLS,
    shade: { n: 'shade/n', w: 'shade/w', e: 'shade/e', nw: 'shade/nw', ne: 'shade/ne' },
  }
  atlas.palettes = { ramps: pal.ramps, recolorSource: pal.recolorSource, office: pal.office }
  const json = JSON.stringify(atlas) + "\n"
  files['atlas.json'] = Buffer.from(json)
  log(`placeholders: ${placeholders.length}`)
  return { atlas, files, images, pal, chars, unusedParts: charFrames.filter((f) => !f.name.startsWith('prop-') && !chars.used.has(f.name)).map((f) => f.name) }
}

export function totalBytes(files) {
  return Object.values(files).reduce((s, b) => s + b.length, 0)
}

// ── Preview sheets (4×) ────────────────────────────────────────────────────────────────────────────
export async function writePreviews(build) {
  const { previews } = await import('./previews.mjs')
  return previews(build)
}

async function main() {
  const t0 = Date.now()
  const build = buildAtlas({ log: (m) => console.log(`pixel: ${m}`) })
  const total = totalBytes(build.files)
  if (total > BUDGET_BYTES) throw new Error(`pixel atlas ${total} B exceeds the ${BUDGET_BYTES} B budget`)
  mkdirSync(OUT, { recursive: true })
  for (const [name, buf] of Object.entries(build.files)) writeFileSync(join(OUT, name), buf)
  console.log(
    `pixel: ${Object.entries(build.files)
      .map(([n, b]) => `${n} ${(b.length / 1024).toFixed(1)} KB`)
      .join(', ')} (total ${(total / 1024).toFixed(1)} KB) → ${relative(ROOT, OUT)}`,
  )
  if (build.unusedParts.length) console.log(`pixel: unused character parts: ${build.unusedParts.join(', ')}`)
  if (!process.argv.includes('--no-previews')) {
    mkdirSync(PREVIEWS, { recursive: true })
    const written = await writePreviews(build)
    console.log(`pixel: previews ${written.map((p) => relative(ROOT, p)).join(', ')}`)
  }
  console.log(`pixel: done in ${Date.now() - t0} ms`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
