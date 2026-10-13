import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launch, newProfile } from './app.ts'

// Horizon (the 'special' view mode), plan §6.9: the Classic office rendered by the Classic scene
// with a light flavor. Mock mode with AGENT_OFFICE_DEBUG=1: `__aoDebug` is the Classic scene's
// debug hook (`anchorOf`, `views`, `gpu`, `flavor`) plus `horizon` (`ready`, `calm`, `luma`,
// `emissive`). Assertions are on DOM, data attributes and that debug state.
test.setTimeout(300_000)

interface HorizonDebug {
  ready(): boolean
  calm(): string[]
  luma(): number | null
  contrast(): number | null
  emissive(): { max: number; name: string }
}
interface Debug {
  ready(): boolean
  flavor?(): 'classic' | 'horizon'
  views(): string[]
  view(id: string): boolean
  anchorOf(id: string): string | null
  graphics(): { labels: { mode: string } }
  gpu(): { textureMB: number; geometryMB: number }
  horizon?: HorizonDebug
}
type W = { __aoDebug?: Debug }

const dbg = <T>(win: Page, fn: (d: Debug, arg: unknown) => T, arg?: unknown) =>
  win.evaluate(
    ([src, a]) => {
      const d = (window as unknown as W).__aoDebug
      if (!d) return null as T
      const f = new Function('d', 'a', `return (${src})(d, a)`) as (d: Debug, a: unknown) => T
      return f(d, a)
    },
    [fn.toString(), arg] as const,
  )
/** True once the Horizon scene has loaded its office. */
const horizonReady = (win: Page) => dbg(win, (d) => d.horizon?.ready() === true)
/** True once the Classic scene (not Horizon) has loaded its office. */
const classicReady = (win: Page) => dbg(win, (d) => d.flavor?.() === 'classic' && d.ready())
/** HORIZON_SHOTS=<dir>: save review screenshots (local visual check only). */
const shot = async (win: Page, name: string) => {
  const dir = process.env.HORIZON_SHOTS
  if (dir) await win.screenshot({ path: join(dir, `horizon-${name}.png`) })
}

/** Every mock agent's desk (seat anchor) as the active scene sees it. */
async function desks(win: Page, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const id of ids) {
    const a = await dbg(win, (d, i) => d.anchorOf(i as string), id)
    if (a && a.includes('seat:desk:')) out.set(id, a)
  }
  return out
}

/** CI renders with software GL: start on the Low preset. */
function profileWith(settings: object = {}) {
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  writeFileSync(
    join(profile.userData, 'settings.json'),
    JSON.stringify({ graphicsQuality: 'low', ...settings }),
  )
  return profile
}

