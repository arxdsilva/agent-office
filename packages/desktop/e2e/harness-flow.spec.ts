import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, newProfile } from './app.ts'
import { answerQuitConfirm, makeRepo, stubDialogs } from './projects-helpers.ts'

// A harness with a flow end to end (docs/harness.md §2a): the "Content pipeline" template becomes a
// harness with five steps; a managed session (scripted runner) works through them while the person
// marks, approves and skips steps in the Harness tab and the Overview approval card. Assertions are
// on `data-state` / `data-step` attributes and text, never pixels.
test.setTimeout(240_000)

test('harness flow: template, stepper, approval card, skip with confirmation, Minimal badge', async () => {
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  // Minimal mode: DOM only, no WebGL needed; it is also where the step badge lives.
  writeFileSync(
    join(profile.userData, 'settings.json'),
    JSON.stringify({ graphicsQuality: 'low', viewMode: 'minimal' }),
  )
  const repo = makeRepo(join(profile.dir, 'shop-api'))
  const { app, win, errors } = await launch(profile, {
    env: { AGENT_OFFICE_FAKE_RUNNER: '1', AGENT_OFFICE_MOCK: undefined },
    waitForAgents: false,
  })
  await stubDialogs(app, repo)
  const steps = win.locator('#p-harness ol.ih-steps li.ih-step')
  const step = (n: number) => steps.nth(n - 1)

  await test.step('F-1: create a project and open the Harnesses pane', async () => {
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
    await win.locator('#sb-harness').click()
    await expect(win.locator('#ws-harness')).toBeVisible()
  })

  await test.step('F-2: "Use template" on Content pipeline opens the editor on its five-step flow', async () => {
    await win
      .locator(
        '.hb-template[data-template-id="content-pipeline"] button[data-action="use-template"]',
      )
      .click()
    await expect(win.locator('#hb-panel-editor')).toBeVisible({ timeout: 15_000 })
    // The template's steps live on the editor's Flow tab.
    await win.locator('#hb-subtabs [data-editor-tab="flow"]').click()
    await expect(win.locator('#hb-steps li.hb-step')).toHaveCount(5)
  })

  await test.step('F-3: publish and attach it from the Library', async () => {
    await win.locator('#hb-tab-library').click()
    const card = win.locator('.hb-card[data-harness-id]')
    await expect(card).toHaveCount(1)
    await card.first().locator('button[data-action="publish"]').click()
    // A published version can no longer be changed: publishing asks first.
    await win.locator('#hb-confirm-ok').click()
    await expect(card.first()).toHaveAttribute('data-status', 'published', { timeout: 15_000 })
    await card.first().locator('button[data-action="attach"]').click()
    await win.locator('#hb-confirm-ok').click()
    await expect(win.locator('.hb-applied-row')).toHaveCount(1, { timeout: 15_000 })
  })

  await test.step('F-4: start a session on the project: the Harness tab shows step 1 active', async () => {
    await win.locator('#sb-project-list li[data-project-id] button').first().click()
    await win.locator('#pd-actions [data-action="start"]').click()
    await expect(win.locator('#new-session')).toBeVisible()
    // New Session announces the flow before the session starts.
    await expect(win.locator('#ns-harness .ns-harness-flow')).toContainText('5 steps', {
      timeout: 15_000,
    })
    if (!(await win.locator('#ns-folder').innerText()).includes('shop-api'))
      await win.locator('#ns-choose').click()
    await win.locator('#ns-text').fill('Write a post about caching')
    await win.locator('#ns-start').click()
    await expect(win.locator('#new-session')).toBeHidden({ timeout: 25_000 })
    await expect(win.locator('#p-badge')).toHaveText('managed', { timeout: 15_000 })
    await win.locator('#p-tab-harness').click()
    await expect(steps).toHaveCount(5, { timeout: 15_000 })
    await expect(step(1)).toHaveAttribute('data-state', 'active')
    await expect(step(2)).toHaveAttribute('data-state', 'pending')
  })

  await test.step('F-5: Mark done on step 1 makes step 2 active, waiting for your approval', async () => {
    await step(1).locator('button[data-action="mark-done"]').click()
    await expect(step(1)).toHaveAttribute('data-state', 'done', { timeout: 15_000 })
    await expect(step(2)).toHaveAttribute('data-state', 'active')
    await expect(step(2).locator('.ih-check[data-kind="approval"]')).toHaveAttribute(
      'data-state',
      'waiting-user',
    )
  })

  await test.step('F-6: the Overview lists the approval; Approve there makes step 3 active', async () => {
    await win.locator('#sb-overview').click()
    const approval = win.locator('li.ov-approval')
    await expect(approval).toHaveCount(1, { timeout: 15_000 })
    await approval.locator('button[data-action="approve"]').click()
    await expect(approval).toHaveCount(0, { timeout: 15_000 })
    // Back to the agent: the stepper moved on.
    await win.locator('#sb-office').click()
    await win.locator('.mm-agent').first().click()
    await win.locator('#p-tab-harness').click()
    await expect(step(2)).toHaveAttribute('data-state', 'done')
    await expect(step(3)).toHaveAttribute('data-state', 'active')
  })

  await test.step('F-7: skipping a required step asks first; confirming moves to step 4', async () => {
    await step(3).locator('button[data-action="skip"]').click()
    await expect(win.locator('#p-step-confirm')).toBeVisible()
    await win.locator('#p-step-ok').click()
    await expect(step(3)).toHaveAttribute('data-state', 'skipped', { timeout: 15_000 })
    await expect(step(4)).toHaveAttribute('data-state', 'active')
  })

  await test.step('F-8: Minimal mode shows the agent at step 4 of 5', async () => {
    await win.locator('#sb-office').click()
    await expect(win.locator('body')).toHaveAttribute('data-view-mode', 'minimal')
    const badge = win.locator('.mm-agent .mm-harness')
    await expect(badge).toHaveCount(1, { timeout: 15_000 })
    await expect(badge).toHaveAttribute('data-step', /.+/)
    await expect(badge).toContainText('Step 4/5')
  })

  expect(errors).toEqual([])
  await answerQuitConfirm(app)
  await app.close()
})
