// Minimap (plan §9, §2c): agents as dots in status colours (waiting / error flagged), the player
// marker, wing and major-room labels, and the camera's viewport. Pure.
import { STATUS_COLORS, type AgentStatus } from '@agent-office/shared'
import { toWorld } from '../building.ts'
import type { BuildingLayout, Vec2 } from '../office-types.ts'
import { PIXEL_COPY } from '../pixel-copy.ts'
import { toTile, type Projection } from './project.ts'
import type { MinimapVM, PlanByModule, TileRect } from './types.ts'

type Label = NonNullable<MinimapVM['labels']>[number]

export interface MinimapExtras {
  labels?: Label[]
  viewport?: TileRect
  /** Mark waiting and error dots (drawn larger and pulsing). */
  flags?: boolean
}

export function minimapVM(
  proj: Projection,
  agents: readonly { id: string; pos: Vec2; status: AgentStatus }[],
  player?: Vec2,
  extras: MinimapExtras = {},
): MinimapVM {
  const vm: MinimapVM = {
    widthTiles: proj.widthTiles,
    heightTiles: proj.heightTiles,
    dots: [...agents]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((a) => {
        const d: MinimapVM['dots'][number] = {
          id: a.id,
          ...toTile(a.pos, proj),
          color: STATUS_COLORS[a.status],
        }
        if (extras.flags && a.status === 'waiting') d.waiting = true
        if (extras.flags && a.status === 'error') d.error = true
        return d
      }),
  }
  if (player) vm.player = toTile(player, proj)
  if (extras.labels) vm.labels = extras.labels
  if (extras.viewport) vm.viewport = clampRect(extras.viewport, proj)
  return vm
}

function clampRect(r: TileRect, proj: Projection): TileRect {
  const x0 = Math.max(0, r.tx)
  const y0 = Math.max(0, r.ty)
  const x1 = Math.min(proj.widthTiles, r.tx + r.tw)
  const y1 = Math.min(proj.heightTiles, r.ty + r.th)
  return { tx: x0, ty: y0, tw: Math.max(0, x1 - x0), th: Math.max(0, y1 - y0) }
}

/** Plan room id → the label shown on the map (only these rooms are labelled). */
const MAJOR_ROOMS: Record<string, string> = {
  kitchen: 'Kitchen',
  lounge: 'Lounge',
  'meeting-A': 'Meeting A',
  'meeting-B': 'Meeting B',
  library: 'Library',
  adapters: 'Adapters',
  cafe: 'Cafe',
}

interface Box {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}
const grow = (b: Box | undefined, x: number, z: number): Box =>
  b
    ? {
        minX: Math.min(b.minX, x),
        minZ: Math.min(b.minZ, z),
        maxX: Math.max(b.maxX, x),
        maxZ: Math.max(b.maxZ, z),
      }
    : { minX: x, minZ: z, maxX: x, maxZ: z }

/** Wing labels (provider sign), Lobby, Main Street (once) and the major rooms, in tiles. */
export function minimapLabels(
  layout: BuildingLayout,
  plans: PlanByModule,
  proj: Projection,
): Label[] {
  const out: Label[] = []
  const at = (b: Box, text: string, kind: Label['kind']) => {
    const t = toTile({ x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 }, proj)
    out.push({
      text,
      kind,
      tx: Math.max(0, Math.min(proj.widthTiles - 1, t.tx)),
      ty: Math.max(0, Math.min(proj.heightTiles - 1, t.ty)),
    })
  }
  let street: Box | undefined
  for (const p of layout.placements) {
    const plan = plans[p.kind]
    if (!plan?.rooms.length) continue
    let all: Box | undefined
    for (const r of plan.rooms) {
      const [x0, z0, x1, z1] = r.rect
      let box: Box | undefined
      for (const [x, z] of [
        [x0, z0],
        [x1, z1],
      ] as const) {
        const w = toWorld({ x, z }, p)
        box = grow(box, w.x, w.z)
        all = grow(all, w.x, w.z)
      }
      const name = MAJOR_ROOMS[r.id]
      if (name && box) at(box, name, 'room')
    }
    if (!all) continue
    if (p.kind === 'wing') at(all, p.label ?? p.provider ?? p.id, 'wing')
    else if (p.kind === 'atrium') at(all, PIXEL_COPY.hud.lobby, 'room')
    else if (p.kind === 'street')
      street = grow(grow(street, all.minX, all.minZ), all.maxX, all.maxZ)
  }
  if (street) at(street, PIXEL_COPY.hud.street, 'room')
  return out
}
