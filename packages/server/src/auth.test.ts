import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAuth, loadOrCreateToken } from './auth.ts'

describe('loadOrCreateToken', () => {
  it('creates a 64-hex token with mode 0600 and reuses it', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ao-')), 'home')
    const t1 = loadOrCreateToken(dir)
    expect(t1).toMatch(/^[0-9a-f]{64}$/)
    expect(statSync(join(dir, 'token')).mode & 0o777).toBe(0o600)
    expect(loadOrCreateToken(dir)).toBe(t1)
    expect(readFileSync(join(dir, 'token'), 'utf8').trim()).toBe(t1)
  })
})

describe('createAuth', () => {
  const auth = createAuth({ token: 'secret', port: 4317, devOrigins: ['http://localhost:5173'] })

  it('allows only local hosts on the right port', () => {
    expect(auth.hostAllowed('localhost:4317')).toBe(true)
    expect(auth.hostAllowed('127.0.0.1:4317')).toBe(true)
    expect(auth.hostAllowed('evil.com')).toBe(false)
    expect(auth.hostAllowed('localhost:9999')).toBe(false)
    expect(auth.hostAllowed(undefined)).toBe(false)
  })

  it('accepts the dev server host (Vite proxy forwards it)', () => {
    expect(auth.hostAllowed('localhost:5173')).toBe(true)
  })

  it('accepts extra allowed hosts', () => {
    const a = createAuth({ token: 't', port: 1, allowedHosts: ['office.lan:1'] })
    expect(a.hostAllowed('office.lan:1')).toBe(true)
  })

  it('allows a missing origin (non-browser) but rejects foreign origins', () => {
    expect(auth.originAllowed(undefined)).toBe(true)
    expect(auth.originAllowed('http://localhost:4317')).toBe(true)
    expect(auth.originAllowed('http://localhost:5173')).toBe(true)
    expect(auth.originAllowed('https://evil.com')).toBe(false)
    expect(auth.originAllowed('null')).toBe(false)
  })

  it('checks the bearer token', () => {
    expect(auth.bearerOk('Bearer secret')).toBe(true)
    expect(auth.bearerOk('Bearer wrong!')).toBe(false)
    expect(auth.bearerOk('secret')).toBe(false)
    expect(auth.bearerOk(undefined)).toBe(false)
    expect(auth.tokenOk('secret')).toBe(true)
    expect(auth.tokenOk('nope')).toBe(false)
  })
})
