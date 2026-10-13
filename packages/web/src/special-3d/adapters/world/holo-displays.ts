// Holo displays (`holo` role): the atrium's giant suspended screen and the Command Center's central
// holo draw the display VM (app/special/display-vm.ts: counts and names only) onto one canvas,
// repainted only when the VM changes. Text goes through fillText (plain text, never HTML).
import * as THREE from 'three'
import type { DisplayVM } from '../../../app/special/display-vm.ts'
import { markBloom } from '../rendering/bloom-selective.ts'
import { applyFlips, uvFlips } from './uv-orient.ts'

const W = 1024
const H = 512
const FONT = '"Arial Narrow", "Helvetica Neue", Arial, sans-serif'

export function paintDisplay(g: CanvasRenderingContext2D, vm: DisplayVM): void {
  g.clearRect(0, 0, W, H)
  const bg = g.createLinearGradient(0, 0, 0, H)
  bg.addColorStop(0, 'rgba(4,18,30,0.96)')
  bg.addColorStop(1, 'rgba(2,8,16,0.96)')
  g.fillStyle = bg
  g.fillRect(0, 0, W, H)
  // Frame: angular corners.
  g.strokeStyle = '#29e3ff'
  g.lineWidth = 4
  g.beginPath()
  g.moveTo(24, 8)
  g.lineTo(W - 60, 8)
  g.lineTo(W - 8, 60)
  g.lineTo(W - 8, H - 8)
  g.lineTo(60, H - 8)
  g.lineTo(8, H - 60)
  g.lineTo(8, 24)
  g.closePath()
  g.stroke()
  g.fillStyle = '#ffb02e'
  g.font = `600 26px ${FONT}`
  g.textBaseline = 'top'
  g.fillText('MERIDIAN DYNAMICS · PROJECT COMMAND', 44, 34)
  g.fillStyle = '#e8f6ff'
  g.font = `700 64px ${FONT}`
  g.fillText(vm.title.toUpperCase(), 44, 72, W - 88)
  const n = vm.tiles.length
  const cols = Math.min(3, Math.max(1, n))
  const rows = Math.ceil(n / cols)
  const tw = (W - 88 - (cols - 1) * 16) / cols
  const th = Math.min(140, (H - 230 - (rows - 1) * 14) / rows)
  vm.tiles.forEach((t, i) => {
    const x = 44 + (i % cols) * (tw + 16)
    const y = 168 + Math.floor(i / cols) * (th + 14)
    g.fillStyle = 'rgba(41,227,255,0.08)'
    g.fillRect(x, y, tw, th)
    g.strokeStyle = 'rgba(41,227,255,0.55)'
    g.lineWidth = 2
    g.strokeRect(x, y, tw, th)
    g.fillStyle = '#9fdcf0'
    g.font = `600 24px ${FONT}`
    g.fillText(t.label.toUpperCase(), x + 16, y + 12, tw - 32)
    g.fillStyle = t.label === 'Waiting' && t.value > 0 ? '#3ccf91' : '#ffffff'
    g.font = `700 ${Math.round(th * 0.5)}px ${FONT}`
    g.fillText(String(t.value), x + 16, y + th * 0.36, tw - 32)
  })
  if (vm.footer) {
    g.fillStyle = '#ffb02e'
    g.font = `500 24px ${FONT}`
    g.fillText(vm.footer, 44, H - 52, W - 88)
  }
  // Scanlines.
  g.fillStyle = 'rgba(0,0,0,0.18)'
  for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1)
}

export class HoloDisplays {
  readonly canvas = document.createElement('canvas')
  readonly texture: THREE.CanvasTexture
  readonly material: THREE.MeshBasicMaterial
  /** glTF meshes: same canvas, one texture/material per UV orientation (flips). */
  private gltf = new Map<
    string,
    { texture: THREE.CanvasTexture; material: THREE.MeshBasicMaterial }
  >()
  private key = ''

  constructor() {
    this.canvas.width = W
    this.canvas.height = H
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.name = 'special:holo'
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      color: new THREE.Color(1.7, 1.7, 1.7),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    this.material.name = 'special:holo'
  }

  private gltfVariant(f: { x: boolean; y: boolean }) {
    const key = `${f.x}:${f.y}`
    let v = this.gltf.get(key)
    if (!v) {
      const texture = this.texture.clone()
      texture.flipY = false
      applyFlips(texture, f)
      const material = this.material.clone()
      material.map = texture
      v = { texture, material }
      this.gltf.set(key, v)
    }
    return v
  }

  /** Puts the display on a mesh (holo role, or a placeholder plane). */
  attach(mesh: THREE.Mesh, viewer?: THREE.Vector3): void {
    mesh.material = mesh.userData.aoGltf
      ? this.gltfVariant(viewer ? uvFlips(mesh, viewer) : { x: false, y: false }).material
      : this.material
    markBloom(mesh)
  }

  render(vm: DisplayVM): void {
    const key = JSON.stringify(vm)
    if (key === this.key) return
    this.key = key
    paintDisplay(this.canvas.getContext('2d')!, vm)
    this.texture.needsUpdate = true
    for (const v of this.gltf.values()) v.texture.needsUpdate = true
  }

  /** The text shown now (debug/E2E: plain data, never rendered as HTML). */
  get shown(): string {
    return this.key
  }

  dispose(): void {
    this.texture.dispose()
    this.material.dispose()
    for (const v of this.gltf.values()) (v.texture.dispose(), v.material.dispose())
  }
}
