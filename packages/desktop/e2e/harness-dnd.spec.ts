import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { launch, newProfile } from './app.ts'
import { makeRepo, stubDialogs } from './projects-helpers.ts'

// Drag and drop in the Harnesses pane (docs/harness.md §2a, §8): a published card attaches by
// dropping it on the Applied drop zone or on a project in the sidebar, applied rows reorder by
// dragging, a row dropped on the library detaches only after a confirmation, and a draft card is
// never accepted. Drags are real mouse drags (Chromium drag interception, see `drag` below), and
// every assertion is on rows and their order, never on highlight classes.
test.setTimeout(180_000)

const draftWith = (name: string) => ({
  name,
  rules: [
    {
      name: `${name} rule`,
      text: 'Write a failing test before the code.',
      category: 'testing',
      enforcement: 'instruction',
      severity: 'required',
    },
  ],
})

/** Creates a harness through the bridge the UI uses; `publish` makes it attachable. */
async function createHarness(win: import('@playwright/test').Page, name: string, publish: boolean) {
  return win.evaluate(
    `(async (draft) => {
      const h = window.agentOffice.projects.harness
      const d = await h.create(draft)
      if (${publish}) await h.publish(d.id)
      return d.id
    })(${JSON.stringify(draftWith(name))})`,
  ) as Promise<string>
}

/**
 * A real mouse drag with a pause over the target. `locator.dragTo` fires a single `dragover` on the
 * target, which is not enough for the sidebar: it accepts a drop only after the view model has the
 * drag state (one render after `dragstart`), exactly like a human who keeps the mouse moving.
 * Playwright dispatches one `dragover` per mouse move, so several moves make the drop deterministic.
 */
async function drag(
  win: Page,
  from: Locator,
  to: Locator,
  at: { x: number; y: number } | undefined = undefined,
) {
  await from.hover()
  await win.mouse.down()
  const box = (await to.boundingBox())!
  const x = box.x + (at?.x ?? box.width / 2)
  const y = box.y + (at?.y ?? box.height / 2)
  await win.mouse.move(x, y, { steps: 8 })
  await win.waitForTimeout(150)
  await win.mouse.move(x + 1, y, { steps: 3 })
  await win.mouse.up()
}

test('harness drag and drop: attach, reorder, detach with confirm, drafts rejected', async () => {
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  // Minimal mode needs no WebGL (CI and headless machines may have none).
  writeFileSync(
    join(profile.userData, 'settings.json'),
    JSON.stringify({ graphicsQuality: 'low', viewMode: 'minimal' }),
  )
  const repo = makeRepo(join(profile.dir, 'shop-api'))
  const { app, win, errors } = await launch(profile, {
    env: { AGENT_OFFICE_MOCK: undefined },
    waitForAgents: false,
  })
  await stubDialogs(app, repo)
  const pane = win.locator('#ws-harness')
  const rows = win.locator('.hb-applied-row')
  const rowIds = () =>
    rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.harnessId))
  const card = (id: string) => win.locator(`.hb-card[data-harness-id="${id}"]`)

  await test.step('setup: a project, two published harnesses and one draft', async () => {
    await expect(async () => {
      await win.locator('#sb-new-project').click()
      await expect(win.locator('#np-dialog')).toBeVisible({ timeout: 2_000 })
    }).toPass({ timeout: 30_000 })
    await win.locator('#np-name').fill('Shop API')
    await win.locator('#np-repo-add').click()
    await expect(win.locator('#np-folders')).toContainText('shop-api')
    await win.locator('#np-create').click()
    await expect(win.locator('#np-dialog')).toBeHidden({ timeout: 15_000 })
    await win.locator('#sb-project-list li[data-project-id] button').first().click()
    await expect(win.locator('#ws-project')).toBeVisible()
  })
  const a = await createHarness(win, 'Alpha standards', true)
  const b = await createHarness(win, 'Beta standards', true)
  const draft = await createHarness(win, 'Gamma draft', false)
  await win.locator('#sb-harness').click()
  await expect(pane).toBeVisible()
  await expect(card(a)).toHaveAttribute('data-status', 'published', { timeout: 15_000 })
  await expect(card(b)).toHaveAttribute('data-status', 'published')
  await expect(card(draft)).toHaveAttribute('data-status', 'draft')
  const scope = win.locator('#hb-scope')
  const scopeBefore = await scope.inputValue()
  await expect(rows).toHaveCount(0)

  await test.step('DND-1: card onto the Applied drop zone attaches it', async () => {
    await drag(win, card(a), win.locator('.hb-dropzone'))
    await expect(rows).toHaveCount(1, { timeout: 15_000 })
    expect(await rowIds()).toEqual([a])
  })

  await test.step('DND-2: card onto a project in the sidebar attaches it there, scope unchanged', async () => {
    await drag(win, card(b), win.locator('#sb-project-list li[data-project-id]').first())
    await expect(rows).toHaveCount(2, { timeout: 15_000 })
    expect(await rowIds()).toEqual([a, b])
    // The drop never switches the pane's scope.
    await expect(scope).toHaveValue(scopeBefore)
    await expect(pane).toBeVisible()
  })

  await test.step('DND-3: row onto the top half of another row reorders; the order persists', async () => {
    await drag(win, rows.nth(1).locator('.hb-grip'), rows.nth(0), { x: 10, y: 2 })
    await expect.poll(rowIds, { timeout: 15_000 }).toEqual([b, a])
    // Leave the pane and return: the order comes back from the vault, not from local state.
    await win.locator('#sb-overview').click()
    await expect(pane).toBeHidden()
    await win.locator('#sb-harness').click()
    await expect(rows).toHaveCount(2)
    expect(await rowIds()).toEqual([b, a])
  })

  await test.step('DND-4: row onto the library asks first; Cancel keeps it applied', async () => {
    await drag(win, rows.nth(0).locator('.hb-grip'), win.locator('.hb-library'), { x: 40, y: 120 })
    await expect(win.locator('#hb-confirm-cancel')).toBeVisible({ timeout: 10_000 })
    await win.locator('#hb-confirm-cancel').click()
    await expect(win.locator('#hb-confirm-cancel')).toBeHidden()
    await expect(rows).toHaveCount(2)
    expect(await rowIds()).toEqual([b, a])
  })

  await test.step('DND-5: a draft card is rejected by the drop zone and by the sidebar', async () => {
    await drag(win, card(draft), win.locator('.hb-dropzone'))
    await drag(win, card(draft), win.locator('#sb-project-list li[data-project-id]').first())
    // Give a wrongly accepted drop time to land, then check nothing changed.
    await win.waitForTimeout(1_000)
    await expect(rows).toHaveCount(2)
    expect(await rowIds()).toEqual([b, a])
  })

  expect(errors).toEqual([])
  await app.close()
})
