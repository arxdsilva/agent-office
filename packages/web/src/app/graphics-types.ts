// Contract for graphics settings (low-spec plan §4.3, §5). Pure data. Owned by the lead;
// quality.ts implements `effectiveGraphics` and the presets that produce these shapes.
import type { GraphicsAdvanced, GraphicsQuality } from '@agent-office/shared'

export type Preset = Exclude<GraphicsQuality, 'auto'>

export type ShadowMode = 'off' | 'contact' | 'full'
export type LabelMode = 'selected' | 'nearby' | 'all'
export type LinkMode = 'off' | 'static' | 'animated'
export type LightmapTier = 'full' | 'half' | 'quarter'

/** What the scene applies: preset ⊕ advanced overrides ⊕ power state. */
export interface Effective {
  /** The preset in force (the battery preset while on battery, when configured). */
  preset: Preset
  /** Multiplies the capped device pixel ratio (0.5–1). */
  resolutionScale: number
  pixelRatioCap: number
  /** null = every animation frame; 0 = paused (hidden window). */
  fpsLimit: number | null
  shadows: ShadowMode
  shadowMap: 0 | 1024 | 2048 | 4096
  bloom: boolean
  smaa: boolean
  gtao: 'off' | 'half' | 'full'
  /** Character animation LOD distances [near, far] in metres. */
  lod: [number, number]
  maxAnimated: number
  labels: { mode: LabelMode; nearbyM: number }
  links: LinkMode
  /** Furniture/detail cull distance (m). */
  detailCullM: number
  lightmapTier: LightmapTier
  envMap: boolean
  /** Hover raycasts for surface tooltips (off on Minimal). */
  hover: boolean
  /** Renderer `powerPreference` used at the next start (changing it needs a reload). */
  powerPreference: 'low-power' | 'default' | 'high-performance'
}

export interface PowerInput {
  focused: boolean
  hidden: boolean
  onBattery: boolean
}

export interface SaverInput {
  blur: boolean
  hidden: boolean
  battery: Preset | 'off'
}

export interface EffectiveInput {
  preset: Preset
  advanced: GraphicsAdvanced
  dpr: number
  power: PowerInput
  saver: SaverInput
}

/** What the renderer learned about the GPU (from WEBGL_debug_renderer_info and navigator). */
export interface HardwareInfo {
  renderer: string
  vendor: string
  maxTextureSize: number
  dpr: number
  cores: number
  memoryGB?: number
  webgl2: boolean
}

export type TierReason = 'software' | 'integrated' | 'lowMemory' | 'hiDpi' | 'capable'

export interface Tier {
  start: Preset
  ceiling: Preset
  why: TierReason
}

/** Live numbers for Settings → Graphics and `?stats`. */
export interface GraphicsStats {
  fps: number
  drawCalls: number
  triangles: number
  textureMB: number
  geometryMB: number
  width: number
  height: number
}

/** Frame rate when the window isn't focused (power saver). */
export const BLUR_FPS = 15
