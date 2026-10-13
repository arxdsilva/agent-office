// Placeholder geometry for Night City modules without a .glb yet (docs/special-3d/assets.md): built
// from the module's floor plan (walls, furniture: the same boxes the colliders use) plus the
// fixture's decor (suspended screen, skybridges, bonsai, strips). Static parts are merged per
// material (a few draw calls per module); monitors and booth LEDs are instanced so their colours
// can follow real agent status. Original primitives only: no logos, no third-party art.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { PlanFurniture, PlanWall } from '../../../app/pixel/types.ts'
import { wallRuns, type SpecialModuleDef } from '../../../app/special/world.ts'
import type { FixtureDecor } from '../../fixtures/manifest.ts'
import { markBloom } from '../rendering/bloom-selective.ts'
import type { ShaftSpec } from '../rendering/atmosphere.ts'
import { PALETTE, type MaterialLibrary } from '../rendering/material-library.ts'

export interface PlaceholderModule {
  group: THREE.Group
  /** The room's wet floor material(s): the reflection probe goes here. */
  floors: THREE.MeshStandardMaterial[]
  /** Planes for the holo displays (`holo` role). */
  holo: THREE.Mesh[]
  /** Window glass for the rain shader (`rain-glass` role). */
  rainGlass: THREE.Mesh[]
  /** Workstation monitors: one instance per `screen` key. */
  monitors: { mesh: THREE.InstancedMesh; index: Map<string, number> } | null
  /** Booth indicator LEDs: one instance per `led` key. */
  leds: { mesh: THREE.InstancedMesh; index: Map<string, number> } | null
  lights: { light: THREE.PointLight | THREE.SpotLight; priority: number }[]
  shafts: ShaftSpec[]
  neon: { text: string; color: string; pos: THREE.Vector3; yaw: number }[]
  /** Local point for the reflection probe. */
  probe: THREE.Vector3
  geometries: THREE.BufferGeometry[]
}

const UP = new THREE.Vector3(0, 1, 0)

/** Collects transformed geometry per material and merges it once (static batching). */
class Batcher {
  private parts = new Map<THREE.Material, THREE.BufferGeometry[]>()
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private e = new THREE.Euler()

  add(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    ry = 0,
    rx = 0,
    rz = 0,
  ): void {
    this.e.set(rx, ry, rz, 'YXZ')
    this.q.setFromEuler(this.e)
    this.m.compose(new THREE.Vector3(x, y, z), this.q, new THREE.Vector3(1, 1, 1))
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(this.m)
    if (!g.getAttribute('uv'))
      g.setAttribute(
        'uv',
        new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2),
      )
    const list = this.parts.get(mat) ?? []
    list.push(g)
    this.parts.set(mat, list)
  }

  box(
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    ry = 0,
    rx = 0,
  ): void {
    const g = new THREE.BoxGeometry(w, h, d)
    this.add(g, mat, x, y, z, ry, rx)
    g.dispose()
  }

  build(group: THREE.Group, out: THREE.BufferGeometry[], bloom: Set<THREE.Material>): void {
    for (const [mat, list] of this.parts) {
      const merged = mergeGeometries(list, false)
      for (const g of list) g.dispose()
      if (!merged) continue
      out.push(merged)
      const mesh = new THREE.Mesh(merged, mat)
      mesh.name = `ph:${mat.name}`
      mesh.receiveShadow = true
      mesh.castShadow = !bloom.has(mat) && !(mat as THREE.Material).transparent
      if (bloom.has(mat)) markBloom(mesh)
      group.add(mesh)
    }
    this.parts.clear()
  }
}

interface Ctx {
  b: Batcher
  mats: MaterialLibrary
  bloom: Set<THREE.Material>
  out: PlaceholderModule
  height: number
}

const emissive = (c: Ctx, color: number, intensity = 2.2) => {
  const m = c.mats.emissive(color, intensity)
  c.bloom.add(m)
  return m
}

