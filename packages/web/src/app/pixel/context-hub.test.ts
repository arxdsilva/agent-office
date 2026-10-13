import { describe, expect, it } from 'vitest'
import { CONTEXT_DARK, CONTEXT_GLOW, contextScreenColor } from './context-hub.ts'

describe('contextScreenColor (2D Context Hub consoles and core)', () => {
  it('maps the glow level onto the dark..glow ramp and clamps outside 0..1', () => {
    expect(contextScreenColor(0)).toBe(CONTEXT_DARK)
    expect(contextScreenColor(1)).toBe(CONTEXT_GLOW)
    expect(contextScreenColor(-3)).toBe(CONTEXT_DARK)
    expect(contextScreenColor(7)).toBe(CONTEXT_GLOW)
  })

  it('gets brighter with the level', () => {
    const channel = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16)
    expect(channel(contextScreenColor(0.7))).toBeGreaterThan(channel(contextScreenColor(0.3)))
    expect(contextScreenColor(0.5)).toMatch(/^#[0-9a-f]{6}$/)
  })
})
