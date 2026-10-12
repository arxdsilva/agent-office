// Review sheets for the pixel atlas (assets/pixel/previews/*.png, 4×). Not shipped: they exist so a human
// (or the art agent) can look at the art in context. Everything is composed from the built atlas images.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHAR_LAYERS, DIRS, PREVIEWS, blit, encodePng, fill, hexToRgba, image } from './build.mjs'

const SCALE = 4
const BG = hexToRgba('#2b2a33')
const BG2 = hexToRgba('#35343f')
const INK = [240, 236, 228, 255]

/** Frame lookup: crops a frame of the built sheets into its own image. */
function framer(build) {
  const sheets = Object.fromEntries(Object.entries(build.images).map(([k, v]) => [k, v.sheet]))
  return (key) => {
    const f = build.atlas.frames[key]
    if (!f) return null
    const img = image(f.w, f.h)
    blit(img, sheets[f.sheet], 0, 0, { sx: f.x, sy: f.y, w: f.w, h: f.h })
    return { img, ...f }
  }
}

function text(build, frame, dst, str, x, y, color = INK) {
  let cx = x
  for (const ch of str) {
    const g = build.atlas.font.glyphs[ch] ?? build.atlas.font.glyphs['?']
    if (!g) {
      cx += 4
      continue
    }
    const f = frame(g.frame)
    if (f) {
      const tinted = image(f.w, f.h)
      for (let i = 0; i < f.img.data.length; i += 4)
        if (f.img.data[i + 3]) tinted.data.set([color[0], color[1], color[2], f.img.data[i + 3]], i)
      blit(dst, tinted, cx, y)
    }
    cx += g.advance
  }
  return cx
}

function recolor(img, source, ramp) {
  if (!ramp) return img
  const out = image(img.w, img.h)
  out.data.set(img.data)
  const src = source.map(hexToRgba)
  const dst = ramp.map(hexToRgba)
  for (let i = 0; i < out.data.length; i += 4) {
    if (!out.data[i + 3]) continue
    for (let k = 0; k < src.length; k++)
      if (out.data[i] === src[k][0] && out.data[i + 1] === src[k][1] && out.data[i + 2] === src[k][2]) {
        out.data.set(dst[k].slice(0, 3), i)
        break
      }
  }
  return out
}

/** Composes one character frame for an appearance. */
export function character(build, frame, look, ref) {
  const { recolor: rc } = build.atlas.characters
  const ramps = build.atlas.palettes.ramps
  const img = image(16, 24)
  for (const layer of CHAR_LAYERS) {
    if (layer.startsWith('hair-') && layer !== look.hair) continue
    if (layer === 'glasses' && !look.glasses) continue
    if (layer === 'headset' && !look.headset) continue
    if (layer === 'badge' && !look.badge) continue
    if ((layer === 'cap' || layer === 'jacket') && !look.player) continue
    const f = frame(`char:${layer}/${ref}`)
    if (!f) continue
    const group = rc.groups[layer]
    let ramp = null
    if (group === 'skin') ramp = ramps.skin[look.skin]
    if (group === 'shirt') ramp = look.player ? ramps.jacket.default : ramps.shirt[look.shirt]
    if (group === 'pants') ramp = ramps.pants[look.pants]
    if (group === 'hair') ramp = ramps.hair[look.hairColor]
    if (group === 'shoes') ramp = ramps.shoes.default
    if (group === 'outfit') ramp = ramps.outfit.default
    if (group === 'jacket') ramp = ramps.jacket.default
    if (group === 'badge') ramp = ramps.shirt[look.badge]
    blit(img, recolor(f.img, rc.source, ramp), 0, 0)
  }
  return img
}

