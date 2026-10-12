import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { Link } from '../../app/office-types.ts'
import { LinkSystem } from './links.ts'

// Regression: tubes were built from a curve whose arc-length cache still described the empty curve
// they were created with, so every tube collapsed to a point (invisible) at its first endpoint.
const link = (over: Partial<Link> = {}): Link => ({
  id: 'a>web',
  agentId: 'a',
  capabilityId: 'web',
  category: 'adapter',
  from: { x: 0, y: 1.25, z: 0 },
  to: { x: 10, y: 2.3, z: 2 },
  control: { x: 5, y: 3.4, z: 1 },
  color: '#2CB6A0',
  label: 'Web',
  style: 'dash',
  state: 'calling',
  since: 0,
  opacity: 1,
  ...over,
})

describe('LinkSystem', () => {
  const camera = new THREE.PerspectiveCamera()

  it('builds each tube along the whole arc, from the agent to the capability', () => {
    const links = new LinkSystem()
    links.set([link()], camera, null)
    links.update(1)
    const [d] = links.debug()
    expect(d!.from).toEqual([0, 1.25, 0])
    expect(d!.to).toEqual([10, 2.3, 2])
    expect(d!.radius).toBeGreaterThan(4) // ~half the 10 m span, not the 0.025 m tube radius
    expect(d!.visible).toBe(true)
    expect(d!.shown).toBe(1)

    // Moving an end rebuilds the tube along the new arc.
    links.set([link({ from: { x: -10, y: 1.25, z: 0 } })], camera, null)
    expect(links.debug()[0]!.radius).toBeGreaterThan(9)
  })

  it('page-particle links spread their particles along the arc', () => {
    const links = new LinkSystem()
    links.set(
      [link({ id: 'a>skill:x', capabilityId: 'skill:x', style: 'particles' })],
      camera,
      null,
    )
    links.update(0.5)
    expect(links.debug()[0]!.radius).toBeGreaterThan(3)
  })

  it('fades in, dims links of other capabilities while one is highlighted, fades out when gone', () => {
    const links = new LinkSystem()
    links.set([link(), link({ id: 'a>fs', capabilityId: 'fs' })], camera, null)
    links.update(0.1)
    expect(links.debug()[0]!.shown).toBeCloseTo(0.4)
    links.update(1)
    links.highlight('fs')
    links.update(0)
    const byId = new Map(links.debug().map((d) => [d.id, d]))
    expect(byId.get('a>web')!.opacity).toBeCloseTo(0.12)
    expect(byId.get('a>fs')!.opacity).toBe(1)
    links.set([], camera, null)
    links.update(1)
    expect(links.count()).toBe(0)
  })
})
