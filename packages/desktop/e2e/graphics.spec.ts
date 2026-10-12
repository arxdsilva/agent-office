import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launch, newProfile } from './app.ts'

// Settings → Graphics (low-spec plan §2, §7 G1–G3, G5): presets and Advanced overrides reach the
// scene's effective graphics, the power saver paces frames, and a WebGL failure offers software
// rendering. AGENT_OFFICE_DEBUG=1 installs `__aoDebug` (graphics(), frames()).
test.setTimeout(120_000)

const DEBUG = { env: { AGENT_OFFICE_DEBUG: '1' } }

interface EffectiveLike {
  preset: string
  fpsLimit: number | null
  resolutionScale: number
  shadows: string
  labels: { mode: string }
}
interface AoDebug {
  graphics(): EffectiveLike
  /** Frames the scene has rendered since start (skipped frames don't count). */
  frames(): number
}
type DebugWindow = { __aoDebug: AoDebug }
const graphics = (win: Page) =>
  win.evaluate(() => (window as unknown as DebugWindow).__aoDebug.graphics())
const frames = (win: Page) =>
  win.evaluate(() => (window as unknown as DebugWindow).__aoDebug.frames())

/** A profile with saved settings (the window may not have focus under Playwright: no blur cap). */
function profileWith(settings: Record<string, unknown>) {
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  writeFileSync(
    join(profile.userData, 'settings.json'),
    JSON.stringify({ powerSaverBlur: false, ...settings }),
  )
  return profile
}

const savedSettings = (userData: string) =>
  JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as Record<string, unknown>

/** Runs a BrowserWindow method in the main process (focus, blur, hide, show). */
const windowDo = (app: ElectronApplication, method: 'focus' | 'blur' | 'hide' | 'show') =>
  app.evaluate(({ BrowserWindow }, m) => BrowserWindow.getAllWindows()[0]![m](), method)

test('G1: Minimal applies its preset and Settings shows the live stats line', async () => {
  const { app, win, errors } = await launch(profileWith({ graphicsQuality: 'low' }), DEBUG)

  // Pick Minimal in Settings → Graphics: the scene gets the §2.2 Minimal values live.
  await win.locator('#settings-btn').click()
  await win.locator('#s-graphicsQuality').selectOption('minimal')
  await expect
    .poll(() => graphics(win))
    .toMatchObject({
      preset: 'minimal',
      fpsLimit: 30,
      resolutionScale: 0.75,
      shadows: 'off',
      labels: { mode: 'nearby' },
    })

  // The "Now" line refreshes while the dialog is open: fps, preset, GPU memory, size.
  await expect(win.locator('#s-gfx-now')).toHaveText(/fps · Minimal · GPU memory ≈ \d+ MB/)

  expect(errors).toEqual([])
  await app.close()
})

test('G2: Advanced overrides apply on top of High, show "(custom)" and reset', async () => {
  const { app, win, profile, errors } = await launch(
    profileWith({ graphicsQuality: 'high' }),
    DEBUG,
  )
  await win.locator('#settings-btn').click()

  // Advanced is collapsed and not custom on a fresh profile.
  const custom = win.locator('#s-adv-custom')
  await expect(custom).toBeHidden()
  await win.locator('#s-gfx-advanced > summary').click()

  // Frame-rate limit 30 and name tags "Selected only": the rest stays High.
  await win.locator('#s-adv-fps').selectOption('30')
  await win.locator('#s-adv-labels').selectOption('selected')
  await expect
    .poll(() => graphics(win))
    .toMatchObject({ preset: 'high', fpsLimit: 30, labels: { mode: 'selected' } })
  await expect(custom).toBeVisible()
  // The whole graphicsAdvanced object is saved (not a partial patch).
  await expect
    .poll(() => savedSettings(profile.userData).graphicsAdvanced)
    .toMatchObject({ fps: '30', labels: 'selected', shadows: 'auto' })

  // Reset to preset: every option back to Auto → High's own values (unlimited fps, all tags).
  await win.locator('#s-adv-reset').click()
  await expect(custom).toBeHidden()
  await expect(win.locator('#s-adv-fps')).toHaveValue('auto')
  await expect
    .poll(() => graphics(win))
    .toMatchObject({ preset: 'high', fpsLimit: null, labels: { mode: 'all' } })

  expect(errors).toEqual([])
  await app.close()
})

