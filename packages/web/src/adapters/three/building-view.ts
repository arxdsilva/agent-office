// The building (contract §2, §5, §6): module instances from `BuildingLayout`, lightmaps, runtime-driven
// surfaces (screens, booth LEDs, signs, the LED wall, elevator doors), ceilings, colliders, culling.
import { STATUS_COLORS } from '@agent-office/shared'
import * as THREE from 'three'
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'
import type { Lightmap, Manifest } from '../../app/manifest.ts'
import type { AABB, BuildingLayout, ModulePlacement } from '../../app/office-types.ts'
import type { AssetStore } from './assets.ts'

/** World-space box from a `collider` mesh (walk-mode collision, label occlusion). */
export interface WorldBox {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
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

/** Baked meshes get their light from the lightmap: no direct/hemisphere lights, no IBL diffuse (§6). */
const BAKED_DEFS = [
  'NUM_DIR_LIGHTS',
  'NUM_DIR_LIGHT_SHADOWS',
  'NUM_HEMI_LIGHTS',
  'NUM_POINT_LIGHTS',
  'NUM_POINT_LIGHT_SHADOWS',
  'NUM_SPOT_LIGHTS',
  'NUM_SPOT_LIGHT_SHADOWS',
  'NUM_SPOT_LIGHT_COORDS',
  'NUM_SPOT_LIGHT_MAPS',
  'NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS',
  'NUM_RECT_AREA_LIGHTS',
]
  .map((d) => `#undef ${d}\n#define ${d} 0`)
  .join('\n')
const BAKED_MAPS = THREE.ShaderChunk.lights_fragment_maps.replace(
  'iblIrradiance += getIBLIrradiance( geometryNormal );',
  '',
)
/** Environment reflections on baked surfaces (specular only). */
export const BAKED_SPECULAR = 0.55
const DIM_FACTOR = 0.35
const CULL_DISTANCE = 140
const DOOR_TRAVEL = 0.55
const DOOR_SPEED = 1 / 0.9
const MODULE_HEIGHT = 7.5

type StdMat = THREE.MeshStandardMaterial

function patchBaked(m: StdMat): void {
  m.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <lights_fragment_begin>',
        `${BAKED_DEFS}\n#include <lights_fragment_begin>`,
      )
      .replace('#include <lights_fragment_maps>', BAKED_MAPS)
  }
  m.customProgramCacheKey = () => 'ao-baked'
  m.userData.baked = true
}

