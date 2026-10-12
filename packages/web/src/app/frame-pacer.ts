// Frame pacing (low-spec plan §5.2). Pure: the scene asks on every animation frame whether to render.
/** Renders this early before the next slot, so vsync jitter doesn't skip a frame (ms). */
export const VSYNC_TOLERANCE_MS = 1.5

export interface Pacer {
  /** `limit`: frames per second; null = every frame; 0 = paused. */
  shouldRender(nowMs: number, limit: number | null): boolean
  /** Forget the last frame (after a pause the next frame renders at once). */
  reset(): void
}

export function createPacer(): Pacer {
  let last = -Infinity
  return {
    shouldRender(now, limit) {
      if (limit === 0) return false
      if (limit !== null && now - last < 1000 / limit - VSYNC_TOLERANCE_MS) return false
      last = now
      return true
    },
    reset() {
      last = -Infinity
    },
  }
}