test('G3: power saver lowers the frame rate when unfocused and pauses when hidden', async () => {
  // Power saver defaults (blur 15 fps, pause when hidden) on the Low preset.
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  writeFileSync(join(profile.userData, 'settings.json'), JSON.stringify({ graphicsQuality: 'low' }))
  const { app, win, errors } = await launch(profile, DEBUG)

  // Unfocused: frames over 2 s stay at or under ~15 fps (a range: CI renders with software GL).
  // Playwright emulates page focus, so a native BrowserWindow blur never reaches the page; dispatch
  // the window's blur event the way Chromium does when the app loses focus.
  await win.evaluate(() => window.dispatchEvent(new Event('blur')))
  await win.waitForTimeout(500)
  let before = await frames(win)
  await win.waitForTimeout(2000)
  expect((await frames(win)) - before).toBeLessThanOrEqual(2 * 18)

  // Hidden: no frames at all for a second.
  await windowDo(app, 'hide')
  await win.waitForTimeout(500)
  before = await frames(win)
  await win.waitForTimeout(1000)
  expect(await frames(win)).toBe(before)

  // Shown and focused again: rendering resumes.
  await windowDo(app, 'show')
  await win.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => frames(win)).toBeGreaterThan(before)

  expect(errors).toEqual([])
  await app.close()
})

// SwiftShader gives no WebGL on macOS with Electron 44 (ANGLE "Internal Vulkan error"), so the
// software-rendering path is checked on Linux and Windows CI only.
test('G4: on software rendering, Auto picks Minimal', async () => {
  test.skip(process.platform === 'darwin', 'no software WebGL on macOS')
  const { app, win } = await launch(profileWith({ graphicsQuality: 'auto' }), {
    env: { ...DEBUG.env, AGENT_OFFICE_FORCE_SOFTWARE_GL: '1' },
  })
  // The hardware tier sees SwiftShader/llvmpipe and starts Auto at Minimal.
  await expect.poll(async () => (await graphics(win)).preset, { timeout: 20_000 }).toBe('minimal')
  // Settings explains why.
  await win.locator('#settings-btn').click()
  await expect(win.locator('#s-gfx-auto-note')).toContainText(/software rendering/i)
  await app.close()
})

test('G5: when WebGL fails, the card turns hardware acceleration off', async () => {
  // AGENT_OFFICE_FORCE_WEBGL_FAIL=1 makes main load the renderer with ?forceWebglFail=1, so the
  // scene factory throws. AGENT_OFFICE_NO_RELAUNCH=1 keeps the restart from spawning a new app
  // outside Playwright's control (it quits instead).
  const profile = newProfile()
  const { app, win } = await launch(profile, {
    env: { AGENT_OFFICE_FORCE_WEBGL_FAIL: '1', AGENT_OFFICE_NO_RELAUNCH: '1' },
    waitForAgents: false,
  })

  // The full-window card replaces the 3D view.
  const card = win.locator('#gfx-failure')
  await expect(card).toBeVisible()
  await expect(win.locator('#gfx-f-title')).toHaveText('3D isn’t available on this computer')
  await expect(win.locator('#stage')).toBeHidden()

  // [Use software rendering and restart] saves hardwareAcceleration:false (main then restarts).
  const closed = app.waitForEvent('close').catch(() => undefined)
  await win.locator('#gfx-f-software').click()
  await expect.poll(() => savedSettings(profile.userData).hardwareAcceleration).toBe(false)
  await Promise.race([closed, new Promise((r) => setTimeout(r, 5000))])
  await app.close().catch(() => undefined)
})
