// Asset loading (contract §7): manifest, module .glb files (meshopt-compressed), lightmaps, the HDRI,
// plus the loading screen. Every file is fetched relative to the page (app://renderer/assets/…).
import * as THREE from 'three'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js'
import { parseManifest, type Manifest } from '../../app/manifest.ts'

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

  constructor(readonly base: string) {
    this.gltf = new GLTFLoader(this.manager)
    this.gltf.setMeshoptDecoder(MeshoptDecoder)
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
      p = this.gltf.loadAsync(this.url(file))
      this.glbs.set(file, p)
      p.catch(() => this.glbs.delete(file))
    }
    return p
  }

  /** A lightmap atlas (contract §6): 8-bit sRGB, UV1, no flip. */
  lightmap(file: string): Promise<THREE.Texture> {
    let p = this.maps.get(file)
    if (!p) {
      p = this.textures.loadAsync(this.url(file)).then((t) => {
        t.channel = 1
        t.colorSpace = THREE.SRGBColorSpace
        t.flipY = false
        t.needsUpdate = true
        return t
      })
      this.maps.set(file, p)
      p.catch(() => this.maps.delete(file))
    }
    return p
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
