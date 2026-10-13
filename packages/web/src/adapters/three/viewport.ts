// Pure helpers for sizing and picking against the stage element's box (not the window): the stage
// sits inside the workspace shell (sidebar + top bar) and can be hidden (display: none).
export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** Hidden or collapsed: nothing to size or render. */
export const isEmptyBox = (b: Pick<Box, 'width' | 'height'>): boolean =>
  !(b.width > 0) || !(b.height > 0)

/** Client px → normalized device coordinates (−1..1, y up) inside the box. */
export function pointerToNdc(r: Box, x: number, y: number): { x: number; y: number } {
  return {
    x: ((x - r.left) / Math.max(1, r.width)) * 2 - 1,
    y: -((y - r.top) / Math.max(1, r.height)) * 2 + 1,
  }
}

/** NDC → client px (tooltips, hover specs). */
export function ndcToClient(r: Box, ndcX: number, ndcY: number): { x: number; y: number } {
  return { x: r.left + ((ndcX + 1) / 2) * r.width, y: r.top + ((1 - ndcY) / 2) * r.height }
}
