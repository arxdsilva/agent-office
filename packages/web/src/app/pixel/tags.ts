// Name-tag layout for the 2D view: tags never overlap. Greedy by priority (selected, hovered,
// then nearest to the player), ties broken by id so the result is stable from frame to frame.
// Zoomed out (below 2 device px per art px), only essential tags compete.

export interface TagBox {
  id: string
  /** Centre x and top y, in logical pixels. */
  x: number
  y: number
  w: number
  h: number
  /** Higher wins. */
  priority: number
  /** Selected, hovered, waiting or error: still shown when zoomed out. */
  essential?: boolean
}

/** Below this zoom (device px per art px) only essential tags show. */
export const TAG_ZOOM_MIN = 2

/** The ids of the tags to draw at `zoom` (device px per art px; omitted = no zoom-out rule). */
export function declutterTags(tags: readonly TagBox[], zoom = Infinity): Set<string> {
  const shown = zoom < TAG_ZOOM_MIN ? tags.filter((t) => t.essential) : tags
  const order = [...shown].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1))
  const placed: TagBox[] = []
  const kept = new Set<string>()
  for (const t of order) {
    if (placed.some((p) => overlaps(p, t))) continue
    placed.push(t)
    kept.add(t.id)
  }
  return kept
}

function overlaps(a: TagBox, b: TagBox): boolean {
  return Math.abs(a.x - b.x) * 2 < a.w + b.w && a.y < b.y + b.h && b.y < a.y + a.h
}
