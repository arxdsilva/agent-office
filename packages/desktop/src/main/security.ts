// Pure security policy for the Electron shell. See PRIVACY_SECURITY rule (Electron checklist).

export function secureWebPreferences(preload: string) {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
  }
}

/**
 * CSP for the renderer. Production serves the page from `app://renderer` (see renderer-protocol.ts),
 * so `'self'` is exactly the bundled files and assets. `'wasm-unsafe-eval'` lets WebAssembly compile
 * (the meshopt decoder for compressed .glb); JS eval stays forbidden. Blob URLs carry textures
 * decoded from .glb files and decoder workers. Dev also allows the Vite server and its websocket.
 */
export function contentSecurityPolicy(devServerUrl?: string): string {
  const dev = devServerUrl ? new URL(devServerUrl).origin : ''
  const ws = dev.replace(/^http/, 'ws')
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${dev ? ` ${dev}` : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `connect-src 'self'${dev ? ` ${dev} ${ws}` : ''}`,
    "worker-src 'self' blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

/** pointerLock powers walk mode; notifications are shown by the main process anyway. */
const ALLOWED_PERMISSIONS = new Set(['pointerLock', 'notifications'])
export const isAllowedPermission = (permission: string) => ALLOWED_PERMISSIONS.has(permission)

/** IPC calls are accepted only from the app's own renderer document. */
export function isTrustedSender(senderUrl: string | undefined, rendererUrl: string): boolean {
  if (!senderUrl) return false
  try {
    const got = new URL(senderUrl)
    const want = new URL(rendererUrl)
    if (want.protocol === 'file:') return got.protocol === 'file:' && got.pathname === want.pathname
    // Custom schemes (app://renderer) have an opaque "null" origin in WHATWG URL: compare scheme + host.
    if (want.protocol !== 'http:' && want.protocol !== 'https:')
      return got.protocol === want.protocol && got.host === want.host && want.host !== ''
    return got.origin === want.origin
  } catch {
    return false
  }
}

export function isSafeExternalUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}
