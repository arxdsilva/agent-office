// The Night City world view (docs/special-3d/world-layout.md): loads `special3d/manifest.json`
// (graphics contract §14) or, until the Blender set is published, the in-code fixture; places each
// module (its .glb, or placeholder geometry from its plan) and collects the role meshes the scene
// drives: holo displays, ad screens, neon, rain glass, traffic splines, monitors and booth LEDs.
import * as THREE from 'three'
import type { AssetStore } from '../../../adapters/three/assets.ts'
import { bakeMaterial, inherited, toCheapGlass } from '../../../adapters/three/building-view.ts'
import type { LightmapTier } from '../../../app/graphics-types.ts'
import {
  buildSpecialWorld,
  parseSpecialManifest,
  type SpecialKind,
  type SpecialManifest,
  type SpecialModuleDef,
  type SpecialWorld,
} from '../../../app/special/world.ts'
import { FIXTURE_DECOR, fixtureManifest } from '../../fixtures/manifest.ts'
import { markBloom } from '../rendering/bloom-selective.ts'
import type { ShaftSpec } from '../rendering/atmosphere.ts'
import type { MaterialLibrary } from '../rendering/material-library.ts'
import { buildPlaceholder, type PlaceholderModule } from './placeholder.ts'

export const SPECIAL_BASE = 'special3d/'
const SCREEN_OFF = new THREE.Color(0.06, 0.08, 0.1)

export interface ScreenState {
  color: string
  intensity: number
}

interface MeshScreen {
  mesh: THREE.Mesh
  mat: THREE.MeshBasicMaterial
}

export interface ModuleView {
  kind: SpecialKind
  group: THREE.Group
  floors: THREE.MeshStandardMaterial[]
  probe: THREE.Vector3
  lights: { light: THREE.PointLight | THREE.SpotLight; priority: number }[]
}

/** Loads the published manifest; null when it is missing (the fixture is used). Throws if invalid. */
async function fetchManifest(): Promise<SpecialManifest | null> {
  let res: Response
  try {
    res = await fetch(`${SPECIAL_BASE}manifest.json`)
  } catch {
    return null
  }
  if (!res.ok) return null
  return parseSpecialManifest(await res.json())
}

export class SpecialWorldView {
  readonly group = new THREE.Group()
  readonly modules: ModuleView[] = []
  readonly holo: THREE.Mesh[] = []
  readonly ads: THREE.Mesh[] = []
  readonly neonMeshes: THREE.Mesh[] = []
  readonly rainGlass: THREE.Mesh[] = []
  readonly traffic: THREE.Vector3[][] = []
  readonly shafts: ShaftSpec[] = []
  readonly neon: { text: string; color: string; pos: THREE.Vector3; yaw: number }[] = []
  /** Exported neon (`nc-neon-*`, 6× white) and glow strips (`nc-glow-*`, 2×) with their base intensity. */
  private emissives: { mat: THREE.MeshStandardMaterial; base: number; kind: 'neon' | 'glow' }[] = []
  private instScreens: {
    mesh: THREE.InstancedMesh
    index: Map<string, number>
    placement: string
  }[] = []
  private instLeds: { mesh: THREE.InstancedMesh; index: Map<string, number>; placement: string }[] =
    []
  private meshScreens = new Map<string, MeshScreen>()
  private meshLeds = new Map<string, MeshScreen>()
  private geometries: THREE.BufferGeometry[] = []
  private color = new THREE.Color()
  private lastScreens = ''

  private constructor(
    readonly world: SpecialWorld,
    /** True while the Blender set isn't published (placeholder geometry). */
    readonly fixture: boolean,
  ) {
    this.group.name = 'special-world'
  }

  static async load(
    store: AssetStore,
    mats: MaterialLibrary,
    rainGlass: THREE.ShaderMaterial,
    progress: (f: number) => void,
    tier: LightmapTier = 'full',
  ): Promise<SpecialWorldView> {
    let manifest: SpecialManifest | null = null
    try {
      manifest = await fetchManifest()
    } catch (err) {
      console.warn(
        `agent-office: special3d/manifest.json is invalid (${(err as Error).message}); using the fixture`,
      )
    }
    const fixture = manifest === null
    const m = manifest ?? parseSpecialManifest(fixtureManifest())
    const view = new SpecialWorldView(buildSpecialWorld(m), fixture)
    const placements = view.world.layout.placements
    let done = 0
    await Promise.all(
      placements.map(async (pl) => {
        const kind = pl.id as SpecialKind
        const def = m.modules[kind]!
        const group = new THREE.Group()
        group.name = `module:${kind}`
        group.position.set(pl.position.x, 0, pl.position.z)
        group.rotation.y = pl.yaw
        const mv: ModuleView = { kind, group, floors: [], probe: new THREE.Vector3(), lights: [] }
        if (def.file) {
          try {
            await view.adoptGlb(store, def, group, mv, pl.id, tier)
          } catch (err) {
            console.warn(
              `agent-office: ${def.file} failed (${(err as Error).message}); placeholder used`,
            )
            view.adoptPlaceholder(kind, def, mats, rainGlass, group, mv, fixture, pl.id)
          }
        } else if (kind !== 'skyline')
          view.adoptPlaceholder(kind, def, mats, rainGlass, group, mv, fixture, pl.id)
        mv.probe.applyEuler(group.rotation).add(group.position)
        view.group.add(group)
        view.modules.push(mv)
        progress(++done / placements.length)
      }),
    )
    view.group.updateMatrixWorld(true)
    return view
  }

