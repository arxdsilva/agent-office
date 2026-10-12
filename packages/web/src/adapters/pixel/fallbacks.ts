// Adapter-side helpers PL's pure modules don't cover: the world centre of a view region (2D
// framing per view id) and a fallback map from module footprints for manifests without floor
// plans (PL's buildPixelMap draws nothing for modules without one; a notice says so).
import { toWorld } from '../../app/building.ts'
import type { Manifest } from '../../app/manifest.ts'
import type { BuildingLayout, ModulePlacement, Vec2 } from '../../app/office-types.ts'
import { indexSolids, type TileResolver } from '../../app/pixel/map.ts'
import { projectionFor, toPixel, toTile } from '../../app/pixel/project.ts'
import {
  TILE_PX,
  WALL_PX,
  type MapObject,
  type MapWall,
  type PixelMap,
  type PixelRoom,
  type TileRect,
} from '../../app/pixel/types.ts'

const FLOOR: Record<ModulePlacement['kind'], string> = {
  atrium: 'tile',
  street: 'street',
  garden: 'grass',
  wing: 'carpet',
  cap: 'concrete',
}

/** A walkable map from the module footprints (no floor plan): floors, thin walls around, elevator doors. */
export function footprintMap(
  layout: BuildingLayout,
  manifest: Manifest,
  tiles: TileResolver,
): PixelMap {
  const proj = projectionFor(layout.bounds)
  const { widthTiles: w, heightTiles: h, originM } = proj
  const widthPx = w * TILE_PX
  const heightPx = h * TILE_PX
  const floor = new Uint16Array(w * h)
  const rooms: PixelRoom[] = []
  const order = { cap: 0, garden: 1, wing: 2, atrium: 3, street: 4 } as const
  for (const p of [...layout.placements].sort((a, c) => order[a.kind] - order[c.kind])) {
    if (p.kind === 'cap') continue
    const b = p.kind === 'wing' ? manifest.modules.wing.bounds : manifest.modules[p.kind].bounds
    const a = toTile(toWorld({ x: b.minX, z: b.minZ }, p), proj)
    const c = toTile(toWorld({ x: b.maxX - 1e-6, z: b.maxZ - 1e-6 }, p), proj)
    const rect: TileRect = {
      tx: Math.min(a.tx, c.tx),
      ty: Math.min(a.ty, c.ty),
      tw: Math.abs(c.tx - a.tx) + 1,
      th: Math.abs(c.ty - a.ty) + 1,
    }
    const id = tiles.tile({
      layer: 'floor',
      kind: FLOOR[p.kind],
      ...(p.theme && { theme: p.theme }),
    })
    for (let y = Math.max(0, rect.ty); y < Math.min(h, rect.ty + rect.th); y++)
      for (let x = Math.max(0, rect.tx); x < Math.min(w, rect.tx + rect.tw); x++)
        floor[y * w + x] = id
    const box = {
      x: rect.tx * TILE_PX,
      y: rect.ty * TILE_PX,
      w: rect.tw * TILE_PX,
      h: rect.th * TILE_PX,
    }
    const room: PixelRoom = { id: p.id, name: '', box, rect, placement: p.id }
    if (p.theme) room.theme = p.theme
    if (p.provider) room.provider = p.provider
    rooms.push(room)
  }
  // Thin walls just outside the floor's outline, merged into runs along each row and column.
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && floor[y * w + x]! > 0
  const walls: MapWall[] = []
  const runs = (
    n: number,
    len: number,
    edge: (i: number, k: number) => boolean,
    make: (i: number, k0: number, k1: number) => MapWall,
  ) => {
    for (let i = 0; i < n; i++) {
      let k = 0
      while (k < len) {
        if (!edge(i, k)) {
          k++
          continue
        }
        const k0 = k
        while (k < len && edge(i, k)) k++
        walls.push(make(i, k0, k))
      }
    }
  }
  const T = WALL_PX
  // North edges (a room below: the wall shows its ¾ face), south edges, then west and east.
  runs(
    h,
    w,
    (y, x) => at(x, y) && !at(x, y - 1),
    (y, x0, x1) => ({
      box: { x: x0 * TILE_PX, y: y * TILE_PX - T, w: (x1 - x0) * TILE_PX, h: T },
      kind: 'solid',
      face: 's',
    }),
  )
  runs(
    h,
    w,
    (y, x) => at(x, y) && !at(x, y + 1),
    (y, x0, x1) => ({
      box: { x: x0 * TILE_PX, y: (y + 1) * TILE_PX, w: (x1 - x0) * TILE_PX, h: T },
      kind: 'solid',
      face: null,
    }),
  )
  runs(
    w,
    h,
    (x, y) => at(x, y) && !at(x - 1, y),
    (x, y0, y1) => ({
      box: { x: x * TILE_PX - T, y: y0 * TILE_PX - T, w: T, h: (y1 - y0) * TILE_PX + 2 * T },
      kind: 'solid',
      face: null,
    }),
  )
  runs(
    w,
    h,
    (x, y) => at(x, y) && !at(x + 1, y),
    (x, y0, y1) => ({
      box: { x: (x + 1) * TILE_PX, y: y0 * TILE_PX - T, w: T, h: (y1 - y0) * TILE_PX + 2 * T },
      kind: 'solid',
      face: null,
    }),
  )
  const objects: MapObject[] = []
  for (const a of layout.anchors.values()) {
    if (!/^spot:elevator:\d+$/.test(a.local)) continue
    const { px, py } = toPixel(a.pos, proj)
    const box = { x: Math.round(px) - TILE_PX, y: Math.round(py) - T, w: 2 * TILE_PX, h: T }
    objects.push({
      id: `${a.placement}/elevator-door:${a.local.slice(a.local.lastIndexOf(':') + 1)}`,
      kind: 'elevator-door',
      box,
      sortY: box.y + box.h,
      solid: false,
      interact: { kind: 'object', object: 'elevator' },
    })
  }
  const solids = walls.map((x) => x.box)
  return {
    widthTiles: w,
    heightTiles: h,
    widthPx,
    heightPx,
    originM,
    layers: { floor },
    objects,
    walls,
    solids,
    solidIndex: indexSolids(solids, widthPx, heightPx),
    rooms,
    key: `footprint|${layout.key}`,
    dirty: layout.placements.map((p) => p.id),
  }
}

