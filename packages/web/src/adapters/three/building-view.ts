// The building (contract §2, §5, §6): module instances from `BuildingLayout`, lightmaps, runtime-driven
// surfaces (screens, booth LEDs, signs, the LED wall, elevator doors), ceilings, colliders, culling.
// Graphics levers (low-spec plan §5.3): detail-cull distance, lightmap size tier (load → swap →
// dispose, live), canvas resolution and LED-wall redraw rate.
import { STATUS_COLORS } from '@agent-office/shared'
import * as THREE from 'three'
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'
import type { LightmapTier } from '../../app/graphics-types.ts'
import { LIB_COPY } from '../../app/library-copy.ts'
import type { Lightmap, Manifest } from '../../app/manifest.ts'
import type { AABB, BuildingLayout, ModulePlacement, Vec3 } from '../../app/office-types.ts'
import type { ProviderSurfaces, SurfaceSlot } from '../../app/capability-vm.ts'
import { DETAIL_DISTANCE, moduleCulling } from '../../app/culling.ts'
import { contextHubActive, contextPulse } from '../../app/stations.ts'
import { wallBases, wallBoxes, type WallBox } from '../../app/walls.ts'
import { lightmapFile, type AssetStore, type TieredLightmap } from './assets.ts'
import {
  accentOrBlue,
  canvasFor,
  drawBoard,
  drawBooks,
  drawNotebook,
  drawStation,
  type Surface,
} from './surfaces.ts'
import { injectWalls, InstanceWalls, registerWallMaterial } from './wall-cutaway.ts'

/** World-space box from a `collider` mesh (walk-mode collision, label occlusion). */
export interface WorldBox {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
}

/** One placed capability surface (camera close-ups). Width × height from its extras (m). */
export interface SurfaceSpot {
  pos: THREE.Vector3
  placement: string
  role: SurfaceRole
  slot: string
  width: number
  height: number
}

export interface ScreenState {
  color: string
  /** Emissive strength; > ~1 blooms. */
  intensity: number
}

export interface WallStats {
  agents: number
  working: number
  waiting: number
  meetings: number
  wings: number
}

/**
 * Baked meshes get their light from the lightmap: no punctual/hemisphere lights, no IBL diffuse (§6).
 * three.js substitutes light counts as literals, so the light loops are cut by zeroing them in the chunk.
 */
const BAKED_LIGHTS = THREE.ShaderChunk.lights_fragment_begin.replace(/\bNUM_[A-Z_]+\b/g, '0')
const BAKED_MAPS = THREE.ShaderChunk.lights_fragment_maps.replace(
  'iblIrradiance += getIBLIrradiance( geometryNormal );',
  '',
)
/** Environment reflections on baked surfaces (specular only). */
export const BAKED_SPECULAR = 0.55
const DIM_FACTOR = 0.35
/** The Context Hub's glow colour (shared with the 2D hub). */
const CONTEXT_COLOR = '#66d9e8'
const DOOR_TRAVEL = 0.55
const DOOR_SPEED = 1 / 0.9
const MODULE_HEIGHT = 7.5
/** Unbaked meshes entirely above this (m) count as ceiling fixtures. */
const OVERHEAD_Y = 3.4

type StdMat = THREE.MeshStandardMaterial

/**
 * Cutaway caps: with ceilings hidden in orbit view, the top faces of walls and tall furniture
 * (above 3.3 m, facing up) render flat charcoal, so the floor plan reads cleanly (and they don't bloom).
 */
export const CAP_HEIGHT = 3.3
const CAP_LINEAR = 'vec3( 0.022, 0.024, 0.028 )'
/** 1 in orbit view (ceilings hidden), 0 in walk mode. Shared by every patched material. */
export const ORBIT_VIEW = { value: 1 }
/** From above, static surfaces never exceed this (linear), below the bloom threshold: no glare bands. */
const ORBIT_MAX = 1.0
const CUT_VERTEX = `
  vec4 aoWorld = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    aoWorld = instanceMatrix * aoWorld;
  #endif
  aoWorld = modelMatrix * aoWorld;
  vAoY = aoWorld.y;
  vAoNy = normalize( mat3( modelMatrix ) * objectNormal ).y;`
const CUT_DECL = 'varying float vAoY;\nvarying float vAoNy;\nuniform float uAoOrbit;'
const CUT_FRAGMENT = `
  #ifdef AO_FIXTURE
    if ( uAoOrbit > 0.5 && vAoY > ${CAP_HEIGHT.toFixed(2)} ) discard;
  #endif
  #ifdef AO_SKYLIGHT
    if ( uAoOrbit > 0.5 && vAoY > ${CAP_HEIGHT.toFixed(2)} && abs( vAoNy ) > 0.7 ) discard;
  #endif`

export type CutawayMode = 'baked' | 'fixture' | 'glass'

/**
 * Cutaway for the orbit view (ceilings hidden), done in the shader because static geometry is merged
 * per material:
 * - baked: lightmap only (no punctual lights, no IBL diffuse); up-facing tops above 3.3 m (wall and
 *   shelf tops) render flat charcoal so the floor plan reads cleanly and nothing blooms;
 * - fixture (emissive baked lights): everything above 3.3 m is a ceiling light → hidden in orbit;
 * - glass: horizontal panes above 3.3 m (skylights) → hidden in orbit.
 */
function patchCutaway(m: StdMat, mode: CutawayMode): void {
  m.defines = { ...m.defines }
  if (mode === 'fixture') m.defines.AO_FIXTURE = ''
  if (mode === 'glass') m.defines.AO_SKYLIGHT = ''
  m.onBeforeCompile = (s) => {
    s.uniforms.uAoOrbit = ORBIT_VIEW
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>\n${CUT_DECL}`)
      .replace('#include <project_vertex>', `#include <project_vertex>${CUT_VERTEX}`)
    let f = s.fragmentShader
      .replace('#include <common>', `#include <common>\n${CUT_DECL}`)
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>${CUT_FRAGMENT}`,
      )
    if (mode !== 'glass')
      f = f
        .replace('#include <lights_fragment_begin>', BAKED_LIGHTS)
        .replace('#include <lights_fragment_maps>', BAKED_MAPS)
        .replace(
          '#include <tonemapping_fragment>',
          `if ( uAoOrbit > 0.5 ) {\n  if ( vAoY > ${CAP_HEIGHT.toFixed(2)} && vAoNy > 0.7 ) gl_FragColor.rgb = ${CAP_LINEAR};\n  gl_FragColor.rgb = min( gl_FragColor.rgb, vec3( ${ORBIT_MAX.toFixed(2)} ) );\n}\nif ( aoWallCap > 0.5 ) gl_FragColor.rgb = ${CAP_LINEAR};\n#include <tonemapping_fragment>`,
        )
    s.fragmentShader = f
    // Wall cutaway (contract §13): fade/lower walls per fragment from the per-wall table.
    injectWalls(s)
  }
  m.customProgramCacheKey = () => `ao-cut-${mode}-wall`
  m.userData.cutaway = mode
  registerWallMaterial(m)
}

