import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launch, newProfile, PORT, type Profile } from './app.ts'

// Night City (Special 3D), plan §8 steps 1–11. Mock mode with AGENT_OFFICE_DEBUG=1:
// `__aoDebug.special` reports readiness, every agent's Night City anchor and the GPU estimate,
// and `interact(kind)` fires a semantic interaction as E would. Assertions are on DOM, data
// attributes and that debug state, never on pixels.
test.setTimeout(300_000)

interface SpecialAgent {
  id: string
  anchor: string
  activity: string
  desk?: string
}
interface SpecialDebug {
  ready(): boolean
  agents(): SpecialAgent[]
  room(): string | null
  interact(kind: string, agentId?: string): boolean
  gpu(): { textureMB: number; geometryMB: number }
}
type DebugWindow = { __aoDebug?: { special?: SpecialDebug; view?: (id: string) => boolean } }

const ready = (win: Page) =>
  win.evaluate(() => (window as unknown as DebugWindow).__aoDebug?.special?.ready() === true)
const agents = (win: Page) =>
  win.evaluate(() => (window as unknown as DebugWindow).__aoDebug?.special?.agents() ?? [])
const gpu = (win: Page) =>
  win.evaluate(() => (window as unknown as DebugWindow).__aoDebug!.special!.gpu())
const interact = (win: Page, kind: string) =>
  win.evaluate((k) => (window as unknown as DebugWindow).__aoDebug!.special!.interact(k), kind)

/** Waits until the Classic 3D scene is the active one (its own canvas, the special one gone). */
async function classic3d(win: Page): Promise<void> {
  await expect(win.locator('body')).toHaveAttribute('data-mode', '3d')
  await expect(win.locator('#stage canvas[data-scene="special"]')).toHaveCount(0, {
    timeout: 30_000,
  })
  await expect(win.locator('#stage canvas')).toHaveCount(1, { timeout: 30_000 })
  await expect
    .poll(
      () =>
        win.evaluate(
          () =>
            typeof (window as unknown as { __aoDebug?: { sceneBackground?: unknown } }).__aoDebug
              ?.sceneBackground,
        ),
      { timeout: 30_000 },
    )
    .toBe('function')
}

/** CI renders with software GL: start on the Low preset. */
function profileWith(settings: object = {}): Profile {
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  writeFileSync(
    join(profile.userData, 'settings.json'),
    JSON.stringify({ graphicsQuality: 'low', graphicsAdvanced: { labels: 'all' }, ...settings }),
  )
  return profile
}

function poster(profile: Profile) {
  return async (body: object) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${profile.token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(r.status).toBeLessThan(300)
  }
}

