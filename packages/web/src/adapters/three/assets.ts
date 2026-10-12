// Asset loading (contract §6, §6b, §7): manifest, module .glb files (meshopt-compressed, WebP
// textures shared across modules by `extras.hash`), lightmaps (size tiers, PNG/WebP), the HDRI,
// plus the loading screen. Every file is fetched relative to the page (app://renderer/assets/…).
import * as THREE from 'three'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { GLTFLoader, type GLTF, type GLTFParser } from 'three/addons/loaders/GLTFLoader.js'
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js'
import type { LightmapTier } from '../../app/graphics-types.ts'
import { parseManifest, type Lightmap, type Manifest } from '../../app/manifest.ts'
import {
  lightmapSource,
  textureBytes as bytesOf,
  textureHash,
  type BYTES_PER_PIXEL,
} from '../../app/texture-cache.ts'

/** Contract §6 size tiers (additive): absent in older manifests, which only have `file`. */
export type TieredLightmap = Lightmap & {
  variants?: Partial<Record<LightmapTier, string>>
}

/** The file for a lightmap tier: its variant, else `file` (contract §6). */
export const lightmapFile = (lm: TieredLightmap, tier: LightmapTier): string =>
  lightmapSource(lm, tier).url

/**
 * Rejects after `ms`: a load that never settles must not hang the scene, which then opens with
 * placeholders / no lightmap.
 */
export function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms)
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e: unknown) => (clearTimeout(t), reject(e)),
    )
  })
}
const MODULE_TIMEOUT_MS = 30_000
const LIGHTMAP_TIMEOUT_MS = 15_000

/**
 * Dedup key for a glTF texture (contract §6b): `extras.hash` of the texture or its image, plus
 * the sampler, so identical pixels share one GPU texture across modules. Null: no hash.
 */
function textureKey(json: GltfJson, textureIndex: number, sourceIndex: number): string | null {
  const tex = json.textures?.[textureIndex]
  const hash = textureHash(tex?.extras) ?? textureHash(json.images?.[sourceIndex]?.extras)
  if (!hash) return null
  return `${hash}|${JSON.stringify(json.samplers?.[tex?.sampler ?? -1] ?? null)}`
}

interface GltfJson {
  textures?: { sampler?: number; extras?: unknown }[]
  images?: { extras?: unknown }[]
  samplers?: unknown[]
}

/**
 * GLTFLoader plugin: textures with the same `extras.hash` resolve to the first one loaded, in any
 * module. It hooks `loadTextureImage` (every texture extension also goes through it), so a
 * duplicate is never fetched, decoded or uploaded.
 */
function dedupPlugin(cache: Map<string, Promise<THREE.Texture>>) {
  return (parser: GLTFParser) => {
    const load = parser.loadTextureImage.bind(parser)
    parser.loadTextureImage = (textureIndex, sourceIndex, loader) => {
      const key = textureKey(parser.json as GltfJson, textureIndex, sourceIndex)
      if (!key) return load(textureIndex, sourceIndex, loader)
      let p = cache.get(key)
      if (!p) {
        p = load(textureIndex, sourceIndex, loader)
        cache.set(key, p)
        // A failed load resolves to null in GLTFLoader; don't pin that for other modules.
        void p.then((t) => (t ? (t.userData.dedup = key) : cache.delete(key)))
      }
      return p
    }
    return { name: 'AO_texture_dedup' }
  }
}

export interface LoadingElements {
  root: HTMLElement
  fill: HTMLElement
  label: HTMLElement
  tip: HTMLElement
}

const TIPS = [
  'Each provider gets its own themed wing off Main Street.',
  'Agents waiting for you head to a phone booth: its light turns green.',
  'A parent with subagents books a meeting room for the team.',
  'Click a name tag to chat; press F to walk around.',
  'Idle agents take breaks in the kitchen, the lounge or the atrium cafe.',
]

/** Progress bar + tips over the canvas until the atrium is ready. Text goes through textContent only. */
export class LoadingScreen {
  private tipTimer: ReturnType<typeof setInterval> | undefined
  constructor(private el: LoadingElements) {
    let i = Math.floor(Math.random() * TIPS.length)
    const next = () => (el.tip.textContent = TIPS[i++ % TIPS.length]!)
    next()
    this.tipTimer = setInterval(next, 4000)
  }