  private adoptPlaceholder(
    kind: SpecialKind,
    def: SpecialModuleDef,
    mats: MaterialLibrary,
    rainGlass: THREE.ShaderMaterial,
    group: THREE.Group,
    mv: ModuleView,
    fixture: boolean,
    placement: string,
  ): void {
    const ph: PlaceholderModule = buildPlaceholder(
      kind,
      def,
      mats,
      rainGlass,
      fixture ? FIXTURE_DECOR : null,
    )
    group.add(ph.group)
    mv.floors.push(...ph.floors)
    mv.probe.copy(ph.probe)
    mv.lights.push(...ph.lights)
    this.holo.push(...ph.holo)
    this.rainGlass.push(...ph.rainGlass)
    this.geometries.push(...ph.geometries)
    const toWorld = (v: THREE.Vector3) => v.clone().applyEuler(group.rotation).add(group.position)
    for (const s of ph.shafts)
      this.shafts.push({ ...s, top: toWorld(s.top), yaw: s.yaw + group.rotation.y })
    for (const n of ph.neon)
      this.neon.push({ ...n, pos: toWorld(n.pos), yaw: n.yaw + group.rotation.y })
    for (const { light } of ph.lights) {
      light.position.copy(toWorld(light.position))
      const spot = light as THREE.SpotLight
      if (spot.isSpotLight) spot.target.position.copy(toWorld(spot.target.position))
    }
    if (ph.monitors) this.instScreens.push({ ...ph.monitors, placement })
    if (ph.leds) this.instLeds.push({ ...ph.leds, placement })
  }

  private async adoptGlb(
    store: AssetStore,
    def: SpecialModuleDef,
    group: THREE.Group,
    mv: ModuleView,
    placement: string,
    tier: LightmapTier,
  ): Promise<void> {
    const gltf = await store.module(def.file!)
    const scene = gltf.scene.clone(true)
    const lm = def.lightmap
    const lightmap = lm ? await store.lightmap(lm, tier).catch(() => null) : null
    scene.updateMatrixWorld(true)
    const screens = new Map<THREE.BufferGeometry, THREE.Mesh[]>()
    const doomed: THREE.Object3D[] = []
    scene.traverse((o) => {
      const m = o as THREE.Mesh
      const role = o.userData.role as string | undefined
      if (role === 'collider') {
        // Invisible collision boxes (the plan's walls and furniture are the colliders here).
        doomed.push(o)
        return
      }
      if (!m.isMesh) {
        if (role === 'traffic' && Array.isArray(o.userData.points))
          this.traffic.push(
            (o.userData.points as number[][]).map(([x = 0, y = 0, z = 0]) =>
              new THREE.Vector3(x, y, z).applyEuler(group.rotation).add(group.position),
            ),
          )
        return
      }
      m.userData.aoGltf = true
      m.castShadow = false
      m.receiveShadow = false
      const baked =
        !!lightmap &&
        (inherited(m, 'role') === 'baked' || inherited(m, 'lightmap') === true) &&
        !!m.geometry.getAttribute('uv1')
      const mats = (
        Array.isArray(m.material) ? m.material : [m.material]
      ) as THREE.MeshStandardMaterial[]
      const next = mats.map((mat) => {
        const g = toCheapGlass(mat)
        return baked && g === mat ? this.bakedOf(mat, lightmap!, lm!.intensity) : g
      })
      m.material = Array.isArray(m.material) ? next : next[0]!
      const std = next[0] as THREE.MeshStandardMaterial
      for (const mat of next as THREE.MeshStandardMaterial[]) this.trackEmissive(mat)
      if (std.emissive && std.emissive.getHex() !== 0 && std.emissiveIntensity >= 1) markBloom(m)
      if (baked)
        mv.floors.push(
          ...(next as THREE.MeshStandardMaterial[]).filter((x) => /floor/.test(x.name)),
        )
      const ref = o.userData.ref as string | undefined
      switch (role) {
        case 'holo':
          this.holo.push(m)
          break
        case 'ad':
          this.ads.push(m)
          break
        case 'neon':
          this.neonMeshes.push(m)
          break
        case 'rain-glass':
          this.rainGlass.push(m)
          break
        case 'screen':
          if (ref) screens.set(m.geometry, [...(screens.get(m.geometry) ?? []), m])
          break
        case 'led':
          if (ref) {
            const mat = new THREE.MeshBasicMaterial({ color: 0x203038 })
            m.material = mat
            markBloom(m)
            this.meshLeds.set(`${placement}|${ref}`, { mesh: m, mat })
          }
          break
      }
    })
    for (const o of doomed) o.removeFromParent()
    // Monitors: one instanced mesh per screen geometry, the screen art tinted by agent status.
    for (const [geo, list] of screens) {
      const src = list[0]!.material as THREE.MeshStandardMaterial
      const mat = new THREE.MeshBasicMaterial({
        map: src.emissiveMap ?? src.map ?? null,
        color: 0xffffff,
      })
      mat.name = 'special:monitor'
      const im = new THREE.InstancedMesh(geo, mat, list.length)
      const index = new Map<string, number>()
      list.forEach((m, i) => {
        im.setMatrixAt(i, m.matrixWorld)
        im.setColorAt(i, SCREEN_OFF)
        index.set(m.userData.ref as string, i)
        doomed.push(m)
        m.removeFromParent()
      })
      im.name = 'screens'
      markBloom(im)
      scene.add(im)
      this.instScreens.push({ mesh: im, index, placement })
    }
    const b = def.bounds
    mv.probe.set((b.minX + b.maxX) / 2, 1.8, (b.minZ + b.maxZ) / 2)
    group.add(scene)
  }

