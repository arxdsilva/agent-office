import { describe, expect, it } from 'vitest'
import { fixtureManifestJson } from './__fixtures__/manifest.ts'
import { ManifestError, parseManifest } from './manifest.ts'

type Json = Record<string, any>
const json = (): Json => fixtureManifestJson() as Json

/** Runs parseManifest and returns the error it throws. */
function failure(input: unknown): ManifestError {
  try {
    parseManifest(input)
  } catch (e) {
    expect(e).toBeInstanceOf(ManifestError)
    return e as ManifestError
  }
  throw new Error('expected parseManifest to throw')
}

describe('parseManifest', () => {
  it('parses a valid manifest and keeps its data', () => {
    const m = parseManifest(json())
    expect(m.version).toBe(1)
    expect(Object.keys(m.modules.wing.themes)).toEqual([
      'terracotta',
      'nordic',
      'forest',
      'ocean',
      'neon',
      'brass',
    ])
    expect(Object.keys(m.modules.wing.anchors).filter((k) => k.startsWith('seat:desk:'))).toHaveLength(24)
    const seat = m.modules.wing.anchors['seat:desk:3:2']!
    expect(seat.pose).toBe('sit')
    expect(seat.room).toBe('pod-3')
    expect(seat.approach.z).toBeCloseTo(seat.z + 0.6)
    expect(m.modules.wing.capacity.desk).toBe(24)
    expect(m.modules.cap.nav.nodes.end).toEqual({ x: 0, z: 0, width: 2 })
    expect(m.modules.atrium.lightmap).toEqual({ file: 'atrium.lightmap.png', intensity: 3 })
    expect(m.modules.street.lightmap).toBeUndefined()
    expect(m.character).toEqual({ file: 'character.glb', meta: 'character.json' })
  })

  it('accepts a subset of themes (milestone 1 ships terracotta only)', () => {
    const m = parseManifest(fixtureManifestJson(['terracotta']))
    expect(Object.keys(m.modules.wing.themes)).toEqual(['terracotta'])
  })

  it('rejects a non-object', () => {
    expect(failure(null).path).toBe('(root)')
    expect(failure([]).path).toBe('(root)')
  })

  it('rejects a bad version', () => {
    const j = json()
    j.version = 2
    const e = failure(j)
    expect(e.path).toBe('version')
    expect(e.message).toContain('version')
  })

  it('rejects an unknown pose, naming the anchor', () => {
    const j = json()
    j.modules.wing.anchors['seat:desk:1:0'].pose = 'crouch'
    const e = failure(j)
    expect(e.path).toBe('modules.wing.anchors["seat:desk:1:0"].pose')
    expect(e.message).toMatch(/sit|stand|lounge/)
  })

  it('rejects missing anchor kinds with the module path', () => {
    const j = json()
    delete j.modules.wing.anchors['spot:booth:3']
    const e = failure(j)
    expect(e.path).toBe('modules.wing.anchors')
    expect(e.message).toContain('spot:booth')

    const a = json()
    delete a.modules.atrium.anchors['spot:elevator:5']
    expect(failure(a).message).toContain('spot:elevator')

    const p = json()
    delete p.modules.atrium.anchors['spot:pingpong:1:B']
    expect(failure(p).message).toContain('pingpong')

    const g = json()
    delete g.modules.garden.anchors['spot:garden:0']
    expect(failure(g).path).toBe('modules.garden.anchors')
  })

  it('rejects malformed anchor ids and fields', () => {
    const j = json()
    j.modules.wing.anchors['desk 1'] = j.modules.wing.anchors['seat:desk:1:0']
    expect(failure(j).path).toBe('modules.wing.anchors["desk 1"]')

    const k = json()
    k.modules.wing.anchors['seat:desk:1:0'].x = 'left'
    expect(failure(k).path).toBe('modules.wing.anchors["seat:desk:1:0"].x')

    const a = json()
    delete a.modules.wing.anchors['seat:desk:1:0'].approach
    expect(failure(a).path).toBe('modules.wing.anchors["seat:desk:1:0"].approach')

    const r = json()
    r.modules.wing.anchors['seat:desk:1:0'].room = 7
    expect(failure(r).path).toBe('modules.wing.anchors["seat:desk:1:0"].room')
  })

  it('rejects bad nav edges, disconnected graphs and missing connectors', () => {
    const e = json()
    e.modules.cap.nav.edges = [['end', 'nowhere']]
    expect(failure(e).path).toBe('modules.cap.nav.edges[0]')

    const d = json()
    d.modules.cap.nav.nodes.island = { x: 5, z: 0.2, width: 1 }
    const disc = failure(d)
    expect(disc.path).toBe('modules.cap.nav')
    expect(disc.message).toContain('island')

    const c = json()
    c.modules.street.nav.nodes['door:R'].x = 2
    const conn = failure(c)
    expect(conn.path).toBe('modules.street.nav.nodes')
    expect(conn.message).toContain('(3, 9)')

    const w = json()
    w.modules.wing.nav.nodes['g:2:0'].width = 0
    expect(failure(w).path).toBe('modules.wing.nav.nodes["g:2:0"].width')

    const bad = json()
    bad.modules.wing.nav.edges = 'none'
    expect(failure(bad).path).toBe('modules.wing.nav.edges')
  })

  it('rejects unknown or missing themes and bad capacity', () => {
    const u = json()
    u.modules.wing.themes.pink = u.modules.wing.themes.ocean
    expect(failure(u).path).toBe('modules.wing.themes.pink')

    const none = json()
    none.modules.wing.themes = {}
    expect(failure(none).path).toBe('modules.wing.themes')

    const cap = json()
    delete cap.modules.wing.capacity.booth
    expect(failure(cap).path).toBe('modules.wing.capacity.booth')

    const sign = json()
    sign.modules.wing.themes.ocean.signColor = undefined
    expect(failure(sign).path).toBe('modules.wing.themes.ocean.signColor')
  })

  it('rejects missing modules, units and character', () => {
    const m = json()
    delete m.modules.garden
    expect(failure(m).path).toBe('modules.garden')

    const u = json()
    u.units = 'ft'
    expect(failure(u).path).toBe('units')

    const c = json()
    c.character = { file: 'character.glb' }
    expect(failure(c).path).toBe('character.meta')

    const l = json()
    l.modules.atrium.lightmap = { file: 'x.png', intensity: '3' }
    expect(failure(l).path).toBe('modules.atrium.lightmap.intensity')

    const b = json()
    b.modules.atrium.bounds.minX = Number.NaN
    expect(failure(b).path).toBe('modules.atrium.bounds.minX')
  })
})
