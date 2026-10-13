// Horizon's daylight environment (docs/horizon/rendering.md, art direction "Sky and outside"): a
// soft sky gradient, a 5600 K sun at 40° with a pale hemisphere fill (dynamic objects only: the
// lightmaps already carry the bake), Neutral tone mapping at exposure 0.85 (AgX flattened the pale
// palette into a milky haze), a weak tight bloom so only the light lines glow, and a static pale
// skyline. Implements the scene's `SceneEnvironment` seam.
import * as THREE from 'three'
import type { AABB } from '../../app/office-types.ts'
import type { EnvironmentLight, SceneEnvironment } from '../../adapters/three/scene.ts'
import type { PipelineConfig } from '../../adapters/three/render-pipeline.ts'
import { Skyline } from './skyline.ts'

/** Sky gradient stops, top (zenith) to bottom (below the horizon). */
const SKY: [number, string][] = [
  [0, '#cfe6f7'],
  [0.4, '#e3eef8'],
  [0.5, '#f4f7fa'],
  [0.58, '#eef2f5'],
  [1, '#e3e8ec'],
]
const HAZE = 0xf1f5f8
/** 40° elevation, from the same side as Classic's sun. */
const ELEVATION = (40 * Math.PI) / 180
const SUN_AZIMUTH = Math.atan2(0.3, -0.45)

export const HORIZON_LIGHT: EnvironmentLight = {
  sky: 0xe8f1fb,
  ground: 0xd8d2c6,
  // Dynamic objects only (the baked surfaces ignore both): enough to light the characters.
  fill: 0.35,
  environment: 0.7,
  sun: {
    color: 0xfff1e4,
    intensity: 1.5,
    dir: [
      Math.cos(ELEVATION) * Math.cos(SUN_AZIMUTH),
      Math.sin(ELEVATION),
      Math.cos(ELEVATION) * Math.sin(SUN_AZIMUTH),
    ],
  },
}

export const HORIZON_PIPELINE: PipelineConfig = {
  // Baked whites stay below 1.2 in linear HDR; only the light lines (≤ 1.5) bloom, faintly.
  bloom: { threshold: 1.2, strength: 0.12, radius: 0.15 },
  exposure: 0.85,
  // Neutral keeps whites white and accents soft but present; AgX lifted and desaturated them.
  toneMapping: THREE.NeutralToneMapping,
}

/** The Horizon bake is brighter than Classic's: keep pale surfaces below clipping. */
export const HORIZON_LIGHTMAP_SCALE = 0.55

/** The sky as an equirectangular gradient (one column; three draws it as the background). */
function skyTexture(): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = 2
  c.height = 256
  const g = c.getContext('2d')!
  const grad = g.createLinearGradient(0, 0, 0, c.height)
  for (const [at, color] of SKY) grad.addColorStop(at, color)
  g.fillStyle = grad
  g.fillRect(0, 0, c.width, c.height)
  const t = new THREE.CanvasTexture(c)
  t.mapping = THREE.EquirectangularReflectionMapping
  t.colorSpace = THREE.SRGBColorSpace
  t.name = 'horizon:sky'
  return t
}

export class HorizonEnvironment implements SceneEnvironment {
  readonly pipeline = HORIZON_PIPELINE
  readonly light = HORIZON_LIGHT
  private sky: THREE.Texture | null = null
  private skyline: Skyline | null = null
  private scene: THREE.Scene | null = null

  attach(scene: THREE.Scene): void {
    this.scene = scene
    this.sky = skyTexture()
    scene.background = this.sky
    scene.backgroundIntensity = 1.0
    const sun = new THREE.Vector3(...this.light.sun.dir)
    this.skyline = new Skyline({
      facadeA: 0xe3e8ee,
      facadeB: 0xc9d2db,
      glass: 0xb9c9d8,
      haze: HAZE,
      sun,
    })
    scene.add(this.skyline.group)
  }

  place(bounds: AABB): void {
    this.skyline?.place(bounds)
  }

  dispose(): void {
    this.skyline?.dispose()
    this.skyline = null
    if (this.scene && this.scene.background === this.sky) this.scene.background = null
    this.sky?.dispose()
    this.sky = null
    this.scene = null
  }
}
