// Per-agent tinting without a material per agent: tinted clones are cached by (base material,
// color) and ref-counted, so agents with identical palettes share every material.
// Fades get short-lived private transparent clones (a shared material can't fade one agent).
import * as THREE from 'three'

/** Material names the runtime tints per agent (contract §8). */
export const TINT_SLOTS = ['skin', 'shirt', 'pants', 'hair', 'badge'] as const
export type TintSlot = (typeof TINT_SLOTS)[number]
export const isTintSlot = (name: string): name is TintSlot =>
  (TINT_SLOTS as readonly string[]).includes(name)

type Colored = THREE.Material & { color?: THREE.Color }

export class TintCache {
  private readonly byKey = new Map<string, { mat: THREE.Material; refs: number }>()
  private readonly keyOf = new Map<THREE.Material, string>()

  acquire(base: THREE.Material, hex: number): THREE.Material {
    const key = `${base.uuid}:${hex}`
    let e = this.byKey.get(key)
    if (!e) {
      const mat = base.clone() as Colored
      mat.name = base.name
      mat.color?.setHex(hex)
      e = { mat, refs: 0 }
      this.byKey.set(key, e)
      this.keyOf.set(mat, key)
    }
    e.refs++
    return e.mat
  }

  /** Shared material for an arbitrary key (e.g. a palette), built once by `make`. */
  acquireKeyed(key: string, make: () => THREE.Material): THREE.Material {
    let e = this.byKey.get(key)
    if (!e) {
      e = { mat: make(), refs: 0 }
      this.byKey.set(key, e)
      this.keyOf.set(e.mat, key)
    }
    e.refs++
    return e.mat
  }

  release(mat: THREE.Material) {
    const key = this.keyOf.get(mat)
    const e = key && this.byKey.get(key)
    if (!e) return
    if (--e.refs > 0) return
    this.byKey.delete(key)
    this.keyOf.delete(mat)
    mat.dispose()
  }

  get size() {
    return this.byKey.size
  }

  dispose() {
    for (const { mat } of this.byKey.values()) mat.dispose()
    this.byKey.clear()
    this.keyOf.clear()
  }
}

/** Swaps an agent's meshes to private transparent clones while it fades, then back. */
export class FadeMaterials {
  private saved = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
  private clones: THREE.Material[] = []

  get active() {
    return this.saved.size > 0
  }

  begin(meshes: readonly THREE.Mesh[]) {
    if (this.active) return
    for (const mesh of meshes) {
      this.saved.set(mesh, mesh.material)
      const mk = (m: THREE.Material) => {
        const c = m.clone()
        c.transparent = true
        c.depthWrite = true
        this.clones.push(c)
        return c
      }
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(mk) : mk(mesh.material)
    }
  }

  set(opacity: number) {
    for (const c of this.clones) c.opacity = opacity
  }

  end() {
    for (const [mesh, mat] of this.saved) mesh.material = mat
    for (const c of this.clones) c.dispose()
    this.saved.clear()
    this.clones = []
  }
}
