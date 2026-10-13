// Exterior ad screens (`ad` role, docs/special-3d/rendering.md): canvas-drawn ORIGINAL ads for
// fictional brands (app/special/env-schedule.ts), rotated every 12 s per screen. The brand marks
// are drawn from primitives. Never agent-office data, project names or real trademarks.
import * as THREE from 'three'
import { ADS, adAt, type Ad } from '../../../app/special/env-schedule.ts'
import { markBloom } from '../rendering/bloom-selective.ts'
import { applyFlips, uvFlips } from '../world/uv-orient.ts'

const W = 512
const H = 256

function drawMark(g: CanvasRenderingContext2D, ad: Ad, x: number, y: number, s: number): void {
  g.save()
  g.translate(x, y)
  g.strokeStyle = ad.colors[0]
  g.fillStyle = ad.colors[1]
  g.lineWidth = s * 0.12
  switch (ad.mark) {
    case 'ring':
      g.beginPath()
      g.arc(0, 0, s * 0.42, 0, Math.PI * 2)
      g.stroke()
      g.beginPath()
      g.arc(0, 0, s * 0.16, 0, Math.PI * 2)
      g.fill()
      break
    case 'chevron':
      g.beginPath()
      g.moveTo(-s * 0.4, -s * 0.3)
      g.lineTo(0, s * 0.1)
      g.lineTo(s * 0.4, -s * 0.3)
      g.moveTo(-s * 0.4, s * 0.05)
      g.lineTo(0, s * 0.45)
      g.lineTo(s * 0.4, s * 0.05)
      g.stroke()
      break
    case 'hex':
      g.beginPath()
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 6
        g[i ? 'lineTo' : 'moveTo'](Math.cos(a) * s * 0.42, Math.sin(a) * s * 0.42)
      }
      g.closePath()
      g.stroke()
      break
    case 'bars':
      for (let i = 0; i < 4; i++)
        g.fillRect(-s * 0.4 + i * s * 0.22, -s * 0.1 * i, s * 0.14, s * 0.3 + s * 0.1 * i)
      break
    case 'diamond':
      g.beginPath()
      g.moveTo(0, -s * 0.45)
      g.lineTo(s * 0.35, 0)
      g.lineTo(0, s * 0.45)
      g.lineTo(-s * 0.35, 0)
      g.closePath()
      g.stroke()
      g.fillRect(-s * 0.06, -s * 0.06, s * 0.12, s * 0.12)
      break
    case 'wave':
      g.beginPath()
      for (let i = 0; i <= 20; i++) {
        const px = -s * 0.45 + (i / 20) * s * 0.9
        g[i ? 'lineTo' : 'moveTo'](px, Math.sin(i * 0.9) * s * 0.18)
      }
      g.stroke()
      break
  }
  g.restore()
}

/** Paints one ad (plain text through fillText; no HTML). */
export function paintAd(g: CanvasRenderingContext2D, ad: Ad): void {
  const grad = g.createLinearGradient(0, 0, W, H)
  grad.addColorStop(0, '#05070c')
  grad.addColorStop(1, '#101828')
  g.fillStyle = grad
  g.fillRect(0, 0, W, H)
  g.globalAlpha = 0.18
  g.fillStyle = ad.colors[0]
  for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 1)
  g.globalAlpha = 1
  drawMark(g, ad, 96, H / 2, 120)
  g.fillStyle = '#f2f6ff'
  g.font = '700 38px "Arial Narrow", "Helvetica Neue", Arial, sans-serif'
  g.textBaseline = 'middle'
  g.fillText(ad.brand.toUpperCase(), 180, H / 2 - 30, W - 200)
  g.fillStyle = ad.colors[1]
  g.font = '600 24px "Arial Narrow", "Helvetica Neue", Arial, sans-serif'
  ad.lines.forEach((l, i) => g.fillText(l, 180, H / 2 + 14 + i * 28, W - 200))
  g.strokeStyle = ad.colors[0]
  g.lineWidth = 4
  g.strokeRect(6, 6, W - 12, H - 12)
}

interface Screen {
  mesh: THREE.Mesh
  canvas: HTMLCanvasElement
  texture: THREE.CanvasTexture
  showing: number
}

export class AdScreens {
  readonly group = new THREE.Group()
  private screens: Screen[] = []
  private geometry = new THREE.PlaneGeometry(1, 1)
  private materials: THREE.Material[] = []

  constructor(
    scene: THREE.Scene,
    private seed = 3,
  ) {
    this.group.name = 'ads'
    scene.add(this.group)
  }

  /** A screen facing `normal` at `pos` (world), `w` × `h` metres. */
  add(pos: THREE.Vector3, normal: THREE.Vector3, w: number, h: number): void {
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.name = 'special:ad'
    const mat = new THREE.MeshBasicMaterial({ map: texture, color: new THREE.Color(1.6, 1.6, 1.6) })
    this.materials.push(mat)
    const mesh = new THREE.Mesh(this.geometry, mat)
    mesh.scale.set(w, h, 1)
    mesh.position.copy(pos)
    mesh.lookAt(pos.clone().add(normal))
    markBloom(mesh)
    this.group.add(mesh)
    this.screens.push({ mesh, canvas, texture, showing: -1 })
  }

  /** Adopts an existing `ad`-role mesh from the real asset set (its material gets the canvas). */
  adopt(mesh: THREE.Mesh, viewer?: THREE.Vector3): void {
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    // glTF UVs start top-left.
    texture.flipY = false
    if (viewer) applyFlips(texture, uvFlips(mesh, viewer))
    const mat = new THREE.MeshBasicMaterial({ map: texture, color: new THREE.Color(1.3, 1.3, 1.3) })
    this.materials.push(mat)
    mesh.material = mat
    markBloom(mesh)
    this.screens.push({ mesh, canvas, texture, showing: -1 })
  }

  get count(): number {
    return this.screens.length
  }

  /** Repaints a screen only when its ad changes (every 12 s at most). */
  update(ms: number, rotate: boolean): void {
    this.screens.forEach((s, i) => {
      const idx = adAt(this.seed, i, ms, rotate)
      if (idx === s.showing) return
      s.showing = idx
      paintAd(s.canvas.getContext('2d')!, ADS[idx]!)
      s.texture.needsUpdate = true
    })
  }

  textures(): THREE.Texture[] {
    return this.screens.map((s) => s.texture)
  }

  dispose(): void {
    this.group.removeFromParent()
    for (const s of this.screens) s.texture.dispose()
    for (const m of this.materials) m.dispose()
    this.geometry.dispose()
    this.screens = []
  }
}
