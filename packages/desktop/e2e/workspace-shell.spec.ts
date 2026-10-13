import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, newProfile } from './app.ts'
import { projectsApi } from './projects-helpers.ts'

// Workspace shell end to end (plan §11 "workspace-shell.spec.ts", docs/projects.md §9):
// the Office is the default first view, the palette and sidebar switch panes, the layout
// persists, and with a project the app opens on the Overview. Runs on the mock office.
test.setTimeout(180_000)

test('workspace shell: office first, palette, pane switching, persisted sidebar, overview start', async () => {
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  // CI renders with software GL: start on the Low preset.
  writeFileSync(join(profile.userData, 'settings.json'), JSON.stringify({ graphicsQuality: 'low' }))
  const first = await launch(profile)
  const { win } = first
  const errors = first.errors

  await test.step('WS-1: a fresh profile opens on the Office with the stage visible', async () => {
    // No project exists, so startView "auto" keeps the Office as the landing view.
    await expect(win.locator('body')).toHaveAttribute('data-view', 'office')
    await expect(win.locator('#stage')).toBeVisible()
    await expect(win.locator('#sidebar')).toBeVisible()
    await expect(win.locator('#ws-overview')).toBeHidden()
  })

  await test.step('WS-2: Cmd/Ctrl+K opens the palette; typing filters; Esc closes', async () => {
    await win.keyboard.press('ControlOrMeta+k')
    await expect(win.locator('#palette')).toBeVisible()
    const items = win.locator('#pal-list li')
    await expect(items.first()).toBeVisible()
    const before = await items.count()
    // A nonsense query narrows the list (usually to nothing); it must not grow.
    await win.locator('#pal-input').fill('overview')
    await expect(win.locator('#pal-list')).toContainText(/overview/i)
    const after = await items.count()
    expect(after).toBeLessThanOrEqual(before)
    await win.keyboard.press('Escape')
    await expect(win.locator('#palette')).toBeHidden()
  })

  await test.step('WS-3: sidebar navigation switches panes and hides the stage outside the Office', async () => {
    for (const [btn, pane] of [
      ['#sb-overview', '#ws-overview'],
      ['#sb-sessions', '#ws-sessions'],
      ['#sb-memory', '#ws-memory'],
    ] as const) {
      await win.locator(btn).click()
      await expect(win.locator(pane)).toBeVisible()
      // Leaving the Office hides the stage; only the chosen pane is shown.
      await expect(win.locator('#stage')).toBeHidden()
      await expect(win.locator('.ws-pane:visible')).toHaveCount(1)
    }
    // Back to the Office: the stage returns and the mock agents are still there.
    await win.locator('#sb-office').click()
    await expect(win.locator('#stage')).toBeVisible()
    await expect(win.locator('body')).toHaveAttribute('data-view', 'office')
    await expect(win.locator('.ws-pane:visible')).toHaveCount(0)
    await expect(win.locator('.tag').first()).toBeAttached()
  })

  await test.step('WS-4: collapsing the sidebar persists in settings.layout across a relaunch', async () => {
    await win.locator('#sb-collapse').click()
    await expect(win.locator('body')).toHaveClass(/sb-collapsed/)
    await expect
      .poll(() => {
        try {
          return JSON.parse(readFileSync(join(profile.userData, 'settings.json'), 'utf8')).layout
            ?.sidebarCollapsed
        } catch {
          return undefined
        }
      })
      .toBe(true)
  })
  expect(errors).toEqual([])
  await first.app.close()

  const second = await launch(profile)
  await test.step('WS-5: the relaunch restores the collapsed sidebar', async () => {
    await expect(second.win.locator('body')).toHaveClass(/sb-collapsed/)
    await expect(second.win.locator('#sb-collapse')).toHaveAttribute('aria-pressed', 'true')
    // Put it back so the next relaunch only differs by the project.
    await second.win.locator('#sb-collapse').click()
    await expect(second.win.locator('body')).not.toHaveClass(/sb-collapsed/)
  })

  await test.step('WS-6: with one project and startView auto, the next relaunch opens on the Overview', async () => {
    const proj = await projectsApi(second.win, (p) => p.create({ name: 'Shell Demo' }))
    expect(proj.id).toMatch(/^prj_/)
    await expect(second.win.locator('#sb-project-list li[data-project-id]')).toHaveCount(1)
    await second.app.close()
    const third = await launch(profile)
    await expect(third.win.locator('body')).toHaveAttribute('data-view', 'overview')
    await expect(third.win.locator('#ws-overview')).toBeVisible()
    await expect(third.win.locator('#stage')).toBeHidden()
    await expect(third.win.locator('#sb-project-list li[data-project-id]')).toHaveCount(1)
    expect(third.errors).toEqual([])
    await third.app.close()
  })
})
