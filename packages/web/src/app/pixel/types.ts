// Contract for the optional 2D RPG mode (plan §3, §8–§10). Pure data, no DOM or canvas.
// Owned by the lead; app/pixel/* produces these shapes, adapters/pixel/* and adapters/dom/* render them.
// The 2D mode only *draws* the same office state the 3D mode uses: it adds no behaviour of its own.
import type { AgentStatus, ViewMode } from '@agent-office/shared'
import type { CapabilityRef } from '../library-types.ts'
import type { ThemeId } from '../office-types.ts'

/**
 * Scale (GBA scale, plan "2D at GBA scale" §1): 16 px per metre. Floors are 16 px tiles = 1 m
 * cells; furniture, walls and rooms are placed at their exact plan positions in pixels (not
 * snapped to tiles). A character (16×24) is one metre wide.
 */
export const PX_PER_M = 16
export const TILE_PX = 16
export const TILE_M = TILE_PX / PX_PER_M
/** Logical canvas, integer-scaled to the window (letterboxed). */
export const VIEW_W = 480
export const VIEW_H = 270

export type Dir4 = 'n' | 'e' | 's' | 'w'

export interface TilePos {
  tx: number
  ty: number
}
export interface TileRect {
  tx: number
  ty: number
  tw: number
  th: number
}
/** A rect in map pixels (integers; origin = `PixelMap.originM`). */
export interface PxRect {
  x: number
  y: number
  w: number
  h: number
}

// ── Floor plan as exported by Blender (graphics contract §11), module-local metres ──────────
export type WallKind = 'solid' | 'glass' | 'curtain'
export const FURNITURE_KINDS = [
  'desk',
  'chair',
  'meeting-table',
  'booth',
  'station',
  'core-rack',
  'bookshelf',
  'board',
  'notebook-rack',
  'reading-table',
  'sofa',
  'armchair',
  'beanbag',
  'kitchen-counter',
  'island',
  'fridge',
  'coffee-machine',
  'plant',
  'planter',
  'bench',
  'reception-desk',
  'elevator',
  'pingpong',
  'arcade',
  'cafe-table',
  'cafe-bar',
  'led-wall',
  'sign',
  'rug',
  'tv',
] as const
export type FurnitureKind = (typeof FURNITURE_KINDS)[number]

export interface PlanRoom {
  id: string
  name: string
  /** [x0, z0, x1, z1] in module-local metres. */
  rect: [number, number, number, number]
  floor?: string
}
export interface PlanWall {
  a: [number, number]
  b: [number, number]
  kind: WallKind
  /** Door/gap intervals [t0, t1] in metres along a→b. */
  openings?: [number, number][]
  /** Which side of the a→b line the wall body extends to (−1 left, +1 right, module-local). */
  side?: -1 | 1
  /** Wall body thickness in metres. */
  thick?: number
}
export interface PlanFurniture {
  kind: FurnitureKind
  x: number
  z: number
  w: number
  d: number
  yaw: number
  /** Interactive reference, e.g. 'station:3', 'book:12', 'board:2', 'notebook:1', 'booth:0'. */
  ref?: string
}
export interface ModulePlan {
  rooms: PlanRoom[]
  walls: PlanWall[]
  furniture: PlanFurniture[]
}
/** Module kind → plan (wings share one plan across themes). */
export type PlanByModule = Partial<
  Record<'atrium' | 'street' | 'wing' | 'garden' | 'cap', ModulePlan>
>

// ── The generated world (map pixels, 16 px per metre) ────────────────────────────────────────
export interface MapObject {
  id: string
  kind: FurnitureKind | 'door' | 'window' | 'booth-lamp' | 'elevator-door'
  /**
   * The footprint in map pixels, after the module's yaw. It is both the solid box (when `solid`)
   * and the base the art is drawn on: fixed art is drawn with its base exactly on `box` and its
   * overhang above; strips repeat along the long axis; areas 9-slice-fill it.
   */
  box: PxRect
  /** Feet line in map pixels (the box's bottom edge), for y-sorting with characters. */
  sortY: number
  solid: boolean
  theme?: ThemeId
  facing?: Dir4
  /** Drawing orientation: 'v' when the footprint is taller than wide (vertical art variants). */
  orientation?: 'h' | 'v'
  /** How the renderer fills `box`: one sprite, a sprite repeated along the long axis, or a 9-slice. */
  fill?: 'sprite' | 'repeat' | 'area'
  /** Against a wall: the art never crosses that wall (no overhang drawn past it). */
  wallMounted?: boolean
  /** Room id the object belongs to (for invariants and debug). */
  room?: string
  /** Interactive objects: what E/click opens. */
  interact?:
    | { kind: 'capability'; ref: CapabilityRef }
    | { kind: 'object'; object: 'elevator' | 'stats-board' | 'sign'; label?: string }
}

