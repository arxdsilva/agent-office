import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, newProfile } from './app.ts'

// Changing one setting must never reset the others. Zod 4 keeps `.default()` inside `.partial()`,
// so the settings patch used to carry every default: changing a graphics option reset the quality
// preset to Auto, the theme to System and the port to 4317. Graphics G2 caught it on 3-core CI Macs.
test('SP1: changing one setting keeps every other saved setting', async () => {
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  const file = join(profile.userData, 'settings.json')
  writeFileSync(
    file,
    JSON.stringify({
      graphicsQuality: 'high',
      theme: 'dark',
      notifications: false,
      powerSaverBlur: false,
    }),
  )
  const saved = () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  const { app, win, errors } = await launch(profile)

  // Change only the frame-rate limit in Settings → Graphics → Advanced.
  await win.locator('#settings-btn').click()
  await win.locator('#s-gfx-advanced > summary').click()
  await win.locator('#s-adv-fps').selectOption('30')
  await expect
    .poll(() => (saved().graphicsAdvanced as { fps?: string } | undefined)?.fps)
    .toBe('30')

  // Everything else is exactly what the user had chosen.
  expect(saved()).toMatchObject({ graphicsQuality: 'high', theme: 'dark', notifications: false })
  expect(errors).toEqual([])
  await app.close()
})