test('Horizon: intro, same rooms and seats, panel, calm and bright, mode round trips, failure card', async () => {
  // Tags for every agent (clickable); the calm "nearby" default is checked in the next test.
  const profile = profileWith({ graphicsAdvanced: { labels: 'all' } })
  const { app, win, errors } = await launch(profile, { env: { AGENT_OFFICE_DEBUG: '1' } })
  const toggle = (mode: '3d' | 'pixel' | 'special') =>
    win.locator(`#mode-toggle [data-mode="${mode}"]`)

  // Classic first: its rooms (bookmarks) and every mock agent's desk, to compare with Horizon.
  await expect.poll(() => classicReady(win), { timeout: 60_000 }).toBe(true)
  const ids = ['ada', 'linus', 'grace', 'ken', 'barbara', 'dennis', 'margaret', 'alan'].map(
    (n) => `mock:${n}`,
  )
  await expect
    .poll(async () => (await desks(win, ids)).size, { timeout: 30_000 })
    .toBeGreaterThan(2)
  // The view list grows as the wings stream in: wait until it is stable.
  let classicViews: string[] = []
  await expect
    .poll(
      async () => {
        const v = (await dbg(win, (d) => d.views()))!.sort()
        const same = v.join() === classicViews.join()
        classicViews = v
        return same && v.some((id) => id.startsWith('library-rules:'))
      },
      { timeout: 60_000, intervals: [2000] },
    )
    .toBe(true)
  const classicDesks = await desks(win, ids)

  await test.step('1: the toggle offers Horizon; the first visit shows the intro; Continue → ready', async () => {
    await expect(toggle('special')).toHaveText('Horizon')
    await toggle('special').click()
    await expect(win.locator('body')).toHaveAttribute('data-mode', 'special')
    await expect(win.locator('#horizon-intro')).toBeVisible({ timeout: 60_000 })
    await expect(win.locator('#horizon-intro')).toContainText('Same rooms, same agents.')
    await win.locator('#horizon-intro [data-action="continue"]').click()
    await expect(win.locator('#horizon-intro')).toBeHidden()
    await expect.poll(() => horizonReady(win), { timeout: 60_000 }).toBe(true)
    // One WebGL canvas, Horizon's; the Classic HUD and controls stay (no extra HUD).
    await expect(win.locator('#stage canvas')).toHaveCount(1)
    await expect(win.locator('#stage canvas')).toHaveAttribute('data-scene', 'horizon')
    await expect(win.locator('#walk')).toBeVisible()
    await expect(win.locator('#hud')).toBeVisible()
  })

  await test.step('2: the same rooms, and every agent at the same desk as in Classic', async () => {
    await expect
      .poll(async () => (await dbg(win, (d) => d.views()))!.sort(), { timeout: 60_000 })
      .toEqual(classicViews)
    // Desks fill in as agents come back to them (replayed plans start where agents are).
    await expect
      .poll(async () => (await desks(win, ids)).size, { timeout: 60_000 })
      .toBeGreaterThan(Math.min(2, classicDesks.size - 1))
    const now = await desks(win, ids)
    for (const [id, desk] of now) if (classicDesks.has(id)) expect(desk).toBe(classicDesks.get(id))
  })

  await test.step('3: the kiosk opens the Project Directory', async () => {
    await win
      .locator('.fixture-tag[data-fixture="project-directory"]')
      .dispatchEvent('click', undefined, { timeout: 20_000 })
    await expect(win.locator('#palette')).toBeVisible()
    await win.keyboard.press('Escape')
    await expect(win.locator('#palette')).toBeHidden()
  })

  await test.step('4: clicking an agent opens Agent Details (#panel) with its name', async () => {
    const tag = win.locator('.tag[data-agent-id="mock:ada"]')
    await expect(tag).toBeAttached({ timeout: 20_000 })
    await tag.dispatchEvent('click')
    await expect(win.locator('#panel')).toBeVisible()
    await expect(win.locator('#p-name')).toHaveText('Ada')
    await win.locator('#p-input').fill('hi from Horizon')
    await win.locator('#p-input').press('Enter')
    await expect(win.locator('#p-thread li.agent').last()).toHaveText(
      '(mock) got it: hi from Horizon',
      { timeout: 15_000 },
    )
    await win.locator('#p-input').press('Escape')
    await expect(win.locator('#panel')).toBeHidden()
  })

  await test.step('5: calm: no ad, holo, rain or traffic objects anywhere in the scene', async () => {
    expect(await dbg(win, (d) => d.horizon!.calm())).toEqual([])
  })

  await test.step('6: bright and crisp: the atrium reads as daylight (luma ≥ 0.5, contrast ≥ 0.12)', async () => {
    await dbg(win, (d) => d.view('atrium'))
    await win.waitForTimeout(1500)
    await shot(win, 'atrium')
    const luma = await dbg(win, (d) => d.horizon!.luma())
    expect(luma).not.toBeNull()
    expect(luma!).toBeGreaterThanOrEqual(0.5)
    // Light, not faded: a milky, low-contrast image has a small luma spread.
    const contrast = await dbg(win, (d) => d.horizon!.contrast())
    expect(contrast!).toBeGreaterThanOrEqual(0.12)
  })

  await test.step('7: neon restrained: no visible emissive above 1.5', async () => {
    // Twice, a second apart: pulsing surfaces (stations, the context core) stay within the ceiling.
    for (let i = 0; i < 2; i++) {
      const e = (await dbg(win, (d) => d.horizon!.emissive()))!
      expect(e.max, e.name).toBeLessThanOrEqual(1.5)
      await win.waitForTimeout(1000)
    }
  })

  await test.step('8: 3D ↔ 2D ↔ Horizon keep the agents and the chat; GPU memory back to baseline', async () => {
    await toggle('pixel').click()
    await expect(win.locator('body')).toHaveAttribute('data-mode', 'pixel')
    await expect(win.locator('#pixel')).toBeVisible({ timeout: 20_000 })
    await toggle('special').click()
    await expect.poll(() => horizonReady(win), { timeout: 60_000 }).toBe(true)
    // The intro was seen once: it does not come back.
    await expect(win.locator('#horizon-intro')).toHaveCount(0)
    await win.locator('.tag[data-agent-id="mock:ada"]').dispatchEvent('click')
    await expect(win.locator('#p-thread li.agent').last()).toHaveText(
      '(mock) got it: hi from Horizon',
    )
    await win.locator('#p-input').press('Escape')
    // Memory once every wing has streamed in: steady across two readings 1.5 s apart. A reading
    // taken mid-stream records a half-loaded building and reads as a "leak" later.
    const settled = async () => {
      let last = (await dbg(win, (d) => d.gpu()))!
      await expect
        .poll(
          async () => {
            await win.waitForTimeout(1500)
            const now = (await dbg(win, (d) => d.gpu()))!
            const steady = now.textureMB === last.textureMB && now.geometryMB === last.geometryMB
            last = now
            return steady
          },
          { timeout: 60_000 },
        )
        .toBe(true)
      return last
    }
    const roundTrip = async () => {
      await toggle('3d').click()
      await expect.poll(() => classicReady(win), { timeout: 60_000 }).toBe(true)
      await toggle('special').click()
      await expect.poll(() => horizonReady(win), { timeout: 60_000 }).toBe(true)
    }
    // The baseline is taken after one round trip, so it includes whatever a rebuild keeps (a
    // lightmap tier, caches) and a leak shows as growth across the later rounds.
    await roundTrip()
    const base = await settled()
    // Ten round trips on a real GPU; three under software GL (each scene build is slow there).
    const rounds = process.env.AGENT_OFFICE_FORCE_SOFTWARE_GL === '1' ? 3 : 10
    for (let i = 0; i < rounds; i++) await roundTrip()
    await expect(win.locator('#stage canvas')).toHaveCount(1)
    const after = await settled()
    expect(Math.abs(after.textureMB - base.textureMB)).toBeLessThanOrEqual(
      Math.max(1, base.textureMB * 0.05),
    )
    expect(Math.abs(after.geometryMB - base.geometryMB)).toBeLessThanOrEqual(
      Math.max(0.5, base.geometryMB * 0.05),
    )
  })

  await test.step('9: a forced start failure shows #horizon-failure; Classic 3D still works', async () => {
    await toggle('3d').click()
    await expect.poll(() => classicReady(win), { timeout: 60_000 }).toBe(true)
    await win.evaluate(
      () => ((window as unknown as { __aoForceSpecialFail?: boolean }).__aoForceSpecialFail = true),
    )
    await toggle('special').click()
    await expect(win.locator('#horizon-failure')).toBeVisible({ timeout: 30_000 })
    // Safe diagnostics only: no paths or URLs.
    await expect(win.locator('#horizon-failure .hz-diag')).not.toContainText('/')
    await win.evaluate(
      () => delete (window as unknown as { __aoForceSpecialFail?: boolean }).__aoForceSpecialFail,
    )
    await win.locator('#horizon-failure [data-mode="3d"]').click()
    await expect(win.locator('#horizon-failure')).toHaveCount(0)
    await expect(win.locator('body')).toHaveAttribute('data-mode', '3d')
    await expect(toggle('3d')).toHaveAttribute('aria-checked', 'true')
  })

  // The failure step logs the forced error once; nothing else may.
  expect(errors.filter((e) => !/forced to fail|forceSpecialFail/.test(e))).toEqual([])
  await app.close()
})

test('Horizon at startup: calm name tags by default', async () => {
  // Starting straight in Horizon (the lazy chunk via SceneHost.initAsync), labels on Auto. Medium
  // shows every tag in Classic; Horizon's calm default shows only nearby ones.
  const profile = profileWith({
    graphicsQuality: 'medium',
    viewMode: 'special',
    special: { introSeen: true },
  })
  const { app, win } = await launch(profile, {
    env: { AGENT_OFFICE_DEBUG: '1' },
    waitForAgents: false,
  })
  await expect.poll(() => horizonReady(win), { timeout: 60_000 }).toBe(true)
  await expect(win.locator('#horizon-intro')).toHaveCount(0)
  await expect
    .poll(() => dbg(win, (d) => d.graphics().labels.mode), { timeout: 10_000 })
    .toBe('nearby')
  await app.close()
})
