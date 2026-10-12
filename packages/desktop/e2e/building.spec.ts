import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, newProfile } from './app.ts'

/** CI renders with software GL: start on the Low preset (no post-processing, no shadow maps). */
function lowQualityProfile() {
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  writeFileSync(join(profile.userData, 'settings.json'), JSON.stringify({ graphicsQuality: 'low' }))
  return profile
}

test('loads the HQ: loading screen hides, the canvas renders, one signed wing per provider', async () => {
  const { app, win, errors } = await launch(lowQualityProfile())

  // The loading screen covers the canvas until the manifest, atrium and character are in.
  await expect(win.locator('#loading')).toBeHidden({ timeout: 30_000 })

  // The WebGL canvas fills the window.
  const canvas = win.locator('#stage canvas').first()
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  expect(box!.width).toBeGreaterThan(300)
  expect(box!.height).toBeGreaterThan(200)

  // Mock mode seeds three providers → three wings; sign texts are mirrored in an accessible list
  // (the signs themselves are canvas textures).
  await expect(win.locator('#wing-signs .zone-sign')).toHaveText([
    'claude-code',
    'langgraph',
    'openai-agents',
  ])

  // Camera bookmarks: atrium, Main Street, each wing (in building order), the capability rooms of
  // the current wing, overview.
  const views = win.locator('#views .view-btn')
  await expect(views).toHaveCount(8)
  const labels = await views.allTextContents()
  expect(labels.slice(0, 2)).toEqual(['Atrium', 'Main Street'])
  expect(labels.slice(2, 5).sort()).toEqual(['claude-code', 'langgraph', 'openai-agents'])
  expect(labels.slice(5)).toEqual(['Adapters', 'Library', 'Overview'])

  // The capture/debug hook exists only when the app runs with AGENT_OFFICE_DEBUG=1.
  expect(await win.evaluate(() => typeof (window as { __aoDebug?: unknown }).__aoDebug)).toBe(
    'undefined',
  )

  // Flying to a wing works without errors.
  await win.locator('#views .view-btn', { hasText: 'claude-code' }).click()
  await win.waitForTimeout(1000)

  expect(errors).toEqual([])
  await app.close()
})
