// World coordinates for camera framing, computed with the renderer's own pure layout code
// (packages/web/src/app/building.ts, loaded through Node's TypeScript type stripping) from the
// published manifest. Scenarios seed the same three providers, so the app plans the same building.
import { readFileSync } from 'node:fs'

const root = new URL('../../', import.meta.url)
const { planBuilding, toWorld } = await import(new URL('packages/web/src/app/building.ts', root))
const { parseManifest } = await import(new URL('packages/web/src/app/manifest.ts', root))

export const PROVIDERS = ['claude-code', 'langgraph', 'openai-agents']

export function loadWorld(providers = PROVIDERS) {
  const manifest = parseManifest(
    JSON.parse(readFileSync(new URL('packages/web/public/assets/manifest.json', root), 'utf8')),
  )
  const layout = planBuilding(
    providers.map((provider) => ({ provider, agents: 1 })),
    manifest,
    undefined,
    0,
  )
  const placement = (id) => {
    const p = layout.placements.find((x) => x.id === id)
    if (!p) throw new Error(`no placement ${id}`)
    return p
  }
  /** A module-local point [x, y, z] → world [x, y, z]. */
  const at = (placementId, [x, y, z]) => {
    const w = toWorld({ x, z }, placement(placementId))
    return [w.x, y, w.z]
  }
  const kindOf = (placementId) => placement(placementId).kind
  /** Module-local position of a manifest anchor (ports carry a height). */
  const localAnchor = (placementId, anchor) => {
    const mod = manifest.modules[kindOf(placementId)]
    const a = mod.anchors[anchor] ?? mod.ports?.[anchor]
    if (!a) throw new Error(`no anchor ${anchor} in ${placementId}`)
    const p = a.pos ?? a
    return [p.x, p.y ?? 0, p.z]
  }
  return {
    manifest,
    layout,
    at,
    localAnchor,
    anchor: (placementId, anchor) => at(placementId, localAnchor(placementId, anchor)),
    /** Camera spec in module-local coordinates → world {pos, target}. */
    view: (placementId, cam, target) => ({
      pos: at(placementId, cam),
      target: at(placementId, target),
    }),
  }
}
