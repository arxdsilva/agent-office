// Atmosphere (docs/special-3d/rendering.md): exponential height fog and light shafts.
// - Height fog: three's fog chunks are swapped (while a Night City scene lives) for an analytic
//   exponential height fog. `scene.fog` is a THREE.Fog whose `near` carries the density and `far`
//   the height falloff, so the built-in fog uniforms feed it without patching every material.
//   Scenes without `scene.fog` never compile the chunk (USE_FOG), so the classic office is unchanged;
//   the original chunks are restored when the last Night City scene is disposed.
// - Light shafts: additive gradient cards under ceiling fixtures and along the curtain wall.
import * as THREE from 'three'

const ORIGINAL = {
  fog_pars_vertex: THREE.ShaderChunk.fog_pars_vertex,
  fog_vertex: THREE.ShaderChunk.fog_vertex,
  fog_pars_fragment: THREE.ShaderChunk.fog_pars_fragment,
  fog_fragment: THREE.ShaderChunk.fog_fragment,
}

const HEIGHT_FOG = {
  fog_pars_vertex: /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vAoFogWorld;
#endif`,
  fog_vertex: /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vAoFogWorld = ( inverse( viewMatrix ) * mvPosition ).xyz;
#endif`,
  fog_pars_fragment: /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vAoFogWorld;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`,
  fog_fragment: /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    // Height fog: density · ∫ exp(−k·h) along the view ray (fogNear = density, fogFar = k).
    float aoK = max( fogFar, 1e-4 );
    float aoH0 = cameraPosition.y;
    float aoH1 = vAoFogWorld.y;
    float aoDh = aoH1 - aoH0;
    float aoDist = length( vAoFogWorld - cameraPosition );
    float aoInt = abs( aoDh ) > 1e-3
      ? ( exp( - aoK * aoH0 ) - exp( - aoK * aoH1 ) ) / ( aoK * aoDh )
      : exp( - aoK * aoH0 );
    float fogFactor = clamp( 1.0 - exp( - fogNear * aoDist * aoInt ), 0.0, 0.92 );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`,
}

let installs = 0
/** Swaps in the height-fog chunks (reference counted). */
export function installHeightFog(): void {
  if (installs++ === 0) Object.assign(THREE.ShaderChunk, HEIGHT_FOG)
}
/** Restores three's fog chunks once no Night City scene uses them. */
export function uninstallHeightFog(): void {
  if (installs > 0 && --installs === 0) Object.assign(THREE.ShaderChunk, ORIGINAL)
}

const SHAFT_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`
const SHAFT_FRAG = /* glsl */ `
  uniform vec3 color;
  uniform float strength;
  uniform float time;
  varying vec2 vUv;
  void main() {
    // Bright at the source (top), fading down and towards the edges; a slow dust shimmer.
    float edge = smoothstep(0.0, 0.35, vUv.x) * smoothstep(1.0, 0.65, vUv.x);
    float fall = pow(vUv.y, 1.6);
    float dust = 0.85 + 0.15 * sin(vUv.y * 40.0 + time * 0.6 + vUv.x * 9.0);
    gl_FragColor = vec4(color * strength * edge * fall * dust, 1.0);
  }`

export interface ShaftSpec {
  /** Top centre of the shaft (world). */
  top: THREE.Vector3
  /** Length downward and width at the bottom. */
  length: number
  width: number
  yaw: number
  /** Tilt from vertical (radians), e.g. sunlight through the curtain wall. */
  tilt?: number
  color: number
}

export class Atmosphere {
  readonly group = new THREE.Group()
  private fog = new THREE.Fog(0x0a1220, 0.012, 0.09)
  private materials: THREE.ShaderMaterial[] = []
  private geometry = new THREE.PlaneGeometry(1, 1, 1, 1)

  constructor(private scene: THREE.Scene) {
    this.group.name = 'atmosphere'
    installHeightFog()
    scene.add(this.group)
  }

  /** Two crossed cards per shaft (reads from any angle). */
  addShafts(specs: ShaftSpec[]): void {
    for (const s of specs) {
      const mat = new THREE.ShaderMaterial({
        name: 'special:shaft',
        uniforms: {
          color: { value: new THREE.Color(s.color) },
          strength: { value: 0.22 },
          time: { value: 0 },
        },
        vertexShader: SHAFT_VERT,
        fragmentShader: SHAFT_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      })
      this.materials.push(mat)
      for (const rot of [0, Math.PI / 2]) {
        const m = new THREE.Mesh(this.geometry, mat)
        m.scale.set(s.width, s.length, 1)
        m.position.copy(s.top).add(new THREE.Vector3(0, -s.length / 2, 0))
        m.rotation.set(0, s.yaw + rot, s.tilt ?? 0, 'YXZ')
        m.renderOrder = 5
        this.group.add(m)
      }
    }
  }

  /** Fog on/off with density (per metre) and colour; shafts on/off. */
  apply(o: { fog: boolean; density: number; shafts: boolean; color?: number }): void {
    if (o.color !== undefined) this.fog.color.setHex(o.color)
    this.fog.near = o.density
    this.fog.far = 0.09
    this.scene.fog = o.fog && o.density > 0 ? this.fog : null
    this.group.visible = o.shafts
  }

  update(t: number): void {
    if (!this.group.visible) return
    for (const m of this.materials) m.uniforms.time!.value = t
  }

  dispose(): void {
    this.scene.fog = null
    this.scene.remove(this.group)
    for (const m of this.materials) m.dispose()
    this.geometry.dispose()
    uninstallHeightFog()
  }
}
