// One draw per body: the glb's body (and LOD1) are a skinned mesh with one primitive per material
// (skin, shirt, pants, shoes, eyes, hair → 6 draws). At load we merge those primitives into a single
// SkinnedMesh with a per-vertex slot index, and colour each slot from a small uniform array, so a
// character's body is ONE draw call. Materials are shared by palette (one program for all).
import * as THREE from 'three'

/** Slots per body (material names in discovery order: skin, shirt, pants, shoes, eyes, hair …). */
export const MAX_SLOTS = 8

interface SlotData {
  colors: THREE.Color[]
  rough: number[]
}

function install(m: THREE.Material & { userData: { slots?: SlotData } }, lit: boolean) {
  m.onBeforeCompile = (shader) => {
    const d = m.userData.slots!
    shader.uniforms.uSlotColor = { value: d.colors }
    shader.uniforms.uSlotRough = { value: d.rough }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aSlot;\nvarying float vSlot;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSlot = aSlot;')
    let fs = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nuniform vec3 uSlotColor[${MAX_SLOTS}];\nuniform float uSlotRough[${MAX_SLOTS}];\nvarying float vSlot;`,
      )
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\nint aoSlot = int(vSlot + 0.5);\ndiffuseColor.rgb = uSlotColor[aoSlot];',
      )
    if (lit)
      fs = fs.replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = uSlotRough[aoSlot];',
      )
    shader.fragmentShader = fs
  }
  m.customProgramCacheKey = () => (lit ? 'ao-slots-lit' : 'ao-slots-basic')
}

const newSlots = (): SlotData => ({
  colors: Array.from({ length: MAX_SLOTS }, () => new THREE.Color(1, 1, 1)),
  rough: new Array<number>(MAX_SLOTS).fill(0.7),
})

/** Lit body material with per-slot colour and roughness. Clones keep their slots. */
export class SlotMaterial extends THREE.MeshStandardMaterial {
  constructor() {
    super({ metalness: 0 })
    this.name = 'body-slots'
    this.userData.slots = newSlots()
    install(this, true)
  }
  get slots(): SlotData {
    return this.userData.slots as SlotData
  }
  override copy(source: SlotMaterial): this {
    super.copy(source)
    this.userData.slots = {
      colors: source.slots.colors.map((c) => c.clone()),
      rough: [...source.slots.rough],
    }
    install(this, true)
    return this
  }
}

/** Unlit variant (impostor shirt mask). */
export class SlotBasicMaterial extends THREE.MeshBasicMaterial {
  constructor() {
    super()
    this.name = 'body-slots'
    this.userData.slots = newSlots()
    install(this, false)
  }
  get slots(): SlotData {
    return this.userData.slots as SlotData
  }
}

/** The body's slot names (by index) and their template colours/roughness, filled at merge time.
 * Share one layout between LOD0 and LOD1 so both use the same slot indices. */
export interface BodyLayout {
  names: string[]
  colors: number[]
  rough: number[]
}

const attr = (g: THREE.BufferGeometry, name: string) =>
  g.getAttribute(name) as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined

/**
 * Replaces the per-material SkinnedMesh children of `group` by one merged SkinnedMesh. Returns
 * false (and leaves the group untouched) when the children can't be merged safely.
 */
export function mergeBody(group: THREE.Object3D, layout: BodyLayout): boolean {
  const parts = group.children.filter(
    (c): c is THREE.SkinnedMesh => (c as THREE.SkinnedMesh).isSkinnedMesh === true,
  )
  if (parts.length < 2) return false
  const skeleton = parts[0]!.skeleton
  if (parts.some((p) => p.skeleton.bones.length !== skeleton.bones.length)) return false
  const names = ['position', 'normal', 'skinIndex', 'skinWeight']
  if (parts.some((p) => names.some((n) => !attr(p.geometry, n)))) return false

  const slotOf = (mat: THREE.Material) => {
    let i = layout.names.indexOf(mat.name)
    if (i < 0 && layout.names.length < MAX_SLOTS) {
      i = layout.names.push(mat.name) - 1
      const c = (mat as THREE.Material & { color?: THREE.Color }).color
      layout.colors[i] = c ? c.getHex() : 0xffffff
      layout.rough[i] = (mat as THREE.MeshStandardMaterial).roughness ?? 0.7
    }
    return Math.max(0, i)
  }
  let nv = 0
  let ni = 0
  for (const p of parts) {
    nv += p.geometry.getAttribute('position').count
    ni += p.geometry.index ? p.geometry.index.count : p.geometry.getAttribute('position').count
  }
  const pos = new Float32Array(nv * 3)
  const nor = new Float32Array(nv * 3)
  const si = new Uint16Array(nv * 4)
  const sw = new Float32Array(nv * 4)
  const slot = new Float32Array(nv)
  const index = new Uint32Array(ni)
  let v0 = 0
  let i0 = 0
  for (const p of parts) {
    const g = p.geometry
    const P = attr(g, 'position')!
    const N = attr(g, 'normal')!
    const I = attr(g, 'skinIndex')!
    const Wt = attr(g, 'skinWeight')!
    const s = slotOf(Array.isArray(p.material) ? p.material[0]! : p.material)
    for (let v = 0; v < P.count; v++) {
      const o = v0 + v
      pos[o * 3] = P.getX(v)
      pos[o * 3 + 1] = P.getY(v)
      pos[o * 3 + 2] = P.getZ(v)
      nor[o * 3] = N.getX(v)
      nor[o * 3 + 1] = N.getY(v)
      nor[o * 3 + 2] = N.getZ(v)
      si[o * 4] = I.getX(v)
      si[o * 4 + 1] = I.getY(v)
      si[o * 4 + 2] = I.getZ(v)
      si[o * 4 + 3] = I.getW(v)
      sw[o * 4] = Wt.getX(v)
      sw[o * 4 + 1] = Wt.getY(v)
      sw[o * 4 + 2] = Wt.getZ(v)
      sw[o * 4 + 3] = Wt.getW(v)
      slot[o] = s
    }
    if (g.index) for (let k = 0; k < g.index.count; k++) index[i0 + k] = g.index.getX(k) + v0
    else for (let k = 0; k < P.count; k++) index[i0 + k] = k + v0
    i0 += g.index ? g.index.count : P.count
    v0 += P.count
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4))
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4))
  geo.setAttribute('aSlot', new THREE.BufferAttribute(slot, 1))
  geo.setIndex(new THREE.BufferAttribute(index, 1))
  geo.computeBoundingSphere()
  geo.computeBoundingBox()

  const mat = new SlotMaterial()
  const merged = new THREE.SkinnedMesh(geo, mat)
  merged.name = `${group.name}-merged`
  merged.bind(skeleton, parts[0]!.bindMatrix)
  merged.position.copy(parts[0]!.position)
  merged.quaternion.copy(parts[0]!.quaternion)
  merged.scale.copy(parts[0]!.scale)
  for (const p of parts) {
    group.remove(p)
    p.geometry.dispose()
  }
  group.add(merged)
  return true
}

/** Fills a slot material for a palette (slot name → colour); unnamed slots keep the template colour. */
export function paintSlots(
  mat: SlotMaterial | SlotBasicMaterial,
  layout: BodyLayout,
  colorOf: (slot: string) => number | undefined,
) {
  const s = mat.slots
  layout.names.forEach((name, i) => {
    s.colors[i]!.setHex(colorOf(name) ?? layout.colors[i] ?? 0xffffff)
    s.rough[i] = layout.rough[i] ?? 0.7
  })
}
