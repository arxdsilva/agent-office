// Night City characters (docs/special-3d/character-system.md): `special3d/character-cyber.glb`
// (same rig and 22 clips as the classic character, contract §14) when the set has it, else the
// classic `assets/character.glb`. Agents are driven by the shared CharacterSystem (adapters/three),
// so clips, timing, LOD and tints match the other modes exactly.
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import {
  loadCharacterAssets,
  type CharacterAssets,
  type CharacterMeta,
} from '../../../adapters/three/characters.ts'
import { within } from '../../../adapters/three/assets.ts'

export type CharacterSet = 'cyber' | 'classic'

function meta(json: unknown): CharacterMeta {
  const m = json as Partial<CharacterMeta> | null
  const ok = (v: unknown) => typeof v === 'number' && v > 0
  if (
    !m ||
    !ok(m.height) ||
    !ok(m.seatHeight) ||
    !ok(m.loungeSeatHeight) ||
    typeof m.clips !== 'object'
  )
    throw new Error('character-cyber.json: height/seatHeight/loungeSeatHeight/clips required')
  return m as CharacterMeta
}

/** The cyber set if published (and complete), else the classic character. Null if neither loads. */
export async function loadSpecialCharacters(
  loader: GLTFLoader,
  cyber: { file: string; meta: string } | null,
): Promise<{ assets: CharacterAssets; set: CharacterSet } | null> {
  if (cyber)
    try {
      const [gltf, json] = await within(
        Promise.all([
          loader.loadAsync(`special3d/${cyber.file}`),
          fetch(`special3d/${cyber.meta}`).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            return r.json() as Promise<unknown>
          }),
        ]),
        30_000,
        cyber.file,
      )
      return { assets: { gltf, meta: meta(json) }, set: 'cyber' }
    } catch (err) {
      console.warn(
        `agent-office: Night City character unavailable (${(err as Error).message}); using the classic one`,
      )
    }
  try {
    return {
      assets: await within(loadCharacterAssets('assets/', loader), 30_000, 'character.glb'),
      set: 'classic',
    }
  } catch (err) {
    console.warn(`agent-office: character assets unavailable (${(err as Error).message})`)
    return null
  }
}
