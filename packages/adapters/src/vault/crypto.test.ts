import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { openLine, sealLine } from './aes-box.ts'
import { TestKeyProvider } from './key-provider.ts'

const key = randomBytes(32)

describe('aes-box', () => {
  it('seals to 1.<iv>.<ct+tag> and opens with the same AAD', () => {
    const line = sealLine(key, 'hello', 'catalog|1')
    expect(line).toMatch(/^1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/)
    expect(openLine(key, line, 'catalog|1').toString('utf8')).toBe('hello')
  })

  it('uses a fresh IV per seal', () => {
    expect(sealLine(key, 'x', 'a')).not.toBe(sealLine(key, 'x', 'a'))
  })

  it('throws on a wrong AAD, a wrong key, a flipped byte or a bad format', () => {
    const line = sealLine(key, 'hello', 'catalog|1')
    expect(() => openLine(key, line, 'catalog|2')).toThrow()
    expect(() => openLine(randomBytes(32), line, 'catalog|1')).toThrow()
    const [v, iv, ct] = line.split('.') as [string, string, string]
    const bytes = Buffer.from(ct, 'base64')
    bytes[0] = bytes[0]! ^ 1
    expect(() => openLine(key, `${v}.${iv}.${bytes.toString('base64')}`, 'catalog|1')).toThrow()
    expect(() => openLine(key, `2.${iv}.${ct}`, 'catalog|1')).toThrow()
    expect(() => openLine(key, 'garbage', 'catalog|1')).toThrow()
    expect(() =>
      openLine(key, `1.${Buffer.alloc(4).toString('base64')}.${ct}`, 'catalog|1'),
    ).toThrow()
    expect(() => openLine(key, `1.${iv}.AAAA`, 'catalog|1')).toThrow()
  })

  it('rejects keys that are not 32 bytes', () => {
    expect(() => sealLine(randomBytes(16), 'x', 'a')).toThrow()
  })
})

describe('TestKeyProvider', () => {
  it('round-trips a wrapped key and never returns it in clear', () => {
    const p = new TestKeyProvider()
    expect(p.status()).toBe('available')
    const blob = p.wrap(key)
    expect(blob.includes(key)).toBe(false)
    expect(p.unwrap(blob).equals(key)).toBe(true)
  })

  it('fails to unwrap with another master key, and when unavailable', () => {
    const blob = new TestKeyProvider().wrap(key)
    expect(() => new TestKeyProvider({ master: 'other' }).unwrap(blob)).toThrow()
    const off = new TestKeyProvider({ available: false })
    expect(off.status()).toBe('unavailable')
    expect(() => off.wrap(key)).toThrow()
    expect(() => off.unwrap(blob)).toThrow()
  })
})
