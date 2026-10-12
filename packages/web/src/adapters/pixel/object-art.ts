// Pure atlas lookups for furniture art (plan §1.1, §1.5): which variant an object uses and its
// base, from atlas.json alone (no DOM), so the map invariants can run on the real atlas in Node.
// At GBA scale (16 px per metre) the base is `footPx` (px); atlases without it fall back to the
// older `foot` (tiles) × 16.
import { TILE_PX, type Dir4, type SpriteFoot } from '../../app/pixel/types.ts'

interface ArtVariant {
  frame: string
  themed?: boolean
  /** Base in 1 m tiles (derived: ceil(footPx / 16)); kept for the minimap and older atlases. */
  foot?: [number, number]
  /** Base in px (the solid box the art sits on). */
  footPx?: [number, number]
  /** Columns [left, right] kept at the ends when the art is stretched wider (the middle repeats). */
  stretch?: [number, number]
  /** Rows [top, bottom] of the frame kept when the art is stretched taller (the middle repeats). */
  stretchY?: [number, number]
  /** Frame rects [x, y, w, h] drawn at runtime: a desk's status screen, a sign's text. */
  screen?: [number, number, number, number]
  text?: [number, number, number, number]
  placeholder?: boolean
}
/** The slice of atlas.json these lookups read. */
export interface ArtAtlas {
  frames?: Record<string, unknown>
  objects?: Record<string, { variants: Record<string, ArtVariant | undefined> }>
  placeholders?: string[]
}

/** Which art an object uses (pure, from the raw atlas): frame name, base and rotation. */
export interface ObjectArt {
  frame: string
  themed: boolean
  /** Base in 1 m tiles (ceil of `footPx` / 16). */
  foot: [number, number]
  /** Base in px (after `rotated`). */
  footPx: [number, number]
  rotated: boolean
  stretch?: [number, number]
  stretchY?: [number, number]
  screen?: [number, number, number, number]
}

type Sized = ArtVariant & { px: [number, number] }
/** A variant's base in px: `footPx`, else `foot` × 16 (temporary, until every frame has `footPx`). */
const basePx = (v: ArtVariant): [number, number] | undefined =>
  v.footPx ?? (v.foot && [v.foot[0] * TILE_PX, v.foot[1] * TILE_PX])
const vertical = (v: Sized) => v.px[1] > v.px[0]

/** Frame names that have `name@…` variants (themed art), per raw atlas. */
const basesCache = new WeakMap<ArtAtlas, Set<string>>()
function themedBases(raw: ArtAtlas): Set<string> {
  let out = basesCache.get(raw)
  if (!out) {
    out = new Set()
    for (const k of Object.keys(raw.frames ?? {}))
      for (let i = k.indexOf('@'); i > 0; i = k.indexOf('@', i + 1)) out.add(k.slice(0, i))
    basesCache.set(raw, out)
  }
  return out
}

/**
 * The art for `kind` (plan §1.5). `orientation` undefined keeps the old rule (facing, else `s`).
 * `v`: a vertical facing variant (desk e/w), else `v`, else any vertical e/w, else `s` rotated.
 * `h`: the facing's variant when it isn't vertical, else `s`. Null when the kind has no art.
 */
export function objectArt(
  raw: ArtAtlas,
  kind: string,
  facing?: Dir4,
  orientation?: 'h' | 'v',
  named?: string,
  placeholders: ReadonlySet<string> = new Set(raw.placeholders ?? []),
): ObjectArt | null {
  const vs = raw.objects?.[kind]?.variants
  if (!vs) return null
  const frames = raw.frames ?? {}
  const themed = themedBases(raw)
  const exists = (v: ArtVariant) =>
    !placeholders.has(v.frame) && (!!frames[v.frame] || (!!v.themed && themed.has(v.frame)))
  const ok = (v: ArtVariant | undefined): Sized | undefined => {
    const px = v && !v.placeholder && exists(v) ? basePx(v) : undefined
    return px && { ...v!, px }
  }
  const art = (v: Sized, rotated = false): ObjectArt => {
    const px: [number, number] = rotated ? [v.px[1], v.px[0]] : [v.px[0], v.px[1]]
    return {
      frame: v.frame,
      themed: !!v.themed,
      foot: [Math.ceil(px[0] / TILE_PX), Math.ceil(px[1] / TILE_PX)],
      footPx: px,
      rotated,
      ...(!rotated && v.stretch && { stretch: v.stretch }),
      ...(!rotated && v.stretchY && { stretchY: v.stretchY }),
      ...(!rotated && v.screen && { screen: v.screen }),
    }
  }
  if (named) {
    const v = ok(vs[named])
    return v ? art(v) : null
  }
  const face = facing ? ok(vs[facing]) : undefined
  if (orientation === undefined) {
    const v = face ?? ok(vs.s)
    return v ? art(v) : null
  }
  if (orientation === 'v') {
    const v =
      (face && vertical(face) ? face : undefined) ??
      ok(vs.v) ??
      [vs.e, vs.w].map(ok).find((x) => x && vertical(x))
    if (v) return art(v)
    const s = ok(vs.s)
    return s ? (vertical(s) ? art(s) : art(s, s.px[0] !== s.px[1])) : null
  }
  const v = (face && !vertical(face) ? face : undefined) ?? ok(vs.s)
  return v ? art(v) : null
}

/**
 * The atlas-backed `SpriteFoot` for `buildPixelMap` (plan §1.1): the art's base in px for an
 * orientation. Kinds with only named states (booth-lamp, elevator-door) use their first state.
 */
export function spriteFootOf(raw: ArtAtlas): SpriteFoot {
  const placeholders = new Set(raw.placeholders ?? [])
  const cache = new Map<string, { w: number; h: number } | null>()
  return {
    foot(kind, orientation) {
      const k = `${kind}:${orientation}`
      if (cache.has(k)) return cache.get(k)!
      let art = objectArt(raw, kind, undefined, orientation, undefined, placeholders)
      if (!art)
        for (const name of Object.keys(raw.objects?.[kind]?.variants ?? {})) {
          art = objectArt(raw, kind, undefined, undefined, name, placeholders)
          if (art) break
        }
      const out = art && { w: art.footPx[0], h: art.footPx[1] }
      cache.set(k, out)
      return out
    },
  }
}
