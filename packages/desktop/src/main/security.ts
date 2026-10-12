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

/** CSP for the renderer. Production loads only bundled files; dev also allows the Vite server. */
export function contentSecurityPolicy(devServerUrl?: string): string {
  const dev = devServerUrl ? new URL(devServerUrl).origin : ''
  const ws = dev.replace(/^http/, 'ws')
  return [
    "default-src 'self'",
    `script-src 'self'${dev ? ` ${dev}` : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    dev ? `connect-src ${dev} ${ws}` : "connect-src 'none'",
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
