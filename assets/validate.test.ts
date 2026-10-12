// Asset validation (docs/graphics-contract.md §9). Two parts:
//  1. The validator itself, against a tiny generated fixture (always runs, no Blender needed).
//  2. The real assets in packages/web/public/assets — CI fails when they are missing or off-contract.
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Document, Logger, type Node } from '@gltf-transform/core'
import { EXTMeshGPUInstancing } from '@gltf-transform/extensions'
import { meshopt } from '@gltf-transform/functions'
import { MeshoptEncoder } from 'meshoptimizer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BONES,
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
  type Vec2,
} from './validate.ts'

const REAL_ASSETS = resolve(import.meta.dirname, '../packages/web/public/assets')
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
const clone = <T>(v: T): T => structuredClone(v)

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
  return kind === 'wing' ? { ...placed, ...portsFor() } : placed
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
    lightmap: { file: `${kind}.lightmap.png`, intensity: 3 },
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
              lightmap: { file: `wing-${t}.lightmap.png`, intensity: 2.8 },
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
    if (uv1)
      for (const set of ['TEXCOORD_0', 'TEXCOORD_1'])
        prim.setAttribute(
          set,
          doc
            .createAccessor()
            .setType('VEC2')
            .setBuffer(buf)
            .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1])),
        )
    return doc.createMesh(name).addPrimitive(prim)
  }
  const scene = doc.createScene(name)
  doc.getRoot().setDefaultScene(scene)
  return { doc, buf, scene, quad }
}

function moduleDoc(kind: ModuleKind, anchors: Record<string, AnchorJson>) {
  const { doc, scene, quad } = quadDoc(kind)
  scene.addChild(doc.createNode('floor').setMesh(quad(true)).setExtras({ role: 'baked' }))
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

/** Writes the full fixture (manifest, 10 glbs, lightmaps, HDRI, character.json) into `dir`. */
async function writeFixture(dir: string) {
  await MeshoptEncoder.ready
  const io = (await createIO()).registerDependencies({ 'meshopt.encoder': MeshoptEncoder })
  const m = fixtureManifest()
  await mkdir(join(dir, 'hdri'), { recursive: true })
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(m))
  await writeFile(join(dir, m.hdri), '#?RADIANCE\n')
  await writeFile(join(dir, m.character.meta), JSON.stringify(characterMeta()))
  await writeFile(join(dir, m.character.file), await io.writeBinary(characterDoc()))
  for (const kind of ['atrium', 'street', 'garden', 'cap'] as const) {
    const mod = m.modules[kind]
    await writeFile(join(dir, mod.file), await io.writeBinary(moduleDoc(kind, mod.anchors)))
    await writeFile(join(dir, mod.lightmap!.file), PNG_1PX)
  }
  for (const t of THEMES) {
    const doc = moduleDoc('wing', m.modules.wing.anchors)
    // One theme goes through EXT_meshopt_compression, like the real gltf-transform step.
    if (t === 'terracotta')
      await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }))
    const th = m.modules.wing.themes[t]!
    await writeFile(join(dir, th.file), await io.writeBinary(doc))
    await writeFile(join(dir, th.lightmap.file), PNG_1PX)
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

  it('enforces size and triangle budgets', () => {
    expect(checkBudget('a.glb', 2 * MB, { maxBytes: 3 * MB, maxTriangles: 10 }, 10)).toEqual([])
    expect(checkBudget('a.glb', 4 * MB, { maxBytes: 3 * MB, maxTriangles: 10 }, 11)).toEqual([
      'a.glb: 4.00 MB exceeds the 3 MB budget',
      'a.glb: 11 triangles exceeds the 10 budget',
    ])
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
  })

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
      await writeFile(join(broken, m.modules.wing.themes.ocean!.lightmap.file), 'not a png')
      await rm(join(broken, m.hdri))
      const meta = characterMeta() as any
      delete meta.clips.Walk.footPlants
      await writeFile(join(broken, 'character.json'), JSON.stringify(meta))
      const p = (await validateAssets(broken)).problems
      expect(p).toContain('cap.glb: referenced by manifest.json but missing')
      expect(p.some((e) => e.startsWith('street.glb: is a Git LFS pointer'))).toBe(true)
      expect(p.some((e) => e.startsWith('garden.glb: gltf-validator found'))).toBe(true)
      expect(p).toContain('wing-ocean.lightmap.png: is not a PNG file')
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
