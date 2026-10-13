// Night City materials (docs/special-3d/art-direction.md): brushed metal, wet concrete (roughness
// map + puddle mask, reflecting the room's probe), dark glass, carbon, polished stone, painted
// steel, frosted partitions, and emissive accents. Shared per key so placeholder geometry and the
// real glb set reuse one GPU program each; textures are generated procedurally (no files).
import * as THREE from 'three'
import { mulberry32 } from '../../../app/special/env-schedule.ts'

export const PALETTE = {
  charcoal: 0x0d0f12,
  graphite: 0x1a1d22,
  navy: 0x0f1a2a,
  steel: 0x5b6470,
  cyan: 0x29e3ff,
  magenta: 0xff2bd6,
  amber: 0xffb02e,
  acid: 0xd7ff3a,
  red: 0xe0202e,
} as const

/** Puddle mask as a roughness map: dark (glossy) puddles on a mid-rough concrete. */
function puddleTexture(seed: number, size = 256): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const rnd = mulberry32(seed)
  g.fillStyle = 'rgb(150,150,150)'
  g.fillRect(0, 0, size, size)
  // Speckle (concrete grain).
  for (let i = 0; i < 2600; i++) {
    const v = 120 + Math.floor(rnd() * 70)
    g.fillStyle = `rgb(${v},${v},${v})`
    g.fillRect(rnd() * size, rnd() * size, 1 + rnd() * 2, 1 + rnd() * 2)
  }
  // Puddles: soft, glossy blobs (wrapping so the tile repeats).
  for (let i = 0; i < 14; i++) {
    const x = rnd() * size
    const y = rnd() * size
    const r = 10 + rnd() * 38
    for (const ox of [-size, 0, size])
      for (const oy of [-size, 0, size]) {
        const grad = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r)
        grad.addColorStop(0, 'rgba(18,18,18,0.95)')
        grad.addColorStop(0.7, 'rgba(30,30,30,0.6)')
        grad.addColorStop(1, 'rgba(150,150,150,0)')
        g.fillStyle = grad
        g.beginPath()
        g.ellipse(x + ox, y + oy, r, r * (0.5 + rnd() * 0.5), rnd() * Math.PI, 0, Math.PI * 2)
        g.fill()
      }
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.NoColorSpace
  t.name = 'special:puddles'
  return t
}

/** Brushed-metal streaks (a roughness map). */
function brushedTexture(seed: number, size = 128): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const rnd = mulberry32(seed)
  for (let y = 0; y < size; y++) {
    const v = 90 + Math.floor(rnd() * 60)
    g.fillStyle = `rgb(${v},${v},${v})`
    g.fillRect(0, y, size, 1)
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.NoColorSpace
  t.name = 'special:brushed'
  return t
}

export class MaterialLibrary {
  private cache = new Map<string, THREE.Material>()
  private textures: THREE.Texture[] = []
  private puddles: THREE.CanvasTexture
  private brushed: THREE.CanvasTexture

  constructor(seed = 7) {
    this.puddles = puddleTexture(seed)
    this.brushed = brushedTexture(seed + 1)
    this.textures.push(this.puddles, this.brushed)
  }

  private get<T extends THREE.Material>(key: string, make: () => T): T {
    let m = this.cache.get(key) as T | undefined
    if (!m) {
      m = make()
      m.name = `special:${key}`
      this.cache.set(key, m)
    }
    return m
  }

  /** Wet concrete for one room: its own instance so the room's reflection probe can be applied. */
  wetFloor(room: string, repeat = 6): THREE.MeshStandardMaterial {
    return this.get(`wet-floor:${room}`, () => {
      const map = this.puddles.clone()
      map.repeat.set(repeat, repeat)
      map.needsUpdate = true
      this.textures.push(map)
      return new THREE.MeshStandardMaterial({
        color: 0x15181d,
        roughness: 1,
        roughnessMap: map,
        metalness: 0.1,
        envMapIntensity: 1.4,
      })
    })
  }

  concrete(): THREE.MeshStandardMaterial {
    return this.get(
      'concrete',
      () => new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.85 }),
    )
  }

  graphitePanel(): THREE.MeshStandardMaterial {
    return this.get(
      'graphite',
      () =>
        new THREE.MeshStandardMaterial({
          color: PALETTE.graphite,
          roughness: 0.55,
          metalness: 0.35,
        }),
    )
  }

  brushedMetal(): THREE.MeshStandardMaterial {
    return this.get(
      'brushed',
      () =>
        new THREE.MeshStandardMaterial({
          color: 0x7b8490,
          roughness: 0.6,
          roughnessMap: this.brushed,
          metalness: 0.9,
        }),
    )
  }

  paintedSteel(): THREE.MeshStandardMaterial {
    return this.get(
      'painted-steel',
      () => new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.45, metalness: 0.6 }),
    )
  }

  carbon(): THREE.MeshStandardMaterial {
    return this.get(
      'carbon',
      () => new THREE.MeshStandardMaterial({ color: 0x101215, roughness: 0.35, metalness: 0.2 }),
    )
  }

  stone(): THREE.MeshStandardMaterial {
    return this.get(
      'stone',
      () => new THREE.MeshStandardMaterial({ color: 0x2e2a28, roughness: 0.25, metalness: 0.05 }),
    )
  }

  leather(): THREE.MeshStandardMaterial {
    return this.get(
      'leather',
      () => new THREE.MeshStandardMaterial({ color: 0x1b1714, roughness: 0.5, metalness: 0 }),
    )
  }

  foliage(): THREE.MeshStandardMaterial {
    return this.get(
      'foliage',
      () => new THREE.MeshStandardMaterial({ color: 0x1f3a1c, roughness: 0.8, flatShading: true }),
    )
  }

  bark(): THREE.MeshStandardMaterial {
    return this.get(
      'bark',
      () => new THREE.MeshStandardMaterial({ color: 0x3a2618, roughness: 0.9 }),
    )
  }

  darkGlass(): THREE.MeshPhysicalMaterial {
    return this.get(
      'dark-glass',
      () =>
        new THREE.MeshPhysicalMaterial({
          color: 0x0b1a26,
          roughness: 0.05,
          metalness: 0,
          transparent: true,
          opacity: 0.28,
          depthWrite: false,
          envMapIntensity: 1.2,
        }),
    )
  }

  frosted(): THREE.MeshStandardMaterial {
    return this.get(
      'frosted',
      () =>
        new THREE.MeshStandardMaterial({
          color: 0x9fb6c8,
          roughness: 0.9,
          transparent: true,
          opacity: 0.18,
          depthWrite: false,
        }),
    )
  }

  /** Unlit emissive accent (bloom layer): `intensity` > 1 blooms. */
  emissive(color: number, intensity = 2.2): THREE.MeshBasicMaterial {
    return this.get(`emissive:${color.toString(16)}:${intensity}`, () => {
      const c = new THREE.Color(color).multiplyScalar(intensity)
      return new THREE.MeshBasicMaterial({ color: c, toneMapped: true })
    })
  }

  /** Every cached material and generated texture (GPU accounting, dispose). */
  all(): THREE.Material[] {
    return [...this.cache.values()]
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose()
    for (const t of this.textures) t.dispose()
    this.cache.clear()
    this.textures = []
  }
}
