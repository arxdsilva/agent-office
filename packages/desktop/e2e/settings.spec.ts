import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, newProfile, PORT } from './app.ts'

/** A port that is free right now (the OS picks it, then we release it). */
async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as { port: number }).port
  await new Promise((r) => s.close(r))
  return port
}

test('settings: install and uninstall the Claude Code hook (isolated settings file)', async () => {
  const { app, win, profile } = await launch()
  await win.locator('#settings-btn').click()
  await expect(win.locator('#settings')).toBeVisible()
  await expect(win.locator('#s-hook-label')).toHaveText('Not installed')

  // Install writes a wrapper in userData and registers it in the (temp) Claude settings.
  await win.locator('#s-hook-btn').click()
  await expect(win.locator('#s-hook-label')).toHaveText('Installed ✓')
  const claude = JSON.parse(readFileSync(profile.claudeSettings, 'utf8'))
  const wrapper = join(
    profile.userData,
    'hook',
    process.platform === 'win32' ? 'agent-office-hook.cmd' : 'agent-office-hook.sh',
  )
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

test('settings: changing the port rewrites the hook wrapper with the new port', async () => {
  // The port comes from saved settings (no PORT override), so the user can change it.
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  writeFileSync(join(profile.userData, 'settings.json'), JSON.stringify({ port: PORT }))
  const { app, win } = await launch(profile, { env: { PORT: undefined } })
  const wrapper = join(
    profile.userData,
    'hook',
    process.platform === 'win32' ? 'agent-office-hook.cmd' : 'agent-office-hook.sh',
  )

  // Installing the hook writes a wrapper that points the hook at the live port.
  await win.locator('#settings-btn').click()
  await win.locator('#s-hook-btn').click()
  await expect(win.locator('#s-hook-label')).toHaveText('Installed ✓')
  expect(readFileSync(wrapper, 'utf8')).toContain(`http://127.0.0.1:${PORT}`)

  // Applying a free port restarts the API there, and the wrapper follows without a reinstall.
  const next = await freePort()
  await win.locator('#s-port').fill(String(next))
  await win.locator('#s-port').press('Enter')
  await expect
    .poll(() => readFileSync(wrapper, 'utf8'), { timeout: 10_000 })
    .toContain(`http://127.0.0.1:${next}`)
  await app.close()
})
