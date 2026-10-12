// Room lookups for the HUD ("p · Pod 2"), the minimap and the directory (plan §3.2, §9).
import { toWorld } from '../building.ts'
import type { Manifest } from '../manifest.ts'
import type { BuildingLayout, ModulePlacement, Vec2 } from '../office-types.ts'
import { PIXEL_COPY } from '../pixel-copy.ts'
import type { PixelMap, PixelRoom, TilePos } from './types.ts'

const contains = (r: PixelRoom, t: TilePos) =>
  t.tx >= r.rect.tx &&
  t.ty >= r.rect.ty &&
  t.tx < r.rect.tx + r.rect.tw &&
  t.ty < r.rect.ty + r.rect.th

/** The smallest room containing the tile (rooms nest: a pod inside the open floor). */
export function roomAt(map: Pick<PixelMap, 'rooms'>, t: TilePos): PixelRoom | undefined {
  let best: PixelRoom | undefined
  for (const r of map.rooms)
    if (contains(r, t) && (!best || r.rect.tw * r.rect.th < best.rect.tw * best.rect.th)) best = r
  return best
}

const MODULE_NAMES: Record<string, string> = {
  atrium: PIXEL_COPY.hud.lobby,
  street: PIXEL_COPY.hud.street,
  garden: PIXEL_COPY.hud.garden,
  cap: PIXEL_COPY.hud.street,
}

/** HUD text for where the player stands: "<wing sign> · <room>", a room name, or the module's. */
export function roomLabel(
  map: Pick<PixelMap, 'rooms'>,
  layout: BuildingLayout,
  t: TilePos,
): string {
  const room = roomAt(map, t)
  if (!room) return ''
  const p = layout.placements.find((x) => x.id === room.placement)
  if (p?.kind === 'wing') {
    const sign = p.label ?? p.provider ?? p.id
    return room.name ? `${sign} · ${room.name}` : sign
  }
  return room.name || (p ? (MODULE_NAMES[p.kind] ?? '') : '')
}

/** The view-bar id that frames a placement (the same ids `viewsFor` lists). */
export function viewIdOf(p: ModulePlacement): string {
  if (p.kind === 'atrium') return 'atrium'
  if (p.kind === 'street') return 'street'
  if (p.kind === 'wing') return `wing:${p.provider}:${p.annex ?? 0}`
  return 'overview'
}

/** The view id for a tile (minimap clicks): its room's placement, else the overview. */
export function viewIdAt(map: Pick<PixelMap, 'rooms'>, layout: BuildingLayout, t: TilePos): string {
  const room = roomAt(map, t)
  const p = room && layout.placements.find((x) => x.id === room.placement)
  return p ? viewIdOf(p) : 'overview'
}

/** The placement whose module bounds contain a world point (minimap clicks), else undefined. */
export function placementAt(
  layout: BuildingLayout,
  manifest: Manifest,
  pos: Vec2,
): ModulePlacement | undefined {
  return layout.placements.find((p) => {
    const b = manifest.modules[p.kind].bounds
    const a = toWorld({ x: b.minX, z: b.minZ }, p)
    const c = toWorld({ x: b.maxX, z: b.maxZ }, p)
    return (
      pos.x >= Math.min(a.x, c.x) &&
      pos.x <= Math.max(a.x, c.x) &&
      pos.z >= Math.min(a.z, c.z) &&
      pos.z <= Math.max(a.z, c.z)
    )
  })
}
