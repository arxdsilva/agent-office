// Shared pieces of the WebGL scene (`ThreeScene`, Classic and Horizon flavors): the preset shim,
// the paced render loop, listener teardown, GPU memory accounting and hardware info.
import { GraphicsAdvancedSchema } from '@agent-office/shared'
import * as THREE from 'three'
import { createPacer } from '../../app/frame-pacer.ts'
import type { Effective, HardwareInfo } from '../../app/graphics-types.ts'
import { effectiveGraphics, type Preset } from '../../app/quality.ts'
import { textureBytes } from './assets.ts'

/** The effective graphics for a plain preset (the `setQuality` shim and the start-up default). */
export const presetGraphics = (preset: Preset): Effective =>
  effectiveGraphics({
    preset,
    advanced: GraphicsAdvancedSchema.parse({}),
    dpr: typeof devicePixelRatio === 'number' ? devicePixelRatio : 1,
    power: { focused: true, hidden: false, onBattery: false },
    saver: { blur: false, hidden: false, battery: 'off' },
  })

export const TEXTURE_KEYS = [
  'map',
  'lightMap',
  'aoMap',
  'emissiveMap',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'alphaMap',
  'bumpMap',
  'envMap',
] as const

type AnyEventMap = WindowEventMap & DocumentEventMap

/** Listeners on targets that outlive a scene, removed together on dispose. */
export class Teardown {
  private offs: (() => void)[] = []

  on<K extends keyof AnyEventMap>(
    target: Window | Document | HTMLElement,
    type: K,
    fn: (e: AnyEventMap[K]) => void,
  ): void {
    const h = fn as EventListener
    target.addEventListener(type, h)
    this.offs.push(() => target.removeEventListener(type, h))
  }

  add(off: () => void): void {
    this.offs.push(off)
  }

  run(): void {
    for (const off of this.offs.splice(0)) off()
  }
}

/**
 * `setAnimationLoop` paced by the frame limit (low-spec plan §5.4): 0 stops the loop (no rAF at
 * all); skipped frames do nothing, so the next rendered one gets the accumulated time (≤ 0.5 s).
 */
export class FrameLoop {
  private pacer = createPacer()
  private looping = false
  private lastFrame = -1
  frames = 0
  stopped = false

  constructor(
    private renderer: THREE.WebGLRenderer,
    private o: {
      limit: () => number | null
      /** False while the stage is hidden (the user left the Office). */
      visible: () => boolean
      frame: (dt: number, t: number) => void
    },
  ) {}

  /** Starts or stops the loop to match the limit. */
  arm(): void {
    const run = !this.stopped && this.o.limit() !== 0
    if (run === this.looping) return
    this.looping = run
    if (!run) return this.renderer.setAnimationLoop(null)
    this.pacer.reset()
    this.renderer.setAnimationLoop((t) => this.tick(t))
  }

  stop(): void {
    this.stopped = true
    this.looping = false
    this.renderer.setAnimationLoop(null)
  }

  private tick(t: number): void {
    if (this.stopped || !this.o.visible()) return
    if (!this.pacer.shouldRender(t, this.o.limit())) return
    const dt = this.lastFrame < 0 ? 0 : Math.min(0.5, (t - this.lastFrame) / 1000)
    this.lastFrame = t
    this.frames++
    this.o.frame(dt, t)
  }
}

/**
 * GPU memory estimate (low-spec plan §5.5): unique textures in the scene (shared sources once)
 * plus `extra` textures (canvases), the environment and `targetBytes` (shadow maps, post targets);
 * geometry buffers by byte length.
 */
export function sceneMemory(
  scene: THREE.Scene,
  extra: Iterable<THREE.Texture>,
  targetBytes: number,
): { textureMB: number; geometryMB: number } {
  const sources = new Map<unknown, number>()
  const addTex = (t: THREE.Texture | null | undefined) => {
    if (t && !sources.has(t.source)) sources.set(t.source, textureBytes(t))
  }
  const geos = new Set<THREE.BufferGeometry>()
  let geoBytes = 0
  scene.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.geometry && !geos.has(m.geometry)) {
      geos.add(m.geometry)
      for (const a of Object.values(m.geometry.attributes))
        geoBytes += (a as THREE.BufferAttribute).array?.byteLength ?? 0
      geoBytes += m.geometry.index?.array.byteLength ?? 0
    }
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : []
    for (const mat of mats) {
      const rec = mat as unknown as Record<string, unknown>
      for (const k of TEXTURE_KEYS) addTex(rec[k] as THREE.Texture | undefined)
      const uniforms = (mat as THREE.ShaderMaterial).uniforms
      if (uniforms)
        for (const u of Object.values(uniforms))
          if ((u?.value as THREE.Texture)?.isTexture) addTex(u.value as THREE.Texture)
    }
  })
  for (const t of extra) addTex(t)
  let bytes = [...sources.values()].reduce((a, b) => a + b, 0)
  // PMREM: a half-float CubeUV atlas (~3 × size² texels for a 256 face).
  if (scene.environment) bytes += 768 * 1024 * 8
  bytes += targetBytes
  return { textureMB: bytes / 2 ** 20, geometryMB: geoBytes / 2 ** 20 }
}

/** What the controller needs to pick the hardware tier (low-spec plan §5.1); null if unreadable. */
export function hardwareInfo(renderer: THREE.WebGLRenderer): HardwareInfo | null {
  try {
    const gl = renderer.getContext()
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    const nav = navigator as Navigator & { deviceMemory?: number }
    return {
      renderer: str(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
      vendor: str(gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
      maxTextureSize: renderer.capabilities.maxTextureSize,
      dpr: devicePixelRatio,
      cores: nav.hardwareConcurrency ?? 4,
      ...(typeof nav.deviceMemory === 'number' ? { memoryGB: nav.deviceMemory } : {}),
      webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
    }
  } catch {
    return null
  }
}