export const LOOKS = [
  { skin: 'eac0a0', shirt: '3b6ea5', pants: '2c3440', hair: 'hair-a', hairColor: '3b2a1e' },
  { skin: 'b57d5a', shirt: 'c8553d', pants: '5c4a3a', hair: 'hair-b', hairColor: '1f1a17', glasses: true },
  { skin: 'f6d5c3', shirt: '5b8c5a', pants: '6b7a8f', hair: 'hair-c', hairColor: 'a8763e', headset: true },
  { skin: '5f3a24', shirt: 'e0a339', pants: '22252b', hair: 'hair-d', hairColor: '1f1a17', badge: '7a5ca8' },
  { skin: 'd8a47f', shirt: '7a5ca8', pants: 'bfae8e', hair: 'hair-a', hairColor: '9c3b2a', glasses: true },
  { skin: '8d5a3b', shirt: '2f9e9a', pants: '3a3a3a', hair: 'hair-c', hairColor: '1f1a17' },
  { skin: 'eac0a0', shirt: 'f2efe9', pants: '2c3440', hair: 'hair-b', hairColor: 'd9c08c', headset: true, badge: 'c8553d' },
  { skin: 'd8a47f', shirt: '404a59', pants: '6b7a8f', hair: 'hair-d', hairColor: '8a8a8a' },
  { skin: 'eac0a0', shirt: '3d5a80', pants: '2c3440', hair: 'hair-a', hairColor: '3b2a1e', player: true },
]

function save(name, img) {
  const big = image(img.w * SCALE, img.h * SCALE)
  blit(big, img, 0, 0, { scale: SCALE })
  const p = join(PREVIEWS, name)
  writeFileSync(p, encodePng(big))
  return p
}

function checker(img) {
  for (let y = 0; y < img.h; y += 8)
    for (let x = 0; x < img.w; x += 8) fill(img, x, y, 8, 8, ((x + y) >> 3) & 1 ? BG2 : BG)
}

// ── Sheets ─────────────────────────────────────────────────────────────────────────────────────────
function charactersSheet(build, frame) {
  const anims = build.atlas.animations
  const names = [...new Set(anims.map((a) => a.name))]
  const maxFrames = Math.max(...anims.map((a) => a.frames.length))
  const cellW = 18
  const colW = maxFrames * cellW + 6
  const labelW = 64
  const W = labelW + DIRS.length * colW
  const H = 14 + names.length * 28
  const img = image(W, H)
  checker(img)
  DIRS.forEach((d, i) => text(build, frame, img, d.toUpperCase(), labelW + i * colW + 2, 3))
  names.forEach((n, row) => {
    const y = 14 + row * 28
    text(build, frame, img, n, 2, y + 9)
    DIRS.forEach((d, i) => {
      const a = anims.find((x) => x.name === n && x.dir === d)
      a.frames.forEach((f, k) => {
        const look = LOOKS[(row + i) % LOOKS.length]
        blit(img, character(build, frame, look, f.ref), labelW + i * colW + k * cellW, y + 2, { alpha: f.alpha ?? 1 })
      })
    })
  })
  return img
}

function castSheet(build, frame) {
  const W = LOOKS.length * 20 + 8
  const img = image(W, 4 * 28 + 18)
  checker(img)
  text(build, frame, img, 'cast: s n e w (last = player)', 4, 3)
  LOOKS.forEach((look, i) =>
    DIRS.forEach((d, k) => blit(img, character(build, frame, look, `stand-${d}`), 4 + i * 20, 14 + k * 28)),
  )
  return img
}

function tilesSheet(build, frame) {
  const tiles = build.atlas.tiles.slice(1)
  const themes = ['house', 'terracotta', 'nordic', 'forest', 'ocean', 'neon', 'brass']
  const names = [...new Set(tiles.map((t) => t.name))].filter((n) => !/-\d+$/.test(n))
  const per = 12
  const rows = Math.ceil(names.length / per)
  const blockH = rows * 26 + 14
  const img = image(per * 20 + 8, themes.length * blockH + 8)
  checker(img)
  themes.forEach((theme, ti) => {
    const y0 = ti * blockH + 4
    text(build, frame, img, theme, 4, y0)
    names.forEach((n, i) => {
      const id = build.atlas.tileIds[`${n}@${theme}`] ? `${n}@${theme}` : n
      const f = frame(`tile:${id}`)
      if (f) blit(img, f.img, 4 + (i % per) * 20, y0 + 10 + Math.floor(i / per) * 26)
    })
  })
  return img
}

