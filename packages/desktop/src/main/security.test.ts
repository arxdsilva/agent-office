import { describe, expect, it } from 'vitest'
import {
  contentSecurityPolicy,
  isAllowedPermission,
  isSafeExternalUrl,
  isTrustedSender,
  secureWebPreferences,
} from './security.ts'

describe('secureWebPreferences', () => {
  it('isolates the renderer', () => {
    expect(secureWebPreferences('/app/preload.js')).toEqual({
      preload: '/app/preload.js',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
    })
  })
})

describe('contentSecurityPolicy', () => {
  it('locks production down to the app itself', () => {
    const csp = contentSecurityPolicy()
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).not.toContain('unsafe-eval')
  })

  it('allows only the Vite dev server origin in development', () => {
    const csp = contentSecurityPolicy('http://localhost:5173/')
    expect(csp).toContain('connect-src http://localhost:5173 ws://localhost:5173')
    expect(csp).toContain("script-src 'self' http://localhost:5173")
  })
})

describe('permissions and senders', () => {
  it('allows only pointer lock and notifications', () => {
    expect(isAllowedPermission('pointerLock')).toBe(true)
    expect(isAllowedPermission('notifications')).toBe(true)
    for (const p of ['media', 'geolocation', 'clipboard-read', 'openExternal'])
      expect(isAllowedPermission(p)).toBe(false)
  })

  it('trusts only the app renderer URL', () => {
    expect(
      isTrustedSender('file:///app/out/renderer/index.html', 'file:///app/out/renderer/index.html'),
    ).toBe(true)
    expect(
      isTrustedSender(
        'file:///app/out/renderer/index.html#x',
        'file:///app/out/renderer/index.html',
      ),
    ).toBe(true)
    expect(isTrustedSender('file:///etc/evil.html', 'file:///app/out/renderer/index.html')).toBe(
      false,
    )
    expect(isTrustedSender('http://localhost:5173/', 'http://localhost:5173')).toBe(true)
    expect(isTrustedSender('http://localhost:5174/', 'http://localhost:5173')).toBe(false)
    expect(isTrustedSender(undefined, 'http://localhost:5173')).toBe(false)
    expect(isTrustedSender('not a url', 'http://localhost:5173')).toBe(false)
  })

  it('opens only https links externally', () => {
    expect(isSafeExternalUrl('https://github.com/arxdsilva/agent-office')).toBe(true)
    expect(isSafeExternalUrl('http://example.com')).toBe(false)
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
  })
})