function walls(c: Ctx, plan: PlanWall[], rainGlass: THREE.ShaderMaterial): void {
  const { b, mats } = c
  for (const w of plan)
    for (const r of wallRuns(w)) {
      const len = Math.hypot(r.b.x - r.a.x, r.b.z - r.a.z)
      const cx = (r.a.x + r.b.x) / 2 + r.normal.x * r.off
      const cz = (r.a.z + r.b.z) / 2 + r.normal.z * r.off
      const yaw = Math.atan2(r.b.x - r.a.x, r.b.z - r.a.z)
      const h = (w as PlanWall & { h?: number }).h ?? c.height
      if (w.kind === 'solid') {
        // Thickness along local x, length along local z (yaw aligns z with a→b).
        b.box(r.thick, h, len, mats.graphitePanel(), cx, h / 2, cz, yaw)
        // Vertical cyan seams every 4 m on both faces, and a skirting light.
        const n = Math.floor(len / 4)
        for (let i = 1; i <= n; i++) {
          const t = i / (n + 1) - 0.5
          const sx = cx + Math.sin(yaw) * len * t
          const sz = cz + Math.cos(yaw) * len * t
          for (const side of [-1, 1])
            b.box(
              0.03,
              h * 0.7,
              0.05,
              emissive(c, PALETTE.cyan, 1.6),
              sx + r.normal.x * side * (r.thick / 2 + 0.02),
              h * 0.45,
              sz + r.normal.z * side * (r.thick / 2 + 0.02),
              yaw,
            )
        }
      } else {
        // Glass: mullions every 2.5 m, transoms every 3.5 m, then the pane.
        const steel = mats.paintedSteel()
        const nm = Math.max(1, Math.round(len / 2.5))
        for (let i = 0; i <= nm; i++) {
          const t = i / nm - 0.5
          b.box(
            0.12,
            h,
            0.12,
            steel,
            cx + Math.sin(yaw) * len * t,
            h / 2,
            cz + Math.cos(yaw) * len * t,
            yaw,
          )
        }
        if (w.kind === 'curtain')
          for (let y = 3.5; y < h; y += 3.5) b.box(0.1, 0.1, len, steel, cx, y, cz, yaw)
        else b.box(0.08, 0.08, len, steel, cx, h - 0.04, cz, yaw)
        const pane = new THREE.Mesh(
          new THREE.PlaneGeometry(len, h),
          w.kind === 'curtain' || (w.kind === 'glass' && r.thick >= 0.2)
            ? rainGlass
            : mats.darkGlass(),
        )
        c.out.geometries.push(pane.geometry)
        pane.position.set(cx, h / 2, cz)
        pane.rotation.y = yaw + Math.PI / 2
        pane.renderOrder = 2
        c.out.group.add(pane)
        if (pane.material === rainGlass) c.out.rainGlass.push(pane)
      }
    }
}

