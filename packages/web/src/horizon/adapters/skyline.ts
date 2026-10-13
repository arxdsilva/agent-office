// Horizon's daytime skyline (docs/horizon/rendering.md): three haze layers of pale, low-contrast
// towers around the office, one instanced mesh per layer. Static: no lit or flickering windows,
// no ads, no traffic, no beacons. Procedural, no textures; ambient only (never agent state).
import * as THREE from 'three'
import type { AABB } from '../../app/office-types.ts'

/** Radii at scale 1 (the group scales up when the office is wider). */
const BANDS = [
  { inner: 110, outer: 170, count: 46, minH: 18, maxH: 70 },
  { inner: 170, outer: 270, count: 80, minH: 30, maxH: 110 },
  { inner: 270, outer: 420, count: 120, minH: 40, maxH: 150 },
] as const
/** Tower feet sink into the haze below the office floor. */
const BASE_Y = -70
/** The skyline keeps at least this much open ground (m) beyond the office's footprint. */
const CLEARANCE = 60

const VERT = /* glsl */ `
  attribute float aSeed;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying float vSeed;
  void main() {
    vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormalW = normalize(mat3(modelMatrix * instanceMatrix) * normal);
    vSeed = aSeed;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`

const FRAG = /* glsl */ `
  uniform vec3 uFacadeA;
  uniform vec3 uFacadeB;
  uniform vec3 uGlass;
  uniform vec3 uHazeColor;
  uniform vec3 uSun;
  uniform float uHaze;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying float vSeed;
  void main() {
    vec3 n = normalize(vNormalW);
    vec3 col = mix(uFacadeA, uFacadeB, fract(vSeed * 0.137));
    if (abs(n.y) < 0.5) {
      // Calm glass bands, one per floor (static).
      float v = fract(vWorld.y / 3.6);
      col = mix(col, uGlass, step(0.38, v) * step(v, 0.86) * 0.5);
    }
    col *= 0.84 + 0.16 * max(dot(n, uSun), 0.0);
    float haze = 1.0 - exp(-length(vWorld - cameraPosition) * uHaze);
    // The lower floors dissolve into the haze.
    haze = max(haze, clamp((8.0 - vWorld.y) / 70.0, 0.0, 0.92));
    gl_FragColor = vec4(mix(col, uHazeColor, haze), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`

/** A small seeded PRNG (mulberry32): the same skyline on every start. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface SkylineColors {
  facadeA: number
  facadeB: number
  glass: number
  haze: number
  sun: THREE.Vector3
}

export class Skyline {
  readonly group = new THREE.Group()
  private materials: THREE.ShaderMaterial[] = []
  private geometries: THREE.BufferGeometry[] = []

  constructor(colors: SkylineColors, seed = 7) {
    this.group.name = 'skyline'
    const rnd = prng(seed)
    BANDS.forEach((band, bi) => {
      const geo = new THREE.BoxGeometry(1, 1, 1)
      geo.translate(0, 0.5, 0)
      const seeds = new Float32Array(band.count)
      const mat = new THREE.ShaderMaterial({
        name: `horizon:skyline:${bi}`,
        uniforms: {
          uFacadeA: { value: new THREE.Color(colors.facadeA) },
          uFacadeB: { value: new THREE.Color(colors.facadeB) },
          uGlass: { value: new THREE.Color(colors.glass) },
          uHazeColor: { value: new THREE.Color(colors.haze) },
          uSun: { value: colors.sun.clone().normalize() },
          // Farther layers are hazier: three distinct, low-contrast depths.
          uHaze: { value: 0.0026 + bi * 0.0016 },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
      })
      const mesh = new THREE.InstancedMesh(geo, mat, band.count)
      mesh.name = `skyline-band-${bi}`
      const m = new THREE.Matrix4()
      for (let i = 0; i < band.count; i++) {
        const ang = rnd() * Math.PI * 2
        const r = band.inner + rnd() * (band.outer - band.inner)
        const w = 12 + rnd() * (bi === 0 ? 16 : 26)
        const d = 12 + rnd() * (bi === 0 ? 16 : 26)
        const h = band.minH + rnd() ** 1.7 * (band.maxH - band.minH)
        m.makeScale(w, h - BASE_Y, d).setPosition(Math.cos(ang) * r, BASE_Y, Math.sin(ang) * r)
        mesh.setMatrixAt(i, m)
        seeds[i] = rnd() * 100
      }
      geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1))
      mesh.instanceMatrix.needsUpdate = true
      mesh.frustumCulled = false
      this.group.add(mesh)
      this.materials.push(mat)
      this.geometries.push(geo)
    })
  }

  /** Centres the skyline on the office and widens it so the nearest towers keep their distance. */
  place(b: AABB): void {
    const half = Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) / 2
    const s = Math.max(1, (half + CLEARANCE) / BANDS[0].inner)
    this.group.position.set((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2)
    this.group.scale.set(s, 1, s)
    this.group.updateMatrixWorld(true)
  }

  dispose(): void {
    this.group.removeFromParent()
    for (const m of this.materials) m.dispose()
    for (const g of this.geometries) g.dispose()
  }
}
