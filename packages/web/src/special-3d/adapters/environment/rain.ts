// Rain (docs/special-3d/rendering.md): instanced streaks falling outside the curtain wall, animated
// entirely in the vertex shader from one time uniform (no per-frame CPU work), and the
// `rain-glass` material: droplets and running rivulets on the window glass. Off with reduced
// motion or `special.rain = false`.
import * as THREE from 'three'
import { mulberry32 } from '../../../app/special/env-schedule.ts'
import type { AABB } from '../../../app/office-types.ts'

const MAX_DROPS = 6500

const RAIN_VERT = /* glsl */ `
  attribute vec4 aDrop; // xyz offset in the volume (0..1), w speed factor
  uniform float uTime;
  uniform vec3 uMin;
  uniform vec3 uSize;
  varying float vAlpha;
  void main() {
    vec3 o = aDrop.xyz;
    float y = fract(o.y - uTime * (0.55 + 0.35 * aDrop.w) * 28.0 / uSize.y);
    vec3 base = uMin + vec3(o.x, y, o.z) * uSize;
    // Billboard around the vertical axis, facing the camera; slight wind slant.
    vec3 toCam = normalize(vec3(cameraPosition.x - base.x, 0.0, cameraPosition.z - base.z));
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
    vec3 p = base + right * position.x + vec3(0.0, position.y, 0.0) + vec3(0.25, 0.0, 0.1) * position.y;
    vAlpha = 0.35 + 0.4 * aDrop.w;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }`
const RAIN_FRAG = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() { gl_FragColor = vec4(uColor * vAlpha, vAlpha); }`

export class Rain {
  readonly mesh: THREE.InstancedMesh
  private material: THREE.ShaderMaterial
  private geometry: THREE.PlaneGeometry

  constructor(scene: THREE.Scene, volume: AABB & { minY: number; maxY: number }, seed = 5) {
    this.geometry = new THREE.PlaneGeometry(0.025, 0.9)
    const drops = new Float32Array(MAX_DROPS * 4)
    const rnd = mulberry32(seed)
    for (let i = 0; i < MAX_DROPS; i++) drops.set([rnd(), rnd(), rnd(), rnd()], i * 4)
    this.geometry.setAttribute('aDrop', new THREE.InstancedBufferAttribute(drops, 4))
    this.material = new THREE.ShaderMaterial({
      name: 'special:rain',
      uniforms: {
        uTime: { value: 0 },
        uMin: { value: new THREE.Vector3(volume.minX, volume.minY, volume.minZ) },
        uSize: {
          value: new THREE.Vector3(
            volume.maxX - volume.minX,
            volume.maxY - volume.minY,
            volume.maxZ - volume.minZ,
          ),
        },
        uColor: { value: new THREE.Color(0x9fc8ff) },
      },
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, MAX_DROPS)
    this.mesh.name = 'rain'
    this.mesh.frustumCulled = false
    this.mesh.count = 0
    scene.add(this.mesh)
  }

  setDrops(n: number): void {
    this.mesh.count = Math.max(0, Math.min(MAX_DROPS, Math.round(n)))
    this.mesh.visible = this.mesh.count > 0
  }

  update(t: number): void {
    if (this.mesh.visible) this.material.uniforms.uTime!.value = t
  }

  dispose(): void {
    this.mesh.removeFromParent()
    this.mesh.dispose()
    this.geometry.dispose()
    this.material.dispose()
  }
}

const GLASS_VERT = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormalW;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }`
const GLASS_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uRain;
  uniform vec3 uTint;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vec3 n = abs(vNormalW);
    vec2 uv = (n.x > n.z ? vWorld.zy : vWorld.xy) * vec2(1.0, 1.0);
    // Static droplets: one per 12 cm cell, random size and offset.
    vec2 c = floor(uv * 8.0);
    vec2 f = fract(uv * 8.0) - 0.5;
    float h = hash(c);
    vec2 off = vec2(hash(c + 3.1), hash(c + 7.7)) - 0.5;
    float r = 0.08 + 0.18 * h;
    float drop = smoothstep(r, r * 0.4, length(f - off * 0.5)) * step(0.82, h);
    // Running rivulets: columns with a drop sliding down and a faint trail above it.
    float col = floor(uv.x * 3.0);
    float hc = hash(vec2(col, 1.7));
    float lane = step(0.6, hc) * smoothstep(0.06, 0.0, abs(fract(uv.x * 3.0) - 0.5 - (hc - 0.5) * 0.6));
    float y = fract(uv.y * 0.25 + uTime * (0.08 + 0.12 * hc) + hc);
    float head = smoothstep(0.04, 0.0, abs(y - 0.5)) * lane;
    float trail = smoothstep(0.5, 0.0, y - 0.5) * step(0.5, y) * lane * 0.25;
    float wet = (drop + head + trail) * uRain;
    vec3 col3 = uTint + vec3(0.55, 0.75, 1.0) * wet * 0.9;
    gl_FragColor = vec4(col3, 0.16 + wet * 0.35);
  }`

/** The `rain-glass` material (one per scene; `uRain` 0 = dry glass when rain is off). */
export function createRainGlassMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'special:rain-glass',
    uniforms: {
      uTime: { value: 0 },
      uRain: { value: 1 },
      uTint: { value: new THREE.Color(0x061019) },
    },
    vertexShader: GLASS_VERT,
    fragmentShader: GLASS_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}