const patchBaked = (m: StdMat) =>
  patchCutaway(
    m,
    m.emissive && m.emissive.getHex() !== 0 && m.emissiveIntensity > 0 ? 'fixture' : 'baked',
  )

/**
 * Wall-mounted runtime nodes (screens, signs, books on wall shelves; contract §13) carry a wall id but
 * no cutaway patch: they get the wall chunk alone, so they fade and lower with their wall.
 */
function patchWallOnly(m: StdMat): void {
  m.onBeforeCompile = (s) => injectWalls(s)
  m.customProgramCacheKey = () => 'ao-wall-only'
  m.userData.wallOnly = true
  registerWallMaterial(m)
}

/** Material clone that keeps the baked shader patch (three's clone() drops onBeforeCompile). */
function cloneMat<T extends THREE.Material>(m: T): T {
  const c = m.clone()
  if (m.userData.cutaway) patchCutaway(c as unknown as StdMat, m.userData.cutaway as CutawayMode)
  else if (m.userData.wallOnly) patchWallOnly(c as unknown as StdMat)
  return c
}

const meshesOf = (o: THREE.Object3D) => {
  const out: THREE.Mesh[] = []
  o.traverse((c) => (c as THREE.Mesh).isMesh && out.push(c as THREE.Mesh))
  return out
}
const matsOf = (m: THREE.Mesh) =>
  (Array.isArray(m.material) ? m.material : [m.material]) as StdMat[]

/** Gives each mesh under `o` its own material copies (per-instance emissive control) and returns them. */
function ownMaterials(o: THREE.Object3D): StdMat[] {
  const out: StdMat[] = []
  for (const mesh of meshesOf(o)) {
    const mats = matsOf(mesh).map((m) => cloneMat(m))
    mesh.material = Array.isArray(mesh.material) ? mats : mats[0]!
    out.push(...mats)
  }
  return out
}

/**
 * One-time preparation of a parsed module (shared by all its clones): lightmaps on `baked` meshes,
 * cheap glass instead of transmission, colliders invisible.
 */
function prepareModule(
  gltf: GLTF,
  lightmap: THREE.Texture | null,
  lm: Lightmap | undefined,
  scale = 1,
): void {
  if (gltf.userData.prepared) return
  gltf.userData.prepared = true
  const bakedMats = new Set<StdMat>()
  const otherMats = new Set<StdMat>()
  gltf.scene.traverse((o) => {
    const role = o.userData.role as string | undefined
    if (role === 'collider') {
      o.visible = false
      return
    }
    for (const mesh of (o as THREE.Mesh).isMesh ? [o as THREE.Mesh] : []) {
      mesh.castShadow = false
      mesh.receiveShadow = false
      const baked = lightmap && isLightmapped(mesh) && mesh.geometry.getAttribute('uv1')
      for (const m of matsOf(mesh)) (baked ? bakedMats : otherMats).add(m)
    }
  })
  // A material shared by baked and unbaked meshes is split so only the baked ones sample UV1.
  const swap = new Map<StdMat, StdMat>()
  for (const m of bakedMats) swap.set(m, otherMats.has(m) ? m.clone() : m)
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const mats = matsOf(mesh)
    const glassy = mats.map((m) => toCheapGlass(m))
    if (!(lightmap && isLightmapped(mesh) && mesh.geometry.getAttribute('uv1'))) {
      mesh.material = Array.isArray(mesh.material) ? glassy : glassy[0]!
      return
    }
    const baked = glassy.map((m) => swap.get(m) ?? m)
    mesh.material = Array.isArray(mesh.material) ? baked : baked[0]!
  })
  // Glass panes: skylights are cut away in orbit view like the ceilings.
  const glass = new Set<StdMat>()
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.isMesh && inherited(mesh, 'role') === 'glass')
      for (const m of matsOf(mesh)) glass.add(m)
  })
  for (const m of glass) if (!m.userData.cutaway) (patchCutaway(m, 'glass'), (m.needsUpdate = true))
  // Wall-mounted pieces outside the baked/glass sets (screens, signs, wall shelves' books).
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry.getAttribute('_wallid')) return
    for (const m of matsOf(mesh))
      if (!m.userData.cutaway && !m.userData.wallOnly && !swap.has(m))
        (patchWallOnly(m), (m.needsUpdate = true))
  })
  for (const m of new Set(swap.values())) bakeMaterial(m, lightmap!, (lm?.intensity ?? 1) * scale)
}

/**
 * A lightmapped material (contract §6): the atlas through UV1, no punctual lights and no IBL
 * diffuse (BAKED_LIGHTS/BAKED_MAPS), specular reflections only, plus the orbit-view cutaway and
 * wall-fade patch.
 */
export function bakeMaterial(m: StdMat, lightmap: THREE.Texture, intensity: number): void {
  m.lightMap = lightmap
  m.lightMapIntensity = intensity
  m.envMapIntensity = BAKED_SPECULAR
  patchBaked(m)
  m.needsUpdate = true
}

/** `baked` meshes, and ceilings flagged `extras.lightmap`, sample the module atlas through UV1. */
const isLightmapped = (mesh: THREE.Mesh) =>
  (inherited(mesh, 'role') === 'baked' || inherited(mesh, 'lightmap') === true) &&
  !!mesh.geometry.getAttribute('uv1')

/** The role of the nearest ancestor node that has one (extras land on the node's Object3D). */
export function inherited(o: THREE.Object3D, key: string): unknown {
  for (let p: THREE.Object3D | null = o; p; p = p.parent)
    if (p.userData[key] !== undefined) return p.userData[key]
  return undefined
}

/** Screen-space transmission is an extra full scene render per frame; plain transparency reads as glass. */
export function toCheapGlass(m: StdMat): StdMat {
  const p = m as THREE.MeshPhysicalMaterial
  if (!p.isMeshPhysicalMaterial || !(p.transmission > 0)) return m
  if (m.userData.cheapGlass) return m.userData.cheapGlass as StdMat
  const g = new THREE.MeshPhysicalMaterial({
    color: p.color,
    roughness: Math.min(p.roughness, 0.08),
    metalness: 0,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    envMapIntensity: 1.2,
    side: THREE.DoubleSide,
  })
  g.name = `${m.name}-glass`
  m.userData.cheapGlass = g
  return g
}

export type SurfaceRole = 'station' | 'book' | 'board' | 'notebook'

/** The Library drawer tab an overflow surface opens. */
const MORE_TAB: Record<SurfaceRole, string> = {
  book: 'skills',
  board: 'rules',
  notebook: 'memory',
  station: 'adapters',
}

interface Door {
  obj: THREE.Object3D
  base: THREE.Vector3
  axis: THREE.Vector3
  sign: number
  bank: string
}

