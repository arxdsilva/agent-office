// The renderer's simulation clock (epoch ms). Real time by default; capture scripts can speed it up
// (debug hook `timeScale`) so breaks and ping-pong happen within seconds. Director and scene share it.
export const MAX_TIME_SCALE = 60

export interface SimClock {
  now(): number
  readonly scale: number
  setScale(n: number): void
}

export function createSimClock(real: () => number = Date.now): SimClock {
  let scale = 1
  let realAt = real()
  let simAt = realAt
  const now = () => simAt + (real() - realAt) * scale
  return {
    now,
    get scale() {
      return scale
    },
    setScale(n) {
      if (!Number.isFinite(n) || n <= 0) return
      simAt = now()
      realAt = real()
      scale = Math.min(n, MAX_TIME_SCALE)
    },
  }
}