  /** One baked clone per source material (shared by the module's meshes). */
  private baked = new Map<THREE.Material, THREE.MeshStandardMaterial>()
  private bakedOf(m: THREE.MeshStandardMaterial, lightmap: THREE.Texture, intensity: number) {
    let b = this.baked.get(m)
    if (!b) {
      b = m.clone()
      bakeMaterial(b, lightmap, intensity, { cutaway: false })
      this.baked.set(m, b)
    }
    return b
  }

  /** Workstation monitors by `<placement>|<screen>` (status colours from real agents only). */
  setScreens(states: Map<string, ScreenState>): void {
    const key = [...states].map(([k, s]) => `${k}=${s.color}:${s.intensity}`).join(',')
    if (key === this.lastScreens) return
    this.lastScreens = key
    for (const s of this.instScreens) {
      for (const [screen, i] of s.index) {
        const st = states.get(`${s.placement}|${screen}`)
        if (st) this.color.set(st.color).multiplyScalar(st.intensity)
        else this.color.copy(SCREEN_OFF)
        s.mesh.setColorAt(i, this.color)
      }
      if (s.mesh.instanceColor) s.mesh.instanceColor.needsUpdate = true
    }
    for (const [k, s] of this.meshScreens) {
      const st = states.get(k)
      if (st) s.mat.color.set(st.color).multiplyScalar(st.intensity)
      else s.mat.color.setHex(0x0a1a24)
    }
  }

  /** Booth LEDs by `<placement>|<led>`: green while a waiting agent is inside. */
  setLeds(on: Set<string>): void {
    for (const s of this.instLeds) {
      for (const [led, i] of s.index) {
        this.color.setHex(on.has(`${s.placement}|${led}`) ? 0x3ccf91 : 0x203038)
        if (on.has(`${s.placement}|${led}`)) this.color.multiplyScalar(3)
        s.mesh.setColorAt(i, this.color)
      }
      if (s.mesh.instanceColor) s.mesh.instanceColor.needsUpdate = true
    }
    for (const [k, s] of this.meshLeds) s.mat.color.setHex(on.has(k) ? 0x3ccf91 : 0x203038)
  }

  dispose(): void {
    this.group.removeFromParent()
    this.group.traverse((o) => {
      const m = o as THREE.Mesh
      if ((m as unknown as THREE.InstancedMesh).isInstancedMesh)
        (m as unknown as THREE.InstancedMesh).dispose()
    })
    for (const g of this.geometries) g.dispose()
    for (const s of [...this.meshScreens.values(), ...this.meshLeds.values()]) s.mat.dispose()
    for (const m of this.baked.values()) m.dispose()
    for (const s of this.instScreens) (s.mesh.material as THREE.Material).dispose()
  }

  private trackEmissive(mat: THREE.MeshStandardMaterial): void {
    const kind = /^nc-neon-/.test(mat.name) ? 'neon' : /^nc-glow-/.test(mat.name) ? 'glow' : null
    if (!kind || this.emissives.some((e) => e.mat === mat)) return
    this.emissives.push({ mat, base: mat.emissiveIntensity, kind })
  }

  /** Emissive restraint (special-quality `emissive`): idempotent, always from the exported base. */
  setEmissive(e: { neon: number; glow: number; floorReflection: number }): void {
    for (const x of this.emissives) x.mat.emissiveIntensity = x.base * e[x.kind]
    for (const mv of this.modules) for (const f of mv.floors) f.envMapIntensity = e.floorReflection
  }

  /** The brightest neon strip after the restraint (debug hook). */
  maxNeonIntensity(): number {
    return this.emissives.reduce((m, x) => Math.max(m, x.mat.emissiveIntensity), 0)
  }
}
