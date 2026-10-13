// Asset validation (docs/graphics-contract.md §9). Two parts:
//  1. The validator itself, against a tiny generated fixture (always runs, no Blender needed).
//  2. The real assets in packages/web/public/assets — CI fails when they are missing or off-contract.
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Document, Logger, type Node } from '@gltf-transform/core'
import { EXTMeshGPUInstancing, KHRTextureBasisu } from '@gltf-transform/extensions'
import { meshopt } from '@gltf-transform/functions'
import { MeshoptEncoder } from 'meshoptimizer'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BONES,
  checkLightmapTiers,
  checkTextures,
  checkTotal,
  checkVram,
  estimateVram,
  ssim,
  textureBytes,
  TOTAL_MAX_BYTES,
  VRAM_MAX_BYTES,
  type TextureInfo,
  CHARACTER_MATERIALS,
  CLIPS,
  checkAnchor,
  checkAnchorCounts,
  checkBudget,
  checkBuildingNav,
  checkCapacity,
  checkCharacterGlb,
  checkCharacterMeta,
  checkManifest,
  checkModuleGlb,
  checkNav,
  checkPlan,
  checkPlans,
  checkPlanWallSides,
  createIO,
  glbStats,
  isSafeRef,
  MB,
  THEMES,
  validateAssets,
  type AnchorJson,
  type Manifest,
  type ModuleKind,
  type NavJson,
  type PlanJson,
  type Vec2,
} from './validate.ts'
import {
  checkSpecialAnchorCounts,
  checkSpecialManifest,
  checkSpecialRoles,
  checkSpecialSetNav,
  SPECIAL_BUDGETS,
  SPECIAL_TOTAL_MAX_BYTES,
  type SpecialManifest,
} from './validate.ts'

const REAL_ASSETS = resolve(import.meta.dirname, '../packages/web/public/assets')
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
const clone = <T>(v: T): T => structuredClone(v)
const HASH = '0123456789ab'

/** A size×size grey PNG (lightmap tiers). */
const pngCache = new Map<number, Promise<Buffer>>()
const png = (size: number) => {
  let p = pngCache.get(size)
  if (!p) {
    p = sharp({ create: { width: size, height: size, channels: 3, background: '#808080' } })
      .png()
      .toBuffer()
    pngCache.set(size, p)
  }
  return p
}
const tiersFor = (base: string) => ({
  full: `${base}.lightmap.full.png`,
  half: `${base}.lightmap.half.png`,
  quarter: `${base}.lightmap.quarter.png`,
})

// ── Fixture: a minimal but contract-complete asset set ──────────────────────────────────────────
type Spec = [id: string, extra?: Partial<AnchorJson>]
const range = (n: number, from = 0) => Array.from({ length: n }, (_, i) => i + from)

function anchorsFor(kind: ModuleKind): Record<string, AnchorJson> {
  const specs: Spec[] =
    kind === 'wing'
      ? [
          ...range(6, 1).flatMap((p) =>
            range(4).map((i): Spec => [
              `seat:desk:${p}:${i}`,
              { room: `pod-${p}`, screen: `desk:${p}:${i}` },
            ]),
          ),
          ...['A', 'B'].flatMap((r) =>
            range(6).map((i): Spec => [`seat:meeting:${r}:${i}`, { room: `meeting-${r}` }]),
          ),
          ...range(4).map((i): Spec => [
            `spot:booth:${i}`,
            { pose: 'stand', led: `booth:${i}`, room: `booth-${i}` },
          ]),
          ...range(6).map((i): Spec => [`spot:kitchen:${i}`, { pose: 'stand' }]),
          ...range(8).map((i): Spec => [`seat:lounge:${i}`, { pose: 'lounge' }]),
          // Capability rooms (contract §4): Adapters stations, Library reading seats and shelf spots.
          ...range(8).map((i): Spec => [
            `spot:station:${i}`,
            { pose: 'stand', room: 'adapters' },
          ]),
          ...range(4).map((i): Spec => [`seat:reading:${i}`, { room: 'library' }]),
          ...range(2).map((i): Spec => [`spot:shelf:${i}`, { pose: 'stand', room: 'library' }]),
        ]
      : kind === 'atrium'
        ? [
            ...range(4).map((i): Spec => [`spot:reception:${i}`, { pose: 'stand' }]),
            ...range(6).map((i): Spec => [`spot:elevator:${i}`, { pose: 'stand' }]),
            ...range(24).map((i): Spec => [`seat:cafe:${i}`]),
            ...['0:A', '0:B', '1:A', '1:B'].map((t): Spec => [
              `spot:pingpong:${t}`,
              { pose: 'stand' },
            ]),
            // Project spaces (contract §4): directory kiosk, context consoles, handoff pad spots.
            ['kiosk:project-directory', { pose: 'stand', room: 'hub' }],
            ...range(6).map((i): Spec => [`console:context:${i}`, { pose: 'stand', room: 'hub' }]),
            ...range(2).map((i): Spec => [`spot:handoff:${i}`, { pose: 'stand', room: 'plaza' }]),
          ]
        : kind === 'garden'
          ? range(6).map((i): Spec => [`spot:garden:${i}`, { pose: 'stand' }])
          : []
  // Spread anchors on a grid inside the module, facing +z, approach 0.6 m in front.
  const sign = kind === 'atrium' ? -1 : 1
  const placed = Object.fromEntries(
    specs.map(([id, extra], i) => {
      const x = (kind === 'atrium' ? -10 : 2) + (i % 8) * 1.2
      const z = sign * (2 + Math.floor(i / 8) * 1.5)
      return [id, { x, y: 0, z, heading: 0, pose: 'sit', approach: { x, z: z + 0.6 }, ...extra }]
    }),
  )
  return kind === 'wing'
    ? { ...placed, ...portsFor() }
    : kind === 'atrium'
      ? { ...placed, ...archivePorts() }
      : placed
}

/** Link attach points (contract §4 `port` kind): 3D points, y ≠ 0, no heading/pose/approach. */
function portsFor(): Record<string, AnchorJson> {
  const port = (x: number, y: number, z: number) => ({ x, y, z }) as unknown as AnchorJson
  return Object.fromEntries([
    ...range(6, 1).flatMap((p) => range(4).map((i) => [`port:desk:${p}:${i}`, port(2 + i, 1.25, p)])),
    ...range(8).map((i) => [`port:station:${i}`, port(25 + (i % 4), 2.3, -8 + Math.floor(i / 4) * 6)]),
    ...range(24).map((i) => [`port:book:${i}`, port(29.6, 0.5 + (i % 6) * 0.35, 1 + Math.floor(i / 6))]),
    ...range(6).map((i) => [`port:board:${i}`, port(24.5 + i * 0.9, 1.6, 8.9)]),
    ...range(8).map((i) => [`port:notebook:${i}`, port(25 + i * 0.3, 1.1, 8.8)]),
  ])
}

/** Session Archive ports (contract §4): 12 alcove volumes in the atrium. */
function archivePorts(): Record<string, AnchorJson> {
  return Object.fromEntries(
    range(12).map((i) => [`port:archive:${i}`, { x: -8 + i * 0.5, y: 1.2, z: -22 } as unknown as AnchorJson]),
  )
}

/** A star graph: a hub at the first connector, one `ap:<id>` node per approach, other connectors. */
function navFor(kind: ModuleKind, anchors: Record<string, AnchorJson>): NavJson {
  const connectors: Record<ModuleKind, Vec2[]> = {
    atrium: [{ x: 0, z: 0 }],
    street: [
      { x: 0, z: 9 },
      { x: 0, z: 0 },
      { x: 3, z: 9 },
      { x: -3, z: 9 },
      { x: 0, z: 18 },
    ],
    wing: [{ x: 0, z: 0 }],
    garden: [{ x: 0, z: 0 }],
    cap: [{ x: 0, z: 0 }],
  }
  const nodes: NavJson['nodes'] = {}
  const edges: NavJson['edges'] = []
  connectors[kind].forEach((c, i) => {
    nodes[`c${i}`] = { ...c, width: 1.5 }
    if (i) edges.push(['c0', `c${i}`])
  })
  for (const [id, a] of Object.entries(anchors)) {
    if (!a.approach) continue // ports are link attach points, not walk targets
    nodes[`ap:${id}`] = { ...a.approach, width: 0.6 }
    edges.push(['c0', `ap:${id}`])
  }
  return { nodes, edges }
}

