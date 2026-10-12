import type { Capability } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import type { CapabilityRepository } from '../../src/ports/driven.ts'

const cap = (provider: string, id: string, over: Partial<Capability> = {}): Capability => ({
  id,
  provider,
  category: 'adapter',
  kind: 'other',
  label: id,
  sees: [],
  tools: [],
  declared: true,
  calls: 0,
  active: [],
  ...over,
})

/** Every CapabilityRepository implementation must pass this. */
export function capabilityRepositoryContract(name: string, make: () => CapabilityRepository) {
  describe(`CapabilityRepository contract: ${name}`, () => {
    it('puts and gets by provider and id; unknown → undefined', () => {
      const r = make()
      r.put(cap('p', 'fs'))
      expect(r.get('p', 'fs')?.id).toBe('fs')
      expect(r.get('q', 'fs')).toBeUndefined()
      expect(r.get('p', 'web')).toBeUndefined()
    })

    it('keeps the same id apart per provider and replaces on put', () => {
      const r = make()
      r.put(cap('p', 'fs'))
      r.put(cap('q', 'fs', { label: 'Q files' }))
      r.put(cap('p', 'fs', { calls: 3 }))
      expect(r.get('p', 'fs')?.calls).toBe(3)
      expect(r.get('q', 'fs')?.label).toBe('Q files')
      expect(r.listByProvider('p')).toHaveLength(1)
    })

    it('lists by provider in insertion order, and lists providers', () => {
      const r = make()
      r.put(cap('p', 'web'))
      r.put(cap('p', 'fs'))
      r.put(cap('q', 'shell'))
      expect(r.listByProvider('p').map((c) => c.id)).toEqual(['web', 'fs'])
      expect(r.listByProvider('nobody')).toEqual([])
      expect(r.providers().sort()).toEqual(['p', 'q'])
    })

    it('returns copies that do not alias stored state (arrays included)', () => {
      const r = make()
      r.put(cap('p', 'fs', { sees: ['project: a'], active: ['x'] }))
      const got = r.get('p', 'fs')!
      got.label = 'mutated'
      got.sees.push('leak')
      got.active.push('y')
      r.listByProvider('p')[0]!.tools.push('leak')
      expect(r.get('p', 'fs')).toMatchObject({ label: 'fs', sees: ['project: a'], active: ['x'] })
      expect(r.get('p', 'fs')!.tools).toEqual([])
    })

    it('does not alias the object passed to put', () => {
      const r = make()
      const c = cap('p', 'fs')
      r.put(c)
      c.tools.push('later')
      expect(r.get('p', 'fs')!.tools).toEqual([])
    })
  })
}
