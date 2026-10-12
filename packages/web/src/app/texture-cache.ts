// Pure parts of the asset cache (low-spec plan §5.4–§5.5): one GPU texture per content hash across
// modules, lightmap variant choice with the PNG fallback, and texture byte accounting for stats().
import type { LightmapTier } from './graphics-types.ts'

export interface TextureDedup<T> {
  /** The texture to use for `hash`; `duplicate` is `tex` when another one already holds the hash. */
  register(tex: T, hash: string | undefined): { use: T; duplicate: T | null }
  /** Every distinct texture kept (for VRAM accounting). */
  unique(): T[]
  readonly size: number
  clear(): void
}

export function createTextureDedup<T>(): TextureDedup<T> {
  const byHash = new Map<string, T>()
  const kept = new Set<T>()
  return {
    register(tex, hash) {
      const first = hash === undefined ? undefined : byHash.get(hash)
      if (first !== undefined && first !== tex) return { use: first, duplicate: tex }
      if (hash !== undefined) byHash.set(hash, tex)
      kept.add(tex)
      return { use: tex, duplicate: null }
    },
    unique: () => [...kept],
    get size() {
      return kept.size
    },
    clear() {
      byHash.clear()
      kept.clear()
    },
  }
}

const HASH = /^[0-9a-f]{12}$/

/** The content hash from a glTF image's `extras` (sha1, 12 hex chars; contract §6b). */
export function textureHash(extras: unknown): string | undefined {
  if (typeof extras !== 'object' || extras === null) return undefined
  const h = (extras as { hash?: unknown }).hash
  return typeof h === 'string' && HASH.test(h) ? h : undefined
}

export interface LightmapRef {
  /** PNG, kept for older readers. */
  file: string
  variants?: Partial<Record<LightmapTier, string>>
}

/** The lightmap file for a tier: its KTX2 variant, the full variant, else the PNG fallback. */
export function lightmapSource(
  lm: LightmapRef,
  tier: LightmapTier,
): { url: string; ktx2: boolean } {
  const v = lm.variants?.[tier] ?? lm.variants?.full
  return v ? { url: v, ktx2: true } : { url: lm.file, ktx2: false }
}

/** Bytes per pixel on the GPU: RGBA8 4; BC7/ASTC/ETC2 (transcoded KTX2) 1; BC1/ETC1 0.5. */
export const BYTES_PER_PIXEL = { rgba8: 4, compressed: 1, bc1: 0.5 } as const

export const textureBytes = (
  w: number,
  h: number,
  format: keyof typeof BYTES_PER_PIXEL,
  mips: boolean,
) => w * h * BYTES_PER_PIXEL[format] * (mips ? 4 / 3 : 1)