const BOUNDS: Record<ModuleKind, Manifest['modules']['atrium']['bounds']> = {
  atrium: { minX: -33, maxX: 33, minZ: -24, maxZ: 0 },
  street: { minX: -3, maxX: 3, minZ: 0, maxZ: 18 },
  wing: { minX: 0, maxX: 30, minZ: -9, maxZ: 9 },
  garden: { minX: 0, maxX: 30, minZ: -9, maxZ: 9 },
  cap: { minX: -33, maxX: 33, minZ: 0, maxZ: 0.5 },
}

function moduleJson(kind: ModuleKind) {
  const anchors = anchorsFor(kind)
  return {
    lightmap: { file: `${kind}.lightmap.full.png`, intensity: 3, variants: tiersFor(kind) },
    bounds: BOUNDS[kind],
    anchors,
    nav: navFor(kind, anchors),
  }
}

function fixtureManifest(): Manifest {
  const wing = moduleJson('wing')
  return {
    version: 1,
    blender: '5.2.2',
    units: 'm',
    hash: 'fixture',
    hdri: 'hdri/office.hdr',
    modules: {
      atrium: { file: 'atrium.glb', ...moduleJson('atrium') },
      street: { file: 'street.glb', ...moduleJson('street') },
      garden: { file: 'garden.glb', ...moduleJson('garden') },
      cap: { file: 'cap.glb', ...moduleJson('cap') },
      wing: {
        themes: Object.fromEntries(
          THEMES.map((t) => [
            t,
            {
              file: `wing-${t}.glb`,
              lightmap: {
                file: `wing-${t}.lightmap.full.png`,
                intensity: 2.8,
                variants: tiersFor(`wing-${t}`),
              },
              signColor: '#F4EDE4',
              accent: '#D97757',
            },
          ]),
        ),
        capacity: { desk: 24, meeting: 2, meetingSeats: 6, booth: 4, kitchen: 6, lounge: 8 },
        bounds: wing.bounds,
        anchors: wing.anchors,
        nav: wing.nav,
      },
    },
    character: { file: 'character.glb', meta: 'character.json' },
  }
}

function characterMeta() {
  return {
    height: 1.75,
    seatHeight: 0.47,
    loungeSeatHeight: 0.42,
    clips: Object.fromEntries(
      CLIPS.map((c) => [
        c,
        c === 'Walk'
          ? { duration: 1.0667, loop: true, speed: 1.4, footPlants: [0, 0.5] }
          : {
              duration: 1,
              loop: !['SitDown', 'StandUp', 'Wave', 'TurnL90', 'TurnR90', 'ElevatorIn'].includes(c),
            },
      ]),
    ),
  }
}

function quadDoc(name: string) {
  const doc = new Document()
  doc.setLogger(new Logger(Logger.Verbosity.SILENT))
  const buf = doc.createBuffer()
  const quad = (uv1: boolean) => {
    const prim = doc
      .createPrimitive()
      .setAttribute(
        'POSITION',
        doc
          .createAccessor()
          .setType('VEC3')
          .setBuffer(buf)
          .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1])),
      )
      .setIndices(
        doc
          .createAccessor()
          .setType('SCALAR')
          .setBuffer(buf)
          .setArray(new Uint16Array([0, 2, 1, 1, 2, 3])),
      )
    // UV0 for materials, UV1 for the lightmap (contract §6).
    if (uv1) {
      for (const set of ['TEXCOORD_0', 'TEXCOORD_1'])
        prim.setAttribute(
          set,
          doc
            .createAccessor()
            .setType('VEC2')
            .setBuffer(buf)
            .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1])),
        )
      // Wall ids (contract §13): vertices 2 and 3 belong to plan wall 1.
      prim.setAttribute(
        '_WALLID',
        doc
          .createAccessor()
          .setType('SCALAR')
          .setBuffer(buf)
          .setArray(new Float32Array([0, 0, 1, 1])),
      )
    }
    return doc.createMesh(name).addPrimitive(prim)
  }
  const scene = doc.createScene(name)
  doc.getRoot().setDefaultScene(scene)
  return { doc, buf, scene, quad }
}

/** The floor's base colour: a PNG with extras.hash (contract §6b); `ktx2` or `noHash` break it. */
interface FloorTexture {
  bytes: Uint8Array
  noHash?: boolean
  ktx2?: boolean
}

function moduleDoc(kind: ModuleKind, anchors: Record<string, AnchorJson>, tex?: FloorTexture) {
  const { doc, scene, quad } = quadDoc(kind)
  const floor = quad(true)
  if (tex) {
    const t = doc
      .createTexture('floor')
      .setImage(tex.bytes)
      .setMimeType(tex.ktx2 ? 'image/ktx2' : 'image/png')
    if (!tex.noHash) t.setExtras({ hash: HASH })
    if (tex.ktx2) doc.createExtension(KHRTextureBasisu).setRequired(true)
    floor.listPrimitives()[0]!.setMaterial(doc.createMaterial('floor').setBaseColorTexture(t))
  }
  scene.addChild(doc.createNode('floor').setMesh(floor).setExtras({ role: 'baked' }))
  const panel = quad(false)
  for (const a of Object.values(anchors)) {
    if (a.screen)
      scene.addChild(
        doc
          .createNode(`screen-${a.screen}`)
          .setMesh(panel)
          .setExtras({ role: 'screen', ref: a.screen }),
      )
    if (a.led)
      scene.addChild(
        doc.createNode(`led-${a.led}`).setMesh(panel).setExtras({ role: 'led', ref: a.led }),
      )
  }
  if (kind === 'wing')
    scene.addChild(doc.createNode('sign').setMesh(panel).setExtras({ role: 'sign', ref: 'wing' }))
  return doc
}

function characterDoc(clips: readonly string[] = CLIPS) {
  const { doc, buf, scene, quad } = quadDoc('character')
  const bones = new Map<string, Node>()
  const root = doc.createNode('root')
  bones.set('root', root)
  for (const b of BONES.slice(1)) {
    const n = doc.createNode(b)
    bones.set(b, n)
    root.addChild(n)
  }
  const ibm = new Float32Array(16 * BONES.length)
  for (let i = 0; i < BONES.length; i++)
    ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], i * 16)
  const skin = doc
    .createSkin('rig')
    .setSkeleton(root)
    .setInverseBindMatrices(doc.createAccessor().setType('MAT4').setBuffer(buf).setArray(ibm))
  for (const b of BONES) skin.addJoint(bones.get(b)!)
  const mesh = doc.createMesh('body')
  for (const name of CHARACTER_MATERIALS) {
    const prim = doc
      .createPrimitive()
      .setMaterial(doc.createMaterial(name))
      .setAttribute(
        'POSITION',
        doc
          .createAccessor()
          .setType('VEC3')
          .setBuffer(buf)
          .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])),
      )
      .setAttribute(
        'JOINTS_0',
        doc.createAccessor().setType('VEC4').setBuffer(buf).setArray(new Uint8Array(12)),
      )
      .setAttribute(
        'WEIGHTS_0',
        doc
          .createAccessor()
          .setType('VEC4')
          .setBuffer(buf)
          .setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])),
      )
    mesh.addPrimitive(prim)
  }
  scene.addChild(root)
  scene.addChild(doc.createNode('body').setMesh(mesh).setSkin(skin))
  // Hidden-by-default variants do not count toward the base budget.
  root.addChild(doc.createNode('hairA').setMesh(quad(false)).setExtras({ accessory: 'hairA' }))
  bones
    .get('prop.R')!
    .addChild(doc.createNode('cup').setMesh(quad(false)).setExtras({ prop: 'cup' }))
  for (const c of clips) {
    const sampler = doc
      .createAnimationSampler()
      .setInput(
        doc
          .createAccessor()
          .setType('SCALAR')
          .setBuffer(buf)
          .setArray(new Float32Array([0, 1])),
      )
      .setOutput(
        doc
          .createAccessor()
          .setType('VEC3')
          .setBuffer(buf)
          .setArray(new Float32Array([0, 0.9, 0, 0, 0.9, 0])),
      )
    const channel = doc
      .createAnimationChannel()
      .setTargetNode(bones.get('hips')!)
      .setTargetPath('translation')
      .setSampler(sampler)
    doc.createAnimation(c).addSampler(sampler).addChannel(channel)
  }
  return doc
}

async function writeTiers(dir: string, base: string) {
  const refs = tiersFor(base)
  await writeFile(join(dir, refs.full), await png(16))
  await writeFile(join(dir, refs.half), await png(8))
  await writeFile(join(dir, refs.quarter), await png(4))
}

