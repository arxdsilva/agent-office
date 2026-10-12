// A small but contract-valid manifest (docs/graphics-contract.md §3, §4, §7) built in code for unit tests.
// Geometry is schematic: walkable grids instead of real corridors, anchors in tidy rows.
import { parseManifest, type Manifest } from '../manifest.ts'

type Json = Record<string, unknown>
interface Nav {
  nodes: Record<string, { x: number; z: number; width: number }>
  edges: [string, string][]
}

const APPROACH = 0.6

/** Adds an anchor plus its dedicated `ap:<id>` nav node, linked to the nearest existing node. */
function addAnchor(
  anchors: Json,
  nav: Nav,
  id: string,
  x: number,
  z: number,
  heading: number,
  pose: 'sit' | 'stand' | 'lounge',
  extra: Json = {},
) {
  // The approach point is behind the anchor (opposite its facing), as in the contract example.
  const approach = {
    x: round(x - APPROACH * Math.sin(heading)),
    z: round(z - APPROACH * Math.cos(heading)),
  }
  anchors[id] = { x, y: 0, z, heading, pose, approach, ...extra }
  let best = ''
  let bestD = Infinity
  for (const [nid, n] of Object.entries(nav.nodes)) {
    if (nid.startsWith('ap:')) continue
    const d = Math.hypot(n.x - approach.x, n.z - approach.z)
    if (d < bestD) {
      bestD = d
      best = nid
    }
  }
  nav.nodes[`ap:${id}`] = { ...approach, width: 0.5 }
  nav.edges.push([`ap:${id}`, best])
}

const round = (v: number) => Math.round(v * 1e6) / 1e6

/** Grid of nodes `g:<x>:<z>` with 4-neighbour edges. */
function grid(xs: number[], zs: number[], width: number): Nav {
  const nav: Nav = { nodes: {}, edges: [] }
  for (const x of xs) for (const z of zs) nav.nodes[`g:${x}:${z}`] = { x, z, width }
  xs.forEach((x, i) =>
    zs.forEach((z, j) => {
      if (i + 1 < xs.length) nav.edges.push([`g:${x}:${z}`, `g:${xs[i + 1]}:${z}`])
      if (j + 1 < zs.length) nav.edges.push([`g:${x}:${z}`, `g:${x}:${zs[j + 1]}`])
    }),
  )
  return nav
}

const range = (from: number, to: number, step: number) => {
  const out: number[] = []
  for (let v = from; v <= to + 1e-9; v += step) out.push(v)
  return out
}

function wingModule() {
  const nav = grid(range(2, 22, 2), range(-8, 8, 2), 1)
  nav.nodes.door = { x: 0, z: 0, width: 1.2 }
  nav.edges.push(['door', 'g:2:0'])
  const anchors: Json = {}
  // Pods 1–3 at z = −3, pods 4–6 at z = +3; four seats facing the pod center.
  for (let p = 1; p <= 6; p++) {
    const cx = 7 + ((p - 1) % 3) * 6
    const cz = p <= 3 ? -3 : 3
    for (let i = 0; i < 4; i++) {
      const x = cx + (i % 2 ? 0.8 : -0.8)
      const z = cz + (i < 2 ? -0.7 : 0.7)
      addAnchor(anchors, nav, `seat:desk:${p}:${i}`, x, z, i < 2 ? 0 : Math.PI, 'sit', {
        room: `pod-${p}`,
        screen: `desk:${p}:${i}`,
      })
    }
  }
  for (const [room, cx] of [
    ['A', 5],
    ['B', 11],
  ] as const) {
    for (let i = 0; i < 6; i++) {
      const x = cx - 1 + (i % 3)
      const z = i < 3 ? 6.4 : 7.6
      addAnchor(anchors, nav, `seat:meeting:${room}:${i}`, x, z, i < 3 ? 0 : Math.PI, 'sit', {
        room: `meeting-${room}`,
      })
    }
  }
  for (let i = 0; i < 4; i++)
    addAnchor(anchors, nav, `spot:booth:${i}`, 16.5 + i * 1.5, 7.5, 0, 'stand', {
      room: `booth-${i}`,
      led: `booth:${i}`,
    })
  for (let i = 0; i < 6; i++)
    addAnchor(anchors, nav, `spot:kitchen:${i}`, 3 + i, -7.5, Math.PI, 'stand', { room: 'kitchen' })
  for (let i = 0; i < 8; i++)
    addAnchor(anchors, nav, `seat:lounge:${i}`, 13 + i, -7.5, Math.PI, 'lounge', { room: 'lounge' })
  return { anchors, nav }
}