/** World centre of a view region (null: unknown id; 'overview' is handled by the camera). */
export function regionCenter(layout: BuildingLayout, viewId: string): Vec2 | null {
  const centroid = (placement: string, re: RegExp): Vec2 | null => {
    const as = [...layout.anchors.values()].filter(
      (a) => a.placement === placement && re.test(a.local),
    )
    if (!as.length) return null
    return {
      x: as.reduce((s, a) => s + a.pos.x, 0) / as.length,
      z: as.reduce((s, a) => s + a.pos.z, 0) / as.length,
    }
  }
  const [kind, provider, annex] = viewId.split(':')
  if (kind === 'atrium' || kind === 'street') {
    const p = layout.placements.find((x) => x.kind === kind)
    if (!p) return null
    return kind === 'atrium' ? (centroid(p.id, /^spot:elevator:/) ?? p.position) : p.position
  }
  const wing = layout.placements.find(
    (p) => p.kind === 'wing' && p.provider === provider && String(p.annex ?? 0) === (annex ?? '0'),
  )
  if (!wing) return null
  if (kind === 'adapters' || kind === 'adapters-door') return centroid(wing.id, /^spot:station:/)
  if (kind === 'library' || kind === 'library-rules')
    return centroid(wing.id, /^(seat:reading|spot:shelf):/)
  return centroid(wing.id, /^seat:desk:/) ?? toWorld({ x: 15, z: 0 }, wing)
}
