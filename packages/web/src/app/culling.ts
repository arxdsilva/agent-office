// Per-module culling decision (pure). Whole modules are culled by the view frustum only: the orbit
// camera may be ~180 m away and still frame the building, so a distance cull would hide modules
// that are on screen. Small runtime surfaces are hidden beyond DETAIL_DISTANCE (unreadable anyway).
export const DETAIL_DISTANCE = 32

export function moduleCulling(
  inFrustum: boolean,
  distance: number,
): { visible: boolean; detail: boolean } {
  return { visible: inFrustum, detail: inFrustum && distance < DETAIL_DISTANCE }
}