/** Material clone that keeps the baked shader patch (three's clone() drops onBeforeCompile). */
function cloneMat<T extends THREE.Material>(m: T): T {
  const c = m.clone()
  if (m.userData.baked) patchBaked(c as unknown as StdMat)
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
function prepareModule(gltf: GLTF, lightmap: THREE.Texture | null, lm: Lightmap | undefined): void {
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
      const baked =
        lightmap && isLightmapped(mesh) && mesh.geometry.getAttribute('uv1')
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
  for (const m of new Set(swap.values())) {
    m.lightMap = lightmap
    m.lightMapIntensity = lm?.intensity ?? 1
    m.envMapIntensity = BAKED_SPECULAR
    patchBaked(m)
    m.needsUpdate = true
  }
}

/** `baked` meshes, and ceilings flagged `extras.lightmap`, sample the module atlas through UV1. */
const isLightmapped = (mesh: THREE.Mesh) =>
  (inherited(mesh, 'role') === 'baked' || inherited(mesh, 'lightmap') === true) &&
  !!mesh.geometry.getAttribute('uv1')

/** The role of the nearest ancestor node that has one (extras land on the node's Object3D). */
function inherited(o: THREE.Object3D, key: string): unknown {
  for (let p: THREE.Object3D | null = o; p; p = p.parent)
    if (p.userData[key] !== undefined) return p.userData[key]
  return undefined
}

/** Screen-space transmission is an extra full scene render per frame; plain transparency reads as glass. */
function toCheapGlass(m: StdMat): StdMat {
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
  signs: StdMat[]
  ledwall: StdMat[]
  arcades: StdMat[]
  doors: Door[]
  /** Elevator bank id → world position (door centers) and open amount 0..1. */
  banks: Map<string, { pos: THREE.Vector3; open: number }>
  ceilings: THREE.Object3D[]
  colliders: WorldBox[]
  /** Dimmed material copies (source → copy) and what each mesh had before. */
  dimmed: Map<THREE.Mesh, THREE.Material | THREE.Material[]> | null
  label: string
  signVariant: number
}

const SCREEN_OFF: ScreenState = { color: '#0b0d12', intensity: 0 }

/** Renders the building and its live surfaces. Placement decisions come from `BuildingLayout`. */
export class BuildingView {
  readonly group = new THREE.Group()
  private instances = new Map<string, Instance>()
  private screens = new Map<string, ScreenState>()
  private leds = new Set<string>()
  private stats: WallStats = { agents: 0, working: 0, waiting: 0, meetings: 0, wings: 0 }
  private wallCanvas = document.createElement('canvas')
  private wallTexture = new THREE.CanvasTexture(this.wallCanvas)
  private wallDrawn = ''
  private ceilingsVisible = false
  private frustum = new THREE.Frustum()
  private projScreen = new THREE.Matrix4()
  private tmp = new THREE.Vector3()
  private arcadeT = 0
  private collidersCache: WorldBox[] | null = null
  /** Fires when a module finished loading (colliders and surfaces changed). */
  onChange: () => void = () => {}

  constructor(
    private store: AssetStore,
    private manifest: Manifest,
  ) {
    this.wallCanvas.width = 1536
    this.wallCanvas.height = 512
    this.wallTexture.colorSpace = THREE.SRGBColorSpace
    this.wallTexture.flipY = false
    this.wallTexture.anisotropy = 4
    this.group.name = 'building'
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
    const [gltf, tex] = await Promise.all([
      this.store.module(file),
      lm ? this.store.lightmap(lm.file).catch(() => null) : Promise.resolve(null),
    ])
    prepareModule(gltf, tex, lm)
    return gltf
  }

  /** Adds, updates and removes module instances to match the layout. Wings stream in as they load. */
  setLayout(layout: BuildingLayout): void {
    const seen = new Set<string>()
    for (const p of layout.placements) {
      seen.add(p.id)
      const files = this.filesFor(p)
      const file = files?.file ?? `placeholder:${p.kind}`
      let inst = this.instances.get(p.id)
      if (inst && inst.file !== file) {
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
    group.updateMatrixWorld(true)
    this.group.add(group)
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
      colliders: [],
      dimmed: null,
      label: p.label ?? '',
      signVariant: p.signVariant ?? 0,
    }
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
    this.indexRoles(inst)
    this.applyDim(inst, true)
    this.drawSigns(inst)
    for (const [key, s] of this.screens)
      if (key.startsWith(`${inst.placement.id}|`)) this.paintScreen(key, s)
    for (const [ref, mats] of inst.leds)
      paintLed(mats, this.leds.has(`${inst.placement.id}|${ref}`))
    for (const c of inst.ceilings) c.visible = this.ceilingsVisible
    this.collidersCache = null
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
      colliders: [],
    })
    const roleNodes: THREE.Object3D[] = []
    inst.content!.traverse((o) => o.userData.role && roleNodes.push(o))
    const box = new THREE.Box3()
    for (const o of roleNodes) {
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
              m.emissiveIntensity = 1.6
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
          break
        }
        case 'sign':
          inst.signs.push(...ownMaterials(o))
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
    if (!inst.signs.length || !inst.label) return
    const theme = inst.placement.theme
      ? this.manifest.modules.wing.themes[inst.placement.theme]
      : undefined
    const accent = new THREE.Color(theme?.accent ?? '#4f8cff')
    if (inst.signVariant) accent.offsetHSL((inst.signVariant * 0.17) % 1, 0, 0)
    const tex = signTexture(inst.label, theme?.signColor ?? '#ffffff', `#${accent.getHexString()}`)
    for (const m of inst.signs) {
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
    if (mats) paintScreen(mats, s)
  }

  /** Booth LED rings that should glow (`<placementId>|<ref>`). */
  setLeds(on: Set<string>): void {
    for (const key of new Set([...this.leds, ...on])) {
      if (this.leds.has(key) === on.has(key)) continue
      const [placement, ref] = splitKey(key)
      const mats = this.instances.get(placement)?.leds.get(ref)
      if (mats) paintLed(mats, on.has(key))
    }
    this.leds = on
  }

  setStats(s: Omit<WallStats, 'wings'>): void {
    Object.assign(this.stats, s)
  }

  /** Ceilings are hidden from above (orbit) and shown at eye level (walk). */
  setCeilingsVisible(v: boolean): void {
    this.ceilingsVisible = v
    for (const inst of this.instances.values()) for (const c of inst.ceilings) c.visible = v
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
      inst.group.visible =
        this.frustum.intersectsBox(inst.box) && inst.box.distanceToPoint(this.tmp) < CULL_DISTANCE
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
      }
    }
    this.arcadeT += dt
    for (const inst of this.instances.values())
      for (const m of inst.arcades) {
        m.emissive.setHSL((this.arcadeT * 0.05 + inst.arcades.indexOf(m) * 0.31) % 1, 0.8, 0.5)
        m.emissiveIntensity = 1.4
      }
    this.drawWall()
  }

  private drawWall(): void {
    const s = this.stats
    const minute = new Date().toTimeString().slice(0, 5)
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
      ['waiting for you', s.waiting, STATUS_COLORS.waiting],
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
      c.font = '500 34px system-ui, sans-serif'
      c.fillText(label.toUpperCase(), x, 352)
      c.fillStyle = color
      c.fillRect(x, 410, tw - 40, 6)
    })
    this.wallTexture.needsUpdate = true
  }

  dispose(): void {
    for (const inst of [...this.instances.values()]) this.removeInstance(inst)
    this.wallTexture.dispose()
  }
}

const splitKey = (key: string): [string, string] => {
  const i = key.indexOf('|')
  return [key.slice(0, i), key.slice(i + 1)]
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

function paintScreen(mats: StdMat[], s: ScreenState): void {
  for (const m of mats) {
    m.color.set(0x05070a)
    m.emissive.set(s.color)
    m.emissiveIntensity = s.intensity
    m.userData.instanceOwned = true
  }
}

function paintLed(mats: StdMat[], on: boolean): void {
  for (const m of mats) {
    m.emissive.set(on ? STATUS_COLORS.waiting : '#1a1f26')
    m.emissiveIntensity = on ? 3 : 0.4
    m.userData.instanceOwned = true
  }
}

/** Provider label on the wing sign, drawn as plain text (no logos, contract §10). */
function signTexture(text: string, fg: string, bg: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 256
  const c = canvas.getContext('2d')!
  c.fillStyle = bg
  c.fillRect(0, 0, canvas.width, canvas.height)
  c.fillStyle = 'rgba(0,0,0,0.18)'
  c.fillRect(0, canvas.height - 18, canvas.width, 18)
  c.fillStyle = fg
  c.textAlign = 'center'
  c.textBaseline = 'middle'
  let size = 132
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
