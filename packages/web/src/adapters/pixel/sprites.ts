// Pixel atlas loading (agent AR's `assets/pixel/atlas.json` + sheets, contract §12) and character
// compositing. Characters are baked once per appearance key (LRU 64): every layer of a pose is
// recoloured from the grey source ramp to the look's palette ramps (`appearanceOf`, the same
// colours as 3D), then stacked. Anything the atlas lacks, or still lists as a placeholder, falls
// back to procedural drawing, so the 2D view always renders.
import type { Appearance } from '../../app/motion.ts'
import type { PropName } from '../../app/office-types.ts'
import type { TileQuery } from '../../app/pixel/map.ts'
import type { Dir4, PixelAnim } from '../../app/pixel/types.ts'

export const CHAR_W = 16
export const CHAR_H = 24
const LRU_KEYS = 64

export interface AtlasFrame {
  image: CanvasImageSource
  x: number
  y: number
  w: number
  h: number
  /** Anchor inside the frame (draw at pos − anchor). */
  ax: number
  ay: number
}

interface RawFrame {
  sheet: string
  x: number
  y: number
  w: number
  h: number
  ax?: number
  ay?: number
}
interface RawAnim {
  name: string
  dir: Dir4
  loop: boolean
  frames: { ref: string; ms: number; alpha?: number }[]
}
interface RawVariant {
  frame: string
  themed?: boolean
  foot?: [number, number]
  placeholder?: boolean
}
export interface RawAtlas {
  sheets?: Record<string, { file: string }>
  frames?: Record<string, RawFrame>
  tileIds?: Record<string, number>
  tiles?: ({ frame: string } | null)[]
  tileSets?: { wallTop?: Record<string, string>; wallFace?: Record<string, [string, string]> }
  objects?: Record<string, { variants: Partial<Record<Dir4, RawVariant>> }>
  characters?: {
    layers?: string[]
    recolor?: { source: string[]; groups: Record<string, string | null> }
    hairStyles?: Record<string, string>
    player?: { layers: string[]; ramps: Record<string, string[]> }
    poses?: Record<string, { hand: [number, number]; propBehind: boolean; seated: boolean }>
  }
  animations?: RawAnim[]
  clipDurations?: Record<string, number>
  effects?: Record<string, { loop: boolean; frames: { ref: string; ms: number }[] }>
  font?: {
    glyphs?: Record<string, { frame: string; w: number; advance: number }>
    lineHeight?: number
  }
  themes?: Record<string, { floor?: string }>
  palettes?: { ramps?: Record<string, Record<string, string[]>> }
  placeholders?: string[]
}

/** A loaded atlas. Lookups return null for anything missing or still a placeholder. */
export class Atlas {
  private placeholders: Set<string>
  private anims = new Map<string, RawAnim>()

  constructor(
    readonly raw: RawAtlas,
    private sheets: Map<string, HTMLImageElement>,
  ) {
    this.placeholders = new Set(raw.placeholders ?? [])
    for (const a of raw.animations ?? []) this.anims.set(`${a.name}:${a.dir}`, a)
  }

  frame(name: string): AtlasFrame | null {
    if (this.placeholders.has(name)) return null
    const f = this.raw.frames?.[name]
    const image = f && this.sheets.get(f.sheet)
    return f && image
      ? { image, x: f.x, y: f.y, w: f.w, h: f.h, ax: f.ax ?? 0, ay: f.ay ?? 0 }
      : null
  }

  /** A tile frame by name, themed first (`name@theme`). */
  tileFrame(name: string, theme?: string): AtlasFrame | null {
    const ids = this.raw.tileIds ?? {}
    const id = (theme && ids[`${name}@${theme}`]) || ids[name]
    const t = id ? this.raw.tiles?.[id] : undefined
    return t ? this.frame(t.frame) : null
  }

