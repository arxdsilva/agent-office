// The production renderer is served from a privileged `app://renderer/` scheme instead of file://,
// so the page has a real origin: `'self'` in the CSP then covers fetch/GLTFLoader of assets/*.glb,
// the HDRI and the meshopt WASM decoder, while every other origin stays blocked.
// Pure and Electron-free: index.ts only registers the scheme and passes this handler to protocol.handle.
import { extname, resolve, sep } from 'node:path'

export const APP_SCHEME = 'app'
export const RENDERER_HOST = 'renderer'
export const RENDERER_URL = `${APP_SCHEME}://${RENDERER_HOST}/index.html`

/** For protocol.registerSchemesAsPrivileged (must run before app `ready`). */
export const APP_SCHEME_PRIVILEGES = {
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true },
} as const

/**
 * Maps `app://renderer/<path>` to an absolute file path inside `root`, or null when the URL is not
 * ours or would escape `root` (encoded `..`, backslashes, NUL bytes, malformed escapes).
 */
export function resolveRendererPath(requestUrl: string, root: string): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== RENDERER_HOST) return null
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (path.includes('\0') || path.includes('\\')) return null
  const base = resolve(root)
  const file = resolve(base, `.${path === '/' || path === '' ? '/index.html' : path}`)
  return file.startsWith(base + sep) ? file : null
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ktx2': 'image/ktx2',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
}

export function contentTypeFor(file: string): string {
  return TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

export interface RendererHandlerOptions {
  /** Absolute path of the built renderer (out/renderer). */
  root: string
  readFile: (path: string) => Promise<Uint8Array>
  /** Sent as a header on HTML documents (the built index.html also carries it as a <meta>). */
  csp: string
}

/** The `protocol.handle('app', …)` callback: read-only, GET/HEAD, contained in `root`. */
export function createRendererHandler(o: RendererHandlerOptions) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(null, { status: 405 })
    const file = resolveRendererPath(request.url, o.root)
    if (!file) return new Response(null, { status: 403 })
    let body: Uint8Array
    try {
      body = await o.readFile(file)
    } catch {
      return new Response(null, { status: 404 })
    }
    const type = contentTypeFor(file)
    const headers: Record<string, string> = {
      'content-type': type,
      'x-content-type-options': 'nosniff',
      ...(type.startsWith('text/html') ? { 'content-security-policy': o.csp } : {}),
    }
    return new Response(request.method === 'HEAD' ? null : (body as BodyInit), { headers })
  }
}
