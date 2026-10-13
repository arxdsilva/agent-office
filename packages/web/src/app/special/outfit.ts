// Night City outfits (docs/special-3d/character-system.md): which `character-cyber` accessories an
// agent wears and its accent tint, from a hash of its id (stable across modes and sessions; never
// from agent state, so outfits carry no meaning). Hair stays the shared `appearanceOf` choice.
import { hash32 } from '../building.ts'

export const OUTFITS = ['techJacket', 'utilityVest', 'longCoat'] as const
/** Art-direction accents: cyan, amber, magenta, acid yellow, deep red, ice blue. */
export const ACCENTS = [0x29e3ff, 0xffb02e, 0xff2bd6, 0xd7ff3a, 0xe0202e, 0x8fd3ff] as const

export interface CyberLook {
  accent: number
  /** Accessory name → shown (names not listed keep the classic rules: hair, glasses…). */
  accessories: Record<string, boolean>
}

export function cyberLook(id: string, o: { player?: boolean } = {}): CyberLook {
  const h = hash32(`cyber:${id}`)
  const pick = (n: number, shift: number) => (h >>> shift) % n
  const outfit = o.player ? 'techJacket' : OUTFITS[pick(OUTFITS.length, 0)]!
  const eyewear = pick(5, 4) // 0 visor, 1 AR glasses, else none
  const accessories: Record<string, boolean> = {
    visor: eyewear === 0,
    arGlasses: eyewear === 1,
    headset: pick(3, 8) === 0,
    wristDisplay: pick(2, 11) === 0,
    collarLight: o.player === true || pick(3, 13) === 0,
  }
  for (const k of OUTFITS) accessories[k] = k === outfit
  return { accent: o.player ? ACCENTS[0] : ACCENTS[pick(ACCENTS.length, 16)]!, accessories }
}
