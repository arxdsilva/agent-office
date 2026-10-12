// Post-processing chain (plan §4.2): RenderPass → GTAO → bloom → OutputPass (AgX, sRGB) → SMAA,
// configured per quality preset. Low renders straight to the screen (no composer).
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { PRESETS, pixelRatioFor, type Preset } from '../../app/quality.ts'

// Threshold above the plan's 0.85: baked white walls reach ~1.0 in linear HDR and would glow.
export const BLOOM = { threshold: 1.15, strength: 0.35, radius: 0.5 }
const GTAO_SAMPLES = { off: 0, half: 8, full: 12, high: 24 } as const

export interface FrameStats {
  fps: number
  drawCalls: number
  triangles: number
}

export class RenderPipeline {
  private composer: EffectComposer
  private renderPass: RenderPass
  private gtao: GTAOPass
  private bloom: UnrealBloomPass
  private output = new OutputPass()
  private smaa = new SMAAPass()
  private preset: Preset = 'high'
  private size = new THREE.Vector2(1, 1)
  private gtaoScale = 1
  readonly stats: FrameStats = { fps: 0, drawCalls: 0, triangles: 0 }
  private frames = 0
  private frameTime = 0

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
  ) {
    renderer.toneMapping = THREE.AgXToneMapping
    renderer.toneMappingExposure = 1
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.info.autoReset = false
    this.composer = new EffectComposer(renderer)
    this.renderPass = new RenderPass(scene, camera)
    this.gtao = new GTAOPass(scene, camera, 1, 1)
    this.gtao.blendIntensity = 0.75
    this.gtao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 1.2, scale: 1 })
    this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6 })
    // Half-resolution AO for Medium: the composer passes full size; scale it here.
    const setSize = this.gtao.setSize.bind(this.gtao)
    this.gtao.setSize = (w: number, h: number) => setSize(w * this.gtaoScale, h * this.gtaoScale)
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(256, 256),
      BLOOM.strength,
      BLOOM.radius,
      BLOOM.threshold,
    )
    for (const p of [this.renderPass, this.gtao, this.bloom, this.output, this.smaa])
      this.composer.addPass(p)
  }

  get current(): Preset {
    return this.preset
  }

  setPreset(p: Preset): void {
    this.preset = p
    const spec = PRESETS[p]
    this.gtaoScale = spec.gtao === 'half' ? 0.5 : 1
    this.gtao.enabled = spec.gtao !== 'off'
    if (spec.gtao !== 'off') this.gtao.updateGtaoMaterial({ samples: GTAO_SAMPLES[spec.gtao] })
    this.bloom.enabled = spec.bloom
    this.smaa.enabled = spec.smaa
    const r = this.renderer
    r.shadowMap.enabled = spec.shadowMap > 0
    r.shadowMap.type = THREE.PCFShadowMap
    this.resize(this.size.x, this.size.y)
  }

  /** Diagnostics (debug hook): toggle one pass on top of the preset. */
  setPass(name: 'gtao' | 'bloom' | 'smaa', on: boolean): void {
    this[name].enabled = on
  }

  /** Shadow map size of the current preset (0 = blob shadows only). */
  get shadowMapSize(): number {
    return PRESETS[this.preset].shadowMap
  }

  resize(w: number, h: number): void {
    this.size.set(w, h)
    const pr = pixelRatioFor(this.preset, devicePixelRatio)
    this.renderer.setPixelRatio(pr)
    this.renderer.setSize(w, h)
    this.composer.setPixelRatio(pr)
    this.composer.setSize(w, h)
  }

  /** Renders one frame and samples stats (FPS over ~0.5 s windows). Returns a window average or null. */
  render(dt: number): { fps: number; dt: number } | null {
    this.renderer.info.reset()
    if (this.preset === 'low') this.renderer.render(this.scene, this.camera)
    else this.composer.render(dt)
    this.stats.drawCalls = this.renderer.info.render.calls
    this.stats.triangles = this.renderer.info.render.triangles
    this.frames++
    this.frameTime += dt
    if (this.frameTime < 0.5) return null
    const sample = { fps: this.frames / this.frameTime, dt: this.frameTime }
    this.stats.fps = sample.fps
    this.frames = 0
    this.frameTime = 0
    return sample
  }

  dispose(): void {
    this.composer.dispose()
    this.gtao.dispose()
    this.bloom.dispose()
  }
}
