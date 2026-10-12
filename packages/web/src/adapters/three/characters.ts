// Characters: one shared skinned `character.glb` (contract §8), cloned per agent with
// SkeletonUtils, one AnimationMixer each, tinted by cached material clones, moved by a `Mover`
// running the director's steps. Animation LOD (plan §4.2): full rate near, every second frame
// mid-range, LOD1 mesh at 10 Hz far, frozen off-screen; beyond the preset's animated budget the
// farthest become instanced impostors (or, without a renderer to bake them, LOD1 at 10 Hz).
import * as THREE from 'three'
import type { GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import {
  CHARACTER_QUALITY,
  SEPARATION,
  animTier,
  appearanceOf,
  impostorCell,
  impostorMask,
  paletteKey,
  poseRowOf,
  presetOf,
  separationPush,
  tickDue,
  type Appearance,
  type CharacterQuality,
  type ClipMeta,
  type ClipTable,
} from '../../app/motion.ts'
import type { Activity, AgentPlan, GraphicsQuality } from '../../app/office-types.ts'
import { Animator } from './characters/animator.ts'
import { BlobShadows } from './characters/blobs.ts'
import { IMPOSTOR_CELLS, Impostors } from './characters/impostors.ts'
import { FadeMaterials, TintCache, isTintSlot, type TintSlot } from './characters/materials.ts'
import { Mover } from './mover.ts'

export interface CharacterMeta {
  height: number
  seatHeight: number
  loungeSeatHeight: number
  clips: Record<string, ClipMeta>
}
export interface CharacterAssets {
  gltf: GLTF
  meta: CharacterMeta
}

/** Loads `character.glb` + `character.json` from `baseUrl` (e.g. 'assets/'). */
export async function loadCharacterAssets(
  baseUrl: string,
  loader: GLTFLoader,
): Promise<CharacterAssets> {
  const [gltf, meta] = await Promise.all([
    loader.loadAsync(`${baseUrl}character.glb`),
    fetch(`${baseUrl}character.json`).then((r) => {
      if (!r.ok) throw new Error(`character.json: HTTP ${r.status}`)
      return r.json() as Promise<unknown>
    }),
  ])
  return { gltf, meta: parseMeta(meta) }
}

function parseMeta(json: unknown): CharacterMeta {
  const m = json as Partial<CharacterMeta> | null
  const num = (v: unknown) => typeof v === 'number' && v > 0
  if (!m || !num(m.height) || !num(m.seatHeight) || !num(m.loungeSeatHeight))
    throw new Error('character.json: height/seatHeight/loungeSeatHeight must be > 0')
  if (!m.clips || typeof m.clips !== 'object') throw new Error('character.json: clips missing')
  return m as CharacterMeta
}

// ── Template analysis ───────────────────────────────────────────────────────────────────────────
interface Parts {
  /** Every mesh (materials, shadows, fades). */
  meshes: THREE.Mesh[]
  /** Base body meshes (LOD0), and the decimated LOD1 nodes. */
  base: THREE.Object3D[]
  lod1: THREE.Object3D[]
  accessories: Map<string, THREE.Object3D>
  props: Map<string, THREE.Object3D>
  head: THREE.Object3D | undefined
}

const isLod1 = (o: THREE.Object3D) =>
  (typeof o.userData.lod === 'number' && o.userData.lod >= 1) || /(^|[_.-])lod[1-9]/i.test(o.name)

function partsOf(root: THREE.Object3D): Parts {
  const p: Parts = {
    meshes: [],
    base: [],
    lod1: [],
    accessories: new Map(),
    props: new Map(),
    head: undefined,
  }
  const visit = (o: THREE.Object3D, inVariant: boolean) => {
    const ud = o.userData as { accessory?: unknown; prop?: unknown }
    let variant = inVariant
    if (typeof ud.accessory === 'string') ((variant = true), p.accessories.set(ud.accessory, o))
    if (typeof ud.prop === 'string') ((variant = true), p.props.set(ud.prop, o))
    if (isLod1(o)) ((variant = true), p.lod1.push(o))
    if ((o as THREE.Bone).isBone && o.name === 'head') p.head = o
    if ((o as THREE.Mesh).isMesh) {
      p.meshes.push(o as THREE.Mesh)
      if (!variant) p.base.push(o)
    }
    for (const c of o.children) visit(c, variant)
  }
  visit(root, false)
  return p
}

/** Accessories shown per look; everything else stays hidden (contract §8). */
function dress(parts: Parts, look: Appearance | undefined, far: boolean) {
  for (const [name, o] of parts.accessories) {
    let on = false
    if (!look) on = name === 'hairA'
    else if (name.startsWith('hair')) on = name === look.hairStyle
    else if (name === 'glasses') on = look.glasses && !far
    else if (name === 'headset') on = look.headset && !far
    else if (name === 'badge') on = look.badge !== undefined && !far
    o.visible = on
  }
}

const slotColor = (look: Appearance, slot: TintSlot): number | undefined =>
  slot === 'badge' ? look.badge : look[slot]

/**
 * Turn clips rotate the root bone themselves (character.json `turn`), but the mover already drives
 * the heading — strip their root rotation so turns aren't doubled (loops would also snap back).
 * ElevatorIn keeps its half-turn: it ends the walk-out and the agent fades away.
 */
function inPlace(clip: THREE.AnimationClip, meta: ClipTable): THREE.AnimationClip {
  if (meta[clip.name]?.turn === undefined || clip.name === 'ElevatorIn') return clip
  const tracks = clip.tracks.filter((t) => t.name !== 'root.quaternion')
  return tracks.length === clip.tracks.length
    ? clip
    : new THREE.AnimationClip(clip.name, clip.duration, tracks, clip.blendMode)
}

// ── One agent ───────────────────────────────────────────────────────────────────────────────────
const HIT_GEOMETRY = new THREE.BoxGeometry(0.7, 1.8, 0.7).translate(0, 0.9, 0)
const HIT_MATERIAL = new THREE.MeshBasicMaterial({ visible: false })
const LABEL_LIFT = 0.25
const HEAD_SMOOTH_TAU = 0.12

interface Agent {
  id: string
  holder: THREE.Group
  model: THREE.Object3D
  parts: Parts
  animator: Animator
  mover: Mover
  hit: THREE.Mesh
  look: Appearance
  lookKey: string
  /** Original (template) material per mesh, and the tinted ones acquired from the cache. */
  baseMats: Map<THREE.Mesh, THREE.Material | THREE.Material[]>
  tinted: THREE.Material[]
  fade: FadeMaterials
  activity: Activity | undefined
  head: THREE.Vector3
  headReady: boolean
  pending: number
  slot: number
  far: boolean
  impostor: boolean
  /** Beyond the animated budget last frame (impostor hysteresis). */
  over: boolean
  push: { x: number; z: number }
  shirt: THREE.Color
}

export interface CharacterSystemOptions {
  quality?: GraphicsQuality
  /** Needed only to bake impostors at load; without it, over-budget agents fall back to LOD1 at 10 Hz. */
  renderer?: THREE.WebGLRenderer
}

export class CharacterSystem {
  private readonly root = new THREE.Group()
  private readonly template: THREE.Object3D
  private readonly clips = new Map<string, THREE.AnimationClip>()
  private readonly clipTable: ClipTable
  private readonly meta: CharacterMeta
  private readonly restHeadTop: number
  private readonly agents = new Map<string, Agent>()
  private readonly tints = new TintCache()
  private readonly blobs: BlobShadows
  private readonly impostors: Impostors | undefined
  private quality: CharacterQuality
  private frame = 0
  private targets: THREE.Object3D[] | undefined
  private nImpostors = 0
  private nAnimated = 0
  // Per-frame scratch (allocation-free update).
  private readonly frustum = new THREE.Frustum()
  private readonly proj = new THREE.Matrix4()
  private readonly sphere = new THREE.Sphere(new THREE.Vector3(), 1.1)
  private readonly cam = new THREE.Vector3()
  private readonly cam2 = { x: 0, z: 0 }
  private clockS = 0
  private readonly tmp = new THREE.Vector3()
  private xs = new Float64Array(64)
  private zs = new Float64Array(64)
  private walkers: Agent[] = []
  private order: Agent[] = []
  private dist = new Float64Array(64)
  private onScreen: boolean[] = []
  private eligible: boolean[] = []
  private mask = new Uint8Array(64)
  private readonly scratch: number[] = []

  constructor(
    private readonly scene: THREE.Scene,
    assets: CharacterAssets,
    opts: CharacterSystemOptions = {},
  ) {
    this.root.name = 'characters'
    scene.add(this.root)
    this.meta = assets.meta
    this.clipTable = assets.meta.clips
    this.quality = CHARACTER_QUALITY[presetOf(opts.quality ?? 'auto')]
    for (const c of assets.gltf.animations) this.clips.set(c.name, inPlace(c, this.clipTable))
    this.template = assets.gltf.scene
    // Clips are in place, so a generous bind-pose sphere covers every pose (skinned meshes
    // otherwise compute bounds from whatever pose they first render in).
    this.template.traverse((o) => {
      const m = o as THREE.SkinnedMesh
      if (!m.isMesh) return
      m.geometry.computeBoundingSphere()
      if (m.isSkinnedMesh && m.geometry.boundingSphere) {
        m.boundingSphere = m.geometry.boundingSphere.clone()
        m.boundingSphere.radius *= 1.4
      }
    })
    const tp = partsOf(this.template)
    this.template.updateMatrixWorld(true)
    const headY = tp.head ? tp.head.getWorldPosition(new THREE.Vector3()).y : this.meta.height
    this.restHeadTop = Math.max(0, this.meta.height - headY)
    this.blobs = new BlobShadows(this.root)
    if (opts.renderer)
      this.impostors = Impostors.bake(this.root, {
        renderer: opts.renderer,
        template: this.template,
        clips: this.clips,
        height: this.meta.height,
        dress: (model) => {
          const p = partsOf(model)
          dress(p, undefined, false)
          for (const o of p.props.values()) o.visible = false
          for (const o of p.lod1) o.visible = false
        },
      })
  }

  setQuality(q: Exclude<GraphicsQuality, 'auto'>): void {
    this.quality = CHARACTER_QUALITY[q]
    for (const a of this.agents.values()) this.applyShadows(a)
  }

  upsert(plan: AgentPlan, now: number): void {
    void now // steps start now; the mover is advanced by update()'s dt
    const id = plan.agent.id
    let a = this.agents.get(id)
    if (!a) a = this.create(id, plan.teamOf)
    else if (paletteKey(appearanceOf(id, plan.teamOf)) !== a.lookKey) this.retint(a, plan.teamOf)
    a.activity = plan.intent.activity
    if (plan.steps) a.mover.run(plan.steps)
  }

  remove(id: string): void {
    const a = this.agents.get(id)
    if (!a) return
    this.agents.delete(id)
    this.targets = undefined
    this.root.remove(a.holder)
    a.fade.end()
    a.animator.dispose(a.model)
    for (const m of a.tinted) this.tints.release(m)
    a.model.traverse((o) => (o as THREE.SkinnedMesh).skeleton?.dispose())
  }

  update(dt: number, camera: THREE.Camera, now: number): void {
    this.clockS = now / 1000
    this.frame++
    const q = this.quality
    const n = this.agents.size
    this.ensureScratch(n)

    // 1. Separation between walkers (positions from the previous frame).
    let w = 0
    for (const a of this.agents.values())
      if (a.mover.walking) {
        this.walkers[w] = a
        this.xs[w] = a.mover.pos.x
        this.zs[w] = a.mover.pos.z
        w++
      }
    for (let k = 0; k < w; k++)
      separationPush(this.xs, this.zs, w, k, SEPARATION.radius, this.walkers[k]!.push)

    // 2. Movers, then visibility / distance.
    camera.updateMatrixWorld()
    this.proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.proj)
    camera.getWorldPosition(this.cam)
    let i = 0
    for (const a of this.agents.values()) {
      const walking = a.mover.walking
      a.mover.update(dt, walking ? a.push : undefined)
      if (!walking) a.push.x = a.push.z = 0
      const m = a.mover.motion
      if (a.holder.visible !== m.visible)
        ((a.holder.visible = m.visible), (this.targets = undefined))
      this.sphere.center.set(m.pos.x, 0.9, m.pos.z)
      this.order[i] = a
      this.dist[i] = this.sphere.center.distanceTo(this.cam)
      this.onScreen[i] = m.visible && this.frustum.intersectsSphere(this.sphere)
      // Fading agents keep their full model (impostors can't fade).
      this.eligible[i] = this.onScreen[i]! && (!this.impostors || m.opacity >= 1)
      this.mask[i] = a.over ? 1 : 0
      i++
    }

    // 3. Budget: the farthest on-screen agents beyond `maxAnimated`.
    impostorMask(this.dist, this.eligible, n, q.maxAnimated, this.mask, this.scratch)

    // 4. Per agent: LOD, mixer ticks, fades, blobs, impostors, labels.
    this.blobs.begin()
    this.impostors?.begin()
    let animated = 0
    for (let k = 0; k < n; k++) {
      const a = this.order[k]!
      const m = a.mover.motion
      const over = this.mask[k] === 1
      a.over = over
      const asImpostor = over && !!this.impostors
      let tier = animTier(this.dist[k]!, this.onScreen[k]!, q)
      if (over && !asImpostor) tier = 'far'
      a.pending += dt
      this.setImpostor(a, asImpostor)
      if (asImpostor) {
        this.cam2.x = this.cam.x
        this.cam2.z = this.cam.z
        const cell = impostorCell(this.cam2, m.pos, m.heading, IMPOSTOR_CELLS)
        this.impostors!.push(m.pos.x, m.pos.z, cell, poseRowOf(m.clip), a.shirt)
      } else if (m.visible) {
        this.setFar(a, tier === 'far')
        if (tickDue(tier, this.frame, a.slot, a.pending)) {
          a.animator.update(a.pending)
          a.pending = 0
        }
        if (tier !== 'frozen') animated++
      }
      this.applyFade(a)
      if (m.visible) this.blobs.push(m.pos.x, m.pos.z, 0.95 * m.opacity)
      this.updateHead(a, dt)
    }
    this.blobs.end()
    this.impostors?.end()
    this.nAnimated = animated
    this.nImpostors = this.impostors?.count ?? 0
  }

  pickTargets(): THREE.Object3D[] {
    if (!this.targets)
      this.targets = [...this.agents.values()].filter((a) => a.holder.visible).map((a) => a.hit)
    return this.targets
  }

  /** World floor position (live vector — read, don't mutate). */
  positionOf(id: string): THREE.Vector3 | undefined {
    return this.agents.get(id)?.holder.position
  }

  /** Label anchor ~0.25 m above the head (live vector — read, don't mutate). */
  headOf(id: string): THREE.Vector3 | undefined {
    return this.agents.get(id)?.head
  }

  activityOf(id: string): Activity | undefined {
    return this.agents.get(id)?.activity
  }

  count(): { total: number; animated: number; impostors: number } {
    return { total: this.agents.size, animated: this.nAnimated, impostors: this.nImpostors }
  }

  dispose(): void {
    for (const id of [...this.agents.keys()]) this.remove(id)
    this.blobs.dispose()
    this.impostors?.dispose()
    this.tints.dispose()
    this.scene.remove(this.root)
  }

  // ── internals ──
  private create(id: string, teamOf: string | undefined): Agent {
    const model = cloneSkinned(this.template)
    const parts = partsOf(model)
    const holder = new THREE.Group()
    holder.name = `agent:${id}`
    holder.visible = false
    holder.add(model)
    const hit = new THREE.Mesh(HIT_GEOMETRY, HIT_MATERIAL)
    hit.userData.agentId = id
    holder.add(hit)
    this.root.add(holder)
    const animator = new Animator(model, this.clips, parts.props)
    for (const o of parts.props.values()) o.visible = false
    for (const o of parts.lod1) o.visible = false
    const baseMats = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
    for (const mesh of parts.meshes) baseMats.set(mesh, mesh.material)
    const look = appearanceOf(id, teamOf)
    const a: Agent = {
      id,
      holder,
      model,
      parts,
      animator,
      mover: new Mover(this.clipTable, animator, holder, () => this.clockS),
      hit,
      look,
      lookKey: paletteKey(look),
      baseMats,
      tinted: [],
      fade: new FadeMaterials(),
      activity: undefined,
      head: new THREE.Vector3(),
      headReady: false,
      pending: 0,
      slot: this.agents.size % 2,
      far: false,
      impostor: false,
      over: false,
      push: { x: 0, z: 0 },
      shirt: new THREE.Color(look.shirt),
    }
    this.tint(a)
    dress(parts, look, false)
    this.applyShadows(a)
    this.agents.set(id, a)
    this.targets = undefined
    return a
  }

  private tint(a: Agent) {
    for (const [mesh, base] of a.baseMats) {
      const one = (m: THREE.Material) => {
        if (!isTintSlot(m.name)) return m
        const hex = slotColor(a.look, m.name)
        if (hex === undefined) return m
        const t = this.tints.acquire(m, hex)
        a.tinted.push(t)
        return t
      }
      mesh.material = Array.isArray(base) ? base.map(one) : one(base)
    }
  }

  private retint(a: Agent, teamOf: string | undefined) {
    a.fade.end()
    for (const m of a.tinted) this.tints.release(m)
    a.tinted = []
    a.look = appearanceOf(a.id, teamOf)
    a.lookKey = paletteKey(a.look)
    a.shirt.setHex(a.look.shirt)
    this.tint(a)
    dress(a.parts, a.look, a.far)
  }

  private applyShadows(a: Agent) {
    for (const mesh of a.parts.meshes) {
      mesh.castShadow = this.quality.shadows
      mesh.receiveShadow = false
    }
  }

  private setFar(a: Agent, far: boolean) {
    if (a.far === far || !a.parts.lod1.length) return
    a.far = far
    for (const o of a.parts.base) o.visible = !far
    for (const o of a.parts.lod1) o.visible = far
    dress(a.parts, a.look, far)
  }

  private setImpostor(a: Agent, on: boolean) {
    if (a.impostor === on) return
    a.impostor = on
    a.model.visible = !on
  }

  private applyFade(a: Agent) {
    const m = a.mover.motion
    if (m.visible && m.opacity < 1 && !a.impostor) {
      a.fade.begin(a.parts.meshes)
      a.fade.set(m.opacity)
    } else if (a.fade.active) a.fade.end()
  }

  private updateHead(a: Agent, dt: number) {
    const p = a.holder.position
    let y: number
    const head = a.parts.head
    if (head && !a.impostor) y = head.getWorldPosition(this.tmp).y + this.restHeadTop + LABEL_LIFT
    else {
      const row = poseRowOf(a.mover.motion.clip)
      y = this.meta.height * (row === 0 ? 1 : row === 1 ? 0.76 : 0.7) + LABEL_LIFT
    }
    const k = a.headReady ? 1 - Math.exp(-dt / HEAD_SMOOTH_TAU) : 1
    a.headReady = true
    a.head.set(p.x, a.head.y + (y - a.head.y) * k, p.z)
  }

  private ensureScratch(n: number) {
    if (this.dist.length >= n) return
    const cap = Math.max(n, this.dist.length * 2)
    this.xs = new Float64Array(cap)
    this.zs = new Float64Array(cap)
    this.dist = new Float64Array(cap)
    this.mask = new Uint8Array(cap)
  }
}
