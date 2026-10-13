// Post-processing chain (plan §4.2): RenderPass → GTAO → bloom → OutputPass (AgX, sRGB) → SMAA,
// configured from the effective graphics (low-spec plan §5.3). With every effect off it renders
// straight to the screen (no composer).
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import type { Effective } from '../../app/graphics-types.ts'
import { patchWallMaterial } from './wall-cutaway.ts'

// Threshold above the plan's 0.85: baked white walls reach ~1.0 in linear HDR and would glow.
export const BLOOM = { threshold: 1.15, strength: 0.35, radius: 0.5 }
/** AO samples: half resolution (High), full (custom "Effects: On"), Ultra. */
const GTAO_SAMPLES = { half: 8, full: 12, ultra: 24 } as const

/**
 * A scene flavor's pipeline. Every field is optional: the defaults are Classic 3D's chain exactly.
 * A flavor may pass its own bloom and exposure.
 */
export interface PipelineConfig {
  bloom?: { threshold: number; strength: number; radius: number }
  exposure?: number
  /** Tone mapping (Classic: AgX). */
  toneMapping?: THREE.ToneMapping
}

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
  private size = new THREE.Vector2(1, 1)
  private gtaoScale = 1
  private direct = false
  private pixelRatio = 1
  private cap = 2
  private scale = 1
  readonly stats: FrameStats = { fps: 0, drawCalls: 0, triangles: 0 }
  private frames = 0
  private frameTime = 0

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    config: PipelineConfig = {},
  ) {
    renderer.toneMapping = config.toneMapping ?? THREE.AgXToneMapping
    renderer.toneMappingExposure = config.exposure ?? 1
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.info.autoReset = false
    this.composer = new EffectComposer(renderer)
    this.renderPass = new RenderPass(scene, camera)
    this.gtao = new GTAOPass(scene, camera, 1, 1)
    this.gtao.blendIntensity = 0.75
    this.gtao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 1.2, scale: 1 })
    this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6 })
    // Wall cutaway (contract §13): AO's normal/depth pass skips faded and lowered wall fragments too,
    // so a hidden wall leaves no dark halo. (Building meshes cast no shadows: castShadow is off.)
    patchWallMaterial(this.gtao.normalMaterial, 'gtao-normal')
    // Half-resolution AO for Medium: the composer passes full size; scale it here.
    const setSize = this.gtao.setSize.bind(this.gtao)
    this.gtao.setSize = (w: number, h: number) => setSize(w * this.gtaoScale, h * this.gtaoScale)
    const bloom = config.bloom ?? BLOOM
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(256, 256),
      bloom.strength,
      bloom.radius,
      bloom.threshold,
    )
    for (const p of [this.renderPass, this.gtao, this.bloom, this.output, this.smaa])
      this.composer.addPass(p)
  }

  /** Passes, real-time shadows and resolution from the effective graphics (live). */
  setGraphics(e: Effective): void {
    this.gtaoScale = e.gtao === 'half' ? 0.5 : 1
    this.gtao.enabled = e.gtao !== 'off'
    if (e.gtao !== 'off')
      this.gtao.updateGtaoMaterial({
        samples:
          e.gtao === 'half'
            ? GTAO_SAMPLES.half
            : e.preset === 'ultra'
              ? GTAO_SAMPLES.ultra
              : GTAO_SAMPLES.full,
      })
    this.bloom.enabled = e.bloom
    this.smaa.enabled = e.smaa
    this.direct = !e.bloom && !e.smaa && e.gtao === 'off'
    const r = this.renderer
    r.shadowMap.enabled = e.shadows === 'full' && e.shadowMap > 0
    r.shadowMap.type = THREE.PCFShadowMap
    this.cap = e.pixelRatioCap
    this.scale = e.resolutionScale
    this.resize(this.size.x, this.size.y)
  }

  /** Diagnostics (debug hook): tone mapping, exposure and bloom levels live. */
  setLook(l: {
    toneMapping?: THREE.ToneMapping
    exposure?: number
    bloom?: { threshold: number; strength: number; radius: number }
  }): void {
    if (l.toneMapping !== undefined) this.renderer.toneMapping = l.toneMapping
    if (l.exposure !== undefined) this.renderer.toneMappingExposure = l.exposure
    if (l.bloom) {
      this.bloom.threshold = l.bloom.threshold
      this.bloom.strength = l.bloom.strength
      this.bloom.radius = l.bloom.radius
    }
  }

  /** Diagnostics (debug hook): toggle one pass on top of the preset. */
  setPass(name: 'gtao' | 'bloom' | 'smaa', on: boolean): void {
    this[name].enabled = on
  }

  resize(w: number, h: number): void {
    this.size.set(w, h)
    const pr = Math.min(devicePixelRatio, this.cap) * this.scale
    this.pixelRatio = pr
    this.renderer.setPixelRatio(pr)
    this.renderer.setSize(w, h)
    // The composer's buffers are only allocated while effects are on.
    this.composer.setPixelRatio(pr)
    this.composer.setSize(this.direct ? 1 : w, this.direct ? 1 : h)
  }

  /** Drawing-buffer size in device pixels (Settings → Graphics). */
  bufferSize(): { width: number; height: number } {
    return {
      width: Math.round(this.size.x * this.pixelRatio),
      height: Math.round(this.size.y * this.pixelRatio),
    }
  }

  /**
   * Approximate GPU bytes of the post-processing targets (low-spec plan §5.5): the composer's two
   * half-float buffers, bloom's mip chain, GTAO's targets and SMAA's edge/weight buffers.
   */
  targetBytes(): number {
    if (this.direct) return 0
    const { width, height } = this.bufferSize()
    const px = width * height
    let bytes = 2 * px * 8
    if (this.bloom.enabled) bytes += px * 8 * 0.7
    if (this.gtao.enabled) bytes += px * this.gtaoScale ** 2 * 4 * 4
    if (this.smaa.enabled) bytes += px * 4 * 2
    return bytes
  }

  /** Renders one frame and samples stats (FPS over ~0.5 s windows). Returns a window average or null. */
  render(dt: number): { fps: number; dt: number } | null {
    this.renderer.info.reset()
    if (this.direct) this.renderer.render(this.scene, this.camera)
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
