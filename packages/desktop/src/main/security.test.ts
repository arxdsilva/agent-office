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
  it('locks production down to the app:// origin, allowing only WASM compilation', () => {
    expect(contentSecurityPolicy()).toBe(
      [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "connect-src 'self' blob:", // blob: lets GLTFLoader decode embedded textures off the main thread
        "worker-src 'self' blob:",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    )
    // JS eval stays forbidden; only WebAssembly compilation (meshopt decoder) is allowed.
    expect(contentSecurityPolicy()).not.toMatch(/(?<!wasm-)unsafe-eval/)
    expect(contentSecurityPolicy()).not.toMatch(/https?:|\*/)
  })

  it('adds only the Vite dev server origin (and its websocket) in development', () => {
    const csp = contentSecurityPolicy('http://localhost:5173/')
    expect(csp).toContain("connect-src 'self' blob: http://localhost:5173 ws://localhost:5173")
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' http://localhost:5173")
    expect(csp).toContain("img-src 'self' data: blob:")
    expect(csp).not.toMatch(/(?<!wasm-)unsafe-eval/)
  })
})

describe('permissions and senders', () => {
  it('allows only pointer lock and notifications', () => {
    expect(isAllowedPermission('pointerLock')).toBe(true)
    expect(isAllowedPermission('notifications')).toBe(true)
    for (const p of ['media', 'geolocation', 'clipboard-read', 'openExternal'])
      expect(isAllowedPermission(p)).toBe(false)
  })

  it('trusts only the app://renderer origin in production', () => {
    const want = 'app://renderer/index.html'
    expect(isTrustedSender('app://renderer/index.html', want)).toBe(true)
    expect(isTrustedSender('app://renderer/index.html#x', want)).toBe(true)
    // Custom schemes have an opaque ("null") origin in WHATWG URL: compare scheme + host instead.
    expect(isTrustedSender('app://evil/index.html', want)).toBe(false)
    expect(isTrustedSender('file:///app/out/renderer/index.html', want)).toBe(false)
    expect(isTrustedSender('https://renderer/index.html', want)).toBe(false)
    expect(isTrustedSender('other://renderer/index.html', want)).toBe(false)
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