/** Writes the full fixture (manifest, 10 glbs, lightmap tiers, HDRI, character.json) into `dir`. */
async function writeFixture(dir: string) {
  await MeshoptEncoder.ready
  const io = (await createIO()).registerDependencies({ 'meshopt.encoder': MeshoptEncoder })
  const m = fixtureManifest()
  const tex: FloorTexture = { bytes: PNG_1PX }
  await mkdir(join(dir, 'hdri'), { recursive: true })
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(m))
  await writeFile(join(dir, m.hdri), '#?RADIANCE\n')
  await writeFile(join(dir, m.character.meta), JSON.stringify(characterMeta()))
  await writeFile(join(dir, m.character.file), await io.writeBinary(characterDoc()))
  for (const kind of ['atrium', 'street', 'garden', 'cap'] as const) {
    const mod = m.modules[kind]
    await writeFile(join(dir, mod.file), await io.writeBinary(moduleDoc(kind, mod.anchors, tex)))
    await writeTiers(dir, kind)
  }
  for (const t of THEMES) {
    const doc = moduleDoc('wing', m.modules.wing.anchors, tex)
    // One theme goes through EXT_meshopt_compression, like the real gltf-transform step.
    if (t === 'terracotta')
      await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }))
    const th = m.modules.wing.themes[t]!
    await writeFile(join(dir, th.file), await io.writeBinary(doc))
    await writeTiers(dir, `wing-${t}`)
  }
  return m
}

// ── 1. Validator logic ──────────────────────────────────────────────────────────────────────────
describe('asset validator: manifest shape', () => {
  it('accepts the fixture manifest', () => {
    expect(checkManifest(fixtureManifest())).toEqual([])
  })

  it('names the offending path for a bad version, unknown pose, missing theme or bad color', () => {
    const m = clone(fixtureManifest()) as unknown as Record<string, any>
    m.version = 2
    m.modules.wing.anchors['seat:desk:1:0'].pose = 'dance'
    delete m.modules.wing.themes.brass
    m.modules.wing.themes.neon.accent = 'purple'
    m.modules.atrium.anchors['spot:reception:0'].y = 0.4
    const errs = checkManifest(m)
    expect(errs).toContain('manifest.version: expected 1, got 2')
    expect(errs).toContain(
      'manifest.modules.wing.anchors["seat:desk:1:0"].pose: unknown pose "dance"',
    )
    expect(errs).toContain('manifest.modules.wing.themes.brass: missing theme')
    expect(errs).toContain('manifest.modules.wing.themes.neon.accent: must be #RRGGBB')
    expect(errs).toContain(
      'manifest.modules.atrium.anchors["spot:reception:0"].y: anchors sit on the floor (y = 0)',
    )
  })

  it('rejects file references that leave the assets dir, and non-objects', () => {
    expect(isSafeRef('wing-ocean.glb', /\.glb$/)).toBe(true)
    expect(isSafeRef('hdri/office.hdr')).toBe(true)
    for (const bad of ['../secret.glb', '/etc/x.glb', 'a\\b.glb', 'x.png', ''])
      expect(isSafeRef(bad, /\.glb$/), bad).toBe(false)
    const m = clone(fixtureManifest()) as unknown as Record<string, any>
    m.modules.street.file = '../../package.json'
    expect(checkManifest(m)).toContain('manifest.modules.street.file: must be a relative .glb path')
    expect(checkManifest(null)).toEqual(['manifest: must be a JSON object'])
    expect(checkManifest({ version: 1 })).toContain('manifest.modules: missing')
  })
})

describe('asset validator: capability rooms (Adapters + Library)', () => {
  it('requires stations, reading seats, shelf spots and every link port in a wing', () => {
    const wing = anchorsFor('wing')
    expect(checkAnchorCounts('wing', wing)).toEqual([])
    delete wing['spot:station:3']
    delete wing['seat:reading:0']
    delete wing['port:book:5']
    delete wing['port:desk:2:1']
    const errs = checkAnchorCounts('wing', wing)
    expect(errs).toContain('wing: expected 8 "spot:station:*" anchors, found 7')
    expect(errs).toContain('wing: expected 4 "seat:reading:*" anchors, found 3')
    expect(errs).toContain('wing: expected 24 "port:book:*" anchors, found 23')
    expect(errs).toContain('wing: expected 24 "port:desk:*" anchors, found 23')
  })

  it('accepts ports in mid-air without pose or approach, but needs numeric x, y, z', () => {
    expect(checkAnchor('p', 'port:station:0', { x: 25, y: 2.3, z: -8 })).toEqual([])
    expect(checkAnchor('p', 'port:book:7', { x: 25, z: 1 })).toEqual(['p["port:book:7"].y: not a number'])
  })

  it('keeps ports off the nav graph check', () => {
    const anchors = anchorsFor('wing')
    expect(checkNav('wing', navFor('wing', anchors), anchors)).toEqual([])
  })
})

describe('asset validator: anchors and capacity', () => {
  it('requires the contract §4 anchor counts per module', () => {
    for (const k of ['wing', 'atrium', 'garden'] as const)
      expect(checkAnchorCounts(k, anchorsFor(k))).toEqual([])
    const wing = anchorsFor('wing')
    delete wing['seat:desk:3:2']
    expect(checkAnchorCounts('wing', wing)).toEqual([
      'wing: expected 24 "seat:desk:*" anchors, found 23',
      'wing: expected 4 "seat:desk:3:*" anchors, found 3',
    ])
    const atrium = anchorsFor('atrium')
    delete atrium['spot:pingpong:1:B']
    atrium['spot:pingpong:2:A'] = atrium['spot:pingpong:1:A']!
    expect(checkAnchorCounts('atrium', atrium)).toContain(
      'atrium: expected 2 ping-pong tables with sides A and B (spot:pingpong:<t>:A|B)',
    )
  })

  it('requires the project-space anchors on the atrium (contract §4, additive)', () => {
    const atrium = anchorsFor('atrium')
    expect(Object.keys(atrium).filter((k) => /^(kiosk|console|port:archive|spot:handoff)/.test(k))).toHaveLength(21)
    delete atrium['kiosk:project-directory']
    delete atrium['console:context:5']
    delete atrium['port:archive:11']
    delete atrium['spot:handoff:1']
    expect(checkAnchorCounts('atrium', atrium)).toEqual([
      'atrium: expected 1 "kiosk:project-directory*" anchors, found 0',
      'atrium: expected 6 "console:context:*" anchors, found 5',
      'atrium: expected 2 "spot:handoff:*" anchors, found 1',
      'atrium: expected 12 "port:archive:*" anchors, found 11',
    ])
  })

  it('accepts the kiosk and console ids and rejects a malformed kiosk', () => {
    const a = { x: 1, y: 0, z: 2, heading: 0, pose: 'stand', approach: { x: 1, z: 2.6 } }
    expect(checkAnchor('p', 'kiosk:project-directory', a)).toEqual([])
    expect(checkAnchor('p', 'console:context:3', a)).toEqual([])
    expect(checkAnchor('p', 'kiosk:Project_Directory', a)[0]).toContain('id must match')
  })

  it('checks the declared wing capacity against the anchors', () => {
    const cap = { desk: 24, meeting: 2, meetingSeats: 6, booth: 4, kitchen: 6, lounge: 8 }
    expect(checkCapacity(cap, anchorsFor('wing'))).toEqual([])
    expect(checkCapacity({ ...cap, booth: 5 }, anchorsFor('wing'))).toEqual([
      'wing.capacity.booth: is 5, but the anchors give 4',
    ])
    expect(checkCapacity({ ...cap, meeting: 0, meetingSeats: 0 }, {})).toContain(
      'wing.capacity.desk: is 24, but the anchors give 0',
    )
  })
})

