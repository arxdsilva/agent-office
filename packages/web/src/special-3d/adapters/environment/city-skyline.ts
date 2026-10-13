// City skyline (docs/special-3d/rendering.md): three depth bands of low-poly towers drawn as one
// instanced mesh per band. Windows are procedural (a hashed grid in world space) with a slow
// flicker driven by one time uniform; far bands fade into the haze. A glowing street grid lies far
// below. Original, procedural: no textures, no logos. Ambient only: it never reflects agent state.
import * as THREE from 'three'
import { mulberry32 } from '../../../app/special/env-schedule.ts'
import type { AABB } from '../../../app/office-types.ts'
import { markBloom } from '../rendering/bloom-selective.ts'

const BANDS = [
  { inner: 75, outer: 140, count: 70, minH: 40, maxH: 170 },
  { inner: 140, outer: 250, count: 120, minH: 60, maxH: 230 },
  { inner: 250, outer: 430, count: 170, minH: 80, maxH: 300 },
] as const
const BASE_Y = -140

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
  uniform float uTime;
  uniform float uAnimate;
  uniform float uHaze;
  uniform vec3 uHazeColor;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying float vSeed;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  void main() {
    vec3 n = abs(vNormalW);
    vec3 facade = mix(vec3(0.010, 0.016, 0.028), vec3(0.020, 0.030, 0.050), clamp((vWorld.y + 140.0) / 400.0, 0.0, 1.0));
    vec3 col = facade;
    if (n.y < 0.5) {
      float u = (n.x > n.z ? vWorld.z : vWorld.x) / 2.4;
      float v = vWorld.y / 3.6;
      vec2 cell = floor(vec2(u, v));
      vec2 f = fract(vec2(u, v));
      float win = step(0.18, f.x) * step(f.x, 0.82) * step(0.25, f.y) * step(f.y, 0.8);
      float h = hash(vec3(cell, vSeed));
      float lit = step(h, 0.34 + 0.2 * fract(vSeed * 7.31));
      // A few windows switch slowly (animated bands only).
      float slot = floor(uTime * 0.25 + h * 40.0);
      float flick = step(0.985, hash(vec3(cell, slot + vSeed))) * uAnimate;
      lit = abs(lit - flick);
      float tone = hash(vec3(cell.yx, vSeed + 3.0));
      vec3 warm = vec3(1.0, 0.62, 0.28);
      vec3 cool = vec3(0.35, 0.85, 1.0);
      vec3 pink = vec3(1.0, 0.25, 0.8);
      vec3 wc = tone < 0.6 ? warm : (tone < 0.92 ? cool : pink);
      col += win * lit * wc * (1.1 + 1.6 * hash(vec3(cell, 9.0)));
    } else {
      col = vec3(0.02, 0.025, 0.035);
    }
    float d = length(vWorld - cameraPosition);
    float haze = 1.0 - exp(-d * uHaze);
    // Lower floors sink into the city glow.
    haze = max(haze, clamp((-vWorld.y - 20.0) / 160.0, 0.0, 0.85));
    gl_FragColor = vec4(mix(col, uHazeColor, haze), 1.0);
  }`

const GROUND_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec3 vWorld;
  void main() {
    vec2 g = abs(fract(vWorld.xz / 36.0) - 0.5);
    float street = smoothstep(0.47, 0.5, max(g.x, g.y));
    vec2 g2 = abs(fract(vWorld.xz / 9.0) - 0.5);
    float alley = smoothstep(0.485, 0.5, max(g2.x, g2.y)) * 0.25;
    float d = length(vWorld.xz) / 600.0;
    vec3 col = vec3(1.0, 0.55, 0.2) * street * 1.6 + vec3(0.3, 0.8, 1.0) * alley;
    col *= 1.0 - clamp(d, 0.0, 1.0);
    gl_FragColor = vec4(col + vec3(0.02, 0.03, 0.05), 1.0);
  }`

