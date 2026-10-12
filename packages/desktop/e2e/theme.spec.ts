import { expect, test, type Page } from '@playwright/test'
import { launch, newProfile } from './app.ts'

// Plan §2.6 / J5: Settings → Appearance switches every surface at once, both themes keep the same
// features and readable contrast, and the choice persists across a relaunch.
// AGENT_OFFICE_DEBUG=1 installs the renderer's __aoDebug hook (sceneBackground()).
const DEBUG = { env: { AGENT_OFFICE_DEBUG: '1' } }

/**
 * Playwright pins the page to `prefers-color-scheme: light` by default; drop that emulation so the
 * page follows Electron's nativeTheme like the real app does.
 */
async function openApp(profile = newProfile()) {
  const r = await launch(profile, DEBUG)
  await r.win.emulateMedia({ colorScheme: null })
  return r
}

const LIGHT_SCENE = 0xe9edf3
const DARK_SCENE = 0x1b2028

/** Elements whose text must reach WCAG AA (4.5:1) in both themes. */
const CONTRAST = ['.tag', '.bubble', '#p-name', '.pill.error', 'button.link', '#connect .tab']

async function setTheme(win: Page, theme: 'light' | 'dark' | 'system') {
  // Through the real UI: Settings → Appearance segmented control.
  await win.locator('#settings-btn').click()
  await expect(win.locator('#settings')).toBeVisible()
  const radio = win.locator(`#s-theme [role=radio][data-theme=${theme}]`)
  await radio.click()
  await expect(radio).toHaveAttribute('aria-checked', 'true')
  await win.locator('#s-close').click()
  await expect(win.locator('#settings')).toBeHidden()
}

/** Channels of an `rgb()/rgba()` string. */
function rgba(rgb: string): [number, number, number, number] {
  const n = rgb.match(/[\d.]+/g)!.map(Number)
  return [n[0]!, n[1]!, n[2]!, n[3] ?? 1]
}

async function bodyBackground(win: Page): Promise<number> {
  const [r, g, b] = rgba(await win.evaluate(() => getComputedStyle(document.body).backgroundColor))
  return (r + g + b) / 3
}

/**
 * In-page WCAG contrast for the first matching visible element: the text color against its
 * effective background (translucent ancestor backgrounds composited over the page --bg).
 * A missing element (e.g. no error pill in mock mode) is measured on a probe built from the same
 * class inside its real container, so the real CSS still decides the colors.
 */
async function contrast(win: Page, selector: string): Promise<number> {
  return win.evaluate((sel) => {
    type C = [number, number, number, number]
    const parse = (s: string): C => {
      const n = (s.match(/[\d.]+/g) ?? ['0', '0', '0', '0']).map(Number)
      return [n[0]!, n[1]!, n[2]!, n[3] ?? 1]
    }
    const over = (top: C, under: C): C => {
      const a = top[3]
      return [
        top[0] * a + under[0] * (1 - a),
        top[1] * a + under[1] * (1 - a),
        top[2] * a + under[2] * (1 - a),
        1,
      ]
    }
    const lum = (c: C) => {
      const f = (v: number) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
    }
    let target = [...document.querySelectorAll<HTMLElement>(sel)].find(
      (e) => e.getClientRects().length > 0 && (e.textContent ?? '').trim() !== '',
    )
    let probe: HTMLElement | undefined
    if (!target) {
      const host =
        sel === '.pill.error'
          ? (document.querySelector<HTMLElement>('#connect[open] .connect-panels') ??
            document.querySelector<HTMLElement>('#settings[open]'))
          : null
      if (!host) throw new Error(`nothing to measure for ${sel}`)
      probe = document.createElement('span')
      probe.className = 'pill error'
      probe.textContent = 'probe'
      host.append(probe)
      target = probe
    }
    const page = parse(getComputedStyle(document.body).backgroundColor)
    const layers: C[] = []
    for (let e: HTMLElement | null = target; e; e = e.parentElement) {
      const bg = parse(getComputedStyle(e).backgroundColor)
      if (bg[3] > 0) layers.push(bg)
      if (bg[3] >= 1) break
    }
    let bg: C = page
    for (const l of layers.reverse()) bg = over(l, bg)
    const fg = over(parse(getComputedStyle(target).color), bg)
    probe?.remove()
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a)
    return (hi! + 0.05) / (lo! + 0.05)
  }, selector)
}