describe('asset validator: navigation', () => {
  it('accepts connected graphs with every approach on them', () => {
    for (const k of ['atrium', 'street', 'wing', 'garden', 'cap'] as const) {
      const a = anchorsFor(k)
      expect(checkNav(k, navFor(k, a), a), k).toEqual([])
    }
  })

  it('reports cut-off nodes, off-graph approaches, unknown edge ends and missing connectors', () => {
    const anchors = anchorsFor('garden')
    const nav = navFor('garden', anchors)
    nav.nodes.island = { x: 20, z: 8, width: 1 }
    nav.edges.push(['c0', 'ghost'])
    anchors['spot:garden:0']!.approach = { x: 23, z: -8 }
    delete nav.nodes['ap:spot:garden:0']
    nav.edges = nav.edges.filter(([, b]) => b !== 'ap:spot:garden:0')
    const errs = checkNav('garden', nav, anchors)
    expect(errs).toContain('garden.nav.edges[5]: unknown node "ghost"')
    expect(errs.some((e) => e.startsWith('garden.nav: graph is not connected'))).toBe(true)
    expect(errs).toContain(
      'garden.anchors["spot:garden:0"].approach: (23, -8) is not on the nav graph',
    )
    const moved = navFor('cap', {})
    moved.nodes.c0 = { x: 1, z: 0.2, width: 1 }
    expect(checkNav('cap', moved, {})).toContain('cap.nav: missing connector node at local (0, 0)')
    expect(checkNav('cap', { nodes: {}, edges: [] }, {})).toContain('cap.nav: has no nodes')
  })

  it('treats a point inside an edge corridor as on the graph', () => {
    const nav: NavJson = {
      nodes: { c0: { x: 0, z: 0, width: 1 }, c1: { x: 10, z: 0, width: 0.8 } },
      edges: [['c0', 'c1']],
    }
    const a = { x: 5, y: 0, z: 0.7, heading: 0, pose: 'stand', approach: { x: 5, z: 0.7 } }
    expect(checkNav('cap', nav, { 'spot:garden:0': a })).toEqual([])
    a.approach = { x: 5, z: 0.9 }
    expect(checkNav('cap', nav, { 'spot:garden:0': a })).toHaveLength(1)
  })

  it('joins the modules of a one-bay building into a single graph (contract §3 connectors)', () => {
    const m = fixtureManifest()
    expect(checkBuildingNav(m)).toEqual([])
    m.modules.street.nav.nodes.c3 = { x: -3.2, z: 9, width: 1.5 } // left door connector off by 20 cm
    expect(checkBuildingNav(m)[0]).toMatch(/do not join into one graph/)
  })
})

describe('asset validator: character', () => {
  it('requires every clip, Walk.speed and Walk.footPlants', () => {
    expect(checkCharacterMeta(characterMeta())).toEqual([])
    const meta = characterMeta() as any
    delete meta.clips.PingPong
    delete meta.clips.Walk.footPlants
    meta.clips.Walk.speed = 0
    meta.seatHeight = -1
    expect(checkCharacterMeta(meta)).toEqual([
      'character.json.seatHeight: must be > 0',
      'character.json.clips.PingPong: missing',
      'character.json.clips.Walk.speed: must be the authored ground speed (m/s) > 0',
      'character.json.clips.Walk.footPlants: must be a non-empty list of phases in [0, 1)',
    ])
    expect(checkCharacterMeta([])).toEqual(['character.json: must be a JSON object'])
  })

  it('checks clips, materials, bones, props and the base triangle budget in the glb', () => {
    const ok = glbStats(characterDoc())
    expect(checkCharacterGlb('character.glb', ok, characterMeta())).toEqual([])
    expect(ok.baseTriangles).toBe(CHARACTER_MATERIALS.length) // hair and cup excluded
    expect(ok.triangles).toBe(CHARACTER_MATERIALS.length + 4)
    const bad = glbStats(characterDoc(CLIPS.filter((c) => c !== 'ElevatorIn')))
    bad.props[0]!.parent = 'hand.R'
    bad.baseTriangles = 9000
    expect(checkCharacterGlb('character.glb', bad, characterMeta())).toEqual([
      'character.glb: missing animation clip "ElevatorIn"',
      'character.glb: character.json lists clip "ElevatorIn" that the glb lacks',
      'character.glb: prop "cup" must be parented to bone prop.R',
      'character.glb: base body has 9000 triangles (budget 8000, accessories hidden)',
    ])
  })
})

describe('asset validator: glb stats and budgets', () => {
  it('counts rendered triangles including GPU instances, strips and fans', () => {
    const { doc, scene, quad } = quadDoc('t')
    const mesh = quad(true)
    const inst = doc.createExtension(EXTMeshGPUInstancing).createInstancedMesh()
    inst.setAttribute(
      'TRANSLATION',
      doc
        .createAccessor()
        .setType('VEC3')
        .setArray(new Float32Array(30))
        .setBuffer(doc.getRoot().listBuffers()[0]!),
    )
    scene.addChild(
      doc.createNode('chairs').setMesh(mesh).setExtension('EXT_mesh_gpu_instancing', inst),
    )
    scene.addChild(doc.createNode('one').setMesh(mesh))
    const strip = quad(false)
    strip.listPrimitives()[0]!.setIndices(null).setMode(5)
    scene.addChild(doc.createNode('strip').setMesh(strip))
    const lines = quad(false)
    lines.listPrimitives()[0]!.setMode(1)
    scene.addChild(doc.createNode('lines').setMesh(lines))
    expect(glbStats(doc).triangles).toBe(2 * 10 + 2 + 2)
  })

  it('flags unknown roles, baked meshes without UV1, missing screens/leds and a missing sign', () => {
    const anchors = anchorsFor('wing')
    expect(checkModuleGlb('w.glb', 'wing', glbStats(moduleDoc('wing', anchors)), anchors)).toEqual(
      [],
    )
    const { doc, scene, quad } = quadDoc('w')
    scene.addChild(doc.createNode('floor').setMesh(quad(false)).setExtras({ role: 'baked' }))
    scene.addChild(doc.createNode('logo').setMesh(quad(false)).setExtras({ role: 'logo' }))
    const errs = checkModuleGlb('w.glb', 'wing', glbStats(doc), anchors)
    expect(errs).toContain('w.glb: unknown extras.role on node logo (logo)')
    expect(errs).toContain('w.glb: baked node "floor" has no TEXCOORD_1 (lightmap UV)')
    expect(errs).toContain(
      'w.glb: anchor seat:desk:1:0 names screen "desk:1:0", but no node has role screen with that ref',
    )
    expect(errs).toContain(
      'w.glb: anchor spot:booth:0 names led "booth:0", but no node has role led with that ref',
    )
    expect(errs).toContain('w.glb: wing has no node with role "sign"')
  })

  it('WALL-1: wing and atrium baked meshes carry an exact _WALLID within the plan walls (contract §13)', () => {
    const anchors = anchorsFor('wing')
    expect(checkModuleGlb('w.glb', 'wing', glbStats(moduleDoc('wing', anchors)), anchors, 1)).toEqual([])
    // A baked mesh without the attribute (UV1 present, so only the wall-id check fires).
    const bare = moduleDoc('wing', anchors)
    const floor = bare.getRoot().listMeshes().find((m) => m.getName() === 'wing')!
    floor.listPrimitives()[0]!.setAttribute('_WALLID', null)
    expect(checkModuleGlb('w.glb', 'wing', glbStats(bare), anchors)).toEqual([
      'w.glb: baked node "floor" has no _WALLID attribute (contract §13)',
    ])
    // Quantized or fractional ids, and ids past the end of plan.walls.
    const bad = moduleDoc('atrium', anchorsFor('atrium'))
    const prim = bad.getRoot().listMeshes()[0]!.listPrimitives()[0]!
    prim.getAttribute('_WALLID')!.setArray(new Float32Array([0, 0.5, 1, 3]))
    expect(checkModuleGlb('a.glb', 'atrium', glbStats(bad), anchorsFor('atrium'), 2)).toEqual([
      'a.glb: baked node "floor" has a non-integer _WALLID (0.5)',
      'a.glb: _WALLID 3 exceeds the 2 walls in the plan',
    ])
    // Other modules don't need wall ids.
    const street = moduleDoc('street', {})
    street.getRoot().listMeshes()[0]!.listPrimitives()[0]!.setAttribute('_WALLID', null)
    expect(checkModuleGlb('s.glb', 'street', glbStats(street), {})).toEqual([])
  })

  it('enforces size and triangle budgets', () => {
    expect(checkBudget('a.glb', 2 * MB, { maxBytes: 3 * MB, maxTriangles: 10 }, 10)).toEqual([])
    expect(checkBudget('a.glb', 4 * MB, { maxBytes: 3 * MB, maxTriangles: 10 }, 11)).toEqual([
      'a.glb: 4.00 MB exceeds the 3 MB budget',
      'a.glb: 11 triangles exceeds the 10 budget',
    ])
  })
})

