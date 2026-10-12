import { expect, test } from '@playwright/test'
import { launch, newProfile } from './app.ts'

test('graphics quality defaults to Auto and Minimal persists across relaunch', async () => {
  const profile = newProfile()
  const first = await launch(profile)

  // A fresh profile starts on Auto (the hardware tier picks the start; the FPS governor adapts).
  await first.win.locator('#settings-btn').click()
  const select = first.win.locator('#s-graphicsQuality')
  await expect(select).toHaveValue('auto')

  // Choosing Minimal is saved through settings.set (no backend restart, so no restart note).
  await select.selectOption('minimal')
  await expect(select).toHaveValue('minimal')
  await expect(first.win.locator('#s-restart')).toBeHidden()
  await expect(first.win.locator('#s-error')).toHaveText('')
  await first.app.close()

  // Same profile → the saved preset comes back in the dialog.
  const second = await launch(profile)
  await second.win.locator('#settings-btn').click()
  await expect(second.win.locator('#s-graphicsQuality')).toHaveValue('minimal')
  expect(second.errors).toEqual([])
  await second.app.close()
})
