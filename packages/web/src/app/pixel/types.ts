// Contract for the optional 2D RPG mode (plan §3, §8–§10). Pure data, no DOM or canvas.
// Owned by the lead; app/pixel/* produces these shapes, adapters/pixel/* and adapters/dom/* render them.
// The 2D mode only *draws* the same office state the 3D mode uses: it adds no behaviour of its own.
import type { AgentStatus, ViewMode } from '@agent-office/shared'
import type { CapabilityRef } from '../library-types.ts'
import type { ThemeId } from '../office-types.ts'

/** Metres per tile and pixels per tile (16 px tiles at 0.5 m: a character is one tile wide). */
export const TILE_M = 0.5
export const TILE_PX = 16
export const PX_PER_M = TILE_PX / TILE_M
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

// ── The generated world ───────────────────────────────────────────────────────────────────────
export interface MapObject {
  id: string
  kind: FurnitureKind | 'door' | 'window' | 'booth-lamp' | 'elevator-door'
  /** Footprint in tiles (world space, after the module's yaw). */
  rect: TileRect
  /** Feet line in pixels, for y-sorting with characters. */
  sortY: number
  solid: boolean
  theme?: ThemeId
  facing?: Dir4
  /** Interactive objects: what E/click opens. */
  interact?:
    | { kind: 'capability'; ref: CapabilityRef }
    | { kind: 'object'; object: 'elevator' | 'stats-board' | 'sign'; label?: string }
}

export interface PixelRoom {
  id: string
  name: string
  rect: TileRect
  theme?: ThemeId
  provider?: string
  placement: string
}

export interface PixelMap {
  widthTiles: number
  heightTiles: number
  /** World metres of tile (0, 0) (bounds min, padded). */
  originM: { x: number; z: number }
  /** Tile ids per layer (atlas indices; 0 = empty), row-major. */
  layers: { floor: Uint16Array; walls: Uint16Array; overhead: Uint16Array }
  objects: MapObject[]
  /** 1 = blocked for the player (walls + solid furniture). */
  solid: Uint8Array
  rooms: PixelRoom[]
  /** Changes only when the building layout or the plan changes. */
  key: string
  /** Placements whose tiles changed since the previous map (chunk re-render list). */
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
  dots: { id: string; tx: number; ty: number; color: string }[]
  player?: TilePos
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
