// Links between agents and the capabilities they use (docs/capabilities.md §5–§6): where each end
// is, the arc, the color and style, and the fade after a use ends. Pure.
import type { Capability } from '@agent-office/shared'
import { CALL_FADE_MS, LIBRARY_FADE_MS } from './behavior.ts'
import { libraryKind, type LibraryMap } from './library.ts'
import type { LinkMode } from './graphics-types.ts'
import type { AgentPose, BuildingLayout, Link, Vec3 } from './office-types.ts'
import type { SlotMap } from './stations.ts'

/** Link colors (docs/capabilities.md §6). Adapters by kind; the library by category. */
export const LINK_COLORS = {
  filesystem: '#4F8CFF',
  shell: '#F5A524',
  web: '#2CB6A0',
  subagents: '#8B5CF6',
  mcp: '#EC4899',
  database: '#22C55E',
  api: '#F97316',
  skill: '#E8B74A',
  rule: '#F1E9D2',
  memory: '#9BD3A4',
} as const

/** The arc rises `clamp(distance × factor, min, max)` above the higher end. */
export const ARC_LIFT = { factor: 0.15, min: 0.8, max: 3 } as const
/** …but stays inside the building envelope. */
export const ARC_MAX_Y = 3.4
/** Link start heights when not at a desk monitor. */
export const SEATED_HEAD_Y = 1.15
export const STANDING_HEAD_Y = 1.6
/** The hand (book or station touch) while visiting. */
export const HAND_Y = { stand: 1.25, sit: 0.9 } as const
export const HAND_REACH = 0.35

export function arcControl(from: Vec3, to: Vec3): Vec3 {
  const d = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
  const lift = Math.min(ARC_LIFT.max, Math.max(ARC_LIFT.min, d * ARC_LIFT.factor))
  return {
    x: (from.x + to.x) / 2,
    y: Math.min(ARC_MAX_Y, Math.max(from.y, to.y) + lift),
    z: (from.z + to.z) / 2,
  }
}

export function linkColor(c: Pick<Capability, 'id' | 'category' | 'kind'>): string {
  const lib = libraryKind(c)
  if (lib) return LINK_COLORS[lib]
  return c.kind in LINK_COLORS ? LINK_COLORS[c.kind as keyof typeof LINK_COLORS] : LINK_COLORS.api
}

/** One agent's current (or fading) use of a capability. */
export interface LinkCall {
  agentId: string
  capability: Capability
  /** The wing whose Adapters room / Library serves the agent. */
  wing: string
  from: Vec3
  /** When the use started (ms). */
  since: number
  /** Last time it was in use (ms); `now` while still in use. */
  last: number
  /** The agent is visiting this capability's room (the link stays at full strength). */
  visiting: boolean
}

export interface LinkContext {
  layout: BuildingLayout
  stations: Map<string, SlotMap>
  library: Map<string, LibraryMap>
}

/** The capability's port in `wing`: station, book, board or notebook (undefined without a slot/port). */
export function capabilityPort(c: Capability, wing: string, ctx: LinkContext): Vec3 | undefined {
  const lib = libraryKind(c)
  const slots = lib
    ? ctx.library.get(c.provider)?.[
        lib === 'skill' ? 'books' : lib === 'rule' ? 'boards' : 'notebooks'
      ]
    : ctx.stations.get(c.provider)
  const slot = slots?.slot.get(c.id)
  if (slot === undefined) return undefined
  const kind =
    lib === 'skill' ? 'book' : lib === 'rule' ? 'board' : lib === 'memory' ? 'notebook' : 'station'
  return ctx.layout.ports?.get(`${wing}/port:${kind}:${slot}`)
}

export function planLinks(calls: LinkCall[], ctx: LinkContext, now: number): Link[] {
  const out: Link[] = []
  for (const c of calls) {
    const lib = libraryKind(c.capability) !== undefined
    const fade = lib ? LIBRARY_FADE_MS : CALL_FADE_MS
    const opacity = c.visiting ? 1 : Math.min(1, 1 - (now - c.last) / fade)
    if (opacity <= 0) continue
    const to = capabilityPort(c.capability, c.wing, ctx)
    if (!to) continue
    out.push({
      id: `${c.agentId}>${c.capability.id}`,
      agentId: c.agentId,
      capabilityId: c.capability.id,
      category: c.capability.category,
      from: c.from,
      to,
      control: arcControl(c.from, to),
      color: linkColor(c.capability),
      label: c.capability.label,
      style: lib ? 'particles' : 'dash',
      state: c.visiting ? 'visiting' : 'calling',
      since: c.since,
      opacity,
    })
  }
  return out
}

const DESK_SEAT = /\/seat:desk:(\d+):(\d+)$/

/** Where an agent's link starts: its desk monitor when seated at a desk, else head height. */
export function agentPort(pose: AgentPose, layout: BuildingLayout): Vec3 {
  if (pose.anchor && pose.posture !== 'stand') {
    const m = DESK_SEAT.exec(pose.anchor)
    const placement = pose.anchor.slice(0, pose.anchor.lastIndexOf('/'))
    const p = m && layout.ports?.get(`${placement}/port:desk:${m[1]}:${m[2]}`)
    if (p) return p
    return { ...pose.pos, y: SEATED_HEAD_Y }
  }
  return { ...pose.pos, y: STANDING_HEAD_Y }
}

/** The hand in front of the agent (touching a station, or the book while reading). */
export function handPort(pose: AgentPose): Vec3 {
  return {
    x: pose.pos.x + Math.sin(pose.heading) * HAND_REACH,
    y: pose.posture === 'stand' ? HAND_Y.stand : HAND_Y.sit,
    z: pose.pos.z + Math.cos(pose.heading) * HAND_REACH,
  }
}

/** A link as drawn: 'line' is the static style (one straight segment, no per-frame update). */
export type RenderLink = Omit<Link, 'style'> & { style: Link['style'] | 'line' }

/** The Capability links lever (low-spec plan §5.3): none, static lines, or animated as planned. */
export function linksForMode(links: Link[], mode: LinkMode): RenderLink[] {
  if (mode === 'off') return []
  if (mode === 'animated') return links
  return links.map((l) => ({ ...l, style: 'line' }))
}
