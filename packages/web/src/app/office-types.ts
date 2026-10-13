// Shared renderer types (see docs/graphics-contract.md). Pure data — no three.js here.
import type { Agent, CapabilityCategory } from '@agent-office/shared'

export type Vec2 = { x: number; z: number }
/** A world point with height (link attach points, `port:*` anchors). */
export type Vec3 = { x: number; y: number; z: number }

export type ThemeId = 'terracotta' | 'nordic' | 'forest' | 'ocean' | 'neon' | 'brass'
export type ModuleKind = 'atrium' | 'street' | 'wing' | 'garden' | 'cap'
export type Pose = 'sit' | 'stand' | 'lounge'
export type AnchorId = string

/** Placement of one module instance in the world (translation + yaw; never mirrored). */
export interface ModulePlacement {
  /** Unique instance id, e.g. "atrium", "street:0", "wing:claude-code:0", "garden:1:L", "cap". */
  id: string
  kind: ModuleKind
  /** For wings: theme id; otherwise undefined. */
  theme?: ThemeId
  /** For wings: owning provider and annex index (0 = main wing). */
  provider?: string
  annex?: number
  bay?: number
  side?: 'L' | 'R'
  position: Vec2
  /** Yaw in radians (three.js rotation.y). */
  yaw: number
  /** Dimmed = provider gone, wing kept for a grace period before freeing. */
  dimmed?: boolean
  /** For wings: sign text, e.g. "claude-code" or "claude-code · 2" for the first annex. */
  label?: string
  /** For wings: 0 the first time a theme is used, 1+ when themes repeat (>6 providers) → vary the sign color. */
  signVariant?: number
}

/** A wing slot remembered between `planBuilding` calls (slot index → bay = ⌊i/2⌋, side = i even ? 'R' : 'L'). */
export interface WingSlot {
  index: number
  provider: string
  annex: number
  theme: ThemeId
  signVariant: number
  /** Last time (ms) the provider needed this wing. */
  lastNeeded: number
}

export interface WorldAnchor {
  /** World-unique id: "<placementId>/<localAnchorId>", e.g. "wing:claude-code:0/seat:desk:3:2". */
  id: AnchorId
  placement: string
  local: string
  pos: Vec2
  heading: number
  pose: Pose
  room?: string
  screen?: string
  led?: string
  approach: Vec2
  /** World nav node the approach point connects to (the merged `ap:<local>` node, else the nearest node). */
  navNode?: string
}

export interface NavNode {
  id: string
  pos: Vec2
  /** Corridor half-width (m). */
  width: number
}

export interface NavGraph {
  nodes: Map<string, NavNode>
  /** Adjacency list (undirected, stored both ways). */
  adj: Map<string, string[]>
}

