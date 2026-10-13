// Reflection probes (docs/special-3d/rendering.md): one cube capture per room, rendered once after
// load (agents hidden), prefiltered with PMREM and applied to that room's wet floor and glass.
// Static reflections instead of SSR: cheap every frame, refreshed only on a context restore.
import * as THREE from 'three'

interface Probe {
  room: string
  at: THREE.Vector3
  materials: THREE.MeshStandardMaterial[]
  texture: THREE.Texture | null
}

export class ReflectionProbes {
  private probes: Probe[] = []
  private enabled = false

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
  ) {}

  add(room: string, at: THREE.Vector3, materials: THREE.MeshStandardMaterial[]): void {
    this.probes.push({ room, at, materials, texture: null })
  }

  /** Captures every probe once (`hide` are hidden meanwhile: characters, the player, rain). */
  capture(hide: THREE.Object3D[]): void {
    const was = hide.map((o) => o.visible)
    for (const o of hide) o.visible = false
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    const rt = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType })
    const cam = new THREE.CubeCamera(0.1, 250, rt)
    const toneMapping = this.renderer.toneMapping
    this.renderer.toneMapping = THREE.NoToneMapping
    for (const p of this.probes) {
      // The floor itself must not reflect into its own probe.
      for (const m of p.materials) m.visible = false
      cam.position.copy(p.at)
      cam.update(this.renderer, this.scene)
      for (const m of p.materials) m.visible = true
      p.texture?.dispose()
      p.texture = pmrem.fromCubemap(rt.texture).texture
      p.texture.name = `special:probe:${p.room}`
    }
    this.renderer.toneMapping = toneMapping
    rt.dispose()
    pmrem.dispose()
    hide.forEach((o, i) => (o.visible = was[i]!))
    this.apply()
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    this.apply()
  }

  get captured(): boolean {
    return this.probes.some((p) => p.texture)
  }

  private apply(): void {
    for (const p of this.probes)
      for (const m of p.materials) {
        const env = this.enabled ? p.texture : null
        if (m.envMap !== env) {
          m.envMap = env
          m.needsUpdate = true
        }
      }
  }

  /** PMREM atlases (~3 × 128² × 8 bytes per probe, half float). */
  bytes(): number {
    return this.probes.filter((p) => p.texture).length * 3 * 256 * 256 * 8
  }

  dispose(): void {
    for (const p of this.probes) p.texture?.dispose()
    this.probes = []
  }
}