function objectsSheet(build, frame, theme = 'terracotta') {
  const entries = []
  for (const [kind, o] of Object.entries(build.atlas.objects))
    for (const [facing, v] of Object.entries(o.variants)) entries.push({ label: facing === 's' ? kind : `${kind}@${facing}`, key: v.themed ? `${v.frame}@${theme}` : v.frame })
  const W = 640
  let x = 4
  let y = 12
  let rowH = 0
  const placed = []
  for (const e of entries) {
    const f = frame(e.key)
    if (!f) continue
    const w = Math.max(f.w, e.label.length * 5) + 6
    if (x + w > W) {
      x = 4
      y += rowH + 12
      rowH = 0
    }
    placed.push({ e, f, x, y })
    x += w
    rowH = Math.max(rowH, f.h)
  }
  const img = image(W, y + rowH + 16)
  checker(img)
  text(build, frame, img, `objects (${theme})`, 4, 2)
  for (const { e, f, x: px, y: py } of placed) {
    blit(img, f.img, px, py)
    text(build, frame, img, e.label, px, py + f.h + 2)
  }
  return img
}

function effectsSheet(build, frame) {
  const fx = Object.entries(build.atlas.effects)
  const img = image(360, fx.length * 30 + 8)
  checker(img)
  fx.forEach(([name, e], i) => {
    const y = 4 + i * 30
    text(build, frame, img, name, 4, y + 10)
    e.frames.forEach((f, k) => {
      const fr = frame(f.ref)
      if (fr) blit(img, fr.img, 70 + k * 40, y)
    })
  })
  // The font and the UI frame.
  return img
}

function fontSheet(build, frame) {
  const img = image(260, 70)
  fill(img, 0, 0, img.w, img.h, hexToRgba('#f4f1ea'))
  const ink = hexToRgba('#2a2333')
  const all = Object.keys(build.atlas.font.glyphs).join('')
  for (let i = 0, line = 0; i < all.length; i += 40, line++) text(build, frame, img, all.slice(i, i + 40), 4, 4 + line * 10, ink)
  text(build, frame, img, 'ADA · Refactor auth → thinking… ✓', 4, 40, ink)
  text(build, frame, img, 'E: Talk   ▶ Talk  Details  Follow', 4, 52, ink)
  return img
}

function tileAt(build, frame, name, theme) {
  const id = build.atlas.tileIds[`${name}@${theme}`] ? `${name}@${theme}` : name
  return frame(`tile:${id}`)
}

/**
 * A small office at 16 px/m (docs/pixel-style.md §Scale), composed from floors, thin walls, objects and characters:
 * the art review in context. Objects are placed by their base's top-left in px (atlas `footPx`), like the map does.
 */