/** One wall run between openings, in map pixels (at least `WALL_PX` thick). */
export interface MapWall {
  box: PxRect
  kind: 'solid' | 'glass'
  /**
   * The side whose 3/4 face is drawn: 's' for a horizontal wall seen from the room below it.
   * Vertical walls and walls with no room below draw only their top strip (null).
   */
  face: 's' | null
  theme?: ThemeId
}
/** Minimum wall thickness in px (drawn and solid), and the 3/4 face height drawn above it. */
export const WALL_PX = 4
export const WALL_FACE_PX = 12

export interface PixelRoom {
  id: string
  name: string
  /** Exact room box in map pixels. */
  box: PxRect
  /** The 1 m cells the room covers (minimap, HUD room lookup). */
  rect: TileRect
  theme?: ThemeId
  provider?: string
  placement: string
}

/** Uniform bucket grid over `PixelMap.solids` for fast circle/rect queries. */
export interface SolidIndex {
  /** Bucket size in px. */
  cellPx: number
  cols: number
  rows: number
  /** Row-major; each bucket lists indices into `PixelMap.solids`. */
  buckets: number[][]
}

export interface PixelMap {
  /** 1 m floor cells. */
  widthTiles: number
  heightTiles: number
  widthPx: number
  heightPx: number
  /** World metres of pixel (0, 0) (bounds min, padded). */
  originM: { x: number; z: number }
  /** Floor tile ids per 1 m cell (atlas indices; 0 = empty), row-major. */
  layers: { floor: Uint16Array }
  objects: MapObject[]
  walls: MapWall[]
  /** Everything that blocks the player: wall boxes + solid object boxes. */
  solids: PxRect[]
  solidIndex: SolidIndex
  rooms: PixelRoom[]
  /** Changes only when the building layout or the plan changes. */
  key: string
  /** Placements whose geometry changed since the previous map (chunk re-render list). */
  dirty: string[]
}

// ── Animation ─────────────────────────────────────────────────────────────────────────────────
export const PIXEL_ANIMS = [
  'idle',
  'walk',
  'sit',
  'sit-type',
  'sit-think',
  'sit-talk',
  'idle-talk',
  'read',
  'phone',
  'stand-interact',
  'coffee',
  'lounge',
  'pingpong',
  'confused',
  'wave',
  'elevator-in',
  'elevator-out',
] as const
export type PixelAnim = (typeof PIXEL_ANIMS)[number]
export type StatusIcon = 'thinking' | 'tool' | 'waiting' | 'error' | null

// ── Interaction and dialogue ──────────────────────────────────────────────────────────────────
export type InteractTarget =
  | { kind: 'agent'; id: string }
  | { kind: 'capability'; ref: CapabilityRef }
  | { kind: 'object'; object: 'elevator' | 'stats-board' | 'sign'; label?: string }

export type DialogueAction =
  'talk' | 'details' | 'follow' | 'open' | 'open-library' | 'go-parent' | 'review'

export interface DialogueVM {
  title: string
  subtitle?: string
  /** Status chip (agents only). */
  status?: { status: AgentStatus; label: string; color: string }
  /** One or two plain lines; never message or transcript content beyond existing snippets. */
  lines: string[]
  actions: { id: DialogueAction; label: string }[]
  /** For go-parent / talk / review / follow. */
  agentId?: string
  parentId?: string
  ref?: CapabilityRef
}

// ── HUD ───────────────────────────────────────────────────────────────────────────────────────
export interface AlertVM {
  agentId: string
  kind: 'approval' | 'waiting' | 'error'
  text: string
  /** True → opening goes straight to the permission card. */
  opensPermission: boolean
}
export interface PixelHudVM {
  room: string
  counts: { agents: number; waiting: number; errors: number }
  alerts: AlertVM[]
  moreAlerts: number
  selected?: { id: string; text: string }
}
export interface MinimapVM {
  widthTiles: number
  heightTiles: number
  dots: { id: string; tx: number; ty: number; color: string; waiting?: boolean; error?: boolean }[]
  player?: TilePos
  /** Wing names (provider) and major room names, at their centres. */
  labels?: { text: string; tx: number; ty: number; kind: 'wing' | 'room' }[]
  /** The tiles the camera shows right now. */
  viewport?: TileRect
}

/** Atlas base size (px) of an object's art for an orientation; null when the kind has no art. */
export interface SpriteFoot {
  foot(kind: string, orientation: 'h' | 'v'): { w: number; h: number } | null
}
export interface DirectoryVM {
  query: string
  wings: {
    viewId: string
    label: string
    topics: { label: string; agents: { id: string; name: string; status: AgentStatus }[] }[]
  }[]
}

export type { ViewMode }