function furniture(
  c: Ctx,
  list: PlanFurniture[],
  decor: FixtureDecor | null,
  anchors: SpecialModuleDef['anchors'],
): void {
  const { b, mats } = c
  const chairs: THREE.Matrix4[] = []
  for (const f of list) {
    const { x, z, w, d, yaw } = f
    switch (f.kind) {
      case 'elevator': {
        // Doors set into the wall behind the footprint, a cyan frame and an amber indicator.
        const fx = x - Math.sin(yaw) * (d / 2 - 0.1)
        const fz = z - Math.cos(yaw) * (d / 2 - 0.1)
        for (const s of [-0.55, 0.55])
          b.box(
            1.05,
            3.1,
            0.06,
            mats.brushedMetal(),
            fx + Math.cos(yaw) * s,
            1.55,
            fz - Math.sin(yaw) * s,
            yaw,
          )
        b.box(w, 0.08, 0.1, emissive(c, PALETTE.cyan, 2), fx, 3.2, fz, yaw)
        for (const s of [-1.2, 1.2])
          b.box(
            0.08,
            3.2,
            0.1,
            emissive(c, PALETTE.cyan, 2),
            fx + Math.cos(yaw) * s,
            1.6,
            fz - Math.sin(yaw) * s,
            yaw,
          )
        b.box(0.5, 0.12, 0.06, emissive(c, PALETTE.amber, 2.6), fx, 3.5, fz, yaw)
        break
      }
      case 'lectern':
        b.box(w, 1.05, d, mats.paintedSteel(), x, 0.525, z, yaw)
        b.box(w + 0.02, 0.04, d + 0.02, emissive(c, PALETTE.cyan, 2.4), x, 1.07, z, yaw)
        break
      case 'reception-desk':
        b.box(w, 1.05, d, mats.carbon(), x, 0.525, z, yaw)
        b.box(w + 0.2, 0.06, d + 0.25, mats.stone(), x, 1.08, z, yaw)
        b.box(w, 0.05, 0.04, emissive(c, PALETTE.amber, 2.6), x, 0.08, z + d / 2 + 0.03, yaw)
        b.box(w - 0.6, 0.03, 0.03, emissive(c, PALETTE.amber, 1.8), x, 0.9, z + d / 2 + 0.02, yaw)
        break
      case 'kiosk':
        b.box(0.6, 1.0, 0.5, mats.paintedSteel(), x, 0.5, z, yaw)
        b.box(1.1, 0.7, 0.05, emissive(c, PALETTE.cyan, 1.8), x, 1.35, z - 0.2, yaw, -0.35)
        break
      case 'planter': {
        b.box(w, 0.7, d, mats.stone(), x, 0.35, z)
        b.box(w - 0.2, 0.05, d - 0.2, mats.concrete(), x, 0.71, z)
        b.box(w + 0.06, 0.04, d + 0.06, emissive(c, PALETTE.amber, 2.2), x, 0.04, z)
        bonsai(c, x, z)
        const spot = new THREE.SpotLight(0xffa040, 40, 14, 0.55, 0.6, 1.6)
        spot.position.set(x + 1.6, 0.2, z)
        spot.target.position.set(x, 3.2, z)
        c.out.lights.push({ light: spot, priority: 1 })
        break
      }
      case 'sofa': {
        // Which side is the back: away from the table (the seats face it).
        const seat = Object.values(anchors).find(
          (a) => a.pose === 'lounge' && Math.abs(a.x - x) < w / 2 && Math.abs(a.z - z) < 0.6,
        )
        const back = seat ? (seat.heading === 0 ? -1 : 1) : 1
        b.box(w, 0.4, d, mats.leather(), x, 0.2, z)
        b.box(w, 0.42, 0.16, mats.leather(), x, 0.55, z + back * (d / 2 - 0.08))
        b.box(w - 0.1, 0.03, d - 0.1, emissive(c, PALETTE.amber, 2.4), x, 0.015, z)
        break
      }
      case 'cafe-table':
        b.box(w, 0.06, d, mats.stone(), x, 0.36, z)
        b.box(w * 0.5, 0.33, d * 0.5, mats.carbon(), x, 0.165, z)
        b.box(w, 0.02, 0.02, emissive(c, PALETTE.cyan, 1.6), x, 0.38, z + d / 2)
        break
      case 'desk': {
        // A pod: two facing desk pairs with a frosted divider; chairs are instanced below.
        b.box(w, 0.05, d, mats.carbon(), x, 0.74, z, yaw)
        b.box(w - 0.1, 0.7, 0.05, mats.paintedSteel(), x, 0.37, z, yaw)
        b.box(w, 0.38, 0.03, mats.frosted(), x, 0.97, z, yaw)
        b.box(w, 0.02, 0.02, emissive(c, PALETTE.cyan, 1.4), x, 0.765, z + d / 2, yaw)
        b.box(w, 0.02, 0.02, emissive(c, PALETTE.cyan, 1.4), x, 0.765, z - d / 2, yaw)
        break
      }
      case 'context-core': {
        const r = decor?.holo.r ?? w / 2
        const base = new THREE.CylinderGeometry(r, r * 1.1, 0.9, 24)
        b.add(base, mats.carbon(), x, 0.45, z)
        base.dispose()
        const rim = new THREE.TorusGeometry(r, 0.04, 6, 48)
        b.add(rim, emissive(c, PALETTE.cyan, 3), x, 0.92, z, 0, Math.PI / 2)
        rim.dispose()
        // Four holo panels facing outward above the platform.
        for (let i = 0; i < 4; i++) {
          const a = (i * Math.PI) / 2
          const p = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.4))
          c.out.geometries.push(p.geometry)
          p.position.set(x + Math.sin(a) * 1.25, 2.3, z + Math.cos(a) * 1.25)
          p.rotation.y = a
          c.out.group.add(p)
          c.out.holo.push(p)
        }
        const pt = new THREE.PointLight(0x29e3ff, 18, 12, 1.8)
        pt.position.set(x, 3.2, z)
        c.out.lights.push({ light: pt, priority: 1 })
        break
      }
      case 'meeting-table':
        b.box(w, 0.05, d, mats.stone(), x, 0.74, z, yaw)
        b.box(0.3, 0.72, d * 0.8, mats.carbon(), x, 0.36, z, yaw)
        break
      case 'console':
        b.box(w, 1.1, d, mats.paintedSteel(), x, 0.55, z, yaw)
        b.box(w - 0.2, 0.6, 0.04, emissive(c, PALETTE.cyan, 1.8), x, 1.5, z + d / 2 - 0.1, yaw, 0.2)
        break
      case 'core-rack':
        b.box(w, 2.2, d, mats.graphitePanel(), x, 1.1, z, yaw)
        for (let i = 0; i < 6; i++)
          b.box(
            0.02,
            0.03,
            d * 0.8,
            emissive(c, i % 3 ? PALETTE.cyan : PALETTE.acid, 2),
            x - Math.sign(x) * (w / 2 + 0.01),
            0.4 + i * 0.3,
            z,
            yaw,
          )
        break
      default:
        b.box(w, 0.8, d, mats.paintedSteel(), x, 0.4, z, yaw)
    }
  }
  // Chairs at every sitting anchor except lounges (they sit on the sofas).
  for (const a of Object.values(anchors)) {
    if (a.pose !== 'sit') continue
    const m = new THREE.Matrix4().makeRotationY(a.heading).setPosition(a.x, 0, a.z)
    chairs.push(m)
  }
  if (chairs.length) {
    const seat = new THREE.BoxGeometry(0.5, 0.08, 0.5).translate(0, 0.46, 0)
    const backrest = new THREE.BoxGeometry(0.5, 0.55, 0.06).translate(0, 0.78, -0.24)
    const post = new THREE.CylinderGeometry(0.04, 0.04, 0.42, 6).translate(0, 0.21, 0)
    const g = mergeGeometries([seat.toNonIndexed(), backrest.toNonIndexed(), post.toNonIndexed()])!
    for (const x of [seat, backrest, post]) x.dispose()
    c.out.geometries.push(g)
    const im = new THREE.InstancedMesh(g, mats.graphitePanel(), chairs.length)
    chairs.forEach((m, i) => im.setMatrixAt(i, m))
    im.castShadow = true
    im.name = 'ph:chairs'
    c.out.group.add(im)
  }
}