export class CitySkyline {
  readonly group = new THREE.Group()
  private materials: THREE.ShaderMaterial[] = []
  private geometries: THREE.BufferGeometry[] = []
  private beacons: THREE.InstancedMesh | null = null
  private beaconMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0xe0202e).multiplyScalar(3),
  })
  /** Tower tops of the nearest band (ads and traffic attach to them). */
  readonly nearFaces: {
    pos: THREE.Vector3
    normal: THREE.Vector3
    width: number
    height: number
  }[] = []

  constructor(scene: THREE.Scene, avoid: AABB, seed = 11) {
    this.group.name = 'skyline'
    const rnd = mulberry32(seed)
    const cx = (avoid.minX + avoid.maxX) / 2
    const cz = (avoid.minZ + avoid.maxZ) / 2
    const beaconAt: THREE.Vector3[] = []
    BANDS.forEach((band, bi) => {
      const geo = new THREE.BoxGeometry(1, 1, 1)
      geo.translate(0, 0.5, 0)
      const seeds = new Float32Array(band.count)
      const mat = new THREE.ShaderMaterial({
        name: `special:skyline:${bi}`,
        uniforms: {
          uTime: { value: 0 },
          uAnimate: { value: 0 },
          uHaze: { value: 0.0016 + bi * 0.0011 },
          uHazeColor: { value: new THREE.Color(0x0a1424) },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
      })
      const mesh = new THREE.InstancedMesh(geo, mat, band.count)
      mesh.name = `skyline-band-${bi}`
      const m = new THREE.Matrix4()
      for (let i = 0; i < band.count; i++) {
        // Denser toward the curtain wall (+x): the view the atrium frames.
        const east = rnd() < 0.55
        const ang = east ? (rnd() - 0.5) * Math.PI * 0.9 : rnd() * Math.PI * 2
        const r = band.inner + rnd() * (band.outer - band.inner)
        const x = cx + Math.cos(ang) * r
        const z = cz + Math.sin(ang) * r
        const w = 10 + rnd() * (bi === 0 ? 18 : 28)
        const d = 10 + rnd() * (bi === 0 ? 18 : 28)
        const h = band.minH + rnd() ** 1.6 * (band.maxH - band.minH)
        m.makeScale(w, h - BASE_Y, d).setPosition(x, BASE_Y, z)
        mesh.setMatrixAt(i, m)
        seeds[i] = rnd() * 100
        if (bi === 0) {
          const top = h
          if (rnd() < 0.6) beaconAt.push(new THREE.Vector3(x, top + 2, z))
          // The face toward the HQ (for ad screens).
          const nx = cx - x
          const nz = cz - z
          const horiz = Math.abs(nx) > Math.abs(nz)
          const normal = horiz
            ? new THREE.Vector3(Math.sign(nx), 0, 0)
            : new THREE.Vector3(0, 0, Math.sign(nz))
          const face = new THREE.Vector3(
            x + normal.x * (w / 2 + 0.3),
            0,
            z + normal.z * (d / 2 + 0.3),
          )
          face.y = Math.min(top - 12, 20 + rnd() * 40)
          this.nearFaces.push({ pos: face, normal, width: horiz ? d : w, height: top })
        }
      }
      geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1))
      mesh.instanceMatrix.needsUpdate = true
      mesh.frustumCulled = false
      markBloom(mesh)
      this.group.add(mesh)
      this.materials.push(mat)
      this.geometries.push(geo)
    })
    // Aircraft-warning beacons on the near towers (blink together, slowly).
    if (beaconAt.length) {
      const g = new THREE.SphereGeometry(0.8, 8, 6)
      this.geometries.push(g)
      this.beacons = new THREE.InstancedMesh(g, this.beaconMat, beaconAt.length)
      const m = new THREE.Matrix4()
      beaconAt.forEach((p, i) => this.beacons!.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)))
      markBloom(this.beacons)
      this.group.add(this.beacons)
    }
    // The city far below.
    const ground = new THREE.PlaneGeometry(1400, 1400)
    ground.rotateX(-Math.PI / 2)
    this.geometries.push(ground)
    const gmat = new THREE.ShaderMaterial({
      name: 'special:city-ground',
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `varying vec3 vWorld; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: GROUND_FRAG,
    })
    this.materials.push(gmat)
    const gm = new THREE.Mesh(ground, gmat)
    gm.position.set(cx, BASE_Y + 1, cz)
    markBloom(gm)
    this.group.add(gm)
    scene.add(this.group)
  }

  /** Which bands animate their windows (0–3), and whether windows flicker at all. */
  setAnimated(bands: number, flicker: boolean): void {
    this.materials
      .slice(0, BANDS.length)
      .forEach((m, i) => (m.uniforms.uAnimate!.value = flicker && i < bands ? 1 : 0))
  }

  update(t: number): void {
    for (const m of this.materials) m.uniforms.uTime!.value = t
    if (this.beacons) {
      const on = Math.sin(t * 2.2) > 0.6
      this.beacons.visible = on
    }
  }

  dispose(): void {
    this.group.removeFromParent()
    for (const m of this.materials) m.dispose()
    for (const g of this.geometries) g.dispose()
    this.beaconMat.dispose()
  }
}
