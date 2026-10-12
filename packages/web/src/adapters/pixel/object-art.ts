// Pure atlas lookups for furniture art (plan §1.1, §1.5): which variant an object uses and its
// footprint, from atlas.json alone (no DOM), so the map invariants can run on the real atlas in Node.
import type { Dir4, SpriteFoot } from '../../app/pixel/types.ts'

interface ArtVariant {
  frame: string
  themed?: boolean
  foot?: [number, number]
  placeholder?: boolean
}
/** The slice of atlas.json these lookups read. */
export interface ArtAtlas {
  frames?: Record<string, unknown>
  objects?: Record<string, { variants: Record<string, ArtVariant | undefined> }>
  placeholders?: string[]
}

/** Which art an object uses (pure, from the raw atlas): frame name, footprint and rotation. */
export interface ObjectArt {
  frame: string
  themed: boolean
  foot: [number, number]
  rotated: boolean
}

const vertical = (f: [number, number]) => f[1] > f[0]

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
  const ok = (v: ArtVariant | undefined): (ArtVariant & { foot: [number, number] }) | undefined =>
    v && !v.placeholder && v.foot && exists(v)
      ? (v as ArtVariant & { foot: [number, number] })
      : undefined
  const art = (v: ArtVariant & { foot: [number, number] }, rotated = false): ObjectArt => ({
    frame: v.frame,
    themed: !!v.themed,
    foot: rotated ? [v.foot[1], v.foot[0]] : [v.foot[0], v.foot[1]],
    rotated,
  })
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
      (face && vertical(face.foot) ? face : undefined) ??
      ok(vs.v) ??
      [vs.e, vs.w].map(ok).find((x) => x && vertical(x.foot))
    if (v) return art(v)
    const s = ok(vs.s)
    return s ? (vertical(s.foot) ? art(s) : art(s, s.foot[0] !== s.foot[1])) : null
  }
  const v = (face && !vertical(face.foot) ? face : undefined) ?? ok(vs.s)
  return v ? art(v) : null
}

/**
 * The atlas-backed `SpriteFoot` for `buildPixelMap` (plan §1.1): the art's footprint in tiles for an
 * orientation. Kinds with only named states (booth-lamp, elevator-door) use their first state.
 */
export function spriteFootOf(raw: ArtAtlas): SpriteFoot {
  const placeholders = new Set(raw.placeholders ?? [])
  const cache = new Map<string, { tw: number; th: number } | null>()
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
      const out = art && { tw: art.foot[0], th: art.foot[1] }
      cache.set(k, out)
      return out
    },
  }
}