describe('asset validator: GPU textures (hashes, lightmap tiers, memory)', () => {
  const ok: TextureInfo = { name: 'oak', mime: 'image/webp', hash: HASH, width: 1024, height: 1024 }

  it('AV-1: every glb texture has a 12-hex extras.hash; no KTX2 (the CSP blocks its transcoder)', () => {
    expect(checkTextures('w.glb', [ok], ['EXT_meshopt_compression'])).toEqual([])
    expect(
      checkTextures(
        'w.glb',
        [
          { ...ok, name: 'b', hash: undefined },
          { ...ok, name: 'c', hash: 'XYZ' },
          { ...ok, name: 'd', mime: 'image/ktx2' },
        ],
        ['KHR_texture_basisu'],
      ),
    ).toEqual([
      'w.glb: uses KHR_texture_basisu; the Basis transcoder needs eval, which the CSP forbids (contract §6b)',
      'w.glb: texture "b" has no extras.hash (12 hex chars of sha1 over its RGBA, contract §6b)',
      'w.glb: texture "c" has no extras.hash (12 hex chars of sha1 over its RGBA, contract §6b)',
      'w.glb: texture "d" is KTX2; the Basis transcoder needs eval, which the CSP forbids (contract §6b)',
    ])
  })

  it('AV-2: lightmap tiers are images at full, ½ and ¼ size', () => {
    const refs = tiersFor('m')
    const sq = (n: number): [number, number] => [n, n]
    expect(checkLightmapTiers(refs, { full: sq(16), half: sq(8), quarter: sq(4) })).toEqual([])
    expect(checkLightmapTiers(refs, { full: sq(16), half: sq(16), quarter: null })).toEqual([
      'm.lightmap.half.png: is 16×16, expected 8×8 (½ of m.lightmap.full.png)',
      'm.lightmap.quarter.png: is not a PNG or WebP image',
    ])
    // A missing file is reported by the loader, not here.
    expect(checkLightmapTiers(refs, { half: sq(3) })).toEqual([])
  })

  it('AV-2: the manifest lists the three image tiers for every lightmap', () => {
    const m = clone(fixtureManifest()) as unknown as Record<string, any>
    delete m.modules.garden.lightmap.variants
    m.modules.wing.themes.forest.lightmap.variants.half = 'wing-forest.lightmap.half.ktx2'
    const errs = checkManifest(m)
    expect(errs).toContain(
      'manifest.modules.garden.lightmap.variants: missing { full, half, quarter } size tiers (contract §6)',
    )
    expect(errs).toContain(
      'manifest.modules.wing.themes.forest.lightmap.variants.half: must be a relative .png or .webp path',
    )
    m.modules.street.lightmap.file = 'street.lightmap.full.webp'
    expect(checkManifest(m).filter((e) => e.includes('street'))).toEqual([])
  })

  it('AV-3: estimates GPU memory as RGBA8 × 4/3, deduped by hash, per lightmap tier', () => {
    expect(textureBytes(1024, 1024)).toBe((1024 * 1024 * 16) / 3)
    const e = estimateVram([
      { key: 'a', width: 1024, height: 1024 },
      { key: 'a', width: 1024, height: 1024 },
      { key: 'b', width: 512, height: 512 },
    ])
    expect(e).toEqual({ bytes: textureBytes(1024, 1024) + textureBytes(512, 512), unique: 2 })
    expect(VRAM_MAX_BYTES).toEqual({ full: 340 * MB, half: 150 * MB, quarter: 110 * MB })
    expect(checkVram(87 * MB, { full: 241 * MB, half: 60 * MB, quarter: 15 * MB })).toEqual([])
    expect(checkVram(100 * MB, { full: 241 * MB, half: 50 * MB, quarter: 15 * MB })).toEqual([
      'GPU texture memory estimate at the full lightmap tier 341 MB exceeds the 340 MB budget (all themes, RGBA8 × 4/3, deduped by extras.hash; contract §9)',
      'GPU texture memory estimate at the quarter lightmap tier 115 MB exceeds the 110 MB budget (all themes, RGBA8 × 4/3, deduped by extras.hash; contract §9)',
    ])
  })

  it('AV-4: the published assets stay within 55 MB', () => {
    expect(checkTotal(TOTAL_MAX_BYTES)).toEqual([])
    expect(checkTotal(56 * MB)).toEqual(['assets total 56.0 MB exceeds the 55 MB budget'])
  })

  it('AV-visual: SSIM is 1 for identical images and drops with noise', () => {
    const w = 32
    const a = new Uint8Array(w * w * 4).map((_, i) => (i % 4 === 3 ? 255 : ((i >> 2) % w) * 8))
    const b = a.map((v, i) => (i % 4 === 3 ? v : Math.max(0, Math.min(255, v + ((i * 37) % 61) - 30))))
    expect(ssim(a, a, w, w)).toBeCloseTo(1, 6)
    expect(ssim(a, b, w, w)).toBeLessThan(0.97)
    expect(() => ssim(a, a.subarray(4), w, w)).toThrow(/size/)
  })
})

describe('asset validator: a whole assets dir', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ao-assets-'))
    await writeFixture(dir)
  }, 30_000)
  afterAll(() => rm(dir, { recursive: true, force: true }))

  it('passes a contract-complete fixture (gltf-validator, meshopt, budgets, nav, clips)', async () => {
    const r = await validateAssets(dir)
    expect(r.problems).toEqual([])
    expect(r.files.map((f) => f.file)).toContain('wing-terracotta.glb')
    expect(r.files).toHaveLength(4 + THEMES.length + 1)
    expect(r.totalBytes).toBeGreaterThan(0)
    // Ten modules share one texture hash: it is counted once (AV-3).
    expect(r.vram.uniqueTextures).toBe(1)
    expect(r.vram.textures).toBeCloseTo(textureBytes(1, 1), 6)
    expect(r.vram.lightmaps.full).toBeCloseTo(10 * textureBytes(16, 16), 6)
    expect(r.vram.lightmaps.quarter).toBeCloseTo(10 * textureBytes(4, 4), 6)
  }, 30_000)

  it('reports missing files, Git LFS pointers, broken glbs and bad PNGs', async () => {
    const broken = await mkdtemp(join(tmpdir(), 'ao-assets-bad-'))
    try {
      const m = await writeFixture(broken)
      await rm(join(broken, 'cap.glb'))
      await writeFile(
        join(broken, 'street.glb'),
        'version https://git-lfs.github.com/spec/v1\noid sha256:00\n',
      )
      await writeFile(join(broken, 'garden.glb'), Buffer.from('glTF\x02\x00\x00\x00garbage'))
      const ocean = m.modules.wing.themes.ocean!.lightmap.variants!
      await writeFile(join(broken, ocean.half), 'not an image')
      await rm(join(broken, ocean.quarter))
      // AV-1: a module with a texture without extras.hash, one with KTX2 (blocked by the CSP).
      const io = await createIO()
      await writeFile(
        join(broken, 'atrium.glb'),
        await io.writeBinary(moduleDoc('atrium', m.modules.atrium.anchors, { bytes: PNG_1PX, noHash: true })),
      )
      await writeFile(
        join(broken, 'wing-neon.glb'),
        await io.writeBinary(moduleDoc('wing', m.modules.wing.anchors, { bytes: PNG_1PX, ktx2: true })),
      )
      // The street's quarter tier at the wrong size: AV-2.
      await writeFile(join(broken, m.modules.street.lightmap!.variants!.quarter), await png(8))
      await rm(join(broken, m.hdri))
      const meta = characterMeta() as any
      delete meta.clips.Walk.footPlants
      await writeFile(join(broken, 'character.json'), JSON.stringify(meta))
      const p = (await validateAssets(broken)).problems
      expect(p).toContain('cap.glb: referenced by manifest.json but missing')
      expect(p.some((e) => e.startsWith('street.glb: is a Git LFS pointer'))).toBe(true)
      expect(p.some((e) => e.startsWith('garden.glb: gltf-validator found'))).toBe(true)
      expect(p).toContain('wing-ocean.lightmap.half.png: is not a PNG or WebP image')
      expect(p).toContain('wing-ocean.lightmap.quarter.png: referenced by manifest.json but missing')
      expect(p).toContain(
        'atrium.glb: texture "floor" has no extras.hash (12 hex chars of sha1 over its RGBA, contract §6b)',
      )
      expect(p).toContain(
        'wing-neon.glb: uses KHR_texture_basisu; the Basis transcoder needs eval, which the CSP forbids (contract §6b)',
      )
      expect(p).toContain(
        'street.lightmap.quarter.png: is 8×8, expected 4×4 (¼ of street.lightmap.full.png)',
      )
      expect(p).toContain('hdri/office.hdr: referenced by manifest.json but missing')
      expect(p).toContain(
        'character.json.clips.Walk.footPlants: must be a non-empty list of phases in [0, 1)',
      )
    } finally {
      await rm(broken, { recursive: true, force: true })
    }
  }, 30_000)

  it('explains how to get the assets when manifest.json is missing or invalid', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'ao-assets-empty-'))
    try {
      expect((await validateAssets(empty)).problems[0]).toMatch(
        /manifest\.json is missing.*make assets.*git lfs pull/,
      )
      await writeFile(join(empty, 'manifest.json'), '{ nope')
      expect((await validateAssets(empty)).problems[0]).toMatch(/^manifest\.json: invalid JSON/)
      await writeFile(
        join(empty, 'manifest.json'),
        JSON.stringify({ ...fixtureManifest(), version: 3 }),
      )
      expect((await validateAssets(empty)).problems).toEqual([
        'manifest.version: expected 1, got 3',
      ])
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})