function bonsai(c: Ctx, x: number, z: number): void {
  const { b, mats } = c
  // A leaning, twisting trunk of cylinder segments and flat-shaded canopy pads.
  let px = x
  let py = 0.7
  let pz = z
  for (let i = 0; i < 5; i++) {
    const len = 0.55 - i * 0.05
    const lean = 0.35 * Math.sin(i * 1.3 + 0.4)
    const seg = new THREE.CylinderGeometry(0.11 - i * 0.015, 0.14 - i * 0.015, len, 7)
    b.add(seg, mats.bark(), px + Math.sin(lean) * len * 0.5, py + len / 2, pz, 0, 0, -lean)
    seg.dispose()
    px += Math.sin(lean) * len
    py += Math.cos(lean) * len * 0.95
  }
  const pads: [number, number, number, number][] = [
    [px, py + 0.1, pz, 0.62],
    [px - 0.7, py - 0.35, pz + 0.3, 0.48],
    [px + 0.55, py - 0.55, pz - 0.35, 0.42],
    [px - 0.2, py + 0.45, pz - 0.3, 0.36],
  ]
  for (const [qx, qy, qz, r] of pads) {
    const g = new THREE.IcosahedronGeometry(r, 0)
    g.scale(1.5, 0.55, 1.2)
    b.add(g, mats.foliage(), qx, qy, qz, qx * 0.7)
    g.dispose()
  }
}