  /** The atlas tile for a map query (null: draw the procedural one). `mask`: connected walls. */
  tile(q: TileQuery, mask: number): AtlasFrame | null {
    const theme = q.theme
    if (q.layer === 'floor') {
      const name =
        q.kind === 'street'
          ? 'floor/path'
          : q.kind === 'default'
            ? (this.raw.themes?.[theme ?? 'house']?.floor ?? 'floor/terrazzo')
            : `floor/${q.kind}`
      return this.tileFrame(name, theme)
    }
    if (q.kind === 'door') {
      return q.layer === 'overhead' ? this.tileFrame('wall/face-hi', theme) : null
    }
    const kind = q.kind === 'window' ? 'window' : q.kind
    if (q.edge === 'v') {
      const top = this.raw.tileSets?.wallTop?.[kind] ?? 'wall/top-%mask%'
      return (
        this.tileFrame(top.replace('%mask%', String(mask)), theme) ??
        this.tileFrame(top.replace('-%mask%', ''), theme)
      )
    }
    const face = this.raw.tileSets?.wallFace?.[kind]
    if (!face) return null
    return this.tileFrame(q.layer === 'overhead' ? face[0] : face[1], theme)
  }

  /** An object's frame for a facing (falls back to 's'); themed frames use `frame@theme`. */
  object(kind: string, dir: Dir4 | undefined, theme?: string): AtlasFrame | null {
    const o = this.raw.objects?.[kind]
    const v = o?.variants[dir ?? 's'] ?? o?.variants.s
    if (!v || v.placeholder) return null
    return (v.themed && theme ? this.frame(`${v.frame}@${theme}`) : null) ?? this.frame(v.frame)
  }

  /** The pose ref (e.g. 'walk-a-s') `t` seconds into an animation, with its alpha. */
  pose(anim: string, dir: Dir4, t: number): { ref: string; alpha: number } | null {
    const a = this.anims.get(`${anim}:${dir}`)
    if (!a || !a.frames.length) return null
    const total = a.frames.reduce((s, f) => s + f.ms, 0)
    let ms = t * 1000
    ms = a.loop ? ms % total : Math.min(ms, total - 1)
    for (const f of a.frames) {
      if (ms < f.ms) return { ref: f.ref, alpha: f.alpha ?? 1 }
      ms -= f.ms
    }
    const last = a.frames[a.frames.length - 1]!
    return { ref: last.ref, alpha: last.alpha ?? 1 }
  }

  /** An effect's frame `t` seconds in. */
  effect(name: string, t: number): AtlasFrame | null {
    const e = this.raw.effects?.[name]
    if (!e || !e.frames.length) return null
    const total = e.frames.reduce((s, f) => s + f.ms, 0)
    let ms = e.loop ? (t * 1000) % total : Math.min(t * 1000, total - 1)
    for (const f of e.frames) {
      if (ms < f.ms) return this.frame(f.ref)
      ms -= f.ms
    }
    return this.frame(e.frames[0]!.ref)
  }

  bytes(): number {
    let n = 0
    for (const i of this.sheets.values()) n += i.naturalWidth * i.naturalHeight * 4
    return n
  }
}

/** Loads the atlas, or null when it isn't published (the 2D mode then draws placeholders). */
export async function loadAtlas(base: string): Promise<Atlas | null> {
  try {
    const res = await fetch(`${base}atlas.json`)
    if (!res.ok) return null
    const raw = (await res.json()) as RawAtlas
    const sheets = new Map<string, HTMLImageElement>()
    await Promise.all(
      Object.entries(raw.sheets ?? {}).map(async ([key, s]) => {
        if (!s || typeof s.file !== 'string' || !/^[\w.-]+\.png$/.test(s.file)) return
        const img = new Image()
        img.src = `${base}${s.file}`
        await img.decode()
        sheets.set(key, img)
      }),
    )
    return new Atlas(raw, sheets)
  } catch {
    return null
  }
}

// ── Characters ──────────────────────────────────────────────────────────────────────────────────
/** Procedural fallback: frames per animation and frames per second. */
export const ANIM_FRAMES: Record<PixelAnim, number> = {
  idle: 2,
  walk: 4,
  sit: 1,
  'sit-type': 2,
  'sit-think': 2,
  'sit-talk': 2,
  'idle-talk': 2,
  read: 2,
  phone: 2,
  'stand-interact': 2,
  coffee: 2,
  lounge: 1,
  pingpong: 2,
  confused: 2,
  wave: 2,
  'elevator-in': 1,
  'elevator-out': 1,
}
export const ANIM_FPS: Record<PixelAnim, number> = {
  idle: 1.5,
  walk: 8,
  sit: 1,
  'sit-type': 6,
  'sit-think': 1.5,
  'sit-talk': 4,
  'idle-talk': 4,
  read: 1,
  phone: 2,
  'stand-interact': 3,
  coffee: 1,
  lounge: 1,
  pingpong: 5,
  confused: 3,
  wave: 4,
  'elevator-in': 1,
  'elevator-out': 1,
}

