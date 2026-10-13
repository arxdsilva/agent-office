// Neon signs (`neon` role): canvas-drawn plain-text signs (original wording) on emissive planes,
// flickering on deterministic schedules (env-schedule.flickerAt). Never on agent-meaningful
// objects (monitors, booth LEDs and name tags are driven by real state only).
import * as THREE from 'three'
import { flickerAt } from '../../../app/special/env-schedule.ts'
import { markBloom } from '../rendering/bloom-selective.ts'

interface Sign {
  mat: THREE.MeshBasicMaterial
  base: THREE.Color
  seed: number
  texture?: THREE.Texture
}

export class NeonSigns {
  readonly group = new THREE.Group()
  private signs: Sign[] = []
  private geometry = new THREE.PlaneGeometry(1, 1)

  constructor(scene: THREE.Scene) {
    this.group.name = 'neon'
    scene.add(this.group)
  }

  /** A text sign `h` m tall at `pos` (world), facing `yaw` (heading convention). */
  addText(text: string, color: string, pos: THREE.Vector3, yaw: number, h = 0.8): void {
    const canvas = document.createElement('canvas')
    const g = canvas.getContext('2d')!
    const font = '700 96px "Arial Narrow", "Helvetica Neue", Arial, sans-serif'
    g.font = font
    const w = Math.ceil(g.measureText(text).width) + 48
    canvas.width = w
    canvas.height = 140
    g.font = font
    g.textBaseline = 'middle'
    g.shadowColor = color
    g.shadowBlur = 18
    g.fillStyle = color
    g.fillText(text, 24, 72)
    g.shadowBlur = 0
    g.fillStyle = '#ffffff'
    g.globalAlpha = 0.55
    g.fillText(text, 24, 72)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.name = 'special:neon'
    const base = new THREE.Color(2.2, 2.2, 2.2)
    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      color: base.clone(),
      transparent: true,
      depthWrite: false,
    })
    const mesh = new THREE.Mesh(this.geometry, mat)
    mesh.scale.set((h * w) / 140, h, 1)
    mesh.position.copy(pos)
    mesh.rotation.y = yaw
    markBloom(mesh)
    this.group.add(mesh)
    this.signs.push({ mat, base, seed: this.signs.length * 17 + 3, texture })
  }

  /** Adopts a `neon`-role mesh from the real set: its emissive colour flickers. */
  adopt(mesh: THREE.Mesh): void {
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(
        (mesh.material as THREE.MeshStandardMaterial).emissive ?? 0xff2bd6,
      ).multiplyScalar(2.4),
    })
    mesh.material = mat
    markBloom(mesh)
    this.signs.push({ mat, base: mat.color.clone(), seed: this.signs.length * 17 + 3 })
  }

  update(t: number, flicker: boolean): void {
    for (const s of this.signs)
      s.mat.color.copy(s.base).multiplyScalar(flickerAt(s.seed, t, flicker))
  }

  dispose(): void {
    this.group.removeFromParent()
    for (const s of this.signs) (s.mat.dispose(), s.texture?.dispose())
    this.geometry.dispose()
  }
}
