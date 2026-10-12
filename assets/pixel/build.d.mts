// Types for build.mjs (used by build.test.ts).
export interface PxFrame {
  name: string
  attrs: Record<string, string>
  meta: Record<string, unknown>
  rows: string[]
  file: string
  line: number
  w: number
  h: number
}
export interface Img {
  w: number
  h: number
  data: Uint8Array
}
export interface AtlasFrame {
  sheet: string
  x: number
  y: number
  w: number
  h: number
  ax: number
  ay: number
}
export interface Atlas {
  version: number
  sheets: Record<string, { file: string; w: number; h: number }>
  frames: Record<string, AtlasFrame>
  tiles: ({ id: string; name: string; theme?: string; frame: string; layer: string; solid: boolean; mask?: number } | null)[]
  tileIds: Record<string, number>
  tileSets: Record<string, unknown>
  objects: Record<string, { variants: Record<string, { frame: string; themed: boolean; foot: [number, number]; footPx: [number, number]; flat?: boolean; solid: boolean; sortY: number; [k: string]: unknown }> }>
  characters: {
    size: [number, number]
    anchor: [number, number]
    layers: string[]
    recolor: { source: string[]; groups: Record<string, string | null> }
    poses: Record<string, { hand: [number, number]; propBehind: boolean; seated: boolean }>
    props: string[]
    [k: string]: unknown
  }
  animations: { name: string; dir: string; loop: boolean; frames: { ref: string; ms: number; alpha?: number }[] }[]
  clipDurations: Record<string, number>
  effects: Record<string, { loop: boolean; frames: { ref: string; ms: number }[] }>
  font: { cell: [number, number]; lineHeight: number; glyphs: Record<string, { frame: string; w: number; advance: number }> }
  ui: Record<string, { frame: string; slice?: number }>
  themes: Record<string, { floor: string; colors: Record<string, string> }>
  palettes: { ramps: Record<string, Record<string, string[]>>; recolorSource: string[]; office: Record<string, string | null> }
  placeholders: string[]
}
export interface Build {
  atlas: Atlas
  files: Record<string, Buffer>
  images: Record<string, { sheet: Img }>
  unusedParts: string[]
}

export declare const SRC: string
export declare const OUT: string
export declare const BUDGET_BYTES: number
export declare const DIRS: string[]
export declare const THEMES: string[]
export declare const FURNITURE_KINDS: string[]
export declare const PIXEL_ANIMS: string[]
export declare const EXTRA_OBJECTS: string[]
export declare const REQUIRED_EFFECTS: string[]
export declare const REQUIRED_TILES: string[]
export declare const EXTRA_GLYPHS: string[]
export declare const CHAR_LAYERS: string[]
export declare const THIN_WALLS: Record<string, Record<string, string>>
export declare function loadPalettes(): {
  office: Record<string, string | null>
  themes: Record<string, Record<string, string>>
  char: Record<string, string | number | null>
  ramps: Record<string, Record<string, string[]>>
  recolorSource: string[]
}
export declare function parsePx(text: string, file?: string): PxFrame[]
export declare function readPxDir(dir: string): PxFrame[]
export declare function transformRows(rows: string[], attrs?: Record<string, string>): string[]
export declare function autotileRows(rows: string[], mask: number, edge?: string, lip?: string | null): string[]
export declare function encodePng(img: Img): Buffer
export declare function image(w: number, h: number): Img
export declare function hexToRgba(hex: string | null): [number, number, number, number]
export declare function buildAtlas(opts?: { log?: (m: string) => void }): Build
export declare function totalBytes(files: Record<string, Buffer>): number