function decorAtrium(c: Ctx, d: FixtureDecor): void {
  const { b, mats } = c
  // The giant suspended display: frame, screen (holo), cables and an emissive lower edge.
  const s = d.screen
  b.box(
    0.35,
    s.h + 0.5,
    s.w + 0.5,
    mats.paintedSteel(),
    s.x + Math.sin(s.yaw) * -0.2,
    s.y,
    s.z + Math.cos(s.yaw) * -0.2,
    s.yaw + Math.PI / 2,
  )
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(s.w, s.h))
  c.out.geometries.push(screen.geometry)
  screen.position.set(s.x, s.y, s.z)
  screen.rotation.y = s.yaw
  c.out.group.add(screen)
  c.out.holo.push(screen)
  // A dimmer back face so the screen reads from behind too.
  const back = new THREE.Mesh(new THREE.PlaneGeometry(s.w, s.h))
  c.out.geometries.push(back.geometry)
  back.position.set(s.x - Math.sin(s.yaw) * 0.4, s.y, s.z - Math.cos(s.yaw) * 0.4)
  back.rotation.y = s.yaw + Math.PI
  c.out.group.add(back)
  c.out.holo.push(back)
  for (const t of [-0.45, 0.45]) {
    const cx = s.x + Math.cos(s.yaw) * s.w * t
    const cz = s.z - Math.sin(s.yaw) * s.w * t
    const top = c.height - (s.y + s.h / 2)
    b.box(0.03, top, 0.03, mats.brushedMetal(), cx, s.y + s.h / 2 + top / 2, cz)
  }
  b.box(
    0.06,
    0.08,
    s.w,
    emissive(c, PALETTE.magenta, 2.6),
    s.x + Math.sin(s.yaw) * 0.1,
    s.y - s.h / 2 - 0.3,
    s.z,
    s.yaw + Math.PI / 2,
  )
  const glow = new THREE.PointLight(0xff2bd6, 22, 18, 1.6)
  glow.position.set(s.x + Math.sin(s.yaw) * 3, s.y - 2, s.z)
  c.out.lights.push({ light: glow, priority: 2 })
  // Skybridges: deck, glass rails, steel top rails and an underside light strip.
  d.bridges.forEach((br, i) => {
    const len = Math.hypot(br.b.x - br.a.x, br.b.z - br.a.z)
    const cx = (br.a.x + br.b.x) / 2
    const cz = (br.a.z + br.b.z) / 2
    const yaw = Math.atan2(br.b.x - br.a.x, br.b.z - br.a.z)
    b.box(br.w, 0.35, len, mats.paintedSteel(), cx, br.y, cz, yaw)
    for (const side of [-1, 1]) {
      const ox = Math.cos(yaw) * side * (br.w / 2)
      const oz = -Math.sin(yaw) * side * (br.w / 2)
      b.box(0.04, 1.05, len, mats.frosted(), cx + ox, br.y + 0.7, cz + oz, yaw)
      b.box(0.06, 0.06, len, mats.brushedMetal(), cx + ox, br.y + 1.25, cz + oz, yaw)
      b.box(
        0.05,
        0.04,
        len,
        emissive(c, i ? PALETTE.amber : PALETTE.cyan, 2.6),
        cx + ox * 0.9,
        br.y - 0.2,
        cz + oz * 0.9,
        yaw,
      )
    }
  })
  for (const st of d.strips) {
    const len = Math.hypot(st.b.x - st.a.x, st.b.z - st.a.z)
    const yaw = Math.atan2(st.b.x - st.a.x, st.b.z - st.a.z)
    b.box(
      0.08,
      0.012,
      len,
      emissive(c, st.color === 'cyan' ? PALETTE.cyan : PALETTE.amber, 2.4),
      (st.a.x + st.b.x) / 2,
      0.006,
      (st.a.z + st.b.z) / 2,
      yaw,
    )
  }
  const recep = new THREE.PointLight(0x29e3ff, 10, 10, 1.8)
  recep.position.set(-8, 3, -7)
  c.out.lights.push({ light: recep, priority: 3 })
  // Shafts: the curtain wall (slanted moonlight) and under the screen's top.
  for (const z of [-9, -3, 3, 9])
    c.out.shafts.push({
      top: new THREE.Vector3(19.5, 13, z),
      length: 15,
      width: 4,
      yaw: Math.PI / 2,
      tilt: 0.55,
      color: 0x5fa8ff,
    })
}

