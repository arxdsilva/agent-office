// Sims-style wall cutaway in the shader (graphics contract §13). Walls stay merged and lightmapped;
// every wall vertex carries its wall id, and a tiny per-wall texture says how visible each wall is:
// R = alpha (0..255), G = lowered (Down mode). Faded walls are dithered with an ordered 4×4 Bayer
// pattern (opaque discard: no sorting, no extra draw calls); lowered walls are cut 1 m above the
// floor with a thin charcoal cap band. The same chunk patches the AO normal/depth material.
import * as THREE from 'three'
import { WALL_DOWN_HEIGHT } from '../../app/walls.ts'

/**
 * Per-instance wall ids are written as `globalId + 0.5` (non-walls 0): a disabled vertex attribute
 * reads as a whole number (0 or a leaked default like 1), which the shader then ignores.
 */
export const WALL_ID_BIAS = 0.5
/** Height of the charcoal band on top of a lowered wall (m). */
const CAP_BAND = 0.04

/** The per-wall table every patched material samples (shared uniform). */
export const WALL_TABLE: { value: THREE.DataTexture } = {
  value: makeTexture(new Uint8Array([255, 0]), 1),
}

function makeTexture(data: Uint8Array, width: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, width, 1, THREE.RGFormat, THREE.UnsignedByteType)
  t.magFilter = THREE.NearestFilter
  t.minFilter = THREE.NearestFilter
  t.generateMipmaps = false
  t.unpackAlignment = 1
  t.needsUpdate = true
  return t
}

/**
 * A shader with `discard` loses early depth / hidden-surface removal on many GPUs (Apple's TBDR
 * especially), which costs on every building fragment. So the cut is compiled in (`AO_WALLS`) only
 * while some wall is faded, fading or lowered; otherwise the patched shaders have no discard at all.
 * Program variants are cached by three, so toggling after the first use costs no compile.
 */
const wallMats = new Set<THREE.Material>()
let wallsActive = false

function applyActive(m: THREE.Material, on: boolean): void {
  const d = ((m as THREE.Material & { defines?: Record<string, unknown> }).defines ??= {})
  if (on) d.AO_WALLS = ''
  else delete d.AO_WALLS
  m.needsUpdate = true
}

/** Every material that carries the wall chunk registers here (patch functions call it). */
export function registerWallMaterial(m: THREE.Material): void {
  if (wallMats.has(m)) return
  wallMats.add(m)
  if (wallsActive) applyActive(m, true)
  m.addEventListener('dispose', () => wallMats.delete(m))
}

/** Compiles the wall cut into (or out of) every registered material. No-op when unchanged. */
export function setWallsActive(on: boolean): void {
  if (on === wallsActive) return
  wallsActive = on
  for (const m of wallMats) applyActive(m, on)
}

/** Owns the table texture: resized when the wall count changes, uploaded only on change. */
export class WallTable {
  private data = new Uint8Array([255, 0])

  constructor() {
    // A fresh table per scene (a previous scene may have disposed the old one), cut compiled out.
    WALL_TABLE.value = makeTexture(this.data, 1)
    setWallsActive(false)
  }

  resize(total: number): void {
    const width = total + 1
    if (this.data.length === width * 2) return
    this.data = new Uint8Array(width * 2)
    for (let i = 0; i < width; i++) this.data[i * 2] = 255
    const old = WALL_TABLE.value
    WALL_TABLE.value = makeTexture(this.data, width)
    old.dispose()
  }

  /** `alpha` and `lowered` are indexed by wall id (from `WallFader.step`). */
  upload(alpha: Float32Array, lowered: Uint8Array): void {
    const n = Math.min(alpha.length, this.data.length / 2)
    for (let i = 0; i < n; i++) {
      this.data[i * 2] = Math.round(Math.max(0, Math.min(1, alpha[i]!)) * 255)
      this.data[i * 2 + 1] = lowered[i] ? 255 : 0
    }
    WALL_TABLE.value.needsUpdate = true
  }

  dispose(): void {
    WALL_TABLE.value.dispose()
  }
}

const VERTEX_DECL = 'attribute float _wallid;\nflat varying float vAoWall;\nvarying float vAoWallY;'
const VERTEX = `
  vAoWall = _wallid;
  vec4 aoWallW = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    aoWallW = instanceMatrix * aoWallW;
  #endif
  vAoWallY = ( modelMatrix * aoWallW ).y;`
