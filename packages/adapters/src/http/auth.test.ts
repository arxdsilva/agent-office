import { describe, expect, it } from 'vitest'
import { createAuth } from './auth.ts'

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

describe('createAuth with a port getter', () => {
  it('follows the port it is given at request time (port 0 → real port after listen)', () => {
    let port = 0
    const a = createAuth({ token: 't', port: () => port })
    expect(a.hostAllowed('localhost:5000')).toBe(false)
    port = 5000
    expect(a.hostAllowed('localhost:5000')).toBe(true)
    expect(a.originAllowed('http://127.0.0.1:5000')).toBe(true)
  })
})