// ── Floor plan (contract §11, the optional 2D mode) ────────────────────────────────────────────
/**
 * A fixture plan: a floor room over the whole module, one room per `extras.room` around its anchors,
 * the perimeter walls (with the connectors as openings), a rug under the anchors and a desk off to the
 * side.
 */
function planFor(kind: ModuleKind, anchors: Record<string, AnchorJson>): PlanJson {
  const b = BOUNDS[kind]
  // The fixture grid spills past the bounds, so the floor room covers every anchor too.
  const all = Object.values(anchors).filter((a) => a.approach)
  const rooms: PlanJson['rooms'] = [
    {
      id: 'floor',
      name: 'Floor',
      rect: [
        Math.min(b.minX, ...all.map((a) => a.x - 1)),
        Math.min(b.minZ, ...all.map((a) => a.z - 1)),
        Math.max(b.maxX, ...all.map((a) => a.x + 1)),
        Math.max(b.maxZ, ...all.map((a) => a.z + 1)),
      ],
    },
  ]
  const byRoom = new Map<string, Vec2[]>()
  for (const a of Object.values(anchors))
    if (a.room && a.approach) byRoom.set(a.room, [...(byRoom.get(a.room) ?? []), a])
  for (const [id, pts] of byRoom) {
    const xs = pts.map((p) => p.x)
    const zs = pts.map((p) => p.z)
    rooms.push({
      id,
      name: id,
      rect: [Math.min(...xs) - 0.3, Math.min(...zs) - 0.3, Math.max(...xs) + 0.3, Math.max(...zs) + 0.3],
    })
  }
  return {
    rooms,
    walls: [
      { a: [b.minX, b.minZ], b: [b.maxX, b.minZ], kind: 'solid' },
      { a: [b.maxX, b.minZ], b: [b.maxX, b.maxZ], kind: 'curtain' },
    ],
    furniture: [
      { kind: 'rug', x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2, w: 60, d: 30, yaw: 0 },
      { kind: 'desk', x: b.maxX - 1, z: b.minZ + 0.25, w: 1.6, d: 0.4, yaw: 0 },
    ],
  }
}

function moduleWithPlan(kind: ModuleKind) {
  const m = fixtureManifest()
  const mod = kind === 'wing' ? m.modules.wing : m.modules[kind]
  return { ...mod, plan: planFor(kind, mod.anchors) }
}

