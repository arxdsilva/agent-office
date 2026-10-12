import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APP_SCHEME,
  APP_SCHEME_PRIVILEGES,
  contentTypeFor,
  createRendererHandler,
  RENDERER_URL,
  resolveRendererPath,
} from './renderer-protocol.ts'

const root = join(tmpdir(), 'ao-renderer-root')

describe('resolveRendererPath', () => {
  it('maps app://renderer/<path> to a file under the renderer root', () => {
    expect(resolveRendererPath('app://renderer/index.html', root)).toBe(join(root, 'index.html'))
    expect(resolveRendererPath('app://renderer/assets/wing-terracotta.glb', root)).toBe(
      join(root, 'assets', 'wing-terracotta.glb'),
    )
    // Query strings and fragments are not part of the file path.
    expect(resolveRendererPath('app://renderer/assets/a.js?v=1#x', root)).toBe(
      join(root, 'assets', 'a.js'),
    )
    // Percent-encoded names are decoded.
    expect(resolveRendererPath('app://renderer/assets/my%20file.png', root)).toBe(
      join(root, 'assets', 'my file.png'),
    )
  })

  it('serves index.html for the bare origin', () => {
    expect(resolveRendererPath('app://renderer/', root)).toBe(join(root, 'index.html'))
    expect(resolveRendererPath('app://renderer', root)).toBe(join(root, 'index.html'))
  })

  it('refuses anything that escapes the root (path traversal)', () => {
    for (const url of [
      'app://renderer/..%2f..%2fsecret.txt',
      'app://renderer/assets/..%2f..%2f..%2fsecret',
      'app://renderer/..%5c..%5csecret',
      'app://renderer/assets%2f..%2f..%2f..',
    ])
      expect(resolveRendererPath(url, root), url).toBeNull()
    // Dot segments the URL parser already normalized stay inside the root.
    expect(resolveRendererPath('app://renderer/%2e%2e/%2e%2e/etc/passwd', root)).toBe(
      join(root, 'etc', 'passwd'),
    )
  })

  it('refuses other hosts, other schemes, NUL bytes and malformed encodings', () => {
    expect(resolveRendererPath('app://evil/index.html', root)).toBeNull()
    expect(resolveRendererPath('file:///etc/passwd', root)).toBeNull()
    expect(resolveRendererPath('https://renderer/index.html', root)).toBeNull()
    expect(resolveRendererPath('app://renderer/index.html%00.png', root)).toBeNull()
    expect(resolveRendererPath('app://renderer/%E0%A4%A', root)).toBeNull()
    expect(resolveRendererPath('not a url', root)).toBeNull()
  })
})

describe('contentTypeFor', () => {
  it('knows the types the renderer and its 3D assets need', () => {
    expect(contentTypeFor('/x/index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('/x/a.js')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('/x/a.css')).toBe('text/css; charset=utf-8')
    expect(contentTypeFor('/x/manifest.json')).toBe('application/json')
    expect(contentTypeFor('/x/atrium.glb')).toBe('model/gltf-binary')
    expect(contentTypeFor('/x/decoder.wasm')).toBe('application/wasm')
    expect(contentTypeFor('/x/office.hdr')).toBe('application/octet-stream')
    expect(contentTypeFor('/x/LIGHTMAP.PNG')).toBe('image/png')
    expect(contentTypeFor('/x/t.webp')).toBe('image/webp')
    expect(contentTypeFor('/x/f.woff2')).toBe('font/woff2')
    expect(contentTypeFor('/x/noext')).toBe('application/octet-stream')
  })
})

describe('app:// scheme', () => {
  it('is a standard, secure scheme that supports fetch (so GLTFLoader and WASM work)', () => {
    expect(APP_SCHEME).toBe('app')
    expect(RENDERER_URL).toBe('app://renderer/index.html')
    expect(APP_SCHEME_PRIVILEGES).toEqual({
      scheme: 'app',
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    })
  })
})

describe('createRendererHandler', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ao-renderer-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>ok</title>')
  writeFileSync(join(dir, 'assets', 'atrium.glb'), Buffer.from([0x67, 0x6c, 0x54, 0x46]))
  const handle = createRendererHandler({ root: dir, readFile, csp: "default-src 'self'" })

  it('serves files with their content type, nosniff, and the CSP on documents', async () => {
    const html = await handle(new Request('app://renderer/index.html'))
    expect(html.status).toBe(200)
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(html.headers.get('content-security-policy')).toBe("default-src 'self'")
    expect(html.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await html.text()).toContain('<title>ok</title>')

    const glb = await handle(new Request('app://renderer/assets/atrium.glb'))
    expect(glb.status).toBe(200)
    expect(glb.headers.get('content-type')).toBe('model/gltf-binary')
    expect(glb.headers.get('content-security-policy')).toBeNull()
    expect(new Uint8Array(await glb.arrayBuffer())).toEqual(
      new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
    )
  })

  it('answers 404 for missing files and directories, 403 for traversal or foreign hosts', async () => {
    expect((await handle(new Request('app://renderer/missing.js'))).status).toBe(404)
    expect((await handle(new Request('app://renderer/assets'))).status).toBe(404)
    expect((await handle(new Request('app://renderer/..%2f..%2fetc%2fpasswd'))).status).toBe(403)
    expect((await handle(new Request('app://renderer/%2e%2e/%2e%2e/etc/passwd'))).status).toBe(404)
    expect((await handle(new Request('app://evil/index.html'))).status).toBe(403)
  })

  it('accepts only GET and HEAD', async () => {
    const r = await handle(new Request('app://renderer/index.html', { method: 'POST', body: 'x' }))
    expect(r.status).toBe(405)
    const head = await handle(new Request('app://renderer/index.html', { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })
})