export interface AABB {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

export interface BuildingLayout {
  placements: ModulePlacement[]
  anchors: Map<AnchorId, WorldAnchor>
  nav: NavGraph
  bounds: AABB
  /** provider → placement ids of its wings (main first, then annexes). */
  wingsByProvider: Map<string, string[]>
  /** Stable key that changes only when placements change (for cheap equality checks). */
  key: string
  /** Wing slot memory for the next `planBuilding` call (stable order, dimming grace). */
  slots?: WingSlot[]
  /** World `port:*` link attach points (with height), keyed "<placementId>/<localPortId>". */
  ports?: Map<AnchorId, Vec3>
}

/** agentId → desk seat anchor id. */
export type Seating = Map<string, AnchorId>

export type Activity =
  | 'arriving'
  | 'desk-work'
  | 'desk-think'
  | 'desk-error'
  | 'desk-idle'
  | 'meeting'
  | 'booth'
  | 'kitchen'
  | 'lounge'
  | 'cafe'
  | 'pingpong'
  | 'leaving'
  /** Overlay at the desk: a link to an adapter station while a tool uses it (docs/capabilities.md §5). */
  | 'connection-call'
  /** Standing at the adapter's station (StandInteract). */
  | 'connection-visit'
  /** Overlay at the desk: a link to a book, board or notebook while a skill or rule is used. */
  | 'library-call'
  /** In the Library: shelf (ShelfPick) → reading seat (SitRead), or reading standing at the shelf. */
  | 'library-visit'

export interface Intent {
  activity: Activity
  /** Anchor the agent should be at for this activity. */
  target: AnchorId
  /** When this intent started (ms). */
  since: number
  /** Anchors visited before the target, in order. `arriving`: [elevator spot, reception spot]. */
  via?: AnchorId[]
  /** Appear directly at the target (agents already present when the office opens) instead of arriving. */
  spawn?: boolean
  /** Capability id a call or visit is about (connection-* / library-*). */
  capability?: string
  /** Metres to the right of shared spots (`spot:shelf:*`) in `via`/`target`: the second person stands 0.6 m aside. */
  lateral?: number
}

export type ClipName =
  | 'Idle'
  | 'Walk'
  | 'TurnL90'
  | 'TurnR90'
  | 'SitDown'
  | 'StandUp'
  | 'SitIdle'
  | 'SitType'
  | 'SitThink'
  | 'SitTalk'
  | 'SitLaptop'
  | 'StandTalk'
  | 'PhoneCall'
  | 'DrinkCoffee'
  | 'LoungeSit'
  | 'PingPong'
  | 'Wave'
  | 'HeadScratch'
  | 'ElevatorIn'
  | 'StandInteract'
  | 'SitRead'
  | 'ShelfPick'

export type PropName = 'laptop' | 'cup' | 'phone' | 'paddle' | 'book'

/** A timed path: walking along a smoothed polyline with a trapezoidal speed profile. */
export interface TimedPath {
  /** Densely sampled points along the smoothed spline (≤ 0.25 m apart). */
  points: Vec2[]
  /** Cumulative arc length at each point. */
  lengths: number[]
  totalLength: number
  vMax: number
  accel: number
  /** Total walking duration (s). */
  duration: number
  /** Heading to face at the end (anchor heading). */
  endHeading: number
  /** Ground speed at t = 0 (m/s); > 0 when re-planned mid-walk. Default 0. */
  startSpeed?: number
  /** Deceleration (m/s²) used to stop at the end. Default `accel`. */
  decel?: number
  /** Heading before the walk starts (used for the turn-in-place phase). */
  startHeading?: number
  /** Seconds spent turning in place before walking (> 0 only when the turn exceeds 100°). */
  turnDuration?: number
}

export type Step =
  | {
      kind: 'clip'
      clip: ClipName
      loop: boolean
      fadeIn: number
      /** seconds; for one-shots = clip duration */ duration?: number
      /** Start this many seconds into the clip (resuming an interrupted one-shot). Default 0. */
      offset?: number
      /** Anchor occupied while this clip plays (seat or spot). */
      anchor?: AnchorId
      /** One-shots: hold the last frame after it ends (e.g. ShelfPick) until new steps arrive. */
      hold?: boolean
    }
  | { kind: 'move'; path: TimedPath }
  | { kind: 'face'; heading: number; duration: number }
  | { kind: 'prop'; prop: PropName; on: boolean }
  | {
      kind: 'teleport'
      pos: Vec2
      heading: number
      /** anchor landed on, if any */ anchor?: AnchorId
    } // only for spawn at the elevator (initial placement); implies the Idle clip
  | { kind: 'fade'; to: 0 | 1; duration: number } // only for elevator arrival/exit; non-blocking: runs alongside the following steps

/** What the controller hands the scene for each agent. */
export interface AgentPlan {
  agent: Agent
  intent: Intent
  /** Present only when the intent changed since the last plan; the scene runs it from the agent's current state. */
  steps?: Step[]
  /** Team color source for subagent badges (parent id) — scene derives colors from ids. */
  teamOf?: string
}

export type { GraphicsQuality } from '@agent-office/shared'

export type Posture = 'stand' | 'sit' | 'lounge'

/** Where an agent is right now (predicted by the director from the steps it issued). */
export interface AgentPose {
  pos: Vec2
  heading: number
  /** Ground speed (m/s); > 0 only while walking. */
  speed: number
  posture: Posture
  /** Anchor the agent occupies (seated at / standing on), if any. */
  anchor?: AnchorId
  /** Clip playing now (Walk while moving). */
  clip?: ClipName
  /** Seconds into the current clip. */
  clipTime?: number
  /** Seconds left of the current one-shot clip (0 / undefined for loops). */
  clipRemaining?: number
  /** False before the spawn teleport and after the leave fade. */
  visible: boolean
  props: PropName[]
}

/** A visible link from an agent to a capability (station, book, board or notebook), docs/capabilities.md §5. */
export interface Link {
  /** `<agentId>><capabilityId>` (stable while the link lives). */
  id: string
  agentId: string
  capabilityId: string
  category: CapabilityCategory
  /** Agent end: desk monitor port, head height, or the hand while visiting. */
  from: Vec3
  /** Capability end: the station, book, board or notebook port. */
  to: Vec3
  /** Quadratic Bezier control point (arc above partitions, ≤ 3.4 m). */
  control: Vec3
  color: string
  label: string
  /** Adapters: dashes; skills and rules: drifting page particles. */
  style: 'dash' | 'particles'
  state: 'calling' | 'visiting'
  /** When the current use started (ms). */
  since: number
  /** 1 while in use, fading to 0 after it ends. */
  opacity: number
}

/**
 * Semantic interactions (docs/special-3d/interaction-contract.md): world objects in every mode map
 * to the same application commands. Renderers only report what was picked; the controller decides.
 */
export const INTERACTION_KINDS = [
  'project-directory',
  'agent-workstation',
  'command-display',
  'memory-terminal',
  'context-console',
  'archive-terminal',
  'handoff-platform',
  'capability-station',
  'provider-terminal',
] as const
export type InteractionKind = (typeof INTERACTION_KINDS)[number]
export interface InteractionHit {
  kind: InteractionKind
  /** The anchor that was used (e.g. `interact:memory-terminal:0`); never shown to the user. */
  anchor: string
  /** Context the object carries: the agent at a workstation, a station's capability, a provider. */
  agentId?: string
  capability?: string
  provider?: string
}
