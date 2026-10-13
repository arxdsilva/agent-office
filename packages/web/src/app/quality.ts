// Render quality presets (low-spec plan §2.2), `effectiveGraphics` (preset ⊕ advanced ⊕ power,
// §5.5) and the Auto governor. Pure: the controller feeds it inputs, the scene applies the result.
import type { GraphicsAdvanced, GraphicsQuality } from '@agent-office/shared'
import {
  BLUR_FPS,
  type Effective,
  type EffectiveInput,
  type LabelMode,
  type LightmapTier,
  type LinkMode,
  type Preset,
  type ShadowMode,
} from './graphics-types.ts'

export type { Preset } from './graphics-types.ts'
export const PRESET_ORDER: readonly Preset[] = ['minimal', 'low', 'medium', 'high', 'ultra']

type Level = 'low' | 'medium' | 'high'

export interface PresetSpec {
  /** Multiplies the capped device pixel ratio. */
  resolutionScale: number
  /** Upper bound for the device pixel ratio. */
  maxPixelRatio: number
  /** null = every animation frame. */
  fpsLimit: number | null
  shadows: ShadowMode
  /** Directional shadow map size; 0 = no sun shadows. */
  shadowMap: 0 | 1024 | 2048 | 4096
  /** Ambient occlusion pass: off, half resolution or full. */
  gtao: 'off' | 'half' | 'full'
  bloom: boolean
  smaa: boolean
  /** Character animation LOD distances (m): full rate below [0], reduced up to [1], LOD1 beyond. */
  lod: [number, number]
  /** Most characters animated at once; the farthest beyond this become impostors. */
  maxAnimated: number
  /** The Character detail level this preset counts as ("Auto · Low"). */
  characters: Level
  labels: { mode: LabelMode; nearbyM: number }
  links: LinkMode
  /** The Building detail level this preset counts as. */
  building: Level
  detailCullM: number
  lightmapTier: LightmapTier
  envMap: boolean
  hover: boolean
  powerPreference: Effective['powerPreference']
}

const FX = {
  off: { bloom: false, smaa: false, gtao: 'off' },
  medium: { bloom: true, smaa: true, gtao: 'off' },
  high: { bloom: true, smaa: true, gtao: 'half' },
  ultra: { bloom: true, smaa: true, gtao: 'full' },
} as const

/** Character detail levels for the Advanced override (the Low/Medium/High presets' values). */
export const CHARACTERS: Readonly<Record<Level, Pick<PresetSpec, 'lod' | 'maxAnimated'>>> = {
  low: { lod: [8, 20], maxAnimated: 60 },
  medium: { lod: [15, 35], maxAnimated: 120 },
  high: { lod: [20, 45], maxAnimated: 150 },
}

/** Building detail levels for the Advanced override (detail-cull distance, lightmap tier). */
export const BUILDING: Readonly<Record<Level, Pick<PresetSpec, 'detailCullM' | 'lightmapTier'>>> = {
  low: { detailCullM: 24, lightmapTier: 'half' },
  medium: { detailCullM: 32, lightmapTier: 'half' },
  high: { detailCullM: 32, lightmapTier: 'full' },
}

/** Name-tag radius in Nearby mode when the preset doesn't set one (m). */
export const NEARBY_M = 30

export const PRESETS: Readonly<Record<Preset, PresetSpec>> = {
  minimal: {
    resolutionScale: 0.75,
    maxPixelRatio: 1,
    fpsLimit: 30,
    shadows: 'off',
    shadowMap: 0,
    ...FX.off,
    lod: [6, 12],
    maxAnimated: 24,
    characters: 'low',
    labels: { mode: 'nearby', nearbyM: 15 },
    links: 'static',
    building: 'low',
    detailCullM: 16,
    lightmapTier: 'quarter',
    envMap: false,
    hover: false,
    powerPreference: 'low-power',
  },
  low: {
    resolutionScale: 1,
    maxPixelRatio: 1,
    fpsLimit: 60,
    shadows: 'contact',
    shadowMap: 0,
    ...FX.off,
    ...CHARACTERS.low,
    characters: 'low',
    labels: { mode: 'nearby', nearbyM: NEARBY_M },
    links: 'static',
    building: 'low',
    ...BUILDING.low,
    envMap: true,
    hover: true,
    powerPreference: 'low-power',
  },
  medium: {
    resolutionScale: 1,
    maxPixelRatio: 1.5,
    fpsLimit: 60,
    shadows: 'full',
    shadowMap: 1024,
    ...FX.medium,
    ...CHARACTERS.medium,
    characters: 'medium',
    labels: { mode: 'all', nearbyM: NEARBY_M },
    links: 'animated',
    building: 'medium',
    ...BUILDING.medium,
    envMap: true,
    hover: true,
    powerPreference: 'default',
  },
  high: {
    resolutionScale: 1,
    maxPixelRatio: 2,
    fpsLimit: null,
    shadows: 'full',
    shadowMap: 2048,
    ...FX.high,
    ...CHARACTERS.high,
    characters: 'high',
    labels: { mode: 'all', nearbyM: NEARBY_M },
    links: 'animated',
    building: 'high',
    ...BUILDING.high,
    envMap: true,
    hover: true,
    powerPreference: 'high-performance',
  },
  ultra: {
    resolutionScale: 1,
    maxPixelRatio: Infinity,
    fpsLimit: null,
    shadows: 'full',
    shadowMap: 4096,
    ...FX.ultra,
    lod: [30, 60],
    maxAnimated: 250,
    characters: 'high',
    labels: { mode: 'all', nearbyM: NEARBY_M },
    links: 'animated',
    building: 'high',
    detailCullM: 48,
    lightmapTier: 'full',
    envMap: true,
    hover: true,
    powerPreference: 'high-performance',
  },
}

