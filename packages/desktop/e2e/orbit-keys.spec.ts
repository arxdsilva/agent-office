import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launch, newProfile } from './app.ts'

// Plan §4c: in the 3D orbit view, WASD / arrows pan the camera over the office. Typing in the chat
// composer never pans, and panning ends follow mode like a drag does.
// AGENT_OFFICE_DEBUG=1 installs the renderer's __aoDebug hook (orbit(), view()).
test.setTimeout(90_000)

type Orbit = {
  target: { x: number; y: number; z: number }
  following: string | null
  /** A camera flight is running. */
  flying: boolean
}
type Debug = {
  ready(): boolean
  view(id: string): boolean
  focus(id: string): void
  orbit(): Orbit
}

/** CI renders with software GL: start on the Low preset. */
function lowQualityProfile() {
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  writeFileSync(join(profile.userData, 'settings.json'), JSON.stringify({ graphicsQuality: 'low' }))
  return profile
}

const orbit = (win: Page) =>
  win.evaluate(() => (window as unknown as { __aoDebug: Debug }).__aoDebug.orbit())

const moved = (a: Orbit, b: Orbit) => Math.hypot(b.target.x - a.target.x, b.target.z - a.target.z)

async function hold(win: Page, key: string, ms: number) {
  await win.keyboard.down(key)
  await win.waitForTimeout(ms)
  await win.keyboard.up(key)
}

test('WASD pans the orbit camera, not while typing, and ends follow mode', async () => {
  const { app, win, errors } = await launch(lowQualityProfile(), {
    env: { AGENT_OFFICE_DEBUG: '1' },
  })
  await expect
    .poll(() => win.evaluate(() => (window as unknown as { __aoDebug?: Debug }).__aoDebug?.ready()))
    .toBe(true)
  const view = (id: string) =>
    win.evaluate((v) => (window as unknown as { __aoDebug: Debug }).__aoDebug.view(v), id)

  // Start from the overview (a jump, no flight running), with nothing selected or focused.
  expect(await view('overview')).toBe(true)
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const start = await orbit(win)
  expect(start.following).toBeNull()

  // Holding W glides the orbit target across the floor: over 2 m within about a second on a GPU
  // (≥ 4 m/s). Keep it held while polling: on software GL each frame's step is capped, so it is slower.
  await win.keyboard.down('KeyW')
  await expect
    .poll(async () => moved(start, await orbit(win)), { timeout: 8_000 })
    .toBeGreaterThan(2)
  await win.keyboard.up('KeyW')

  // Pick Ada (the same path as clicking her tag, which is culled at this height): her chat panel
  // opens and the camera follows her.
  await win.evaluate(() => (window as unknown as { __aoDebug: Debug }).__aoDebug.focus('mock:ada'))
  await expect(win.locator('#p-name')).toHaveText('Ada')
  await expect.poll(async () => (await orbit(win)).following).toBe('mock:ada')

  // Pan with D once the focus flight has landed (keys don't pan during a flight; on software GL
  // it takes longer than its nominal 0.8 s): follow mode ends, just like a drag pan.
  await expect.poll(async () => (await orbit(win)).flying, { timeout: 20_000 }).toBe(false)
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await hold(win, 'KeyD', 1500)
  await expect.poll(async () => (await orbit(win)).following).toBeNull()

  // With the chat composer focused, W types into it and the camera stays put.
  await win.locator('#p-input').focus()
  const before = await orbit(win)
  await hold(win, 'KeyW', 1000)
  expect(moved(before, await orbit(win))).toBeLessThan(0.01)
  await expect(win.locator('#p-input')).toHaveValue(/w/i)

  expect(errors).toEqual([])
  await app.close()
})
