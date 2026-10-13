// Night City outfits: the cyber character's accessories and its accent tint per agent (hash of the
// id), so an agent always looks the same; never derived from agent state.
import { describe, expect, it } from 'vitest'
import { ACCENTS, cyberLook, OUTFITS } from './outfit.ts'

describe('cyberLook', () => {
  it('is stable per agent id', () => {
    expect(cyberLook('mock:ada')).toEqual(cyberLook('mock:ada'))
  })

  it('wears exactly one outer layer and at most one eyewear', () => {
    for (let i = 0; i < 50; i++) {
      const l = cyberLook(`agent-${i}`)
      expect(OUTFITS.filter((o) => l.accessories[o]).length).toBe(1)
      expect(Number(!!l.accessories.visor) + Number(!!l.accessories.arGlasses)).toBeLessThanOrEqual(
        1,
      )
      expect(ACCENTS).toContain(l.accent)
    }
  })

  it('varies across agents (accents and outfits)', () => {
    const looks = Array.from({ length: 40 }, (_, i) => cyberLook(`a${i}`))
    expect(new Set(looks.map((l) => l.accent)).size).toBeGreaterThan(3)
    expect(new Set(looks.map((l) => OUTFITS.find((o) => l.accessories[o]))).size).toBe(
      OUTFITS.length,
    )
  })

  it('the player wears the collar light and a cyan accent', () => {
    const p = cyberLook('player', { player: true })
    expect(p.accessories.collarLight).toBe(true)
    expect(p.accent).toBe(0x29e3ff)
  })
})