test('Night City: switch, intro, agents at workstations and booths, panel, modes, GPU, failure', async () => {
  const profile = profileWith()
  const { app, win, errors } = await launch(profile, { env: { AGENT_OFFICE_DEBUG: '1' } })
  const post = poster(profile)
  const toggle = (mode: '3d' | 'pixel' | 'special') =>
    win.locator(`#mode-toggle [data-mode="${mode}"]`)

  await test.step('1: the toggle offers Night City and switches to it', async () => {
    await expect(toggle('special')).toHaveText('Night City')
    await toggle('special').click()
    await expect(win.locator('body')).toHaveAttribute('data-mode', 'special')
  })

  await test.step('2: the first visit shows the intro; Continue closes it', async () => {
    await expect(win.locator('#special-intro')).toBeVisible({ timeout: 30_000 })
    await win.locator('#special-intro [data-action="continue"]').click()
    await expect(win.locator('#special-intro')).toBeHidden()
  })

  await test.step('3: the scene is ready, with its HUD (classic controls hidden)', async () => {
    await expect.poll(() => ready(win), { timeout: 60_000 }).toBe(true)
    await expect(win.locator('#special-hud')).toBeVisible()
    await expect(win.locator('#walk')).toBeHidden()
    // One WebGL canvas: the classic scene was disposed.
    await expect(win.locator('#stage canvas')).toHaveCount(1)
    await expect(win.locator('#stage canvas')).toHaveAttribute('data-scene', 'special')
  })

  await test.step('4: mock agents sit at ws: workstations', async () => {
    await expect
      .poll(async () => (await agents(win)).filter((a) => a.anchor.startsWith('ws:')).length, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0)
    // Every agent has a workstation of its own.
    const desks = (await agents(win)).map((a) => a.desk).filter(Boolean)
    expect(new Set(desks).size).toBe(desks.length)
  })

  await test.step('5: a waiting agent goes to a secure comm booth (or waits at its desk if all are taken)', async () => {
    const team = { provider: 'e2e', topic: 'Night shift', source: 'e2e' }
    await post({ agentId: 'e2e-wait', name: 'Waiter', status: 'tool', ...team })
    await expect
      .poll(async () => (await agents(win)).some((a) => a.id === 'e2e-wait'), { timeout: 20_000 })
      .toBe(true)
    await post({ agentId: 'e2e-wait', status: 'waiting' })
    await expect
      .poll(async () => (await agents(win)).find((a) => a.id === 'e2e-wait')?.activity, {
        timeout: 30_000,
      })
      .toBe('booth')
    const a = (await agents(win)).find((x) => x.id === 'e2e-wait')!
    expect(a.anchor).toMatch(/^(booth:\d+|ws:\d+:\d+:\d+)$/)
    // With mock agents waiting too, the booths fill up.
    expect((await agents(win)).some((x) => x.anchor.startsWith('booth:'))).toBe(true)
  })

  await test.step('8: clicking an agent opens Agent Details (#panel); chat works', async () => {
    await win.evaluate(() => (window as unknown as DebugWindow).__aoDebug!.view!('command'))
    const tag = win.locator('.tag[data-agent-id="mock:ada"]')
    await expect(tag).toBeAttached({ timeout: 20_000 })
    await tag.dispatchEvent('click')
    await expect(win.locator('#panel')).toBeVisible()
    await expect(win.locator('#p-name')).toHaveText('Ada')
    await win.locator('#p-input').fill('hi from Night City')
    await win.locator('#p-input').press('Enter')
    await expect(win.locator('#p-thread li.agent').last()).toHaveText(
      '(mock) got it: hi from Night City',
      {
        timeout: 15_000,
      },
    )
    await win.locator('#p-input').press('Escape')
    await expect(win.locator('#panel')).toBeHidden()
  })

  const ids = (await agents(win)).map((a) => a.id).sort()

  await test.step('9: Classic 3D and 2D show the same agents; the chat is preserved', async () => {
    await toggle('3d').click()
    await expect(win.locator('body')).toHaveAttribute('data-mode', '3d')
    await expect(win.locator('#special-hud')).toHaveCount(0)
    await expect(win.locator('.tag[data-agent-id="mock:ada"]')).toBeAttached({ timeout: 30_000 })
    await toggle('pixel').click()
    await expect(win.locator('body')).toHaveAttribute('data-mode', 'pixel')
    await expect(win.locator('#pixel')).toBeVisible({ timeout: 20_000 })
    await toggle('special').click()
    await expect.poll(() => ready(win), { timeout: 60_000 }).toBe(true)
    // The intro was seen once: it does not come back.
    await expect(win.locator('#special-intro')).toBeHidden()
    const again = (await agents(win)).map((a) => a.id).sort()
    // Every persistent agent is still here. Mock subagents come and go on their own schedule, and
    // the test agent was stopped, so neither can be compared across the switches.
    for (const id of ids)
      if (id !== 'e2e-wait' && !id.startsWith('mock:sub')) expect(again).toContain(id)
    await win.locator('.tag[data-agent-id="mock:ada"]').dispatchEvent('click')
    await expect(win.locator('#p-thread li.agent').last()).toHaveText(
      '(mock) got it: hi from Night City',
    )
    await win.locator('#p-input').press('Escape')
  })

  await test.step('10: ten switches back and forth: GPU memory back to baseline (±5%)', async () => {
    const base = await gpu(win)
    for (let i = 0; i < 10; i++) {
      await toggle('3d').click()
      await expect(win.locator('body')).toHaveAttribute('data-mode', '3d')
      await classic3d(win)
      await toggle('special').click()
      await expect.poll(() => ready(win), { timeout: 60_000 }).toBe(true)
    }
    await expect(win.locator('#stage canvas')).toHaveCount(1)
    const after = await gpu(win)
    expect(Math.abs(after.textureMB - base.textureMB)).toBeLessThanOrEqual(
      Math.max(1, base.textureMB * 0.05),
    )
    expect(Math.abs(after.geometryMB - base.geometryMB)).toBeLessThanOrEqual(
      Math.max(0.5, base.geometryMB * 0.05),
    )
  })

  await test.step('11: a forced start failure shows #special-failure; Classic 3D works', async () => {
    await toggle('3d').click()
    await classic3d(win)
    await win.evaluate(
      () => ((window as unknown as { __aoForceSpecialFail?: boolean }).__aoForceSpecialFail = true),
    )
    await toggle('special').click()
    await expect(win.locator('#special-failure')).toBeVisible({ timeout: 30_000 })
    // Safe diagnostics only: no paths or URLs.
    await expect(win.locator('#special-failure .nc-diag')).not.toContainText('/')
    await win.evaluate(
      () => delete (window as unknown as { __aoForceSpecialFail?: boolean }).__aoForceSpecialFail,
    )
    await win.locator('#special-failure [data-mode="3d"]').click()
    await expect(win.locator('#special-failure')).toHaveCount(0)
    await expect(win.locator('body')).toHaveAttribute('data-mode', '3d')
    await expect(toggle('3d')).toHaveAttribute('aria-checked', 'true')
  })

  // The failure step logs the forced error once; nothing else may.
  expect(errors.filter((e) => !/forced to fail|forceSpecialFail/.test(e))).toEqual([])
  await app.close()
})

// Steps 6–7: semantic interactions routed by the controller (`onPickInteraction` → interactionAction).
test('Night City: E on the command display and the Project Directory', async () => {
  const profile = profileWith({ viewMode: 'special', special: { introSeen: true } })
  const { app, win } = await launch(profile, { env: { AGENT_OFFICE_DEBUG: '1' } })
  await expect.poll(() => ready(win), { timeout: 60_000 }).toBe(true)
  // 6: the command display opens the Project Dashboard (overview without a project).
  await interact(win, 'command-display')
  await expect(win.locator('body')).toHaveAttribute('data-view', 'overview')
  await expect(win.locator('#ws-overview')).toBeVisible()
  // 7: the Project Directory opens the directory dialogue.
  await win.locator('#sb-office').click()
  await expect(win.locator('body')).toHaveAttribute('data-view', 'office')
  await interact(win, 'project-directory')
  await expect(win.locator('#dialogue')).toBeVisible()
  await app.close()
})