interface Instance {
  placement: ModulePlacement
  file: string
  group: THREE.Group
  content: THREE.Object3D | null
  box: THREE.Box3
  screens: Map<string, StdMat[]>
  leds: Map<string, StdMat[]>
  signs: { ref: string; mats: StdMat[]; aspect: number }[]
  ledwall: StdMat[]
  arcades: StdMat[]
  doors: Door[]
  /** Elevator bank id → world position (door centers) and open amount 0..1. */
  banks: Map<string, { pos: THREE.Vector3; open: number }>
  ceilings: THREE.Object3D[]
  /** Capability surfaces by role → ref (station, book, board, notebook), drawn at runtime. */
  surfaces: Map<SurfaceRole, Map<string, Surface>>
  /** Small interior detail hidden beyond DETAIL_DISTANCE (overview): spines, boards, notebooks, kiosk screens. */
  detail: THREE.Object3D[]
  /** Last detail visibility applied. */
  detailShown: boolean
  /** Last drawn book atlas content. */
  booksKey: string
  /** One canvas atlas per shelf (12 spines each); spines show a slice through texture offsets. */
  bookAtlases: THREE.CanvasTexture[]
  colliders: WorldBox[]
  /** Dimmed material copies (source → copy) and what each mesh had before. */
  dimmed: Map<THREE.Mesh, THREE.Material | THREE.Material[]> | null
  label: string
  signVariant: number
  /** Per-instance geometries carrying building-global wall ids (contract §13), and their base. */
  walls: InstanceWalls[]
  wallBase: number
}

const SCREEN_OFF: ScreenState = { color: '#0b0d12', intensity: 0 }

/** Renders the building and its live surfaces. Placement decisions come from `BuildingLayout`. */
export class BuildingView {
  readonly group = new THREE.Group()
  private instances = new Map<string, Instance>()
  private screens = new Map<string, ScreenState>()
  private leds = new Set<string>()
  private stats: WallStats = { agents: 0, working: 0, waiting: 0, meetings: 0, wings: 0 }
  private surfaces = new Map<string, ProviderSurfaces>()
  private surfaceTime = 0
  private pickList: THREE.Object3D[] | null = null
  private wallCanvas = document.createElement('canvas')
  private wallTexture = new THREE.CanvasTexture(this.wallCanvas)
  private wallDrawn = ''
  private ceilingsVisible = false
  private frustum = new THREE.Frustum()
  private projScreen = new THREE.Matrix4()
  private tmp = new THREE.Vector3()
  private arcadeT = 0
  private contextT = 0
  private contextLevel = 0.3
  private collidersCache: WorldBox[] | null = null
  /** Prepared modules by file, with the lightmap they use now (for tier swaps). */
  private prepared = new Map<string, { gltf: GLTF; lm?: TieredLightmap }>()
  private tier: LightmapTier = 'full'
  private detailCullM = DETAIL_DISTANCE
  /** Canvas surfaces' resolution (0.5 on Low and Minimal). */
  private canvasScale = 1
  /** LED wall redraws only when the minute changes (Low and Minimal). */
  private wallThrottle = false
  /** Wall cutaway (contract §13): every wall's box, and each placement's first global id − 1. */
  private wallList: WallBox[] = []
  private wallTotal = 0
  private wallBase = new Map<string, number>()
  /** Fires when a module finished loading (colliders and surfaces changed). */
  onChange: () => void = () => {}

  private emissiveMax: number
  private lightmapScale: number

  /** An emissive intensity within the flavor's ceiling. */
  private em(v: number): number {
    return Math.min(v, this.emissiveMax)
  }

  constructor(
    private store: AssetStore,
    private manifest: Manifest,
    /**
     * A scene flavor's levels. `emissiveMax`: ceiling on emissive intensity ("neon
     * only where it has a purpose"). `lightmapScale`: multiplies the manifest's lightmap
     * intensity. Classic: neither, so every value is exactly as before.
     */
    flavor: { emissiveMax?: number; lightmapScale?: number } = {},
  ) {
    this.emissiveMax = flavor.emissiveMax ?? Infinity
    this.lightmapScale = flavor.lightmapScale ?? 1
    this.wallCanvas.width = 1536
    this.wallCanvas.height = 512
    this.wallTexture.colorSpace = THREE.SRGBColorSpace
    this.wallTexture.flipY = false
    this.wallTexture.anisotropy = 4
    this.group.name = 'building'
    // Static: the renderer skips this subtree's per-frame matrix walk; we update it on change.
    this.group.matrixWorldAutoUpdate = false
  }

  /** Files for a placement (module .glb + lightmap). */
  private filesFor(p: ModulePlacement): { file: string; lightmap?: Lightmap } | null {
    if (p.kind === 'wing') {
      const t = p.theme ? this.manifest.modules.wing.themes[p.theme] : undefined
      return t ? { file: t.file, ...(t.lightmap ? { lightmap: t.lightmap } : {}) } : null
    }
    const m = this.manifest.modules[p.kind]
    return { file: m.file, ...(m.lightmap ? { lightmap: m.lightmap } : {}) }
  }

  /** Loads (and prepares) the modules needed first, for the loading screen. */
  async preload(kinds: ModulePlacement['kind'][]): Promise<void> {
    await Promise.all(
      kinds.map((k) => {
        const p = { id: k, kind: k, position: { x: 0, z: 0 }, yaw: 0 } as ModulePlacement
        if (k === 'wing') {
          return Promise.all(
            Object.values(this.manifest.modules.wing.themes).map((t) =>
              this.loadPrepared(t.file, t.lightmap).catch(() => null),
            ),
          )
        }
        const f = this.filesFor(p)!
        return this.loadPrepared(f.file, f.lightmap).catch(() => null)
      }),
    )
  }

