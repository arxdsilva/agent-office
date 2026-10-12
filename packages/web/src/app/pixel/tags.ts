// Name-tag layout for the 2D view: tags never overlap. Greedy by priority (selected, hovered,
// then nearest to the player), ties broken by id so the result is stable from frame to frame.

export interface TagBox {
  id: string
  /** Centre x and top y, in logical pixels. */
  x: number
  y: number
  w: number
  h: number
  /** Higher wins. */
  priority: number
}

/** The ids of the tags to draw. */
export function declutterTags(tags: readonly TagBox[]): Set<string> {
  const order = [...tags].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1))
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
