import { describe, expect, it } from 'vitest'
import { ValidationError } from '../../src/domain/errors.ts'
import type { JsonConfigStore, ProviderProbe } from '../../src/ports/driven.ts'

/** Collects every string inside a value (keys included). */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) strings(x, out)
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.push(k)
      strings(x, out)
    }
  return out
}

/**
 * Every ProviderProbe must pass this. `make()` returns a probe in its normal environment (a fake
 * CLI, or whatever the adapter test arranges). `timeoutMs` bounds one detect().
 */
export function providerProbeContract(
  name: string,
  make: () => ProviderProbe | Promise<ProviderProbe>,
  timeoutMs = 4000,
) {
  describe(`ProviderProbe contract: ${name}`, () => {
    it('never throws and returns a well-formed result', { timeout: timeoutMs }, async () => {
      const probe = await make()
      const r = await probe.detect()
      expect(typeof r.installed).toBe('boolean')
      expect(typeof r.flagsOk).toBe('boolean')
      expect(['ok', 'needed', 'unknown']).toContain(r.auth)
      if (r.error !== undefined) expect(['timeout', 'spawn', 'protocol']).toContain(r.error)
    })

    it('results never contain paths', { timeout: timeoutMs }, async () => {
      const r = await (await make()).detect()
      for (const s of strings(r)) expect(s).not.toMatch(/[/\\]/)
    })
  })
}

/**
 * Every JsonConfigStore must pass this. `make(initial)` creates a store whose file holds
 * `initial` (undefined = no file, string = raw contents).
 */
export function jsonConfigStoreContract(
  name: string,
  make: (initial?: string) => Promise<{ store: JsonConfigStore }>,
) {
  describe(`JsonConfigStore contract: ${name}`, () => {
    it('reads undefined when there is no file', async () => {
      const { store } = await make()
      expect(await store.read()).toBeUndefined()
    })

    it('round-trips JSON', async () => {
      const { store } = await make('{"version":1,"hooks":{}}')
      expect(await store.read()).toEqual({ version: 1, hooks: {} })
      await store.write({ version: 1, hooks: { stop: [{ command: 'x' }] } })
      expect(await store.read()).toEqual({ version: 1, hooks: { stop: [{ command: 'x' }] } })
    })

    it('refuses invalid JSON with a ValidationError', async () => {
      const { store } = await make('{oops')
      await expect(store.read()).rejects.toBeInstanceOf(ValidationError)
    })

    it('removes the file; removing a missing file is a no-op', async () => {
      const { store } = await make('{"a":1}')
      await store.remove()
      expect(await store.read()).toBeUndefined()
      await expect(store.remove()).resolves.toBeUndefined()
    })
  })
}
