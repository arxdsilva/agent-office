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
    expect(
      Object.keys(m.modules.wing.anchors).filter((k) => k.startsWith('seat:desk:')),
    ).toHaveLength(24)
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

  // Lightmap size tiers (graphics contract §6): kept by the parser so presets can swap them.
  it('keeps lightmap variants and rejects a non-string variant', () => {
    const l = json()
    l.modules.atrium.lightmap = {
      file: 'atrium.lightmap.png',
      intensity: 3,
      variants: {
        full: 'atrium.lightmap.png',
        half: 'atrium.lightmap.half.png',
        quarter: 'atrium.lightmap.quarter.png',
      },
    }
    expect(parseManifest(l).modules.atrium.lightmap?.variants).toEqual({
      full: 'atrium.lightmap.png',
      half: 'atrium.lightmap.half.png',
      quarter: 'atrium.lightmap.quarter.png',
    })
    l.modules.atrium.lightmap.variants = { half: 4 }
    expect(failure(l).path).toBe('modules.atrium.lightmap.variants.half')
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

  it('parses ports (3D attach points) and the capability-room capacity', () => {
    const m = parseManifest(json())
    expect(m.modules.wing.bounds.maxX).toBe(30)
    expect(m.modules.atrium.bounds).toMatchObject({ minX: -33, maxX: 33 })
    expect(m.modules.wing.capacity).toMatchObject({
      stations: 8,
      books: 24,
      boards: 6,
      notebooks: 8,
      readingSeats: 4,
    })
    const ports = m.modules.wing.ports
    expect(Object.keys(ports).filter((k) => k.startsWith('port:book:'))).toHaveLength(24)
    expect(ports['port:station:0']!.y).toBeCloseTo(2.3)
    expect(ports['port:desk:1:0']!.y).toBeCloseTo(1.25)
    // Ports are not walk-to anchors.
    expect(Object.keys(m.modules.wing.anchors).some((k) => k.startsWith('port:'))).toBe(false)
    expect(
      Object.keys(m.modules.wing.anchors).filter((k) => k.startsWith('spot:station:')),
    ).toHaveLength(8)
    expect(m.modules.atrium.ports).toEqual({})
  })

  it('still parses an older manifest without capability rooms', () => {
    const j = json()
    for (const k of ['stations', 'books', 'boards', 'notebooks', 'readingSeats'])
      delete j.modules.wing.capacity[k]
    for (const k of Object.keys(j.modules.wing.anchors))
      if (/^(port|spot:station|spot:shelf|seat:reading)/.test(k)) delete j.modules.wing.anchors[k]
    const m = parseManifest(j)
    expect(m.modules.wing.ports).toEqual({})
    expect(m.modules.wing.capacity.stations).toBeUndefined()
  })

  it('requires the capability-room anchors and ports the capacity declares', () => {
    const cases: [string, string][] = [
      ['spot:station:7', 'spot:station'],
      ['port:station:3', 'port:station'],
      ['port:desk:6:3', 'port:desk'],
      ['port:book:23', 'port:book'],
      ['port:board:5', 'port:board'],
      ['port:notebook:7', 'port:notebook'],
      ['seat:reading:3', 'seat:reading'],
      ['spot:shelf:1', 'spot:shelf'],
    ]
    for (const [id, label] of cases) {
      const j = json()
      delete j.modules.wing.anchors[id]
      const e = failure(j)
      expect(e.path).toBe('modules.wing.anchors')
      expect(e.message).toContain(label)
    }
    const bad = json()
    bad.modules.wing.anchors['port:book:0'].y = 'high'
    expect(failure(bad).path).toBe('modules.wing.anchors["port:book:0"].y')
    const cap = json()
    cap.modules.wing.capacity.books = 'many'
    expect(failure(cap).path).toBe('modules.wing.capacity.books')
  })
})
