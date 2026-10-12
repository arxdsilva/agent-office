import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, newProfile } from './app.ts'

test('settings: install and uninstall the Claude Code hook (isolated settings file)', async () => {
  const { app, win, profile } = await launch()
  await win.locator('#settings-btn').click()
  await expect(win.locator('#settings')).toBeVisible()
  await expect(win.locator('#s-hook-label')).toHaveText('Not installed')

  // Install writes a wrapper in userData and registers it in the (temp) Claude settings.
  await win.locator('#s-hook-btn').click()
  await expect(win.locator('#s-hook-label')).toHaveText('Installed ✓')
  const claude = JSON.parse(readFileSync(profile.claudeSettings, 'utf8'))
  const wrapper = join(profile.userData, 'hook', process.platform === 'win32' ? 'agent-office-hook.cmd' : 'agent-office-hook.sh')
  expect(claude.hooks.Stop[0].hooks[0].command).toBe(`"${wrapper}"`)
  expect(existsSync(wrapper)).toBe(true)

  // Uninstall removes only our entries and the wrapper.
  await win.locator('#s-hook-btn').click()
  await expect(win.locator('#s-hook-label')).toHaveText('Not installed')
  expect(JSON.parse(readFileSync(profile.claudeSettings, 'utf8'))).toEqual({})
  expect(existsSync(wrapper)).toBe(false)
  await app.close()
})

test('settings persist across relaunch', async () => {
  const profile = newProfile()
  const first = await launch(profile)
  await first.win.locator('#settings-btn').click()
  await first.win.locator('#s-notifications').uncheck()
  await expect(first.win.locator('#s-notifications')).not.toBeChecked()
  await first.app.close()

  // Same profile → the saved choice comes back.
  const second = await launch(profile)
  await second.win.locator('#settings-btn').click()
  await expect(second.win.locator('#s-notifications')).not.toBeChecked()
  await second.app.close()
})