export interface Look extends Appearance {
  /** The player's "operator" outfit: a cap and a jacket. */
  player?: boolean
}

const hex = (c: number) => c.toString(16).padStart(6, '0')
const css = (c: number) => `#${hex(c)}`
const shade = (c: number, f: number) => {
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((c >> s) & 255) * f)))
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`
}
const rgb = (s: string): [number, number, number] => {
  const n = parseInt(s.replace('#', '').slice(0, 6), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export const lookKey = (l: Look) =>
  [
    l.skin,
    l.shirt,
    l.pants,
    l.hair,
    l.badge ?? -1,
    l.hairStyle,
    +l.glasses,
    +l.headset,
    +!!l.player,
  ]
    .map(String)
    .join('-')

export interface CharFrame {
  canvas: HTMLCanvasElement
  /** Feet anchor inside the canvas. */
  ax: number
  ay: number
  alpha: number
}

/** Per-look frame canvases, least recently used looks evicted past 64. */
export class CharacterSprites {
  private looks = new Map<string, Map<string, HTMLCanvasElement>>()
  private atlas: Atlas | null = null

  setAtlas(atlas: Atlas | null): void {
    this.atlas = atlas
    this.clear()
  }

  /**
   * The frame for `anim` facing `dir`, `t` seconds in (`name` overrides the atlas animation name,
   * e.g. 'sit-down'), with the props in hand.
   */
  frame(
    look: Look,
    key: string,
    dir: Dir4,
    anim: PixelAnim,
    t: number,
    props: readonly PropName[] = [],
    name: string = anim,
  ): CharFrame {
    const frames = this.framesOf(key)
    const pose =
      this.atlas?.pose(name, dir, t) ?? (name !== anim ? this.atlas?.pose(anim, dir, t) : null)
    if (pose && this.atlas) {
      const fk = `${pose.ref}|${props.join(',')}`
      let c = frames.get(fk)
      if (!c) {
        c = this.compose(this.atlas, look, pose.ref, dir, props)
        frames.set(fk, c)
      }
      return { canvas: c, ax: 8, ay: 23, alpha: pose.alpha }
    }
    const f = Math.floor(Math.max(0, t) * ANIM_FPS[anim]) % ANIM_FRAMES[anim]
    const fk = `proc:${anim}:${dir}:${f}`
    let c = frames.get(fk)
    if (!c) {
      c = canvas()
      drawCharacter(c.getContext('2d', { willReadFrequently: true })!, look, dir, anim, f)
      frames.set(fk, c)
    }
    return { canvas: c, ax: 8, ay: 23, alpha: 1 }
  }

  private framesOf(key: string): Map<string, HTMLCanvasElement> {
    let frames = this.looks.get(key)
    if (frames) {
      this.looks.delete(key)
      this.looks.set(key, frames)
      return frames
    }
    frames = new Map()
    this.looks.set(key, frames)
    if (this.looks.size > LRU_KEYS) {
      const [oldest, old] = this.looks.entries().next().value as [
        string,
        Map<string, HTMLCanvasElement>,
      ]
      for (const c of old.values()) c.width = c.height = 0
      this.looks.delete(oldest)
    }
    return frames
  }

  /** Stacks the recoloured layers of one pose (plus props) into a 16×24 canvas. */
  private compose(
    atlas: Atlas,
    look: Look,
    ref: string,
    dir: Dir4,
    props: readonly PropName[],
  ): HTMLCanvasElement {
    const ch = atlas.raw.characters ?? {}
    const c = canvas()
    const g = c.getContext('2d', { willReadFrequently: true })!
    g.imageSmoothingEnabled = false
    const hair = ch.hairStyles?.[look.hairStyle] ?? 'hair-a'
    const wanted = new Set(['body', 'shoes', 'pants', 'shirt', hair])
    if (look.badge !== undefined) wanted.add('badge')
    if (look.glasses) wanted.add('glasses')
    if (look.headset) wanted.add('headset')
    if (look.player) for (const l of ch.player?.layers ?? ['cap', 'jacket']) wanted.add(l)
    const ramps = atlas.raw.palettes?.ramps ?? {}
    const rampFor = (layer: string): string[] | null => {
      const group = ch.recolor?.groups[layer]
      if (!group) return null
      if (look.player && (group === 'outfit' || group === 'jacket'))
        return ch.player?.ramps[group] ?? null
      if (look.player && layer === 'shirt') return ch.player?.ramps.jacket ?? null
      const base =
        group === 'skin'
          ? look.skin
          : group === 'shirt'
            ? look.shirt
            : group === 'pants'
              ? look.pants
              : group === 'hair'
                ? look.hair
                : group === 'badge'
                  ? look.badge
                  : undefined
      if (base === undefined) return ramps[group]?.default ?? null
      const r =
        ramps[group]?.[hex(base)] ?? (group === 'badge' ? ramps.shirt?.[hex(base)] : undefined)
      return r ?? [shade(base, 1.2), css(base), shade(base, 0.75), shade(base, 0.45)]
    }
    const poseInfo = ch.poses?.[ref]
    const drawProps = (behind: boolean) => {
      if (!poseInfo || poseInfo.propBehind !== behind) return
      for (const p of props) {
        const f = atlas.frame(`char:prop/${p}-${dir}`) ?? atlas.frame(`char:prop/${p}`)
        if (f)
          g.drawImage(
            f.image,
            f.x,
            f.y,
            f.w,
            f.h,
            poseInfo.hand[0] - f.ax,
            poseInfo.hand[1] - f.ay,
            f.w,
            f.h,
          )
      }
    }
    drawProps(true)
    for (const layer of ch.layers ?? []) {
      if (!wanted.has(layer)) continue
      const f = atlas.frame(`char:${layer}/${ref}`)
      if (!f) continue
      const ramp = rampFor(layer)
      if (!ramp || !ch.recolor) {
        g.drawImage(f.image, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h)
        continue
      }
      g.drawImage(recolor(f, ch.recolor.source, ramp), 0, 0)
    }
    drawProps(false)
    return c
  }

  count(): number {
    let n = 0
    for (const f of this.looks.values()) n += f.size
    return n
  }

  clear(): void {
    for (const f of this.looks.values()) for (const c of f.values()) c.width = c.height = 0
    this.looks.clear()
  }
}

const canvas = () => {
  const c = document.createElement('canvas')
  c.width = CHAR_W
  c.height = CHAR_H
  return c
}

/** One layer frame with the grey source ramp swapped for `ramp` (exact pixel matches only). */
function recolor(f: AtlasFrame, source: string[], ramp: string[]): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = f.w
  c.height = f.h
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(f.image, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h)
  const img = g.getImageData(0, 0, f.w, f.h)
  const d = img.data
  const from = source.map(rgb)
  const to = ramp.map(rgb)
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue
    for (let k = 0; k < from.length; k++) {
      const s = from[k]!
      if (d[i] === s[0] && d[i + 1] === s[1] && d[i + 2] === s[2]) {
        const t = to[Math.min(k, to.length - 1)]!
        d[i] = t[0]
        d[i + 1] = t[1]
        d[i + 2] = t[2]
        break
      }
    }
  }
  g.putImageData(img, 0, 0)
  return c
}

/** The procedural figure: hair, face, shirt, pants, shoes, then a dark outline. */
export function drawCharacter(
  g: CanvasRenderingContext2D,
  look: Look,
  dir: Dir4,
  anim: PixelAnim,
  frame: number,
): void {
  const px = (x: number, y: number, col: string, w = 1, h = 1) => {
    g.fillStyle = col
    g.fillRect(x, y, w, h)
  }
  const sitting = anim.startsWith('sit') || anim === 'read' || anim === 'lounge'
  const walk = anim === 'walk'
  const drop = anim === 'lounge' ? 4 : sitting ? 3 : 0
  const bob = (walk && frame % 2 === 1 ? -1 : 0) + (anim === 'idle' && frame === 1 ? 1 : 0)
  const u = drop + bob
  const skin = css(look.skin)
  const skinD = shade(look.skin, 0.82)
  const shirt = look.player ? '#3d5a80' : css(look.shirt)
  const shirtD = look.player ? '#2e436c' : shade(look.shirt, 0.78)
  const pants = css(look.pants)
  const pantsD = shade(look.pants, 0.75)
  const hair = css(look.hair)
  const hairD = shade(look.hair, 0.7)
  const shoe = '#2a2830'
  const side = dir === 'e' || dir === 'w'
  if (sitting) {
    px(5, 19 + Math.min(1, drop - 3), pants, 6, 2)
    px(5, 21, pantsD, 6, 1)
  } else if (side) {
    const a = walk ? [0, 1, 0, -1][frame]! : 0
    px(6 + a, 17, pants, 2, 4)
    px(8 - a, 17, pantsD, 2, 4)
    px(6 + a, 21, shoe, 3, 1)
    px(8 - a, 21, shoe, 3, 1)
  } else {
    const lift = walk ? [0, 1, 0, -1][frame]! : 0
    px(5, 17, pants, 3, 4 - Math.max(0, lift))
    px(8, 17, pants, 3, 4 - Math.max(0, -lift))
    px(7, 17, pantsD, 2, 1)
    px(5, 21 - Math.max(0, lift), shoe, 3, 1)
    px(8, 21 - Math.max(0, -lift), shoe, 3, 1)
  }
  px(4, 11 + u, shirt, 8, 6)
  px(4, 16 + u, shirtD, 8, 1)
  if (look.badge !== undefined && dir !== 'n') px(side ? 8 : 7, 13 + u, css(look.badge), 2, 2)
  const swing = walk ? [0, 1, 0, -1][frame]! : 0
  if (side) {
    px(7 + swing, 12 + u, shirtD, 2, 4)
    px(7 + swing, 16 + u, skin)
  } else {
    px(3, 12 + u + Math.max(0, swing), shirtD, 1, 4)
    px(3, 16 + u + Math.max(0, swing), skin)
    if (anim === 'wave' || anim === 'confused') {
      px(12, 7 + u + (frame === 1 ? 1 : 0), shirtD, 1, 5)
      px(12, 6 + u + (frame === 1 ? 1 : 0), skin)
    } else {
      px(12, 12 + u + Math.max(0, -swing), shirtD, 1, 4)
      px(12, 16 + u + Math.max(0, -swing), skin)
    }
  }
  const hy = 2 + u
  px(4, hy + 2, skin, 8, 7)
  px(4, hy + 8, skinD, 8, 1)
  if (dir === 'n') {
    px(4, hy + 1, hair, 8, 8)
    px(5, hy, hair, 6, 1)
    px(4, hy + 8, hairD, 8, 1)
  } else {
    px(5, hy, hair, 6, 1)
    px(4, hy + 1, hair, 8, 2)
    if (side) px(dir === 'e' ? 4 : 9, hy + 3, hair, 3, 4)
    const eye = '#1e1c24'
    if (side) px(dir === 'e' ? 10 : 5, hy + 5, eye)
    else (px(6, hy + 5, eye), px(9, hy + 5, eye))
    if (look.glasses && !side) px(5, hy + 4, '#5a6170', 6, 1)
  }
  if (look.player) {
    px(4, hy - 1, '#e07a5f', 8, 3)
    if (dir === 's') px(4, hy + 2, '#aa5a50', 8, 1)
  }
  // A 1 px dark outline around the opaque pixels (the GBA look).
  const img = g.getImageData(0, 0, CHAR_W, CHAR_H)
  const d = img.data
  const solid = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < CHAR_W && y < CHAR_H && d[(y * CHAR_W + x) * 4 + 3]! > 0
  const out: number[] = []
  for (let y = 0; y < CHAR_H; y++)
    for (let x = 0; x < CHAR_W; x++)
      if (
        !solid(x, y) &&
        (solid(x + 1, y) || solid(x - 1, y) || solid(x, y + 1) || solid(x, y - 1))
      )
        out.push((y * CHAR_W + x) * 4)
  for (const i of out) ((d[i] = 28), (d[i + 1] = 24), (d[i + 2] = 32), (d[i + 3] = 255))
  g.putImageData(img, 0, 0)
}