/** The pixel-ratio cap alone (kept for the render pipeline's preset path). */
export const pixelRatioFor = (p: Preset, dpr: number) => Math.min(dpr, PRESETS[p].maxPixelRatio)
/** The drawing-buffer pixel ratio a preset uses: capped DPR × resolution scale. */
export const presetPixelRatio = (p: Preset, dpr: number) =>
  pixelRatioFor(p, dpr) * PRESETS[p].resolutionScale
/** The pixel ratio the scene sets for an `Effective`. */
export const pixelRatioOf = (e: Pick<Effective, 'pixelRatioCap' | 'resolutionScale'>) =>
  e.pixelRatioCap * e.resolutionScale

export const resolvePreset = (q: GraphicsQuality, auto: Preset): Preset => (q === 'auto' ? auto : q)

const FPS = { '30': 30, '60': 60, unlimited: null } as const
const auto = <K extends keyof GraphicsAdvanced>(a: GraphicsAdvanced, k: K) =>
  a[k] === 'auto' ? undefined : (a[k] as Exclude<GraphicsAdvanced[K], 'auto'>)

/** What the scene applies: the preset (or battery preset), advanced overrides, then power saver. */
export function effectiveGraphics(i: EffectiveInput): Effective {
  const preset = i.power.onBattery && i.saver.battery !== 'off' ? i.saver.battery : i.preset
  const p = PRESETS[preset]
  const a = i.advanced
  const fpsSet = auto(a, 'fps')
  let fpsLimit = fpsSet === undefined ? p.fpsLimit : FPS[fpsSet]
  if (i.power.hidden && i.saver.hidden) fpsLimit = 0
  else if (!i.power.focused && i.saver.blur) fpsLimit = Math.min(fpsLimit ?? BLUR_FPS, BLUR_FPS)
  const shadows = auto(a, 'shadows') ?? p.shadows
  const effects = auto(a, 'effects')
  const fx =
    effects === 'off'
      ? FX.off
      : effects === 'on' && !p.bloom
        ? FX.medium
        : { bloom: p.bloom, smaa: p.smaa, gtao: p.gtao }
  const characters = auto(a, 'characters')
  const ch = characters ? CHARACTERS[characters] : p
  const building = auto(a, 'building')
  const bd = building ? BUILDING[building] : p
  const res = auto(a, 'resolution')
  return {
    preset,
    resolutionScale: res === undefined ? p.resolutionScale : Number(res),
    pixelRatioCap: Math.min(i.dpr, p.maxPixelRatio),
    fpsLimit,
    shadows,
    shadowMap: shadows === 'full' ? p.shadowMap || 1024 : 0,
    bloom: fx.bloom,
    smaa: fx.smaa,
    gtao: fx.gtao,
    lod: [ch.lod[0], ch.lod[1]],
    maxAnimated: ch.maxAnimated,
    labels: {
      mode: auto(a, 'labels') ?? i.labelsDefault ?? p.labels.mode,
      nearbyM: p.labels.nearbyM,
    },
    links: auto(a, 'links') ?? p.links,
    detailCullM: bd.detailCullM,
    lightmapTier: bd.lightmapTier,
    envMap: p.envMap,
    hover: p.hover,
    powerPreference: p.powerPreference,
  }
}

/** Auto's default start and ceiling when no hardware tier is known (Ultra is opt-in only). */
export const AUTO_MAX: Preset = 'high'
export const DOWN_FPS = 50
export const DOWN_AFTER_S = 3
export const UP_FPS = 58
export const UP_AFTER_S = 10
/** A level the governor had to leave this many times is not tried again. */
export const MAX_FAILURES = 2
/** The thresholds above are for an uncapped (≥ 60 fps) display. */
const REF_FPS = 60

export interface Governor {
  readonly preset: Preset
  /**
   * One averaged sample: `fps` over the last `dt` seconds, judged against the frame-rate limit in
   * force (`limit`; null/undefined = uncapped, 0 = paused, ignored). Returns the new preset when it
   * changes.
   */
  sample(fps: number, dt: number, limit?: number | null): Preset | null
  reset(): void
}

export function createGovernor(opts: { start?: Preset; ceiling?: Preset } = {}): Governor {
  const start = PRESET_ORDER.indexOf(opts.start ?? AUTO_MAX)
  const ceiling = Math.max(start, PRESET_ORDER.indexOf(opts.ceiling ?? AUTO_MAX))
  // Minimal is only for machines that start there (software rendering); others stop at Low.
  const floor = Math.min(start, PRESET_ORDER.indexOf('low'))
  let level = start
  let slow = 0
  let fast = 0
  let failures = new Map<number, number>()
  const change = (to: number) => {
    level = to
    slow = fast = 0
    return PRESET_ORDER[level]!
  }
  return {
    get preset() {
      return PRESET_ORDER[level]!
    },
    sample(fps, dt, limit) {
      if (limit === 0) return null
      // Under a low cap, slow is judged relative to it, and hitting it proves no headroom.
      const capped = !!limit && limit < REF_FPS
      slow = fps < DOWN_FPS * (capped ? limit / REF_FPS : 1) ? slow + dt : 0
      fast = !capped && fps > UP_FPS ? fast + dt : 0
      if (slow >= DOWN_AFTER_S - 1e-9 && level > floor) {
        failures.set(level, (failures.get(level) ?? 0) + 1)
        return change(level - 1)
      }
      const up = level + 1
      if (fast >= UP_AFTER_S - 1e-9 && up <= ceiling && (failures.get(up) ?? 0) < MAX_FAILURES)
        return change(up)
      return null
    },
    reset() {
      failures = new Map()
      change(start)
    },
  }
}
