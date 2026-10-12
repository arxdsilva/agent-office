import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, newProfile } from './app.ts'

// Managed sessions end to end (plan §7.6 S1–S7) against M1's scripted runner
// (AGENT_OFFICE_FAKE_RUNNER=1: replies "ok"; "/perm" asks for Bash `pnpm test`; "/slow" stays
// busy for 5 s). The native folder dialog is stubbed to return a temp folder.
test.setTimeout(180_000)

test('managed session: start, mode/model, permission, context, Use…, interrupt, stop', async () => {
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  // CI renders with software GL: start on the Low preset.
  writeFileSync(join(profile.userData, 'settings.json'), JSON.stringify({ graphicsQuality: 'low' }))
  const folder = join(profile.dir, 'shop-api')
  mkdirSync(folder)
  const { app, win } = await launch(profile, {
    env: { AGENT_OFFICE_FAKE_RUNNER: '1', AGENT_OFFICE_MOCK: undefined },
    waitForAgents: false,
  })
  // Every folder pick returns the temp folder.
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as never
  }, folder)
  const thread = win.locator('#p-thread')
  const modePill = win.locator('#p-session .session-pill.mode')
  const send = async (text: string) => {
    await win.locator('#p-input').fill(text)
    await win.locator('#p-input').press('Enter')
  }

  await test.step('S1: ⊕ New session → folder, Plan mode, first message → Start', async () => {
    await win.locator('#new-session-btn').click()
    await expect(win.locator('#new-session')).toBeVisible()
    // Start stays disabled until the folder and the message are set.
    await expect(win.locator('#ns-start')).toBeDisabled()
    await win.locator('#ns-choose').click()
    await expect(win.locator('#ns-folder')).toContainText('shop-api')
    await win.locator('#ns-mode').selectOption('plan')
    await win.locator('#ns-text').fill('Plan the logout flow')
    await win.locator('#ns-start').click()
    // The dialog closes and the panel opens on the new managed agent.
    await expect(win.locator('#new-session')).toBeHidden({ timeout: 25_000 })
    await expect(win.locator('#p-badge')).toHaveText('managed', { timeout: 15_000 })
    await expect(modePill).toContainText('◐ Plan')
    await expect(win.locator('.tag[data-agent-id^="cc:"]')).toHaveCount(1)
    // The scripted runner answers the first message.
    await expect(thread.locator('li.agent').last()).toHaveText('ok', { timeout: 15_000 })
  })

  await test.step('S2: mode and model menus change the session live', async () => {
    await modePill.click()
    await win.locator('.menu-item[data-id="acceptEdits"]').click()
    await expect(modePill).toContainText('✎ Accept edits')
    await expect(thread.locator('li.system')).toContainText(['Mode → Accept edits'])
    // Model menu → the second model.
    const modelPill = win.locator('#p-session .session-pill.model')
    await modelPill.click()
    const second = win.locator('.menu-item:not([aria-disabled="true"])').nth(1)
    const label = (await second.locator('.menu-label').textContent())!.trim()
    await second.click()
    await expect(modelPill).toContainText(label)
  })

  await test.step('S3: a permission request shows a card; Allow once lets it continue', async () => {
    const replies = await thread.locator('li.agent').count()
    await send('/perm')
    await expect(win.locator('#p-perm')).toContainText('Bash · pnpm test', { timeout: 10_000 })
    await win.locator('#p-perm [data-decision="allow"]').click()
    await expect(win.locator('#p-perm')).toBeHidden()
    await expect(thread.locator('li.agent')).toHaveCount(replies + 1, { timeout: 10_000 })
  })

  await test.step('S4: + Context → Add folder adds a chip that the sent message keeps', async () => {
    await win.locator('#p-add-context').click()
    await win.locator('.menu-item[data-id="folder"]').click()
    await expect(win.locator('#p-chips .composer-chip')).toContainText(['📁 shop-api'])
    await send('review these')
    await expect(thread.locator('li.user').last().locator('.msg-chips')).toContainText('shop-api')
    await expect(win.locator('#p-chips')).toBeHidden()
    // Its turn ends with a reply before the next step sends anything.
    await expect(thread.locator('li.user').last()).toContainText('replied', { timeout: 10_000 })
  })

  await test.step('S5: Use… → Chrome browser warns when the session started without it', async () => {
    await win.locator('#p-use').click()
    await win.locator('.menu-item[data-id="mcp:claude-in-chrome"]').click()
    await expect(win.locator('#p-chips')).toContainText('Chrome browser')
    await expect(win.locator('#p-chips .composer-chip.warn')).toContainText(
      "Chrome isn't enabled for this session",
    )
    // Remove it again (✕) so the next steps send plain text.
    await win.locator('#p-chips .chip-x').click()
    await expect(win.locator('#p-chips')).toBeHidden()
  })

  await test.step('S6: Interrupt during a slow turn: idle, and a system line', async () => {
    await send('/slow')
    // Wait until the slow tool call is actually running before interrupting it.
    await expect(win.locator('#p-meta')).toContainText('tool', { timeout: 10_000 })
    await win.locator('#p-interrupt').click({ timeout: 10_000 })
    await expect(thread.locator('li.system')).toContainText(['Interrupted'], { timeout: 10_000 })
    await expect(win.locator('#p-meta')).toContainText('idle', { timeout: 10_000 })
  })

  await test.step('S7: Stop → confirm: the agent leaves the office', async () => {
    await win.locator('#p-stop').click()
    await win.locator('#p-stop-ok').click()
    // A stopped session is 'done': its agent walks to the elevator (removed later by the sweep).
    await expect(win.locator('.tag[data-agent-id^="cc:"]')).toHaveAttribute(
      'data-activity',
      'leaving',
      {
        timeout: 15_000,
      },
    )
  })
  await app.close()
})