function ceiling(
  c: Ctx,
  module: string,
  d: FixtureDecor | null,
  bounds: SpecialModuleDef['bounds'],
): void {
  const { b, mats } = c
  const w = bounds.maxX - bounds.minX
  const dd = bounds.maxZ - bounds.minZ
  const cx = (bounds.minX + bounds.maxX) / 2
  const cz = (bounds.minZ + bounds.maxZ) / 2
  const plane = new THREE.PlaneGeometry(w, dd)
  b.add(plane, mats.graphitePanel(), cx, c.height, cz, 0, Math.PI / 2)
  plane.dispose()
  // Coffers: beams every 4 m both ways.
  for (let x = bounds.minX + 4; x < bounds.maxX; x += 4)
    b.box(0.25, 0.5, dd, mats.paintedSteel(), x, c.height - 0.25, cz)
  for (let z = bounds.minZ + 4; z < bounds.maxZ; z += 4)
    b.box(w, 0.5, 0.25, mats.paintedSteel(), cx, c.height - 0.25, z)
  for (const f of d?.ceiling ?? []) {
    if (f.module !== module) continue
    b.box(f.w, 0.06, f.d, emissive(c, PALETTE.cyan, 2.2), f.at.x, f.y, f.at.z)
    if (module === 'command')
      c.out.shafts.push({
        top: new THREE.Vector3(f.at.x, f.y, f.at.z),
        length: 6.5,
        width: 1.6,
        yaw: 0,
        color: 0x29e3ff,
      })
  }
}

