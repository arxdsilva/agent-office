// Night City presets (plan §5.6, docs/special-3d/performance.md): the classic effective graphics
// (preset + Advanced overrides + power saver) plus `settings.special` → the features that run.
// Pure; the scene applies the result. Every animated system is off with reduced motion.
import type { SpecialSettings } from '@agent-office/shared'
import type { Effective } from '../graphics-types.ts'

/** Lighting hierarchy (art direction): at most four dynamic lights per room. */
export const MAX_DYNAMIC_LIGHTS = 4

type Level = 'low' | 'medium' | 'high' | 'ultra'

export interface SpecialFeatures {
  /** The level actually used (Minimal is treated as Low). */
  level: Level
  /** Pipeline levers for this mode (the classic ones with Night City's overrides). */
  gfx: Effective
  bloom: boolean
  fog: boolean
  /** Exponential height-fog density (per metre). */
  fogDensity: number
  /** Additive light-shaft cards under ceiling fixtures and the curtain wall. */
  shafts: boolean
  rain: boolean
  rainGlass: boolean
  rainDrops: number
  traffic: boolean
  trafficCars: number
  /** Skyline depth bands whose windows flicker (0–3; the rest are static). */
  animatedBands: 0 | 1 | 2 | 3
  windowFlicker: boolean
  neonFlicker: boolean
  /** Ad screens rotate every 12 s (else they hold the first ad). */
  adRotation: boolean
  /** One PMREM cube per room, rendered once after load (wet floors reflect it). */
  probes: boolean
  dynamicLights: number
  /**
   * Emissive restraint: the exported neon (6× white) and glow strips (2×) are scaled at runtime so
   * they read as crisp accent lines with a soft, tight bloom instead of glare.
   */
  emissive: {
    neon: number
    glow: number
    bloomStrength: number
    bloomRadius: number
    /** Probe reflection strength on the wet floors (1 = the full room cube: a mirror-like sheen). */
    floorReflection: number
  }
}

/** Same on every preset (Low has no bloom; the strips still must not glare). */
export const EMISSIVE = {
  neon: 0.3,
  glow: 0.6,
  bloomStrength: 0.16,
  bloomRadius: 0.18,
  floorReflection: 0.55,
} as const

interface LevelSpec {
  bloom: boolean
  fog: boolean
  rain: boolean
  rainDrops: number
  traffic: boolean
  trafficCars: number
  animatedBands: 0 | 1 | 2 | 3
  probes: boolean
  gtao: Effective['gtao']
  smaa: boolean
  scale: number
  fpsCap: number | null
  shadowMap: Effective['shadowMap']
  /** Device pixel ratio cap (the renderer still never exceeds the screen's). */
  pixelRatio: number
  dynamicLights: number
  /** Shafts need at least this atmosphere setting. */
  shaftsFrom: SpecialSettings['atmosphere'] | null
}

/** Ultra renders at the screen's own ratio (the renderer clamps to devicePixelRatio). */
const NATIVE_DPR = 3

const LEVELS: Readonly<Record<Level, LevelSpec>> = {
  low: {
    pixelRatio: 1,
    bloom: false,
    fog: false,
    rain: false,
    rainDrops: 0,
    traffic: false,
    trafficCars: 0,
    animatedBands: 0,
    probes: false,
    gtao: 'off',
    smaa: false,
    scale: 0.5,
    fpsCap: 30,
    shadowMap: 0,
    dynamicLights: 1,
    shaftsFrom: null,
  },
  medium: {
    pixelRatio: 1,
    bloom: true,
    fog: true,
    rain: true,
    rainDrops: 1500,
    traffic: false,
    trafficCars: 0,
    animatedBands: 1,
    probes: false,
    gtao: 'off',
    smaa: true,
    scale: 1,
    fpsCap: null,
    shadowMap: 0,
    dynamicLights: 2,
    shaftsFrom: 'medium',
  },
  high: {
    pixelRatio: 1.25,
    bloom: true,
    fog: true,
    rain: true,
    rainDrops: 3000,
    traffic: true,
    trafficCars: 40,
    animatedBands: 3,
    probes: true,
    // The baked lightmaps already carry ambient occlusion: no GTAO pass below Ultra.
    gtao: 'off',
    smaa: true,
    scale: 1,
    fpsCap: null,
    shadowMap: 1024,
    dynamicLights: 3,
    shaftsFrom: 'medium',
  },
  ultra: {
    pixelRatio: NATIVE_DPR,
    bloom: true,
    fog: true,
    rain: true,
    rainDrops: 5000,
    traffic: true,
    trafficCars: 80,
    animatedBands: 3,
    probes: true,
    gtao: 'half',
    smaa: true,
    scale: 1,
    fpsCap: null,
    shadowMap: 2048,
    dynamicLights: MAX_DYNAMIC_LIGHTS,
    shaftsFrom: 'low',
  },
}

const ATMOSPHERE = { low: 0, medium: 1, high: 2 } as const
const FOG_DENSITY = { low: 0.0015, medium: 0.003, high: 0.006 } as const

const levelOf = (e: Effective): Level => (e.preset === 'minimal' ? 'low' : e.preset)

/** A frame cap combined with the classic limit (0 = paused stays paused; the slower one wins). */
function capFps(limit: number | null, cap: number | null): number | null {
  if (limit === 0 || cap === null) return limit
  return limit === null ? cap : Math.min(limit, cap)
}

export function specialFeatures(
  e: Effective,
  s: Pick<SpecialSettings, 'atmosphere' | 'rain' | 'reducedMotion'>,
): SpecialFeatures {
  const level = levelOf(e)
  const spec = LEVELS[level]
  const motion = !s.reducedMotion
  const rain = spec.rain && s.rain && motion
  const atmosphere = ATMOSPHERE[s.atmosphere]
  const shafts = spec.shaftsFrom !== null && atmosphere >= ATMOSPHERE[spec.shaftsFrom] && spec.fog
  const gfx: Effective = {
    ...e,
    gtao: spec.gtao,
    bloom: spec.bloom,
    smaa: spec.smaa,
    resolutionScale: Math.min(e.resolutionScale, spec.scale),
    pixelRatioCap: spec.pixelRatio,
    fpsLimit: capFps(e.fpsLimit, spec.fpsCap),
    shadowMap: spec.shadowMap,
    shadows: spec.shadowMap ? 'full' : e.shadows === 'off' ? 'off' : 'contact',
  }
  return {
    level,
    gfx,
    bloom: spec.bloom,
    fog: spec.fog,
    fogDensity: spec.fog ? FOG_DENSITY[s.atmosphere] : 0,
    shafts,
    rain,
    rainGlass: rain,
    rainDrops: rain ? Math.round(spec.rainDrops * (s.atmosphere === 'high' ? 1.25 : 1)) : 0,
    traffic: spec.traffic && motion,
    trafficCars: spec.traffic && motion ? spec.trafficCars : 0,
    animatedBands: motion ? spec.animatedBands : 0,
    windowFlicker: motion && spec.animatedBands > 0,
    neonFlicker: motion,
    emissive: { ...EMISSIVE },
    adRotation: motion,
    probes: spec.probes,
    dynamicLights: Math.min(MAX_DYNAMIC_LIGHTS, spec.dynamicLights),
  }
}