  private async loadPrepared(file: string, lm?: Lightmap): Promise<GLTF> {
    const tier = this.tier
    const [gltf, tex] = await Promise.all([
      this.store.module(file),
      lm ? this.store.lightmap(lm, tier).catch(() => null) : Promise.resolve(null),
    ])
    const first = !gltf.userData.prepared
    prepareModule(gltf, tex, lm, this.lightmapScale)
    if (first) {
      // The flavor's ceiling on the module's own emissives (light lines, fixtures, signs).
      if (this.emissiveMax < Infinity)
        gltf.scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh)
            for (const m of matsOf(o as THREE.Mesh))
              if (m.emissiveIntensity > this.emissiveMax) m.emissiveIntensity = this.emissiveMax
        })
      gltf.userData.lightmapFile = tex && lm ? lightmapFile(lm, tier) : undefined
      this.prepared.set(file, { gltf, ...(lm ? { lm } : {}) })
      // The tier changed while this module loaded: bring it up to date.
      if (tier !== this.tier) void this.swapLightmap(file)
    }
    return gltf
  }

  /**
   * Graphics levers (low-spec plan §5.3): furniture/detail cull distance, lightmap size tier
   * (swapped live: load the new tier, swap it on every material, dispose the old), canvas
   * resolution (redraws every surface), and the LED wall's redraw rate.
   */
  setDetail(d: { detailCullM: number; lightmapTier: LightmapTier; lowCanvas: boolean }): void {
    this.detailCullM = d.detailCullM
    // Force the next update to re-apply detail visibility.
    for (const inst of this.instances.values()) inst.detailShown = !inst.detailShown
    const scale = d.lowCanvas ? 0.5 : 1
    if (scale !== this.canvasScale) {
      this.canvasScale = scale
      for (const inst of this.instances.values()) {
        inst.booksKey = ''
        for (const byRef of inst.surfaces.values()) for (const sf of byRef.values()) sf.key = ''
      }
      this.surfaceTime = 1
    }
    this.wallThrottle = d.lowCanvas
    if (d.lightmapTier !== this.tier) {
      this.tier = d.lightmapTier
      for (const file of this.prepared.keys()) void this.swapLightmap(file)
    }
  }

  /** Loads the current tier's lightmap for one module, swaps it in everywhere, frees the old one. */
  private async swapLightmap(file: string): Promise<void> {
    const entry = this.prepared.get(file)
    if (!entry?.lm) return
    const { gltf, lm } = entry
    const old = gltf.userData.lightmapFile as string | undefined
    const want = lightmapFile(lm, this.tier)
    // No lightmap at load (failed): the module isn't baked; nothing to swap.
    if (!old || old === want) return
    const tier = this.tier
    let tex: THREE.Texture
    try {
      tex = await this.store.lightmap(lm, tier)
    } catch {
      return // keep the current tier
    }
    if (tier !== this.tier || gltf.userData.lightmapFile !== old) return
    let previous: THREE.Texture | null = null
    const swap = (o: THREE.Object3D) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      for (const m of matsOf(mesh))
        if (m.lightMap && m.lightMap.name === old) {
          previous = m.lightMap
          m.lightMap = tex
        }
    }
    gltf.scene.traverse(swap)
    this.group.traverse(swap)
    for (const inst of this.instances.values())
      if (inst.dimmed)
        for (const mats of inst.dimmed.values())
          for (const m of (Array.isArray(mats) ? mats : [mats]) as StdMat[])
            if (m.lightMap?.name === old) m.lightMap = tex
    gltf.userData.lightmapFile = want
    if (previous) this.store.dropLightmap(old)
  }

  /** Adds, updates and removes module instances to match the layout. Wings stream in as they load. */
  setLayout(layout: BuildingLayout): void {
    const seen = new Set<string>()
    const walls = wallBases(this.manifest, layout.placements)
    this.wallBase = walls.bases
    this.wallTotal = walls.total
    this.wallList = wallBoxes(this.manifest, layout.placements)
    for (const p of layout.placements) {
      seen.add(p.id)
      const files = this.filesFor(p)
      const file = files?.file ?? `placeholder:${p.kind}`
      let inst = this.instances.get(p.id)
      // A placement that moved (the cap when bays are added) is rebuilt in place: its culling box,
      // colliders and elevator banks are in world space.
      const moved =
        inst &&
        (inst.placement.position.x !== p.position.x ||
          inst.placement.position.z !== p.position.z ||
          inst.placement.yaw !== p.yaw)
      if (inst && (inst.file !== file || moved)) {
        this.removeInstance(inst)
        inst = undefined
      }
      if (!inst) {
        inst = this.createInstance(p, file)
        this.instances.set(p.id, inst)
        if (files) void this.populate(inst, files.file, files.lightmap)
        else this.setContent(inst, placeholder(p, this.boundsFor(p)))
      }
      inst.placement = p
      this.applyWallBase(inst)
      this.applyDim(inst)
      if (inst.label !== (p.label ?? '') || inst.signVariant !== (p.signVariant ?? 0)) {
        inst.label = p.label ?? ''
        inst.signVariant = p.signVariant ?? 0
        this.drawSigns(inst)
      }
    }
    for (const inst of [...this.instances.values()])
      if (!seen.has(inst.placement.id)) this.removeInstance(inst)
    this.stats.wings = layout.placements.filter((p) => p.kind === 'wing').length
    this.collidersCache = null
  }

  private boundsFor(p: ModulePlacement): AABB {
    return p.kind === 'wing'
      ? this.manifest.modules.wing.bounds
      : this.manifest.modules[p.kind].bounds
  }

  private createInstance(p: ModulePlacement, file: string): Instance {
    const group = new THREE.Group()
    group.name = p.id
    group.position.set(p.position.x, 0, p.position.z)
    group.rotation.y = p.yaw
    this.group.add(group)
    group.updateMatrixWorld(true)
    const b = this.boundsFor(p)
    const box = new THREE.Box3(
      new THREE.Vector3(b.minX, 0, b.minZ),
      new THREE.Vector3(b.maxX, MODULE_HEIGHT, b.maxZ),
    ).applyMatrix4(group.matrixWorld)
    return {
      placement: p,
      file,
      group,
      content: null,
      box,
      screens: new Map(),
      leds: new Map(),
      signs: [],
      ledwall: [],
      arcades: [],
      doors: [],
      banks: new Map(),
      ceilings: [],
      surfaces: new Map(),
      detail: [],
      detailShown: true,
      booksKey: '',
      bookAtlases: [],
      colliders: [],
      dimmed: null,
      label: p.label ?? '',
      signVariant: p.signVariant ?? 0,
      walls: [],
      wallBase: -1,
    }
  }

  /** Walls of the building (world boxes, global ids) and their count, for the cutaway. */
  wallLayout(): { boxes: WallBox[]; total: number } {
    return { boxes: this.wallList, total: this.wallTotal }
  }

  /**
   * Gives each wall-carrying mesh of an instance its own geometry with building-global wall ids
   * (shared buffers otherwise), so one table and the shared materials serve every instance.
   */
  private bindWalls(inst: Instance): void {
    for (const w of inst.walls) w.dispose()
    inst.walls = []
    inst.wallBase = -1
    if (!inst.content || this.wallBase.get(inst.placement.id) === undefined) return
    for (const mesh of meshesOf(inst.content)) {
      if (!mesh.geometry.getAttribute('_wallid')) continue
      const w = new InstanceWalls(mesh.geometry)
      mesh.geometry = w.geometry
      inst.walls.push(w)
    }
    this.applyWallBase(inst)
  }

  private applyWallBase(inst: Instance): void {
    const base = this.wallBase.get(inst.placement.id)
    if (base === undefined || base === inst.wallBase || !inst.walls.length) return
    inst.wallBase = base
    for (const w of inst.walls) w.setBase(base)
  }

  private async populate(inst: Instance, file: string, lm?: Lightmap): Promise<void> {
    try {
      const gltf = await this.loadPrepared(file, lm)
      if (this.instances.get(inst.placement.id) !== inst) return
      this.setContent(inst, gltf.scene.clone(true))
    } catch (err) {
      console.warn(
        `agent-office: ${file} failed to load (${(err as Error).message}); using a placeholder`,
      )
      if (this.instances.get(inst.placement.id) !== inst) return
      this.setContent(inst, placeholder(inst.placement, this.boundsFor(inst.placement)))
    }
  }

  private setContent(inst: Instance, content: THREE.Object3D): void {
    if (inst.content) inst.group.remove(inst.content)
    inst.content = content
    inst.group.add(content)
    inst.group.updateMatrixWorld(true)
    this.bindWalls(inst)
    this.indexRoles(inst)
    this.applyDim(inst, true)
    this.drawSigns(inst)
    for (const [key, s] of this.screens)
      if (key.startsWith(`${inst.placement.id}|`)) this.paintScreen(key, s)
    for (const [ref, mats] of inst.leds)
      paintLed(mats, this.leds.has(`${inst.placement.id}|${ref}`), this.emissiveMax)
    for (const c of inst.ceilings) c.visible = this.ceilingsVisible
    this.collidersCache = null
    this.pickList = null
    this.onChange()
  }

  /** Finds the runtime-driven nodes by `extras.role` (contract §5). */
  private indexRoles(inst: Instance): void {
    Object.assign(inst, {
      screens: new Map(),
      leds: new Map(),
      signs: [],
      ledwall: [],
      arcades: [],
      doors: [],
      banks: new Map(),
      ceilings: [],
      surfaces: new Map(),
      detail: [],
      detailShown: true,
      booksKey: '',
      bookAtlases: [],
      colliders: [],
    })
    const roleNodes: THREE.Object3D[] = []
    inst.content!.traverse((o) => o.userData.role && roleNodes.push(o))
    const box = new THREE.Box3()
    // Overhead pieces (light strips, skylight glass, ducts) belong with the ceiling: hidden from above.
    for (const mesh of meshesOf(inst.content!)) {
      const role = inherited(mesh, 'role')
      if (role && role !== 'glass') continue
      box.setFromObject(mesh)
      if (!box.isEmpty() && box.min.y > OVERHEAD_Y) inst.ceilings.push(mesh)
    }
    for (const o of roleNodes) {
      // Additive extras.ceiling (e.g. skylight glass): hidden with the ceilings in orbit view.
      if (o.userData.ceiling === true) inst.ceilings.push(o)
      const role = o.userData.role as string
      const ref = String(o.userData.ref ?? '')
      switch (role) {
        case 'screen': {
          const mats = ownMaterials(o)
          for (const m of mats) m.toneMapped = true
          if (ref === 'ledwall') {
            for (const m of mats) {
              m.map = this.wallTexture
              m.emissiveMap = this.wallTexture
              m.emissive.set(0xffffff)
              m.emissiveIntensity = this.em(1.6)
              m.color.set(0x000000)
              m.needsUpdate = true
            }
            inst.ledwall.push(...mats)
          } else if (ref.startsWith('arcade')) inst.arcades.push(...mats)
          else {
            inst.screens.set(ref, [...(inst.screens.get(ref) ?? []), ...mats])
            paintScreen(mats, SCREEN_OFF)
          }
          break
        }
        case 'led': {
          const mats = ownMaterials(o)
          inst.leds.set(ref, [...(inst.leds.get(ref) ?? []), ...mats])
          paintLed(mats, false)
          if (ref.startsWith('station:')) inst.detail.push(o)
          break
        }
        case 'station':
        case 'book':
        case 'board':
        case 'notebook': {
          const mats = ownMaterials(o)
          let byRef = inst.surfaces.get(role)
          if (!byRef) inst.surfaces.set(role, (byRef = new Map()))
          byRef.set(ref, { obj: o, mats, aspect: aspectOf(o, 1), key: '', glow: 0 })
          inst.detail.push(o)
          break
        }
        case 'sign':
          inst.signs.push({ ref, mats: ownMaterials(o), aspect: aspectOf(o, 4) })
          break
        case 'elevatorDoor': {
          const [bank = '0', side = 'L'] = ref.split(':')
          const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(o.quaternion)
          inst.doors.push({
            obj: o,
            base: o.position.clone(),
            axis,
            sign: side === 'R' ? 1 : -1,
            bank,
          })
          const wp = o.getWorldPosition(new THREE.Vector3())
          const b = inst.banks.get(bank)
          if (b) b.pos.lerp(wp, 0.5)
          else inst.banks.set(bank, { pos: wp, open: 0 })
          break
        }
        case 'ceiling':
          inst.ceilings.push(o)
          break
        case 'collider': {
          o.visible = false
          box.setFromObject(o)
          if (!box.isEmpty())
            inst.colliders.push({
              minX: box.min.x,
              maxX: box.max.x,
              minY: box.min.y,
              maxY: box.max.y,
              minZ: box.min.z,
              maxZ: box.max.z,
            })
          break
        }
      }
    }
  }

  private removeInstance(inst: Instance): void {
    this.group.remove(inst.group)
    this.pickList = null
    for (const t of inst.bookAtlases) t.dispose()
    for (const w of inst.walls) w.dispose()
    // Geometries and shared materials belong to the cached module; only per-instance copies go.
    inst.group.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      for (const m of matsOf(mesh)) if (m.userData.instanceOwned) m.dispose()
    })
    this.instances.delete(inst.placement.id)
    this.collidersCache = null
  }

  /** Dimmed wings (provider gone, grace period): darker lightmap, screens off. */
  private applyDim(inst: Instance, force = false): void {
    const want = !!inst.placement.dimmed
    if (!force && want === !!inst.dimmed) return
    if (inst.dimmed) {
      for (const [mesh, mat] of inst.dimmed) mesh.material = mat
      inst.dimmed = null
    }
    if (!want || !inst.content) return
    const copies = new Map<THREE.Material, THREE.Material>()
    inst.dimmed = new Map()
    for (const mesh of meshesOf(inst.content)) {
      inst.dimmed.set(mesh, mesh.material)
      const dim = matsOf(mesh).map((m) => {
        let c = copies.get(m) as StdMat | undefined
        if (!c) {
          c = cloneMat(m)
          c.userData.instanceOwned = true
          c.lightMapIntensity *= DIM_FACTOR
          if (c.color) c.color.multiplyScalar(0.8)
          if (c.emissive) c.emissiveIntensity *= 0.15
          copies.set(m, c)
        }
        return c
      })
      mesh.material = Array.isArray(mesh.material) ? dim : dim[0]!
    }
  }

  private drawSigns(inst: Instance): void {
    if (!inst.signs.length) return
    const theme = inst.placement.theme
      ? this.manifest.modules.wing.themes[inst.placement.theme]
      : undefined
    const accent = new THREE.Color(theme?.accent ?? '#4f8cff')
    if (inst.signVariant) accent.offsetHSL((inst.signVariant * 0.17) % 1, 0, 0)
    for (const sign of inst.signs) {
      // The wing sign shows the provider id; the room signs their room name (plain text, §10).
      const text =
        sign.ref === 'adapters' ? 'Adapters' : sign.ref === 'library' ? 'Library' : inst.label
      if (!text) continue
      const tex = signTexture(
        text,
        theme?.signColor ?? '#ffffff',
        `#${accent.getHexString()}`,
        sign.aspect,
      )
      for (const m of sign.mats) {
        // Dispose only a previous sign texture of ours; the original map is shared with other instances.
        if (m.userData.signTexture) (m.userData.signTexture as THREE.Texture).dispose()
        m.userData.signTexture = tex
        m.map = tex
        m.emissiveMap = tex
        m.emissive.set(0xffffff)
        m.emissiveIntensity = 0.55
        m.color.set(0xffffff)
        m.userData.instanceOwned = true
        m.needsUpdate = true
      }
    }
  }

  /** Screen states keyed `<placementId>|<ref>`; unknown keys turn off. */
  setScreens(next: Map<string, ScreenState>): void {
    for (const key of this.screens.keys()) if (!next.has(key)) this.paintScreen(key, SCREEN_OFF)
    for (const [key, s] of next) {
      const prev = this.screens.get(key)
      if (!prev || prev.color !== s.color || prev.intensity !== s.intensity)
        this.paintScreen(key, s)
    }
    this.screens = next
  }

  private paintScreen(key: string, s: ScreenState): void {
    const [placement, ref] = splitKey(key)
    const mats = this.instances.get(placement)?.screens.get(ref)
    if (mats) paintScreen(mats, s, this.emissiveMax)
  }

  /** Booth LED rings that should glow (`<placementId>|<ref>`). */
  setLeds(on: Set<string>): void {
    for (const key of new Set([...this.leds, ...on])) {
      if (this.leds.has(key) === on.has(key)) continue
      const [placement, ref] = splitKey(key)
      const mats = this.instances.get(placement)?.leds.get(ref)
      if (mats) paintLed(mats, on.has(key), this.emissiveMax)
    }
    this.leds = on
  }

  /** What each provider's capability surfaces show (all its wings alike). Drawn lazily in update(). */
  setSurfaces(byProvider: Map<string, ProviderSurfaces>): void {
    this.surfaces = byProvider
  }

  /** World positions of a capability's surfaces (one per wing of its provider). */
  surfacesOf(ref: { provider: string; id: string }): THREE.Vector3[] {
    return this.surfaceSpots(ref).map((s) => s.pos)
  }

  /** A capability's surfaces with their wing and role (camera close-ups). */
  surfaceSpots(ref: { provider: string; id: string }): SurfaceSpot[] {
    const out: SurfaceSpot[] = []
    for (const inst of this.instances.values()) {
      if (inst.placement.provider !== ref.provider) continue
      for (const [role, byRef] of inst.surfaces)
        for (const [slot, sf] of byRef)
          if ((sf.obj.userData.capability as { id?: string } | undefined)?.id === ref.id)
            out.push({
              pos: sf.obj.getWorldPosition(new THREE.Vector3()),
              placement: inst.placement.id,
              role,
              slot,
              width: Number(sf.obj.userData.width) || 0.5,
              height: Number(sf.obj.userData.height) || 0.5,
            })
    }
    return out
  }

  /**
   * Module-local positions of the wing's capability surfaces by role and slot (every wing theme
   * shares the layout), from the first wing that has loaded; null until one has.
   */
  wingSurfaces(): Map<SurfaceRole, Map<string, Vec3>> | null {
    for (const inst of this.instances.values()) {
      if (inst.placement.kind !== 'wing' || !inst.surfaces.size) continue
      const out = new Map<SurfaceRole, Map<string, Vec3>>()
      const p = new THREE.Vector3()
      for (const [role, byRef] of inst.surfaces) {
        const m = new Map<string, Vec3>()
        for (const [slot, sf] of byRef) {
          inst.group.worldToLocal(sf.obj.getWorldPosition(p))
          m.set(slot, { x: p.x, y: p.y, z: p.z })
        }
        out.set(role, m)
      }
      return out
    }
    return null
  }

  /** The surface object a capability ref resolves to in one wing (hover/debug projection). */
  surfaceObject(ref: { provider: string; id: string }): THREE.Object3D | null {
    for (const inst of this.instances.values()) {
      if (inst.placement.provider !== ref.provider) continue
      for (const byRef of inst.surfaces.values())
        for (const sf of byRef.values())
          if ((sf.obj.userData.capability as { id?: string } | undefined)?.id === ref.id)
            return sf.obj
    }
    return null
  }

  /** Canvas textures of the runtime surfaces, signs and the LED wall (GPU memory accounting). */
  canvasTextures(): THREE.Texture[] {
    const out = new Set<THREE.Texture>([this.wallTexture])
    for (const inst of this.instances.values()) {
      for (const t of inst.bookAtlases) out.add(t)
      for (const byRef of inst.surfaces.values())
        for (const sf of byRef.values()) {
          const t = sf.mats[0]?.userData.canvasTexture as THREE.Texture | undefined
          if (t) out.add(t)
        }
      for (const sign of inst.signs) {
        const t = sign.mats[0]?.userData.signTexture as THREE.Texture | undefined
        if (t) out.add(t)
      }
    }
    return [...out]
  }

  /** Station screens, spines, boards and notebooks that are filled (for picking). */
  pickables(): THREE.Object3D[] {
    if (!this.pickList) {
      this.pickList = []
      for (const inst of this.instances.values())
        for (const byRef of inst.surfaces.values())
          for (const sf of byRef.values())
            if (sf.obj.userData.capability) this.pickList.push(sf.obj)
    }
    return this.pickList
  }

  /**
   * The atrium's Context Hub (core `context-core`, consoles `context:0..5`): a steady glow, brighter
   * in a pulse while the project MCP station is in use (a real retrieval), on the Adapters rooms' signal.
   */
  private pulseContextHub(dt: number): void {
    this.contextT += dt
    const target = contextPulse(this.contextT, contextHubActive(this.surfaces.values()))
    this.contextLevel += (target - this.contextLevel) * Math.min(1, dt / 0.12)
    for (const inst of this.instances.values()) {
      const core = inst.screens.get('context-core')
      if (!core || !inst.group.visible) continue
      for (const m of core) {
        m.emissive.set(CONTEXT_COLOR)
        m.emissiveIntensity = this.em(0.5 + this.contextLevel * 2.2)
      }
      for (let i = 0; i < 6; i++)
        for (const m of inst.screens.get(`context:${i}`) ?? []) {
          m.emissive.set(CONTEXT_COLOR)
          m.emissiveIntensity = this.em(0.35 + this.contextLevel * 1.4)
        }
    }
  }

  /** Redraws changed surfaces (≤ 4 Hz) and eases glows every frame. */
  private updateSurfaces(dt: number): void {
    this.surfaceTime += dt
    const redraw = this.surfaceTime >= 0.25
    if (redraw) this.surfaceTime = 0
    for (const inst of this.instances.values()) {
      if (!inst.group.visible || !inst.placement.provider || !inst.surfaces.size) continue
      const s = this.surfaces.get(inst.placement.provider)
      const accent = this.accentOf(inst)
      if (redraw) this.drawSurfaces(inst, s, accent)
      this.glowSurfaces(inst, s, dt)
    }
  }

  private accentOf(inst: Instance): string {
    const t = inst.placement.theme
      ? this.manifest.modules.wing.themes[inst.placement.theme]
      : undefined
    return t?.accent ?? '#4f8cff'
  }

  private drawSurfaces(inst: Instance, s: ProviderSurfaces | undefined, accent: string): void {
    const provider = inst.placement.provider!
    const k = this.canvasScale
    // An empty Library says so on board 0 instead of six blank boards (low-spec plan §B4).
    const emptyLibrary = !s || (!s.books.some(Boolean) && !s.boards.some(Boolean))
    let picksChanged = false
    // Overflow ("+N more") surfaces pick as '+more:<tab>' so the Library drawer opens on that tab;
    // `label` carries their title for the hover tooltip.
    const mark = (sf: Surface, slot: SurfaceSlot<unknown> | undefined, role: SurfaceRole) => {
      const more = slot?.id === '+more'
      const title = (slot?.vm as { title?: string } | undefined)?.title
      const ref = !slot
        ? undefined
        : more
          ? { provider, id: `+more:${MORE_TAB[role]}`, ...(title ? { label: title } : {}) }
          : { provider, id: slot.id }
      if ((sf.obj.userData.capability as { id?: string } | undefined)?.id !== ref?.id)
        picksChanged = true
      sf.obj.userData.capability = ref
    }
    for (const [ref, sf] of inst.surfaces.get('station') ?? []) {
      const slot = s?.stations[Number(ref)]
      mark(sf, slot, 'station')
      const key = JSON.stringify(slot?.vm ?? null) + accent
      if (key === sf.key) continue
      sf.key = key
      const tex = canvasFor(
        sf,
        Math.round(768 * k),
        Math.round((768 * k) / Math.max(1, sf.aspect || 16 / 9)),
        true,
      )
      drawStation(tex.image as HTMLCanvasElement, slot?.vm, accent)
      tex.needsUpdate = true
    }
    const books = inst.surfaces.get('book')
    if (books) {
      const key = JSON.stringify(s?.books.map((b) => b && [b.id, b.vm]) ?? null)
      if (key !== inst.booksKey) {
        inst.booksKey = key
        for (const [ref, sf] of books) mark(sf, s?.books[Number(ref)], 'book')
        drawBooks(inst.bookAtlases, books, s?.books ?? [], accent, k)
      }
    }
    for (const [ref, sf] of inst.surfaces.get('board') ?? []) {
      const slot = s?.boards[Number(ref)]
      mark(sf, slot, 'board')
      const placard = emptyLibrary && ref === '0' ? LIB_COPY.emptyBoard : undefined
      const key = JSON.stringify(slot?.vm ?? null) + (placard ?? '')
      if (key === sf.key) continue
      sf.key = key
      const tex = canvasFor(
        sf,
        Math.round(384 * k),
        Math.round((384 * k) / Math.max(0.2, sf.aspect || 0.75)),
      )
      drawBoard(tex.image as HTMLCanvasElement, slot?.vm, accent, placard)
      tex.needsUpdate = true
    }
    for (const [ref, sf] of inst.surfaces.get('notebook') ?? []) {
      const slot = s?.notebooks[Number(ref)]
      mark(sf, slot, 'notebook')
      const key = JSON.stringify(slot?.vm ?? null)
      if (key === sf.key) continue
      sf.key = key
      // 2× the old 128 px cover: the label is drawn twice as large (low-spec plan §B4).
      const tex = canvasFor(
        sf,
        Math.round(256 * k),
        Math.round((256 * k) / Math.max(0.2, sf.aspect || 0.8)),
      )
      drawNotebook(tex.image as HTMLCanvasElement, slot?.vm.title, accent)
      tex.needsUpdate = true
    }
    if (picksChanged) this.pickList = null
  }

  /** Emissive glow eased toward 1 while in use / recently used (0.3 s ramp); station rings and core. */
  private glowSurfaces(inst: Instance, s: ProviderSurfaces | undefined, dt: number): void {
    const ease = Math.min(1, dt / 0.3)
    const apply = (
      role: SurfaceRole,
      slots: (SurfaceSlot<unknown> | undefined)[] | undefined,
      base: number,
      boost: number,
      empty = 0.35,
    ) => {
      for (const [ref, sf] of inst.surfaces.get(role) ?? []) {
        const slot = slots?.[Number(ref)]
        const want = slot?.glow ?? 0
        sf.glow += (want - sf.glow) * ease
        const filled = slot ? 1 : empty
        for (const m of sf.mats) m.emissiveIntensity = this.em((base + sf.glow * boost) * filled)
      }
    }
    apply('station', s?.stations, 0.85, 0.45)
    // Empty spines stay dark: no glow at all (low-spec plan §B4).
    apply('book', s?.books, 0.3, 1.4, 0)
    // Boards are near-white paper: low emissive so they don't bloom into a haze up close.
    apply('board', s?.boards, 0.12, 0.35)
    apply('notebook', s?.notebooks, 0.3, 1.4)
    for (const [ref, mats] of inst.leds) {
      if (!ref.startsWith('station:')) continue
      const slot = s?.stations[Number(ref.slice('station:'.length))]
      const pulse = slot?.glow ? 0.75 + 0.25 * Math.sin(this.arcadeT * 6) : 0
      for (const m of mats) {
        m.emissive.set(slot ? slot.color : '#1a1f26')
        m.emissiveIntensity = this.em(slot ? 0.5 + 2.6 * pulse : 0.3)
      }
    }
    const core = inst.screens.get('adapters-core')
    if (core) {
      const n = s?.activeAdapters ?? 0
      for (const m of core) {
        m.emissive.set(accentOrBlue(n))
        m.emissiveIntensity = this.em(
          0.4 + Math.min(n, 4) * 0.35 * (0.8 + 0.2 * Math.sin(this.arcadeT * 4)),
        )
      }
    }
  }

  setStats(s: Omit<WallStats, 'wings'>): void {
    Object.assign(this.stats, s)
  }

  /** Ceilings are hidden from above (orbit) and shown at eye level (walk). */
  setCeilingsVisible(v: boolean): void {
    this.ceilingsVisible = v
    ORBIT_VIEW.value = v ? 0 : 1
    for (const inst of this.instances.values()) for (const c of inst.ceilings) c.visible = v
  }

  /** Debug: which modules are drawn this frame. */
  moduleVisibility(): Record<string, boolean> {
    return Object.fromEntries(
      [...this.instances.values()].map((i) => [i.placement.id, i.group.visible]),
    )
  }

  /** Debug: each module instance's actual world bounds (to spot geometry outside its footprint). */
  contentBounds(): Record<string, [number, number, number, number]> {
    const out: Record<string, [number, number, number, number]> = {}
    const box = new THREE.Box3()
    for (const inst of this.instances.values()) {
      if (!inst.content) continue
      box.setFromObject(inst.content)
      out[inst.placement.id] = [box.min.x, box.max.x, box.min.z, box.max.z].map(
        (v) => Math.round(v * 10) / 10,
      ) as [number, number, number, number]
    }
    return out
  }

  colliders(): WorldBox[] {
    if (!this.collidersCache)
      this.collidersCache = [...this.instances.values()].flatMap((i) => i.colliders)
    return this.collidersCache
  }

  /** World positions of elevator banks (for "doors open when someone is near"). */
  elevatorBanks(): { pos: THREE.Vector3; key: string }[] {
    const out: { pos: THREE.Vector3; key: string }[] = []
    for (const inst of this.instances.values())
      for (const [bank, b] of inst.banks)
        out.push({ pos: b.pos, key: `${inst.placement.id}|${bank}` })
    return out
  }

  /** Per frame: culling, doors, arcade screens, LED wall. `openBanks` = banks someone is near. */
  update(dt: number, camera: THREE.Camera, openBanks: Set<string>): void {
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.projScreen)
    camera.getWorldPosition(this.tmp)
    for (const inst of this.instances.values()) {
      const dist = inst.box.distanceToPoint(this.tmp)
      const cull = moduleCulling(this.frustum.intersectsBox(inst.box), dist, this.detailCullM)
      inst.group.visible = cull.visible
      const detail = cull.detail
      if (inst.group.visible && detail !== inst.detailShown) {
        inst.detailShown = detail
        for (const o of inst.detail) o.visible = detail
      }
      for (const [bank, b] of inst.banks) {
        const want = openBanks.has(`${inst.placement.id}|${bank}`) ? 1 : 0
        if (b.open === want) continue
        b.open =
          want > b.open
            ? Math.min(1, b.open + dt * DOOR_SPEED)
            : Math.max(0, b.open - dt * DOOR_SPEED)
        const k = easeInOut(b.open)
        for (const d of inst.doors)
          if (d.bank === bank)
            d.obj.position.copy(d.base).addScaledVector(d.axis, d.sign * DOOR_TRAVEL * k)
        for (const d of inst.doors) if (d.bank === bank) d.obj.updateMatrixWorld(true)
      }
    }
    this.arcadeT += dt
    for (const inst of this.instances.values())
      for (const m of inst.arcades) {
        m.emissive.setHSL((this.arcadeT * 0.05 + inst.arcades.indexOf(m) * 0.31) % 1, 0.8, 0.5)
        m.emissiveIntensity = 1.4
      }
    this.drawWall()
    this.updateSurfaces(dt)
    this.pulseContextHub(dt)
  }

  private drawWall(): void {
    const s = this.stats
    const minute = new Date().toTimeString().slice(0, 5)
    // Low and Minimal: at most once a minute (the clock tick), not on every count change.
    if (this.wallThrottle && this.wallDrawn.endsWith(`|${minute}`)) return
    const key = `${s.agents}|${s.working}|${s.waiting}|${s.meetings}|${s.wings}|${minute}`
    if (key === this.wallDrawn) return
    this.wallDrawn = key
    const c = this.wallCanvas.getContext('2d')
    if (!c) return
    const { width: w, height: h } = this.wallCanvas
    const g = c.createLinearGradient(0, 0, w, h)
    g.addColorStop(0, '#0b1020')
    g.addColorStop(1, '#141a33')
    c.fillStyle = g
    c.fillRect(0, 0, w, h)
    c.fillStyle = 'rgba(255,255,255,0.55)'
    c.font = '600 40px system-ui, sans-serif'
    c.textBaseline = 'top'
    c.fillText('OFFICE NOW', 60, 46)
    c.textAlign = 'right'
    c.fillText(minute, w - 60, 46)
    c.textAlign = 'left'
    const tiles: [string, number, string][] = [
      ['agents', s.agents, '#ffffff'],
      ['working', s.working, STATUS_COLORS.tool],
      ['waiting on you', s.waiting, STATUS_COLORS.waiting],
      ['in meetings', s.meetings, STATUS_COLORS.thinking],
      ['wings', s.wings, '#c9b8ff'],
    ]
    const tw = (w - 120) / tiles.length
    tiles.forEach(([label, n, color], i) => {
      const x = 60 + i * tw
      c.fillStyle = color
      c.font = '700 168px system-ui, sans-serif'
      c.fillText(String(n), x, 150)
      c.fillStyle = 'rgba(255,255,255,0.7)'
      // Shrink the caption until it fits its tile.
      let size = 34
      do c.font = `600 ${size--}px system-ui, sans-serif`
      while (c.measureText(label.toUpperCase()).width > tw - 48 && size > 16)
      c.fillText(label.toUpperCase(), x, 352)
      c.fillStyle = color
      c.fillRect(x, 410, tw - 48, 6)
    })
    this.wallTexture.needsUpdate = true
  }

  dispose(): void {
    for (const inst of [...this.instances.values()]) this.removeInstance(inst)
    this.wallTexture.dispose()
  }
}

