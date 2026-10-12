// Adapter-side helpers PL's pure modules don't cover: the world centre of a view region (2D
// framing per view id) and a fallback map from module footprints for manifests without floor
// plans (PL's buildPixelMap draws nothing for modules without one; a notice says so).
import { toWorld } from '../../app/building.ts'
import type { Manifest } from '../../app/manifest.ts'
import type { BuildingLayout, ModulePlacement, Vec2 } from '../../app/office-types.ts'
import type { TileResolver } from '../../app/pixel/map.ts'
import { projectionFor, toTile } from '../../app/pixel/project.ts'
import {
  TILE_M,
  TILE_PX,
  type MapObject,
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

/** A walkable map from the module footprints (no floor plan): floors, walls around, elevator doors. */
export function footprintMap(
  layout: BuildingLayout,
  manifest: Manifest,
  tiles: TileResolver,
): PixelMap {
  const proj = projectionFor(layout.bounds)
  const { widthTiles: w, heightTiles: h, originM } = proj
  const floor = new Uint16Array(w * h)
  const walls = new Uint16Array(w * h)
  const overhead = new Uint16Array(w * h)
  const solid = new Uint8Array(w * h).fill(1)
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
      for (let x = Math.max(0, rect.tx); x < Math.min(w, rect.tx + rect.tw); x++) {
        floor[y * w + x] = id
        solid[y * w + x] = 0
      }
    const room: PixelRoom = { id: p.id, name: '', rect, placement: p.id }
    if (p.theme) room.theme = p.theme
    if (p.provider) room.provider = p.provider
    rooms.push(room)
  }
  const face = tiles.tile({ layer: 'wall', kind: 'solid', edge: 'h' })
  const side = tiles.tile({ layer: 'wall', kind: 'solid', edge: 'v' })
  const top = tiles.tile({ layer: 'overhead', kind: 'solid', edge: 'h' })
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (floor[i]) continue
      const at = (dx: number, dy: number) => {
        const xx = x + dx
        const yy = y + dy
        return xx >= 0 && yy >= 0 && xx < w && yy < h && floor[yy * w + xx]! > 0
      }
      if (at(0, 1)) {
        walls[i] = face
        if (y > 0) overhead[i - w] = top
      } else if (at(0, -1) || at(1, 0) || at(-1, 0)) walls[i] = side
    }
  const objects: MapObject[] = []
  for (const a of layout.anchors.values()) {
    if (!/^spot:elevator:\d+$/.test(a.local)) continue
    const t = toTile(a.pos, proj)
    objects.push({
      id: `${a.placement}/elevator-door:${a.local.slice(a.local.lastIndexOf(':') + 1)}`,
      kind: 'elevator-door',
      rect: { tx: t.tx, ty: t.ty, tw: 1, th: 1 },
      sortY: (t.ty + 1) * TILE_PX,
      solid: false,
      interact: { kind: 'object', object: 'elevator' },
    })
  }
  return {
    widthTiles: w,
    heightTiles: h,
    originM,
    layers: { floor, walls, overhead },
    objects,
    solid,
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
  return centroid(wing.id, /^seat:desk:/) ?? toWorld({ x: 15 * TILE_M * 2, z: 0 }, wing)
}
