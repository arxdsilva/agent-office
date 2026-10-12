import { expect, test } from '@playwright/test'
import { launch, PORT } from './app.ts'

test('a tray/notification click (office:select from main) opens that agent', async () => {
  const { app, win } = await launch()
  // Simulate what the tray menu and notification click do in the main process.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.webContents.send('office:select', 'mock:ken'),
  )
  await expect(win.locator('#p-name')).toHaveText('Ken')
  await app.close()
})

test('closing the window keeps the app (and the local API) running in the tray', async () => {
  const { app } = await launch()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
  const visible = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.isVisible(),
  )
  expect(visible).toBe(false)
  // The hook and external agents still reach the API.
  const health = await fetch(`http://127.0.0.1:${PORT}/api/health`)
  expect(health.status).toBe(200)
  await app.close()
})

test('renderer is sandboxed: no Node, no popups, no navigation, CSP present', async () => {
  const { app, win } = await launch()
  // Production serves the page from the privileged app:// scheme, not file://.
  expect(win.url()).toBe('app://renderer/index.html')
  const probe = await win.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    popup: window.open('https://example.com') === null,
    csp:
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute('content') ?? '',
  }))
  expect(probe).toMatchObject({ require: 'undefined', process: 'undefined', popup: true })
  expect(probe.csp).toContain("script-src 'self' 'wasm-unsafe-eval'")
  expect(probe.csp).toContain("connect-src 'self'")
  expect(probe.csp).not.toMatch(/(?<!wasm-)unsafe-eval/)
  const before = win.url()
  await win.evaluate(() => {
    location.href = 'https://example.com'
  })
  await win.waitForTimeout(300)
  expect(win.url()).toBe(before)
  await app.close()
})

test('app:// serves bundled files to fetch, refuses traversal, and CSP blocks other origins', async () => {
  const { app, win } = await launch()
  const r = await win.evaluate(async () => {
    const status = (url: string) =>
      fetch(url).then(
        (res) => res.status,
        () => 'blocked',
      )
    return {
      // Same-origin fetch works: this is how GLTFLoader loads assets/*.glb under connect-src 'self'.
      self: await status('app://renderer/index.html'),
      missing: await status('app://renderer/assets/does-not-exist.glb'),
      // Encoded ../ must not escape out/renderer.
      traversal: await status('app://renderer/..%2f..%2f..%2fpackage.json'),
      // Remote origins stay blocked by connect-src.
      remote: await status('https://example.com/'),
      // 'wasm-unsafe-eval' lets the meshopt decoder compile WebAssembly; JS eval stays blocked.
      wasm: await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])).then(
        () => 'ok',
        () => 'blocked',
      ),
      eval: (() => {
        try {
          return String((0, eval)('1'))
        } catch {
          return 'blocked'
        }
      })(),
    }
  })
  expect(r).toEqual({
    self: 200,
    missing: 404,
    traversal: 403,
    remote: 'blocked',
    wasm: 'ok',
    eval: 'blocked',
  })
  await app.close()
})
