import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import type { ZoneLayout } from './layout.ts'

/** Axis-aligned box on the floor, used for walk-mode collision. */
export interface Collider {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

const WALL_HEIGHT = 1.2
const MARGIN = 6

/** Stable pastel tint per provider name. */
export function zoneColor(name: string): THREE.Color {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return new THREE.Color().setHSL((h % 360) / 360, 0.45, 0.62)
}

function label(className: string, text: string): CSS2DObject {
  const el = document.createElement('div')
  el.className = className
  el.textContent = text
  return new CSS2DObject(el)
}

/** Floor, walls, lights, zone carpets, provider signs and topic labels. */
export class Office {
  readonly group = new THREE.Group()
  private zonesGroup = new THREE.Group()
  private floor: THREE.Mesh
  private walls: THREE.Mesh[] = []
  private wallMat = new THREE.MeshStandardMaterial({ color: 0xdfe3ea, roughness: 0.9 })
  private key = ''
  wallColliders: Collider[] = []
  /** Floor area covered by zones, for camera framing. */
  bounds = { minX: -10, maxX: 10, minZ: -8, maxZ: 8 }

  constructor(dark: boolean) {
    const floorMat = new THREE.MeshStandardMaterial({
      color: dark ? 0x2a2f38 : 0xd9dce2,
      roughness: 0.95,
    })
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), floorMat)
    this.floor.rotation.x = -Math.PI / 2
    this.floor.receiveShadow = true
    this.group.add(this.floor, this.zonesGroup)

    const hemi = new THREE.HemisphereLight(0xffffff, dark ? 0x202530 : 0xb9c2d0, dark ? 1.1 : 1.4)
    const sun = new THREE.DirectionalLight(0xffffff, dark ? 1.4 : 1.8)
    sun.position.set(20, 40, 25)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    const s = sun.shadow.camera
    s.left = s.bottom = -60
    s.right = s.top = 60
    this.group.add(hemi, sun)
    this.setZones([])
  }

  /** Rebuilds zone decorations only when the zone/row structure changed. */
  setZones(zones: ZoneLayout[]): void {
    const key = JSON.stringify(
      zones.map((z) => [z.name, z.x0, z.x1, z.z0, z.z1, z.rows.map((r) => r.name)]),
    )
    if (key === this.key) return
    this.key = key
    this.clearZones()

    for (const z of zones) {
      const carpet = new THREE.Mesh(
        new THREE.PlaneGeometry(z.x1 - z.x0, z.z1 - z.z0),
        new THREE.MeshStandardMaterial({
          color: zoneColor(z.name),
          roughness: 1,
          transparent: true,
          opacity: 0.35,
        }),
      )
      carpet.rotation.x = -Math.PI / 2
      carpet.position.set((z.x0 + z.x1) / 2, 0.01, (z.z0 + z.z1) / 2)
      carpet.receiveShadow = true
      this.zonesGroup.add(carpet)

      const sign = label('zone-sign', z.name)
      sign.position.set((z.x0 + z.x1) / 2, 3.2, z.z0 - 0.5)
      this.zonesGroup.add(sign)

      for (const r of z.rows) {
        const rowLabel = label('row-label', r.name)
        // On the floor in front of the row, so it never collides with the name tags above heads.
        rowLabel.position.set(z.x0 + 0.3, 0.05, r.z + 2.3)
        rowLabel.center.set(0, 0)
        this.zonesGroup.add(rowLabel)
      }
    }

    // Floor and walls enclose all zones with a margin.
    const minX = Math.min(-10, ...zones.map((z) => z.x0)) - MARGIN
    const maxX = Math.max(10, ...zones.map((z) => z.x1)) + MARGIN
    const minZ = Math.min(-8, ...zones.map((z) => z.z0)) - MARGIN
    const maxZ = Math.max(8, ...zones.map((z) => z.z1)) + MARGIN
    this.bounds = {
      minX: minX + MARGIN,
      maxX: maxX - MARGIN,
      minZ: minZ + MARGIN,
      maxZ: maxZ - MARGIN,
    }
    this.floor.scale.set(maxX - minX, maxZ - minZ, 1)
    this.floor.position.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2)
    this.buildWalls(minX, maxX, minZ, maxZ)
  }

  private buildWalls(minX: number, maxX: number, minZ: number, maxZ: number): void {
    for (const w of this.walls) {
      w.geometry.dispose()
      this.group.remove(w)
    }
    const t = 0.3
    const specs: [number, number, number, number][] = [
      [(minX + maxX) / 2, minZ, maxX - minX, t],
      [(minX + maxX) / 2, maxZ, maxX - minX, t],
      [minX, (minZ + maxZ) / 2, t, maxZ - minZ],
      [maxX, (minZ + maxZ) / 2, t, maxZ - minZ],
    ]
    this.walls = specs.map(([x, z, w, d]) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, WALL_HEIGHT, d), this.wallMat)
      m.position.set(x, WALL_HEIGHT / 2, z)
      m.castShadow = m.receiveShadow = true
      this.group.add(m)
      return m
    })
    this.wallColliders = specs.map(([x, z, w, d]) => ({
      minX: x - w / 2,
      maxX: x + w / 2,
      minZ: z - d / 2,
      maxZ: z + d / 2,
    }))
  }

  private clearZones(): void {
    for (const child of [...this.zonesGroup.children]) {
      this.zonesGroup.remove(child)
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose()
        ;(child.material as THREE.Material).dispose()
      }
      if (child instanceof CSS2DObject) child.element.remove()
    }
  }
}
