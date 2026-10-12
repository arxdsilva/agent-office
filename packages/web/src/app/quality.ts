// Render quality presets (plan §4.2) and the Auto governor. Pure: the scene feeds it frame rates.
import type { GraphicsQuality } from '@agent-office/shared'

export type Preset = Exclude<GraphicsQuality, 'auto'>
export const PRESET_ORDER: readonly Preset[] = ['low', 'medium', 'high', 'ultra']

export interface PresetSpec {
  /** Upper bound for the device pixel ratio. */
  maxPixelRatio: number
  /** Directional shadow map size; 0 = blob shadows only. */
  shadowMap: 0 | 1024 | 2048 | 4096
  /** Ambient occlusion pass: off, half resolution, full, full with more samples. */
  gtao: 'off' | 'half' | 'full' | 'high'
  bloom: boolean
  smaa: boolean
  /** Character animation LOD distances (m): full rate below [0], reduced up to [1], LOD1 beyond. */
  lod: [number, number]
  /** Most characters animated at once; the farthest beyond this become impostors. */
  maxAnimated: number
}

export const PRESETS: Readonly<Record<Preset, PresetSpec>> = {
  low: {
    maxPixelRatio: 1,
    shadowMap: 0,
    gtao: 'off',
    bloom: false,
    smaa: false,
    lod: [8, 20],
    maxAnimated: 60,
  },
  medium: {
    maxPixelRatio: 1.5,
    shadowMap: 1024,
    gtao: 'half',
    bloom: true,
    smaa: true,
    lod: [15, 35],
    maxAnimated: 120,
  },
  high: {
    maxPixelRatio: 2,
    shadowMap: 2048,
    gtao: 'full',
    bloom: true,
    smaa: true,
    lod: [20, 45],
    maxAnimated: 150,
  },
  ultra: {
    maxPixelRatio: Infinity,
    shadowMap: 4096,
    gtao: 'high',
    bloom: true,
    smaa: true,
    lod: [30, 60],
    maxAnimated: 250,
  },
}

export const pixelRatioFor = (p: Preset, dpr: number) => Math.min(dpr, PRESETS[p].maxPixelRatio)

export const resolvePreset = (q: GraphicsQuality, auto: Preset): Preset => (q === 'auto' ? auto : q)

/** Auto starts here and never climbs past it (Ultra is opt-in only). */
export const AUTO_MAX: Preset = 'high'
export const DOWN_FPS = 50
export const DOWN_AFTER_S = 3
export const UP_FPS = 58
export const UP_AFTER_S = 10
/** A level the governor had to leave this many times is not tried again. */
export const MAX_FAILURES = 2

export interface Governor {
  readonly preset: Preset
  /** One averaged sample: `fps` over the last `dt` seconds. Returns the new preset when it changes. */
  sample(fps: number, dt: number): Preset | null
  reset(): void
}

export function createGovernor(): Governor {
  let level = PRESET_ORDER.indexOf(AUTO_MAX)
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
    sample(fps, dt) {
      slow = fps < DOWN_FPS ? slow + dt : 0
      fast = fps > UP_FPS ? fast + dt : 0
      if (slow >= DOWN_AFTER_S - 1e-9 && level > 0) {
        failures.set(level, (failures.get(level) ?? 0) + 1)
        return change(level - 1)
      }
      const up = level + 1
      if (
        fast >= UP_AFTER_S - 1e-9 &&
        up <= PRESET_ORDER.indexOf(AUTO_MAX) &&
        (failures.get(up) ?? 0) < MAX_FAILURES
      )
        return change(up)
      return null
    },
    reset() {
      failures = new Map()
      change(PRESET_ORDER.indexOf(AUTO_MAX))
    },
  }
}