/** Opens the agent panel and the Connect dialog so every element in CONTRAST is on screen. */
async function contrastReport(win: Page): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  await win.locator('.bubble:not(:empty)').first().waitFor({ state: 'attached' })
  out['.tag'] = await contrast(win, '.tag')
  out['.bubble'] = await contrast(win, '.bubble')
  // The agent panel: name heading.
  await win.locator('.tag').first().click()
  await expect(win.locator('#panel')).toBeVisible()
  out['#p-name'] = await contrast(win, '#p-name')
  await win.keyboard.press('Escape')
  // Settings holds a real button.link ("more ways to connect").
  await win.locator('#settings-btn').click()
  out['button.link'] = await contrast(win, '#settings button.link')
  await win.locator('#s-close').click()
  // The Connect dialog: tabs and status pills.
  await win.locator('#connect-btn').click()
  await expect(win.locator('#connect')).toBeVisible()
  out['#connect .tab'] = await contrast(win, '#connect .tab')
  out['.pill.error'] = await contrast(win, '.pill.error')
  await win.keyboard.press('Escape')
  return out
}

test('T1: Dark from Settings switches the page, name bubbles and 3D scene', async () => {
  const { app, win, errors } = await openApp()
  await setTheme(win, 'dark')

  // The CSS follows prefers-color-scheme, which main flips through nativeTheme.themeSource.
  await expect.poll(() => bodyBackground(win)).toBeLessThan(60)
  const bubble = await win
    .locator('.bubble')
    .first()
    .evaluate((e) => getComputedStyle(e).backgroundColor)
  expect((([r, g, b]) => (r + g + b) / 3)(rgba(bubble))).toBeLessThan(80)
  // The renderer's matchMedia listener calls scene.setTheme('dark').
  await expect
    .poll(() => win.evaluate(() => (window as any).__aoDebug.sceneBackground()))
    .toBe(DARK_SCENE)
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')

  const report = await contrastReport(win)
  console.log('contrast dark', JSON.stringify(report))
  for (const sel of CONTRAST) expect(report[sel], `${sel} (dark)`).toBeGreaterThanOrEqual(4.5)
  expect(errors).toEqual([])
  await app.close()
})

test('T2: Light from Settings gives light surfaces with AA contrast', async () => {
  const { app, win, errors } = await openApp()
  await setTheme(win, 'light')

  await expect.poll(() => bodyBackground(win)).toBeGreaterThan(200)
  const bubble = await win
    .locator('.bubble')
    .first()
    .evaluate((e) => getComputedStyle(e).backgroundColor)
  expect((([r, g, b]) => (r + g + b) / 3)(rgba(bubble))).toBeGreaterThan(200)
  await expect
    .poll(() => win.evaluate(() => (window as any).__aoDebug.sceneBackground()))
    .toBe(LIGHT_SCENE)
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light')

  const report = await contrastReport(win)
  console.log('contrast light', JSON.stringify(report))
  for (const sel of CONTRAST) expect(report[sel], `${sel} (light)`).toBeGreaterThanOrEqual(4.5)
  expect(errors).toEqual([])
  await app.close()
})

test('T3: the theme persists across a relaunch', async () => {
  const profile = newProfile()
  // First run: pick Dark.
  const first = await openApp(profile)
  await setTheme(first.win, 'dark')
  await first.app.close()

  // Same profile: main applies the saved theme before the window paints; Settings shows it.
  const second = await openApp(profile)
  expect(await second.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')
  await expect.poll(() => bodyBackground(second.win)).toBeLessThan(60)
  await expect
    .poll(() => second.win.evaluate(() => (window as any).__aoDebug.sceneBackground()))
    .toBe(DARK_SCENE)
  await second.win.locator('#settings-btn').click()
  await expect(second.win.locator('#s-theme [data-theme=dark]')).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await second.app.close()
})
