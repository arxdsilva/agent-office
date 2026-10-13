// What "E" talks to (plan §8.1): the nearest interactable within 1.5 m in a 90° cone in front of
// the player, agents before objects. Objects are measured to their nearest edge (a 2 m shelf counts
// from its front, not its centre).
import type { ProviderSurfaces } from '../capability-vm.ts'
import type { CapabilityRef } from '../library-types.ts'
import { parseAnchorId } from '../building.ts'
import type { AABB, BuildingLayout, Vec2, Vec3 } from '../office-types.ts'
import { PIXEL_COPY } from '../pixel-copy.ts'
import { capabilitySlot } from './map.ts'
import { dirVector } from './project.ts'
import { PX_PER_M, type Dir4, type InteractTarget, type PixelMap } from './types.ts'

export const INTERACT_RANGE_M = 1.5
/** Side of a book / notebook port's hit box (m). */
const PORT_M = 0.25
/** Half the cone (45°), with a hair of tolerance for exact diagonals. */
const CONE_COS = Math.cos(Math.PI / 4) - 1e-9

export interface InteractAgent {
  id: string
  pos: Vec2
  parentId?: string
}
export interface InteractObject {
  id: string
  target: InteractTarget
  /** Footprint in world metres. */
  box: AABB
}
export interface InteractHit {
  id: string
  target: InteractTarget
  distance: number
  /** Subagents: their parent (the dialogue offers "Go to <parent>"). */
  parentId?: string
}

/** Distance and cone test from the player to point `q`; undefined when out of reach. */
function reach(from: Vec2, facing: Dir4, q: Vec2): number | undefined {
  const dx = q.x - from.x
  const dz = q.z - from.z
  const d = Math.hypot(dx, dz)
  if (d > INTERACT_RANGE_M) return undefined
  if (d < 1e-6) return 0
  const f = dirVector(facing)
  return (dx * f.x + dz * f.z) / d >= CONE_COS ? d : undefined
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function interactionTarget(
  player: { pos: Vec2; facing: Dir4 },
  agents: readonly InteractAgent[],
  objects: readonly InteractObject[],
): InteractHit | null {
  let best: InteractHit | null = null
  for (const a of agents) {
    const d = reach(player.pos, player.facing, a.pos)
    if (d === undefined || (best && best.distance <= d)) continue
    best = { id: a.id, target: { kind: 'agent', id: a.id }, distance: d }
    if (a.parentId) best.parentId = a.parentId
  }
  if (best) return best
  for (const o of objects) {
    const q = {
      x: clamp(player.pos.x, o.box.minX, o.box.maxX),
      z: clamp(player.pos.z, o.box.minZ, o.box.maxZ),
    }
    const d = reach(player.pos, player.facing, q)
    if (d === undefined || (best && best.distance <= d)) continue
    best = { id: o.id, target: o.target, distance: d }
  }
  return best
}

/** The "E: …" prompt over a target. */
export function promptFor(t: InteractTarget): string {
  if (t.kind === 'agent') return PIXEL_COPY.prompt.talk
  if (t.kind === 'capability') return PIXEL_COPY.prompt.open
  if (t.object === 'project-directory') return PIXEL_COPY.prompt.open
  return PIXEL_COPY.prompt.read
}

const SLOT_LIST = {
  station: 'stations',
  book: 'books',
  board: 'boards',
  notebook: 'notebooks',
} as const

/** Resolves a capability object's slot (`station:3` in `wing:p:0`) to what the surfaces show there. */
export function slotCapability(
  layout: BuildingLayout,
  surfaces: ReadonlyMap<string, ProviderSurfaces>,
): (placement: string, slot: string) => CapabilityRef | undefined {
  return (placement, slot) => {
    const provider = layout.placements.find((p) => p.id === placement)?.provider
    if (!provider) return undefined
    const [kind, i] = slot.split(':') as [keyof typeof SLOT_LIST, string]
    const id = surfaces.get(provider)?.[SLOT_LIST[kind]]?.[Number(i)]?.id
    return id ? { provider, id } : undefined
  }
}

/** Interactable map objects (fixed interactions plus capability slots that hold something). */
export function objectTargets(
  map: PixelMap,
  resolve: (placement: string, slot: string) => CapabilityRef | undefined,
  /**
   * `BuildingLayout.ports`: books and notebooks have no furniture `ref` in the plan, so each
   * `port:book:*` / `port:notebook:*` attach point becomes a 0.25 m target on its shelf face.
   */
  ports?: ReadonlyMap<string, Vec3>,
): InteractObject[] {
  const out: InteractObject[] = []
  for (const [id, at] of ports ?? []) {
    const { placement, local } = parseAnchorId(id)
    const m = /^port:((book|notebook):\d+)$/.exec(local)
    const ref = m && resolve(placement, m[1]!)
    if (!ref) continue
    const h = PORT_M
    out.push({
      id: `${placement}/${m[1]}`,
      target: { kind: 'capability', ref },
      box: { minX: at.x - h / 2, maxX: at.x + h / 2, minZ: at.z - h / 2, maxZ: at.z + h / 2 },
    })
  }
  for (const o of map.objects) {
    let target: InteractTarget | undefined = o.interact
    const s = capabilitySlot(o)
    if (s) {
      const ref = resolve(s.placement, s.slot)
      target = ref && { kind: 'capability', ref }
    }
    if (!target) continue
    out.push({
      id: o.id,
      target,
      box: {
        minX: map.originM.x + o.box.x / PX_PER_M,
        maxX: map.originM.x + (o.box.x + o.box.w) / PX_PER_M,
        minZ: map.originM.z + o.box.y / PX_PER_M,
        maxZ: map.originM.z + (o.box.y + o.box.h) / PX_PER_M,
      },
    })
  }
  return out
}
