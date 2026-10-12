import { describe, expect, it } from 'vitest'
import { fixtureManifest } from './__fixtures__/manifest.ts'
import { toWorld, planBuilding } from './building.ts'
import type { ViewEntry } from './library-types.ts'
import type { BuildingLayout, Vec3 } from './office-types.ts'
import { viewsFor } from './views.ts'
import {
  bookmarksFor,
  type Bookmark,
  type WingSurfaces,
} from '../adapters/three/camera-director.ts'

/** A verbatim copy of `ThreeScene.emitViews` as it was before `viewsFor` (the regression oracle). */
function emitViewsToday(bookmarks: Bookmark[], current: string | null): ViewEntry[] {
  const entry = (b: Bookmark, label = b.label): ViewEntry => ({
    id: b.id,
    label,
    ...(b.group ? { group: b.group } : {}),
    ...(b.provider ? { provider: b.provider } : {}),
    ...(b.id === current ? { active: true } : {}),
  })
  const room = (prefix: string) =>
    bookmarks
      .filter((b) => b.id.split(':')[0] === prefix && b.id.endsWith(':0'))
      .map((b) => entry(b, b.label.slice(0, b.label.indexOf(' · ')) || b.label))
  const byProvider = (_group: 'library' | 'adapters', prefixes: string[]) => {
    const rows = prefixes.flatMap(room)
    const order = [...new Set(rows.map((r) => r.provider))]
    return order.flatMap((p) => rows.filter((r) => r.provider === p))
  }
  return [
    ...bookmarks.filter((b) => b.id === 'atrium' || b.id === 'street').map((b) => entry(b)),
    ...bookmarks.filter((b) => b.id.startsWith('wing:')).map((b) => entry(b)),
    ...byProvider('adapters', ['adapters', 'adapters-door']),
    ...byProvider('library', ['library', 'library-rules']),
    ...bookmarks.filter((b) => b.id === 'overview').map((b) => entry(b)),
  ]
}

/** Wing surfaces (module-local) as the loaded glb reports them, from the manifest's ports. */
function surfacesOf(layout: BuildingLayout): WingSurfaces {
  const wing = layout.placements.find((p) => p.kind === 'wing')!
  const s: WingSurfaces = new Map()
  for (const [id, v] of layout.ports ?? []) {
    const m = /^(.+)\/port:(station|book|board|notebook):(\d+)$/.exec(id)
    if (!m || m[1] !== wing.id) continue
    // World → module-local (inverse of the placement's yaw and translation).
    const back = toWorld(
      { x: v.x - wing.position.x, z: v.z - wing.position.z },
      { position: { x: 0, z: 0 }, yaw: -wing.yaw },
    )
    const role = m[2] as 'station'
    const local: Vec3 = { x: back.x, y: v.y, z: back.z }
    s.set(role, (s.get(role) ?? new Map()).set(m[3]!, local))
  }
  return s
}

describe('viewsFor (VW-1)', () => {
  const layouts = [
    planBuilding([{ provider: 'p', agents: 2 }], fixtureManifest, undefined, 0),
    planBuilding(
      ['claude-code', 'langgraph', 'zeta'].map((provider) => ({ provider, agents: 30 })),
      fixtureManifest,
      undefined,
      0,
    ),
  ]

  it('matches the 3D view list before the wing surfaces load', () => {
    for (const layout of layouts) {
      const marks = bookmarksFor(layout, fixtureManifest, null)
      for (const current of [null, 'atrium', 'wing:p:0', 'library:claude-code:0'])
        expect(viewsFor(layout, { available: new Set(marks.map((b) => b.id)), current })).toEqual(
          emitViewsToday(marks, current),
        )
    }
  })

  it('matches the 3D view list once the surfaces have loaded (framed rooms)', () => {
    for (const layout of layouts) {
      const marks = bookmarksFor(layout, fixtureManifest, surfacesOf(layout))
      expect(marks.some((b) => b.id.startsWith('library-rules:'))).toBe(true)
      const available = new Set(marks.map((b) => b.id))
      expect(viewsFor(layout, { available, current: 'street' })).toEqual(
        emitViewsToday(marks, 'street'),
      )
      // Without `available`, the rooms come from the layout's anchors and ports: the same list.
      expect(viewsFor(layout)).toEqual(emitViewsToday(marks, null))
    }
  })
})