describe('asset validator: floor plan (contract §11)', () => {
  it('PLAN-1: every module needs a plan; a fixture plan passes', () => {
    const m = fixtureManifest()
    expect(checkPlans(m)).toEqual([
      'atrium.plan: missing (run `make assets-plan`)',
      'street.plan: missing (run `make assets-plan`)',
      'garden.plan: missing (run `make assets-plan`)',
      'cap.plan: missing (run `make assets-plan`)',
      'wing.plan: missing (run `make assets-plan`)',
    ])
    for (const kind of ['atrium', 'street', 'garden', 'cap', 'wing'] as const) {
      const mod = kind === 'wing' ? m.modules.wing : m.modules[kind]
      mod.plan = planFor(kind, mod.anchors)
    }
    expect(checkPlans(m)).toEqual([])
  })

  it('PLAN-1: names the path of a bad kind, a NaN or a degenerate rect', () => {
    const mod = moduleWithPlan('garden')
    const plan = mod.plan as any
    plan.furniture.push({ kind: 'throne', x: 1, z: 1, w: 1, d: 1, yaw: 0 })
    plan.furniture.push({ kind: 'plant', x: Number.NaN, z: 1, w: 1, d: 1, yaw: 0 })
    plan.walls.push({ a: [1, 1], b: [2, 1], kind: 'brick' })
    plan.rooms.push({ id: 'void', name: 'Void', rect: [3, 3, 2, 4] })
    expect(checkPlan('garden', mod)).toEqual([
      'garden.plan.rooms[1].rect: must be [x0, z0, x1, z1] with x0 < x1 and z0 < z1',
      'garden.plan.walls[2].kind: must be solid, glass or curtain',
      'garden.plan.furniture[2].kind: "throne" is not a furniture kind',
      'garden.plan.furniture[3]: x, z, w, d and yaw must be finite numbers (w, d > 0)',
    ])
  })

  it('PLAN-2: walls lie within the module bounds, openings within the wall', () => {
    const mod = moduleWithPlan('cap')
    mod.plan.walls.push({ a: [-3, 0.4], b: [3, 0.9], kind: 'glass' })
    mod.plan.walls.push({ a: [-3, 0.2], b: [3, 0.2], kind: 'solid', openings: [[5, 7]] })
    expect(checkPlan('cap', mod)).toEqual([
      'cap.plan.walls[2]: (3, 0.9) is outside the module bounds',
      'cap.plan.walls[3].openings[0]: [5, 7] must lie within 0..6 m along the wall',
    ])
  })

  it('PLAN-3: every seat/spot anchor stands inside the room its extras.room names', () => {
    const mod = moduleWithPlan('wing')
    const pod1 = mod.plan.rooms.find((r) => r.id === 'pod-1')!
    pod1.rect = [pod1.rect[0] + 20, pod1.rect[1], pod1.rect[2] + 20, pod1.rect[3]]
    mod.plan.rooms = mod.plan.rooms.filter((r) => r.id !== 'library')
    const p = checkPlan('wing', mod)
    expect(p).toContain('wing.anchors["seat:desk:1:0"]: is not inside room "pod-1"')
    expect(p).toContain('wing.anchors["seat:reading:0"]: room "library" is not in the plan')
    expect(p.filter((e) => e.includes('anchors["'))).toHaveLength(4 + 6)
    // An anchor without extras.room only needs to stand in some room.
    const atrium = moduleWithPlan('atrium')
    atrium.plan.rooms = []
    expect(checkPlan('atrium', atrium)).toContain(
      'atrium.anchors["seat:cafe:0"]: is not inside any room',
    )
  })

  it('PLAN-4: approach points are not inside solid furniture (rugs are not solid)', () => {
    const mod = moduleWithPlan('garden')
    const a = mod.anchors['spot:garden:0']!.approach
    expect(checkPlan('garden', mod)).toEqual([]) // the fixture rug covers every approach
    // A desk rotated 90° over the approach: its 2 m side runs along z.
    mod.plan.furniture.push({ kind: 'desk', x: a.x, z: a.z + 0.8, w: 2, d: 0.3, yaw: Math.PI / 2 })
    expect(checkPlan('garden', mod)).toEqual([
      'garden.anchors["spot:garden:0"].approach: (2, 2.6) is inside furniture[2] (desk)',
    ])
  })

  it('PLAN-5: a nav edge that crosses a wall passes through an opening', () => {
    const mod = moduleWithPlan('wing')
    // A partition at x = 1 across the connector → approach edges (the hub is at (0, 0)).
    mod.plan.walls.push({ a: [1, -9], b: [1, 9], kind: 'glass' })
    const p = checkPlan('wing', mod)
    expect(p.length).toBeGreaterThan(0)
    expect(p[0]).toMatch(/^wing\.nav\.edges\[\d+\] c0–ap:.*: crosses walls\[2\] at \(1, -?[\d.]+\) outside its openings$/)
    // A doorway over the whole crossing span clears it.
    mod.plan.walls[2]!.openings = [[0, 18]]
    expect(checkPlan('wing', mod)).toEqual([])
  })

  it('validateAssets checks the plan once the manifest has one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ao-assets-plan-'))
    try {
      const m = await writeFixture(dir)
      for (const kind of ['atrium', 'street', 'garden', 'cap', 'wing'] as const) {
        const mod = kind === 'wing' ? m.modules.wing : m.modules[kind]
        mod.plan = planFor(kind, mod.anchors)
      }
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(m))
      expect((await validateAssets(dir)).problems).toEqual([])
      delete m.modules.cap.plan
      m.modules.street.plan!.walls.push({ a: [0, 0], b: [0, 40], kind: 'solid' })
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(m))
      expect((await validateAssets(dir)).problems).toEqual([
        'street.plan.walls[2]: (0, 40) is outside the module bounds',
        'cap.plan: missing (run `make assets-plan`)',
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

// ── 2. The real assets (CI gate) ────────────────────────────────────────────────────────────────
describe('real assets (packages/web/public/assets)', () => {
  it('exist: manifest.json is built and committed (Git LFS)', () => {
    if (!existsSync(join(REAL_ASSETS, 'manifest.json')))
      throw new Error(
        `No assets at ${REAL_ASSETS}/manifest.json. Build them with \`make assets\` (Blender 5.2, see README → Building the assets), ` +
          'or fetch the committed ones with `git lfs install && git lfs pull`.',
      )
  })

  it('match the graphics contract: 0 gltf-validator errors, budgets, anchors, nav, clips, ≤ 55 MB', async () => {
    if (!existsSync(join(REAL_ASSETS, 'manifest.json'))) return // reported by the test above
    const r = await validateAssets(REAL_ASSETS)
    const sizes = r.files.map(
      (f) => `${f.file}: ${(f.bytes / MB).toFixed(2)} MB, ${f.triangles ?? '?'} tris`,
    )
    expect(
      r.problems,
      `Asset problems:\n${r.problems.join('\n')}\n\nFiles:\n${sizes.join('\n')}`,
    ).toEqual([])
    expect(JSON.parse(await readFile(join(REAL_ASSETS, 'manifest.json'), 'utf8')).version).toBe(1)
  }, 180_000)
})

describe('asset validator: wall side and thickness (contract §11, PLAN-6)', () => {
  it('PLAN-6: requires side and thick on every wall, naming the path', () => {
    const m = fixtureManifest()
    for (const kind of ['atrium', 'street', 'garden', 'cap', 'wing'] as const) {
      const mod = kind === 'wing' ? m.modules.wing : m.modules[kind]
      mod.plan = planFor(kind, mod.anchors)
    }
    // planFor's walls predate side/thick: each one is reported
    expect(checkPlanWallSides(m)).toHaveLength(10)
    expect(checkPlanWallSides(m)[0]).toBe('atrium.plan.walls[0]: needs side (−1 or 1) and thick (m)')
    for (const kind of ['atrium', 'street', 'garden', 'cap', 'wing'] as const) {
      const mod = kind === 'wing' ? m.modules.wing : m.modules[kind]
      for (const w of mod.plan!.walls) Object.assign(w, { side: 1, thick: 0.15 })
    }
    expect(checkPlanWallSides(m)).toEqual([])
    expect(checkPlans(m)).toEqual([])
  })

  it('PLAN-6: rejects a side other than ±1 and a non-positive thickness', () => {
    const mod = moduleWithPlan('garden')
    const plan = mod.plan as any
    plan.walls.push({ a: [1, 1], b: [2, 1], kind: 'solid', side: 0, thick: 0.15 })
    plan.walls.push({ a: [1, 2], b: [2, 2], kind: 'solid', side: -1, thick: 0 })
    plan.walls.push({ a: [1, 3], b: [2, 3], kind: 'glass', side: 1, thick: 0.06 })
    expect(checkPlan('garden', mod)).toEqual([
      'garden.plan.walls[2].side: must be -1 or 1',
      'garden.plan.walls[3].thick: must be a finite number > 0',
    ])
  })
})

describe('real assets: floor plan (contract §11)', () => {
  it('PLAN-1..5: every module has a plan that matches its bounds, anchors and nav', async () => {
    const file = join(REAL_ASSETS, 'manifest.json')
    if (!existsSync(file)) return // reported by the real-assets test above
    const m = JSON.parse(await readFile(file, 'utf8')) as Manifest
    const p = checkPlans(m)
    expect(p, p.join('\n')).toEqual([])
  })
})

describe('real assets: wall side and thickness (contract §11)', () => {
  it('PLAN-6: every published wall says which side its body is on and how thick it is', async () => {
    const file = join(REAL_ASSETS, 'manifest.json')
    if (!existsSync(file)) return // reported by the real-assets test above
    const m = JSON.parse(await readFile(file, 'utf8')) as Manifest
    const p = checkPlanWallSides(m)
    expect(p, p.join('\n')).toEqual([])
  })
})

// ── Night City: the 'special' profile (contract §14) ───────────────────────────────────────────────
const REAL_SPECIAL = resolve(import.meta.dirname, '../packages/web/public/special3d')
const KINDS = ['hq-atrium', 'command', 'skyline'] as const

function specialAnchors(kind: (typeof KINDS)[number]): Record<string, AnchorJson> {
  const at = (i: number, extra: Partial<AnchorJson> = {}): AnchorJson => ({
    x: i * 0.7,
    y: 0,
    z: 2,
    heading: 0,
    pose: 'stand',
    approach: { x: i * 0.7, z: 1.4 },
    ...extra,
  })
  const ids: [string, Partial<AnchorJson>][] =
    kind === 'hq-atrium'
      ? [
          ['player:spawn', {}],
          ['interact:project-directory:0', {}],
        ]
      : kind === 'command'
        ? [
            ...range(6).flatMap((d) =>
              range(6).flatMap((p) =>
                range(4).map((s): [string, Partial<AnchorJson>] => [
                  `ws:${d}:${p}:${s}`,
                  { pose: 'sit', screen: `ws:${d}:${p}:${s}` },
                ]),
              ),
            ),
            ...['A', 'B'].flatMap((r) => range(6).map((s): [string, Partial<AnchorJson>] => [`meet:${r}:${s}`, { pose: 'sit' }])),
            ...range(4).map((n): [string, Partial<AnchorJson>] => [`booth:${n}`, { led: `booth:${n}` }]),
            ['interact:command-display:0', {}],
            ...range(6).map((n): [string, Partial<AnchorJson>] => [`interact:provider-terminal:${n}`, {}]),
          ]
        : []
  return Object.fromEntries(ids.map(([id, extra], i) => [id, at(i, extra)]))
}

function specialNav(kind: (typeof KINDS)[number], anchors: Record<string, AnchorJson>): NavJson {
  if (kind === 'skyline') return { nodes: {}, edges: [] }
  const c = kind === 'hq-atrium' ? { x: 20, z: -9 } : { x: 0, z: 0 }
  const nodes: NavJson['nodes'] = { c0: { ...c, width: 1.2 } }
  const edges: NavJson['edges'] = []
  for (const [id, a] of Object.entries(anchors)) {
    nodes[`ap:${id}`] = { ...a.approach, width: 0.5 }
    edges.push(['c0', `ap:${id}`])
  }
  return { nodes, edges }
}

const SPECIAL_ROLE_NODES: Record<(typeof KINDS)[number], [string, string][]> = {
  'hq-atrium': [
    ['holo', 'display'],
    ['holo', 'project-directory'],
    ['rain-glass', 'pane'],
    ...range(4).flatMap((i): [string, string][] => [
      ['elevatorDoor', `${i}:L`],
      ['elevatorDoor', `${i}:R`],
    ]),
  ],
  command: [
    ['holo', 'command-display'],
    ['rain-glass', 'pane'],
  ],
  skyline: [
    ...range(8).map((i): [string, string] => ['ad', `ad:${i}`]),
    ['traffic', 'lane-0'],
    ['neon', 'neon:0'],
  ],
}

function specialManifest(): SpecialManifest {
  const modules: SpecialManifest['modules'] = {}
  for (const kind of KINDS) {
    const anchors = specialAnchors(kind)
    modules[kind] = {
      file: `${kind}.glb`,
      lightmap: { file: `${kind}.lightmap.full.png`, intensity: 3, variants: tiersFor(kind) },
      bounds: { minX: -40, maxX: 40, minZ: -30, maxZ: 10 },
      placement: kind === 'command' ? { x: 20, z: -9, yaw: 0 } : { x: 0, z: 0, yaw: 0 },
      anchors,
      nav: specialNav(kind, anchors),
    }
  }
  return {
    version: 1,
    set: 'special',
    blender: '5.2.2',
    units: 'm',
    hash: 'abc',
    hdri: 'hdri/night.hdr',
    modules,
    character: { file: 'character-cyber.glb', meta: 'character-cyber.json' },
  }
}

async function writeSpecialFixture(dir: string) {
  const io = await createIO()
  const m = specialManifest()
  await mkdir(join(dir, 'hdri'), { recursive: true })
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(m))
  await writeFile(join(dir, m.hdri), '#?RADIANCE\n')
  for (const kind of KINDS) {
    const mod = m.modules[kind]!
    const doc = moduleDoc('atrium', mod.anchors, { bytes: PNG_1PX })
    const panel = doc.getRoot().listMeshes()[0]!
    const scene = doc.getRoot().getDefaultScene()!
    for (const [role, ref] of SPECIAL_ROLE_NODES[kind])
      scene.addChild(doc.createNode(`${role}-${ref}`).setMesh(panel).setExtras({ role, ref }))
    await writeFile(join(dir, mod.file), await io.writeBinary(doc))
    await writeTiers(dir, kind)
  }
  const ch = characterDoc()
  const body = ch.getRoot().listMeshes().find((x) => x.getName() === 'body')!
  body.addPrimitive(body.listPrimitives()[0]!.clone().setMaterial(ch.createMaterial('accent')))
  await writeFile(join(dir, m.character.file), await io.writeBinary(ch))
  await writeFile(join(dir, m.character.meta), JSON.stringify(characterMeta()))
  return m
}

describe('asset validator: Night City profile (contract §14)', () => {
  it('accepts the §14 anchor forms only in the special set', () => {
    const a: AnchorJson = { x: 0, y: 0, z: 0, heading: 0, pose: 'sit', approach: { x: 0, z: -0.6 } }
    for (const id of ['ws:0:5:3', 'booth:2', 'meet:A:4', 'interact:project-directory:0', 'player:spawn']) {
      expect(checkAnchor('m', id, a, 'special')).toEqual([])
      expect(checkAnchor('m', id, a)).toHaveLength(1)
    }
    expect(checkAnchor('m', 'seat:desk:1:0', a, 'special')).toEqual([])
    expect(checkAnchor('m', 'interact:teleporter:0', a, 'special')[0]).toMatch(/contract §14/)
    expect(checkAnchor('m', 'ws:0:0:7', a, 'special')).toHaveLength(1)
  })

  it('checks the manifest shape: set, the R1 modules, known kinds, placement, baked rooms', () => {
    expect(checkSpecialManifest(specialManifest())).toEqual([])
    const m = specialManifest() as any
    m.set = 'classic'
    delete m.modules.skyline
    m.modules.casino = m.modules.command
    m.modules.command.placement = { x: 1 }
    delete m.modules['hq-atrium'].lightmap
    expect(checkSpecialManifest(m)).toEqual([
      'manifest.set: expected "special", got "classic"',
      'manifest.modules.casino: unknown Night City module kind',
      'manifest.modules.skyline: missing',
      'manifest.modules.command.placement: must be { x, z, yaw }',
      'manifest.modules.hq-atrium.lightmap: the hq-atrium must be baked',
    ])
  })

  it('requires the workstation, room and interaction anchors', () => {
    const anchors = specialAnchors('command')
    expect(checkSpecialAnchorCounts('command', anchors)).toEqual([])
    delete anchors['ws:3:0:0']
    delete anchors['interact:command-display:0']
    expect(checkSpecialAnchorCounts('command', anchors)).toEqual([
      'command: expected 144 "ws:*" anchors, found 143',
      'command: expected 24 "ws:3:*" anchors, found 23',
      'command: expected 1 "interact:command-display:*" anchors, found 0',
    ])
  })

  it('requires the runtime roles per module and caps the ad planes', () => {
    const stats = (pairs: [string, string][]) => {
      const roles = new Map<string, string[]>()
      for (const [r, f] of pairs) roles.set(r, [...(roles.get(r) ?? []), f])
      return { roles } as any
    }
    expect(checkSpecialRoles('s.glb', 'skyline', stats(SPECIAL_ROLE_NODES.skyline))).toEqual([])
    expect(checkSpecialRoles('a.glb', 'hq-atrium', stats([['holo', 'display']]))).toEqual([
      'a.glb: no node with role "holo" and ref "project-directory"',
      'a.glb: expected at least 8 node(s) with role "elevatorDoor", found 0',
      'a.glb: expected at least 1 node(s) with role "rain-glass", found 0',
    ])
    const many = range(11).map((i): [string, string] => ['ad', `ad:${i}`])
    expect(checkSpecialRoles('s.glb', 'skyline', stats([...many, ['traffic', 'l'], ['neon', 'n']]))).toEqual([
      's.glb: at most 10 ad planes (contract §14), found 11',
    ])
  })

  it('joins the placed atrium and Command Center through their connectors', () => {
    const m = specialManifest()
    expect(checkSpecialSetNav(m)).toEqual([])
    m.modules.command!.placement = { x: 21, z: -9, yaw: 0 }
    expect(checkSpecialSetNav(m)[0]).toMatch(/do not join into one graph/)
  })

  it('lets mezzanine edges (nav nodes with y) pass above lower walls', () => {
    const mod = {
      bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
      anchors: {},
      nav: {
        nodes: { a: { x: 0, z: -2, width: 1 }, b: { x: 0, z: 2, width: 1 } },
        edges: [['a', 'b']] as [string, string][],
      },
      plan: {
        rooms: [{ id: 'r', name: 'r', rect: [-10, -10, 10, 10] as [number, number, number, number] }],
        walls: [{ a: [-5, 0] as [number, number], b: [5, 0] as [number, number], kind: 'glass' as const, id: 1, h: 2.4 }],
        furniture: [],
      },
    }
    expect(checkPlan('hq-atrium', mod)).toHaveLength(1)
    mod.nav.nodes.a = { ...mod.nav.nodes.a, y: 6 } as any
    mod.nav.nodes.b = { ...mod.nav.nodes.b, y: 6 } as any
    expect(checkPlan('hq-atrium', mod)).toEqual([])
  })

  it('validates a whole special dir; each set totals only its own dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ao-special-'))
    try {
      const dir = join(root, 'special3d')
      await mkdir(dir)
      await writeSpecialFixture(dir)
      const r = await validateAssets(dir, 'special')
      expect(r.problems).toEqual([])
      expect(r.files.map((f) => f.file)).toEqual([...KINDS.map((k) => `${k}.glb`), 'character-cyber.glb'])
      // the classic validator rejects it (no classic modules), and a classic dir's total ignores this sibling
      expect((await validateAssets(dir)).problems.length).toBeGreaterThan(0)
      const classic = join(root, 'assets')
      await mkdir(classic)
      await writeFixture(classic)
      const c = await validateAssets(classic)
      expect(c.problems).toEqual([])
      expect(c.totalBytes).toBeLessThan(r.totalBytes + c.totalBytes)
      expect(SPECIAL_TOTAL_MAX_BYTES).toBe(70 * MB)
      // the special budgets apply: a character over 1.8 MB, a command module over 260k triangles
      expect(checkBudget('character-cyber.glb', 1.9 * MB, SPECIAL_BUDGETS.character)).toHaveLength(1)
      expect(checkBudget('command.glb', MB, SPECIAL_BUDGETS.command, 260_001)).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('explains how to build the set when its manifest is missing', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'ao-special-empty-'))
    try {
      expect((await validateAssets(empty, 'special')).problems[0]).toMatch(/make special-assets/)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})

describe('real Night City assets (packages/web/public/special3d)', () => {
  it('match contract §14 when present: 0 validator errors, budgets, anchors, nav, roles, ≤ 70 MB', async () => {
    if (!existsSync(join(REAL_SPECIAL, 'manifest.json'))) return // optional until make special-assets ran
    const r = await validateAssets(REAL_SPECIAL, 'special')
    const sizes = r.files.map((f) => `${f.file}: ${(f.bytes / MB).toFixed(2)} MB, ${f.triangles ?? '?'} tris`)
    expect(r.problems, `Night City problems:\n${r.problems.join('\n')}\n\nFiles:\n${sizes.join('\n')}`).toEqual([])
  }, 180_000)
})