function mockRoom(build, frame, theme) {
  const W = 30 * 16
  const H = 17 * 16
  const img = image(W, H)
  const floor = build.atlas.themes[theme].floor
  const tile = (name, x, y) => {
    const f = tileAt(build, frame, name, theme)
    if (f) blit(img, f.img, x, y)
    return f
  }
  // Floors per 1 m cell: the theme floor inside, a kitchen tile corner, the street path and grass below.
  for (let ty = 0; ty < 17; ty++)
    for (let tx = 0; tx < 30; tx++)
      tile(ty >= 15 ? 'floor/grass' : ty >= 13 ? 'floor/path' : tx >= 22 && ty < 6 ? 'floor/tile' : floor, tx * 16, ty * 16)
  // Thin walls: the north wall (a 12 px face above a 4 px top), a glass stretch, a west wall and a doorway gap.
  const wallY = 16
  for (let x = 0; x < W; x += 16) {
    if (x >= 160 && x < 176) continue // doorway, 1 m
    const glass = x >= 224 && x < 288
    const k = glass ? 'glass' : 'wall'
    const cap = x === 144 ? '-r' : x === 176 ? '-l' : ''
    tile(`${k}/thin-face${cap}`, x, wallY - 12)
    tile(`${k}/thin-top-h`, x, wallY)
  }
  for (let y = wallY + 4; y < 13 * 16; y += 16) tile('wall/thin-top-v', 0, y)
  tile('wall/thin-post', 0, wallY)
  // Objects + characters, y-sorted by the base's bottom edge (or the feet).
  const sprites = []
  const obj = (kind, x, y, facing = 's') => {
    const o = build.atlas.objects[kind]
    const v = o?.variants[facing] ?? Object.values(o?.variants ?? {})[0]
    if (!v) return
    const f = frame(v.themed ? `${v.frame}@${theme}` : v.frame)
    if (!f) return
    sprites.push({ y: v.flat ? -1 : y + v.sortY, draw: () => blit(img, f.img, x - f.ax, y - f.ay) })
  }
  const npc = (look, ref, px, py) => sprites.push({ y: py, draw: () => blit(img, character(build, frame, look, ref), px - 8, py - 23) })
  // A desk pod: two desks back to back, chairs on the outside.
  obj('desk', 24, 64, 'n')
  obj('chair', 32, 52, 's')
  npc(LOOKS[0], 'sit-type-a-s', 37, 62)
  obj('desk', 24, 77, 's')
  obj('chair', 32, 92, 'n')
  npc(LOOKS[1], 'sit-think-n', 37, 101)
  obj('desk', 52, 64, 'n')
  obj('desk', 52, 77, 's')
  obj('chair', 60, 92, 'n')
  npc(LOOKS[7], 'sit-type-a-n', 65, 101)
  obj('desk', 96, 56, 'e')
  obj('chair', 112, 64, 'w')
  obj('plant', 6, 22)
  obj('bookshelf', 100, 20)
  obj('board', 136, 20)
  // Lounge on a rug.
  obj('rug', 184, 72)
  obj('sofa', 190, 74, 's')
  npc(LOOKS[2], 'lounge-s', 204, 90)
  obj('armchair', 238, 96, 'w')
  obj('cafe-table', 210, 104)
  obj('tv', 196, 20)
  obj('booth', 296, 20)
  obj('booth-lamp', 296, 20, 'on')
  // Kitchen.
  obj('kitchen-counter', 352, 20)
  obj('kitchen-counter', 384, 20)
  obj('coffee-machine', 360, 22)
  obj('fridge', 420, 20)
  obj('island', 360, 56)
  npc(LOOKS[3], 'cup-s', 392, 92)
  obj('meeting-table', 300, 120)
  obj('chair', 306, 108, 's')
  obj('chair', 326, 108, 's')
  obj('chair', 306, 140, 'n')
  npc(LOOKS[4], 'sit-talk-a-s', 311, 118)
  obj('arcade', 440, 120)
  obj('pingpong', 380, 132)
  // Street and garden.
  obj('bench', 40, 218)
  obj('planter', 100, 222)
  obj('planter', 116, 222)
  obj('plant', 160, 214)
  obj('sign', 200, 214)
  npc(LOOKS[5], 'walk-a-e', 100, 214)
  npc(LOOKS[8], 'stand-n', 168, 200)
  npc(LOOKS[6], 'wave-a-s', 250, 214)
  sprites.sort((a, b) => a.y - b.y).forEach((s) => s.draw())
  return img
}

export function previews(build) {
  const frame = framer(build)
  const out = []
  out.push(save('characters.png', charactersSheet(build, frame)))
  out.push(save('cast.png', castSheet(build, frame)))
  out.push(save('tiles.png', tilesSheet(build, frame)))
  out.push(save('objects.png', objectsSheet(build, frame)))
  out.push(save('objects-neon.png', objectsSheet(build, frame, 'neon')))
  out.push(save('effects.png', effectsSheet(build, frame)))
  out.push(save('font.png', fontSheet(build, frame)))
  for (const theme of ['terracotta', 'neon', 'nordic']) out.push(save(`room-${theme}.png`, mockRoom(build, frame, theme)))
  return out
}