  progress(fraction: number, label?: string): void {
    const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100)
    this.el.fill.style.width = `${pct}%`
    this.el.root.setAttribute('aria-valuenow', String(pct))
    if (label) this.el.label.textContent = label
  }

  error(message: string): void {
    this.el.root.classList.add('failed')
    this.el.label.textContent = message
    clearInterval(this.tipTimer)
  }

  hide(): void {
    clearInterval(this.tipTimer)
    this.el.root.classList.add('done')
    // Let the fade-out run, then take it out of the accessibility tree.
    setTimeout(() => (this.el.root.hidden = true), 450)
  }
}

/** Loads and caches every asset the scene needs; reports byte progress through one LoadingManager. */
export class AssetStore {
  readonly manager = new THREE.LoadingManager()
  readonly gltf: GLTFLoader
  private textures = new THREE.TextureLoader(this.manager)
  private hdr = new HDRLoader(this.manager)
  private glbs = new Map<string, Promise<GLTF>>()
  private maps = new Map<string, Promise<THREE.Texture>>()
  /** One texture per `extras.hash` across every module (contract §6b). */
  readonly shared = new Map<string, Promise<THREE.Texture>>()

  constructor(readonly base: string) {
    this.gltf = new GLTFLoader(this.manager)
    this.gltf.setMeshoptDecoder(MeshoptDecoder)
    this.gltf.register(dedupPlugin(this.shared))
  }

  url(file: string): string {
    return this.base + file
  }

  async manifest(url: string): Promise<Manifest> {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${res.status} ${url}`)
    return parseManifest(await res.json())
  }

  /** One parse per file; callers clone the scene for each placement. */
  module(file: string): Promise<GLTF> {
    let p = this.glbs.get(file)
    if (!p) {
      p = within(this.gltf.loadAsync(this.url(file)), MODULE_TIMEOUT_MS, file)
      this.glbs.set(file, p)
      p.catch(() => this.glbs.delete(file))
    }
    return p
  }

  /**
   * A module's lightmap atlas at a size tier (contract §6): sRGB, UV1, no flip. PNG or WebP;
   * without `variants` every tier is `lightmap.file`.
   */
  lightmap(lm: TieredLightmap, tier: LightmapTier = 'full'): Promise<THREE.Texture> {
    const file = lightmapFile(lm, tier)
    let p = this.maps.get(file)
    if (!p) {
      p = within(this.textures.loadAsync(this.url(file)), LIGHTMAP_TIMEOUT_MS, file).then((t) => {
        t.channel = 1
        t.colorSpace = THREE.SRGBColorSpace
        t.flipY = false
        t.name = file
        t.needsUpdate = true
        return t
      })
      this.maps.set(file, p)
      p.catch(() => this.maps.delete(file))
    }
    return p
  }

  /** Frees a lightmap tier no module uses any more (after a tier swap). */
  dropLightmap(file: string): void {
    const p = this.maps.get(file)
    if (!p) return
    this.maps.delete(file)
    void p.then((t) => t.dispose()).catch(() => {})
  }

  /** Equirectangular HDRI → PMREM environment (reflections and fill light for dynamic objects). */
  async environment(file: string, renderer: THREE.WebGLRenderer): Promise<THREE.Texture> {
    const tex = await this.hdr.loadAsync(this.url(file))
    tex.mapping = THREE.EquirectangularReflectionMapping
    const pmrem = new THREE.PMREMGenerator(renderer)
    const env = pmrem.fromEquirectangular(tex).texture
    tex.dispose()
    pmrem.dispose()
    return env
  }
}

/** The accounting class of a texture's GPU format (low-spec plan §5.5). */
function formatClass(t: THREE.Texture): keyof typeof BYTES_PER_PIXEL {
  switch (t.format as number) {
    case THREE.RGB_S3TC_DXT1_Format:
    case THREE.RGBA_S3TC_DXT1_Format:
    case THREE.RGB_ETC1_Format:
    case THREE.RGB_ETC2_Format:
    case THREE.RGB_PVRTC_4BPPV1_Format:
    case THREE.RGBA_PVRTC_4BPPV1_Format:
    case THREE.RED_RGTC1_Format:
      return 'bc1'
  }
  return (t as THREE.CompressedTexture).isCompressedTexture ? 'compressed' : 'rgba8'
}

/** Approximate GPU bytes of one texture: w × h × bpp, × 4/3 with mipmaps. */
export function textureBytes(t: THREE.Texture): number {
  const img = t.image as { width?: number; height?: number } | null | undefined
  const w = img?.width ?? 0
  const h = img?.height ?? 0
  if (!w || !h) return 0
  const mips = t.mipmaps?.length > 1 || (t.generateMipmaps && t.minFilter !== THREE.LinearFilter)
  return bytesOf(w, h, formatClass(t), !!mips)
}
