// Ambient city schedules (docs/special-3d/rendering.md): which original ad a screen shows and how a
// neon sign flickers. Deterministic per seed, so captures repeat. Ambient motion never touches
// agent objects and never reflects agent state.

/** A small, fast deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Ad {
  /** Fictional brand, drawn as plain text at runtime with a mark built from primitives. */
  brand: string
  lines: string[]
  /** Two accent colours (art direction palette). */
  colors: [string, string]
  /** The mark: a few primitives (canvas-drawn). */
  mark: 'ring' | 'chevron' | 'hex' | 'bars' | 'diamond' | 'wave'
}

/** Original fictional advertisers. No game, film or real-world brands. */
export const ADS: readonly Ad[] = [
  {
    brand: 'Meridian Dynamics',
    lines: ['TOMORROW, ON SCHEDULE'],
    colors: ['#29e3ff', '#ffb02e'],
    mark: 'ring',
  },
  {
    brand: 'Halvane Optics',
    lines: ['SEE FURTHER', 'NIGHT LENS SERIES'],
    colors: ['#ff2bd6', '#29e3ff'],
    mark: 'diamond',
  },
  {
    brand: 'Nori-9 Noodles',
    lines: ['HOT IN 90 SECONDS'],
    colors: ['#ffb02e', '#e0202e'],
    mark: 'wave',
  },
  {
    brand: 'Vexa Mobility',
    lines: ['SKYLANE PASS', 'FLY ABOVE THE RAIN'],
    colors: ['#d7ff3a', '#29e3ff'],
    mark: 'chevron',
  },
  {
    brand: 'Orrin Cloudworks',
    lines: ['YOUR DATA, ELSEWHERE'],
    colors: ['#29e3ff', '#ff2bd6'],
    mark: 'hex',
  },
  {
    brand: 'Sable & Finch',
    lines: ['INSURANCE FOR', 'EVERY TOMORROW'],
    colors: ['#ffb02e', '#29e3ff'],
    mark: 'bars',
  },
  {
    brand: 'Kaito Pulse',
    lines: ['ENERGY THAT KEEPS UP'],
    colors: ['#e0202e', '#d7ff3a'],
    mark: 'chevron',
  },
  {
    brand: 'Lyra Sleep Pods',
    lines: ['REST, REDEFINED'],
    colors: ['#ff2bd6', '#ffb02e'],
    mark: 'ring',
  },
]

export const AD_PERIOD_MS = 12_000

/** A screen's own shuffled order of ads (Fisher–Yates on a seeded PRNG). */
export function adOrder(seed: number, screen: number): number[] {
  const rnd = mulberry32(seed * 7919 + screen * 104729 + 1)
  const order = ADS.map((_, i) => i)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[order[i], order[j]] = [order[j]!, order[i]!]
  }
  return order
}

/** The ad index a screen shows at `ms` (rotation off: the screen's first ad holds). */
export function adAt(seed: number, screen: number, ms: number, rotate: boolean): number {
  const order = adOrder(seed, screen)
  if (!rotate) return order[0]!
  // Screens are offset by a fraction of the period, so they never all change at once.
  const offset = (screen * AD_PERIOD_MS) / 3.7
  const slot = Math.floor((ms + offset) / AD_PERIOD_MS) - Math.floor(offset / AD_PERIOD_MS)
  return order[((slot % order.length) + order.length) % order.length]!
}

/** Integer hash → [0, 1). */
function hash01(n: number): number {
  let h = n | 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/**
 * Neon brightness (0–1) at `t` seconds for a sign seed: steady most of the time; in roughly one
 * 0.25 s slot out of twelve it stutters (a few short dips). `on` false: steady 1.
 */
export function flickerAt(seed: number, t: number, on = true): number {
  if (!on) return 1
  const slot = Math.floor(t * 4)
  if (hash01(slot * 31 + seed * 977) > 1 / 12) return 1
  const sub = Math.floor(t * 40)
  const r = hash01(sub * 13 + seed)
  return r < 0.45 ? 0.15 + r : 1
}