/** Builds a module's placeholder group in module-local coordinates. */
export function buildPlaceholder(
  module: string,
  def: SpecialModuleDef,
  mats: MaterialLibrary,
  rainGlass: THREE.ShaderMaterial,
  decor: FixtureDecor | null,
): PlaceholderModule {
  const out: PlaceholderModule = {
    group: new THREE.Group(),
    floors: [],
    holo: [],
    rainGlass: [],
    monitors: null,
    leds: null,
    lights: [],
    shafts: [],
    neon: [],
    probe: new THREE.Vector3(),
    geometries: [],
  }
  out.group.name = `placeholder:${module}`
  const b = new Batcher()
  const bloom = new Set<THREE.Material>()
  const c: Ctx = { b, mats, bloom, out, height: def.height ?? 3.2 }
  const bd = def.bounds
  const cx = (bd.minX + bd.maxX) / 2
  const cz = (bd.minZ + bd.maxZ) / 2
  out.probe.set(cx, 1.8, cz)
  // The wet floor (its own mesh: the probe toggles its material's visibility while capturing).
  const floorMat = mats.wetFloor(module, Math.round((bd.maxX - bd.minX) / 6))
  out.floors.push(floorMat)
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(bd.maxX - bd.minX, bd.maxZ - bd.minZ),
    floorMat,
  )
  out.geometries.push(floor.geometry)
  floor.rotation.x = -Math.PI / 2
  floor.position.set(cx, 0, cz)
  floor.receiveShadow = true
  floor.name = `floor:${module}`
  out.group.add(floor)
  // Polished stone inlays.
  for (let z = bd.minZ + 3; z < bd.maxZ; z += 6)
    b.box(bd.maxX - bd.minX - 1, 0.01, 0.4, mats.stone(), cx, 0.005, z)
  if (def.plan) {
    walls(c, def.plan.walls, rainGlass)
    furniture(c, def.plan.furniture, decor, def.anchors)
  }
  ceiling(c, module, decor, bd)
  if (module === 'hq-atrium' && decor) decorAtrium(c, decor)
  if (module === 'command') {
    const ring = new THREE.CylinderGeometry(3.4, 3.4, 0.12, 40)
    b.add(ring, mats.stone(), 0, 0.06, 0)
    ring.dispose()
    const edge = new THREE.TorusGeometry(3.4, 0.03, 6, 64)
    b.add(edge, emissive(c, PALETTE.cyan, 2.4), 0, 0.12, 0, 0, Math.PI / 2)
    edge.dispose()
    const booth = new THREE.PointLight(0xffb02e, 8, 9, 1.8)
    booth.position.set(0, 3, 12)
    out.lights.push({ light: booth, priority: 2 })
    const meet = new THREE.PointLight(0xff2bd6, 8, 10, 1.8)
    meet.position.set(-24.5, 3, 0)
    out.lights.push({ light: meet, priority: 3 })
  }
  for (const n of decor?.neon ?? [])
    if (n.module === module)
      out.neon.push({
        text: n.text,
        color: n.color,
        pos: new THREE.Vector3(n.at.x, n.y, n.at.z),
        yaw: n.yaw,
      })
  b.build(out.group, out.geometries, bloom)
  // Monitors: one per workstation screen, facing the seat (status colour per instance).
  const screens = Object.entries(def.anchors).filter(([, a]) => a.screen)
  if (screens.length) {
    const g = new THREE.PlaneGeometry(0.62, 0.36)
    out.geometries.push(g)
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff })
    mat.name = 'special:monitor'
    const im = new THREE.InstancedMesh(g, mat, screens.length)
    const index = new Map<string, number>()
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    screens.forEach(([, a], i) => {
      const fx = Math.sin(a.heading)
      const fz = Math.cos(a.heading)
      q.setFromAxisAngle(UP, a.heading + Math.PI)
      m.compose(
        new THREE.Vector3(a.x + fx * 0.62, 1.06, a.z + fz * 0.62),
        q,
        new THREE.Vector3(1, 1, 1),
      )
      im.setMatrixAt(i, m)
      im.setColorAt(i, new THREE.Color(0x0a1a24))
      index.set(a.screen!, i)
    })
    im.name = 'ph:monitors'
    markBloom(im)
    out.group.add(im)
    out.monitors = { mesh: im, index }
  }
  const leds = Object.entries(def.anchors).filter(([, a]) => a.led)
  if (leds.length) {
    const g = new THREE.BoxGeometry(0.5, 0.06, 0.06)
    out.geometries.push(g)
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff })
    mat.name = 'special:booth-led'
    const im = new THREE.InstancedMesh(g, mat, leds.length)
    const index = new Map<string, number>()
    leds.forEach(([, a], i) => {
      im.setMatrixAt(i, new THREE.Matrix4().makeTranslation(a.x, 2.45, a.approach.z + 0.15))
      im.setColorAt(i, new THREE.Color(0x203038))
      index.set(a.led!, i)
    })
    im.name = 'ph:booth-leds'
    markBloom(im)
    out.group.add(im)
    out.leds = { mesh: im, index }
  }
  return out
}
