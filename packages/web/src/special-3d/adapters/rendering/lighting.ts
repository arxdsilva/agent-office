// Lighting hierarchy (docs/special-3d/art-direction.md): (1) architectural, cool ambient and a
// moonlight key; (2) screens and signage, emissive; (3) accents, emissive strips; (4) exterior,
// the city. At most four dynamic lights per room (MAX_DYNAMIC_LIGHTS), in priority order; the
// preset decides how many of them run. Everything else is emissive (and baked in the real set).
import * as THREE from 'three'
import { MAX_DYNAMIC_LIGHTS } from '../../../app/special/special-quality.ts'

export interface RoomLight {
  room: string
  light: THREE.PointLight | THREE.SpotLight
  /** Lower first. */
  priority: number
}

const THEMES = {
  dark: { background: 0x05070b, sky: 0x2a4f7a, ground: 0x120c08, ambient: 0.55, key: 0.55 },
  light: { background: 0x0b1018, sky: 0x4a6f9a, ground: 0x241a10, ambient: 0.8, key: 0.75 },
} as const

export class Lighting {
  readonly group = new THREE.Group()
  readonly hemi = new THREE.HemisphereLight(0x2a4f7a, 0x120c08, 0.55)
  /** Cool moonlight through the curtain wall (the only shadow caster). */
  readonly key = new THREE.DirectionalLight(0x9fc8ff, 0.55)
  private rooms: RoomLight[] = []
  readonly background = new THREE.Color(THEMES.dark.background)

  constructor(scene: THREE.Scene) {
    this.group.name = 'lighting'
    this.key.position.set(60, 50, 10)
    this.key.target.position.set(0, 0, 10)
    const s = this.key.shadow
    s.camera.left = s.camera.bottom = -40
    s.camera.right = s.camera.top = 40
    s.camera.near = 1
    s.camera.far = 160
    s.bias = -0.0005
    s.normalBias = 0.04
    this.group.add(this.hemi, this.key, this.key.target)
    scene.add(this.group)
  }

  /** A dynamic accent light for a room (≤ 4 kept per room, by priority). */
  add(room: string, light: THREE.PointLight | THREE.SpotLight, priority: number): void {
    const inRoom = this.rooms.filter((r) => r.room === room)
    if (inRoom.length >= MAX_DYNAMIC_LIGHTS) return
    light.castShadow = false
    this.rooms.push({ room, light, priority })
    this.group.add(light)
    if ((light as THREE.SpotLight).isSpotLight) this.group.add((light as THREE.SpotLight).target)
  }

  /** How many dynamic lights per room run (the rest stay off), and the shadow map size. */
  apply(o: { perRoom: number; shadowMap: number }): void {
    const byRoom = new Map<string, RoomLight[]>()
    for (const r of this.rooms) byRoom.set(r.room, [...(byRoom.get(r.room) ?? []), r])
    for (const list of byRoom.values())
      list
        .sort((a, b) => a.priority - b.priority)
        .forEach((r, i) => (r.light.visible = i < Math.min(o.perRoom, MAX_DYNAMIC_LIGHTS)))
    const size = o.shadowMap
    this.key.castShadow = size > 0
    if (size && this.key.shadow.mapSize.x !== size) {
      this.key.shadow.mapSize.set(size, size)
      this.key.shadow.map?.dispose()
      this.key.shadow.map = null
    }
  }

  setTheme(theme: 'light' | 'dark'): void {
    const t = THEMES[theme] ?? THEMES.dark
    this.background.setHex(t.background)
    this.hemi.color.setHex(t.sky)
    this.hemi.groundColor.setHex(t.ground)
    this.hemi.intensity = t.ambient
    this.key.intensity = t.key
  }

  /** Lights per room now on (debug). */
  counts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const r of this.rooms) if (r.light.visible) out[r.room] = (out[r.room] ?? 0) + 1
    return out
  }

  shadowBytes(): number {
    return this.key.castShadow ? this.key.shadow.mapSize.x ** 2 * 4 : 0
  }

  dispose(): void {
    this.key.shadow.map?.dispose()
    this.group.removeFromParent()
    for (const r of this.rooms) r.light.dispose()
    this.hemi.dispose()
    this.key.dispose()
  }
}