const FRAGMENT_DECL = `flat varying float vAoWall;
varying float vAoWallY;
uniform sampler2D uAoWalls;
float aoBayer( vec2 p ) {
  const float m[16] = float[16]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );
  ivec2 i = ivec2( mod( p, 4.0 ) );
  return ( m[ i.x + i.y * 4 ] + 0.5 ) / 16.0;
}`
const FRAGMENT = `
  float aoWallCap = 0.0;
  #ifdef AO_WALLS
  if ( fract( vAoWall ) > 0.25 ) {
    vec2 aoW = texelFetch( uAoWalls, ivec2( int( vAoWall ), 0 ), 0 ).rg;
    if ( aoW.g > 0.5 && vAoWallY > ${WALL_DOWN_HEIGHT.toFixed(3)} ) {
      if ( vAoWallY > ${(WALL_DOWN_HEIGHT + CAP_BAND).toFixed(3)} ) discard;
      aoWallCap = 1.0;
    } else if ( aoW.r < 0.998 && aoW.r < aoBayer( gl_FragCoord.xy ) ) discard;
  }
  #endif`

/**
 * Injects the wall chunk into a material's shaders (inside `onBeforeCompile`). Declares
 * `aoWallCap` (1 on a lowered wall's cap band) for later chunks.
 */
export function injectWalls(s: THREE.WebGLProgramParametersWithUniforms): void {
  s.uniforms.uAoWalls = WALL_TABLE
  s.vertexShader = s.vertexShader
    .replace('void main() {', `${VERTEX_DECL}\nvoid main() {`)
    .replace('#include <project_vertex>', `#include <project_vertex>${VERTEX}`)
  s.fragmentShader = s.fragmentShader
    .replace('void main() {', `${FRAGMENT_DECL}\nvoid main() {`)
    .replace(
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>${FRAGMENT}`,
    )
}

/** Patches a material that has no other shader patch (the GTAO normal/depth override). */
export function patchWallMaterial(m: THREE.Material, key: string): void {
  const prev = m.onBeforeCompile.bind(m)
  m.onBeforeCompile = (s, r) => {
    prev(s, r)
    injectWalls(s)
  }
  m.customProgramCacheKey = () => `ao-wall-${key}`
  m.needsUpdate = true
  registerWallMaterial(m)
}

/**
 * A per-instance copy of a module geometry: every attribute is shared (same GPU buffers) except
 * `_wallid`, rewritten as building-global ids so one table serves every module instance.
 */
export class InstanceWalls {
  readonly geometry = new THREE.BufferGeometry()
  private local: ArrayLike<number>
  private attr: THREE.BufferAttribute

  constructor(private src: THREE.BufferGeometry) {
    const g = this.geometry
    const ids = src.getAttribute('_wallid')
    // The module's own ids (kept by the shared geometry; read back on every base change).
    this.local = ids.array
    for (const name of Object.keys(src.attributes))
      if (name !== '_wallid') g.setAttribute(name, src.getAttribute(name))
    g.setIndex(src.index)
    for (const gr of src.groups) g.addGroup(gr.start, gr.count, gr.materialIndex)
    g.setDrawRange(src.drawRange.start, src.drawRange.count)
    if (!src.boundingBox) src.computeBoundingBox()
    if (!src.boundingSphere) src.computeBoundingSphere()
    g.boundingBox = src.boundingBox
    g.boundingSphere = src.boundingSphere
    g.name = `${src.name}#walls`
    this.attr = new THREE.BufferAttribute(new Float32Array(ids.count), 1)
    g.setAttribute('_wallid', this.attr)
  }

  /** Rewrites the ids for this instance's first global id minus one. */
  setBase(base: number): void {
    const a = this.attr.array as Float32Array
    for (let i = 0; i < a.length; i++) {
      const v = this.local[i]!
      a[i] = v > 0.5 ? base + Math.round(v) + WALL_ID_BIAS : 0
    }
    this.attr.needsUpdate = true
  }

  /** Frees only what this copy owns (the shared buffers belong to the module). */
  dispose(): void {
    const g = this.geometry
    for (const name of Object.keys(g.attributes)) if (name !== '_wallid') g.deleteAttribute(name)
    g.setIndex(null)
    g.boundingBox = null
    g.boundingSphere = null
    g.dispose()
    void this.src
  }
}