/** Width/height of a runtime surface from its glTF extras (contract §5), else `fallback`. */
function aspectOf(o: THREE.Object3D, fallback: number): number {
  const w = Number(o.userData.width)
  const h = Number(o.userData.height)
  return w > 0 && h > 0 ? w / h : fallback
}

const splitKey = (key: string): [string, string] => {
  const i = key.indexOf('|')
  return [key.slice(0, i), key.slice(i + 1)]
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

function paintScreen(mats: StdMat[], s: ScreenState, max = Infinity): void {
  for (const m of mats) {
    m.color.set(0x05070a)
    m.emissive.set(s.color)
    m.emissiveIntensity = Math.min(s.intensity, max)
    m.userData.instanceOwned = true
  }
}

function paintLed(mats: StdMat[], on: boolean, max = Infinity): void {
  for (const m of mats) {
    m.emissive.set(on ? STATUS_COLORS.waiting : '#1a1f26')
    m.emissiveIntensity = Math.min(on ? 3 : 0.4, max)
    m.userData.instanceOwned = true
  }
}

/** Provider label on the wing sign, drawn as plain text (no logos, contract §10). */
function signTexture(text: string, fg: string, bg: string, aspect = 4): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = Math.round(1024 / Math.min(8, Math.max(1, aspect)))
  const c = canvas.getContext('2d')!
  c.fillStyle = bg
  c.fillRect(0, 0, canvas.width, canvas.height)
  c.fillStyle = 'rgba(0,0,0,0.18)'
  c.fillRect(0, canvas.height - 18, canvas.width, 18)
  c.fillStyle = fg
  c.textAlign = 'center'
  c.textBaseline = 'middle'
  let size = Math.round(canvas.height * 0.52)
  do {
    c.font = `700 ${size}px system-ui, -apple-system, sans-serif`
    size -= 6
  } while (c.measureText(text).width > canvas.width - 120 && size > 40)
  c.fillText(text, canvas.width / 2, canvas.height / 2 - 6)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.flipY = false
  tex.anisotropy = 8
  return tex
}

const placeholderMats = new Map<string, THREE.MeshStandardMaterial>()
const placeholderGeo = new THREE.BoxGeometry(1, 1, 1)

/** Stand-in when a module file is missing: its floor slab, so the layout still reads. */
function placeholder(p: ModulePlacement, b: AABB): THREE.Object3D {
  const color = p.kind === 'wing' ? '#cfc6bb' : p.kind === 'street' ? '#b9bec6' : '#d9dce2'
  let mat = placeholderMats.get(color)
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9 })
    placeholderMats.set(color, mat)
  }
  const g = new THREE.Group()
  const floor = new THREE.Mesh(placeholderGeo, mat)
  floor.scale.set(b.maxX - b.minX, 0.1, b.maxZ - b.minZ)
  floor.position.set((b.minX + b.maxX) / 2, -0.05, (b.minZ + b.maxZ) / 2)
  floor.receiveShadow = true
  g.add(floor)
  return g
}