function atriumModule() {
  const nav = grid(range(-24, 24, 3), range(-21, -3, 3), 1.5)
  nav.nodes.entry = { x: 0, z: 0, width: 1.5 }
  nav.edges.push(['entry', 'g:0:-3'])
  const anchors: Json = {}
  for (let i = 0; i < 6; i++)
    addAnchor(anchors, nav, `spot:elevator:${i}`, -23 + i, -22.5, Math.PI, 'stand', {
      room: 'elevator',
    })
  for (let i = 0; i < 4; i++)
    addAnchor(anchors, nav, `spot:reception:${i}`, -11 + i, -16, Math.PI, 'stand', {
      room: 'reception',
    })
  const rows: [number, number][] = [
    [-20.5, 0],
    [-19.5, Math.PI],
    [-14.5, 0],
    [-13.5, Math.PI],
  ]
  rows.forEach(([z, h], r) => {
    for (let c = 0; c < 6; c++)
      addAnchor(anchors, nav, `seat:cafe:${r * 6 + c}`, 2.5 + c, z, h, 'sit', { room: 'cafe' })
  })
  for (let t = 0; t < 2; t++) {
    const cx = 15 + t * 6
    addAnchor(anchors, nav, `spot:pingpong:${t}:A`, cx, -11.6, 0, 'stand', {
      room: `pingpong-${t}`,
    })
    addAnchor(anchors, nav, `spot:pingpong:${t}:B`, cx, -8.4, Math.PI, 'stand', {
      room: `pingpong-${t}`,
    })
  }
  return { anchors, nav }
}

function streetModule() {
  const nav: Nav = { nodes: {}, edges: [] }
  const zs = range(0, 18, 3)
  zs.forEach((z, i) => {
    nav.nodes[`s:${z}`] = { x: 0, z, width: 2 }
    if (i > 0) nav.edges.push([`s:${zs[i - 1]}`, `s:${z}`])
  })
  nav.nodes['door:R'] = { x: 3, z: 9, width: 1.2 }
  nav.nodes['door:L'] = { x: -3, z: 9, width: 1.2 }
  nav.edges.push(['door:R', 's:9'], ['door:L', 's:9'])
  return { anchors: {}, nav }
}

function gardenModule() {
  const nav: Nav = { nodes: { door: { x: 0, z: 0, width: 1.2 } }, edges: [] }
  let prev = 'door'
  for (const x of range(2, 22, 4)) {
    nav.nodes[`p:${x}`] = { x, z: 0, width: 1.5 }
    nav.edges.push([prev, `p:${x}`])
    prev = `p:${x}`
  }
  const anchors: Json = {}
  for (let i = 0; i < 6; i++)
    addAnchor(anchors, nav, `spot:garden:${i}`, 4 + i * 3, 2, 0, 'stand', { room: 'garden' })
  return { anchors, nav }
}

const THEMES = ['terracotta', 'nordic', 'forest', 'ocean', 'neon', 'brass']

/** A fresh, mutable JSON object (as `manifest.json` would parse). */
export function fixtureManifestJson(themes: string[] = THEMES): Json {
  const lm = (file: string) => ({ file, intensity: 3 })
  return {
    version: 1,
    blender: '5.2.2',
    units: 'm',
    hash: 'fixture',
    hdri: 'hdri/office.hdr',
    modules: {
      atrium: {
        file: 'atrium.glb',
        lightmap: lm('atrium.lightmap.png'),
        bounds: { minX: -27, maxX: 27, minZ: -24, maxZ: 0 },
        ...atriumModule(),
      },
      street: {
        file: 'street.glb',
        bounds: { minX: -3, maxX: 3, minZ: 0, maxZ: 18 },
        ...streetModule(),
      },
      garden: {
        file: 'garden.glb',
        bounds: { minX: 0, maxX: 24, minZ: -9, maxZ: 9 },
        ...gardenModule(),
      },
      cap: {
        file: 'cap.glb',
        bounds: { minX: -27, maxX: 27, minZ: 0, maxZ: 0.5 },
        anchors: {},
        nav: { nodes: { end: { x: 0, z: 0, width: 2 } }, edges: [] },
      },
      wing: {
        themes: Object.fromEntries(
          themes.map((t) => [
            t,
            {
              file: `wing-${t}.glb`,
              lightmap: lm(`wing-${t}.lightmap.png`),
              signColor: '#FFFFFF',
              accent: '#D97757',
            },
          ]),
        ),
        bounds: { minX: 0, maxX: 24, minZ: -9, maxZ: 9 },
        capacity: { desk: 24, meeting: 2, meetingSeats: 6, booth: 4, kitchen: 6, lounge: 8 },
        ...wingModule(),
      },
    },
    character: { file: 'character.glb', meta: 'character.json' },
  }
}

export const fixtureManifest: Manifest = parseManifest(fixtureManifestJson())
