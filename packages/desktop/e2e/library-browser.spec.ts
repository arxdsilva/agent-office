import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launch, newProfile, PORT, type Profile } from './app.ts'

// The Library browser (low-spec plan §B1/§B2, B8 LB1–LB4): 📚 opens a drawer listing every skill,
// rule, memory entry and adapter (overflow included); a row flies the camera to its surface; the
// view bar's Library ▾ menu picks a wing; hovering a surface shows a tooltip. Mock mode is on
// (claude-code declares 4 skills and 5 rules). AGENT_OFFICE_DEBUG=1 installs `__aoDebug`.
test.setTimeout(120_000)
test.describe.configure({ mode: 'serial' })

interface Ref {
  provider: string
  id: string
}
interface AoDebug {
  cameraDistanceTo(ref: Ref): number
  surfaceScreenPos(ref: Ref): { x: number; y: number } | null
  bookmark(): string | null
}
type DebugWindow = { __aoDebug: AoDebug }

const RUN_OFFICE: Ref = { provider: 'claude-code', id: 'skill:run-office' }
const EXTRA = 30

let app: ElectronApplication
let win: Page
let profile: Profile
let errors: string[]

const api = async (path: string, body: unknown) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${profile.token()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(r.status).toBeLessThan(300)
}

test.beforeAll(async () => {
  // Low, not Auto: CI's software GL would pick Minimal, which turns hover raycasts off.
  const p = newProfile()
  mkdirSync(p.userData, { recursive: true })
  writeFileSync(join(p.userData, 'settings.json'), JSON.stringify({ graphicsQuality: 'low' }))
  ;({ app, win, profile, errors } = await launch(p, { env: { AGENT_OFFICE_DEBUG: '1' } }))

  // 30 more claude-code skills over HTTP: 34 in all, so 10 don't fit the 24 shelf slots.
  await api(
    '/api/providers/claude-code/capabilities',
    Array.from({ length: EXTRA }, (_, i) => {
      const name = `e2e-extra-${String(i + 1).padStart(2, '0')}`
      return {
        id: `skill:${name}`,
        category: 'skill',
        kind: 'skill',
        label: name,
        summary: 'An invented skill for the overflow test.',
        scope: 'plugin',
      }
    }),
  )
})

test.afterAll(async () => {
  expect(errors).toEqual([])
  await app.close()
})

test('LB1: 📚 lists every skill with the overflow; search and keyboard open one', async () => {
  // The 📚 button opens the drawer with the search box focused (keyboard path, L11).
  await win.locator('#library-btn').click()
  const drawer = win.locator('#library')
  await expect(drawer).toBeVisible()
  await expect(win.locator('#lib-search')).toBeFocused()

  // Skills tab: 34 items; the 10 without a shelf slot are grouped at the end.
  await expect(win.locator('#lib-tab-skills .count')).toHaveText('34', { timeout: 20_000 })
  await expect(win.locator('#lib-tab-skills')).toHaveAttribute('aria-selected', 'true')
  // 24 slots: 23 books plus the "+N more" spine, so 34 skills leave 11 off the shelves.
  await expect(win.locator('#lib-overflow-h')).toHaveText('Not on a shelf (11)')
  await expect(win.locator('#lib-overflow [role="option"]')).toHaveCount(11)

  // Search "run" narrows the list (and the tab count) to run-office.
  await win.locator('#lib-search').fill('run')
  await expect(win.locator('#lib-tab-skills .count')).toHaveText('1')
  const rows = win.locator('#lib-rows [role="option"]')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('run-office')

  // ↓ then Enter from the search box opens the Capability panel on that skill.
  await win.locator('#lib-search').press('ArrowDown')
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true')
  await win.locator('#lib-search').press('Enter')
  await expect(win.locator('#c-title')).toHaveText('run-office')
  // The drawer stays open next to the Capability panel.
  await expect(drawer).toBeVisible()
})

test('LB2: clicking a row flies the camera close enough to read the spine', async () => {
  // Clear the search, then click run-office in the full list.
  await win.locator('#lib-search').fill('')
  const row = win.locator(`#lib-rows [data-capability-id="${RUN_OFFICE.id}"]`)
  await row.click()
  await expect(win.locator('#c-title')).toHaveText('run-office')

  // The close-up keeps spine text readable: the camera ends within 2.3 m of the spine.
  await expect
    .poll(
      () =>
        win.evaluate(
          (ref) => (window as unknown as DebugWindow).__aoDebug.cameraDistanceTo(ref),
          RUN_OFFICE,
        ),
      { timeout: 10_000 },
    )
    .toBeLessThanOrEqual(2.3)
})

test('LB4: hovering a spine shows a tooltip', async () => {
  // Close the panels so the spine isn't covered; Esc in the drawer closes it.
  await win.locator('#c-close').click()
  await win.locator('#lib-search').press('Escape')
  await expect(win.locator('#library')).toBeHidden()

  // Move the mouse onto run-office's spine (screen position from the debug hook).
  let pos: { x: number; y: number } | null = null
  await expect
    .poll(async () => {
      pos = await win.evaluate(
        (ref) => (window as unknown as DebugWindow).__aoDebug.surfaceScreenPos(ref),
        RUN_OFFICE,
      )
      return pos
    })
    .not.toBeNull()
  await win.mouse.move(pos!.x + 2, pos!.y)
  await win.mouse.move(pos!.x, pos!.y)
  await expect(win.locator('#tooltip')).toBeVisible()
  await expect(win.locator('#tooltip')).toContainText('run-office')

  // Leaving the surface hides it.
  await win.mouse.move(5, 5)
  await expect(win.locator('#tooltip')).toBeHidden()
})

test('LB3: the view bar Library ▾ menu flies to a provider’s Library', async () => {
  // A second provider with a skill gives the Library menu two entries (one would be a plain button).
  await api('/api/providers/langgraph/capabilities', [
    {
      id: 'skill:e2e-graph',
      category: 'skill',
      kind: 'skill',
      label: 'e2e-graph',
      summary: 'An invented langgraph skill.',
      scope: 'project',
    },
  ])

  // The grouped button keeps today's data-view id and opens a provider menu.
  const btn = win.locator('#views .view-btn[data-view="library"]')
  await expect(btn).toHaveAttribute('aria-haspopup', 'menu', { timeout: 20_000 })
  await btn.click()
  // One entry per provider (menu items carry the bookmark id in data-id).
  const item = win.locator('.menu [role="menuitem"][data-id="library:claude-code:0"]')
  await expect(item).toBeVisible()
  // Providers with several views (Library, Rules wall) are headed sections named after the provider.
  await expect(win.locator('.menu')).toContainText('claude-code')
  await expect(win.locator('.menu [role="menuitem"][data-id^="library:langgraph:"]')).toBeVisible()

  // Picking claude-code moves the camera to that wing's Library bookmark.
  await item.click()
  await expect
    .poll(() => win.evaluate(() => (window as unknown as DebugWindow).__aoDebug.bookmark()))
    .toBe('library:claude-code:0')
})
