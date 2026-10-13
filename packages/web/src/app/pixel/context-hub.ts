// The 2D Context Hub: console and core screens glow on the same signal as the 3D ones
// (`contextPulse`, app/stations.ts). Pure colour maths; the scene paints the result into the
// art's `screen` rect.

/** Screen colour at glow 0 and 1 (the office palette's slate and screen cyan). */
export const CONTEXT_DARK = '#1d3a46'
export const CONTEXT_GLOW = '#66d9e8'

const channel = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16)

/** `level` (0..1, clamped) mapped onto the dark..glow ramp, as `#rrggbb`. */
export function contextScreenColor(level: number): string {
  const t = Math.min(1, Math.max(0, level))
  const mix = (i: number) =>
    Math.round(channel(CONTEXT_DARK, i) + (channel(CONTEXT_GLOW, i) - channel(CONTEXT_DARK, i)) * t)
  return `#${[0, 1, 2].map((i) => mix(i).toString(16).padStart(2, '0')).join('')}`
}
