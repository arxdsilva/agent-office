import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, newProfile } from './app.ts'
import { makeRepo, stubDialogs } from './projects-helpers.ts'

// Automatic knowledge import end to end (docs/projects.md §8b): after the one opt-in in Settings,
// past Claude Code sessions become approved, badged project memory, and one button removes them.
// Fixture transcripts hold invented content in a temp CLAUDE_PROJECTS_DIR; the real ~/.claude is
// never read. The native folder picker is stubbed.
test.setTimeout(180_000)

const CODEWORD = 'TEAL-4410'
const SESSION_TITLE = 'Plan the release checklist'
const T0 = Date.parse('2026-01-01T10:00:00.000Z')
const iso = (ms: number) => new Date(T0 + ms).toISOString()

/** One Claude Code transcript in the shape of the real ones (see adapters/.../claude-code/fixtures.ts). */
function transcript(sessionId: string, cwd: string, title: string, reply: string): string {
  // Every real transcript line carries a uuid (the reader skips lines without one).
  let n = 0
  const base = (over: object) => ({
    sessionId,
    cwd,
    isSidechain: false,
    uuid: `${sessionId}-${++n}`,
    ...over,
  })
  return (
    [
      {
        type: 'user',
        ...base({ timestamp: iso(0) }),
        message: { role: 'user', content: 'Help me plan the release.' },
      },
      {
        type: 'assistant',
        ...base({ timestamp: iso(5_000) }),
        message: {
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: reply }],
          stop_reason: 'end_turn',
        },
      },
      { type: 'ai-title', sessionId, aiTitle: title },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n'
  )
}

test('auto import: opt in, badged memory appears, remove imported clears it', async () => {
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  // CI renders with software GL: start on the Low preset.
  writeFileSync(join(profile.userData, 'settings.json'), JSON.stringify({ graphicsQuality: 'low' }))
  const repo = makeRepo(join(profile.dir, 'shop-api'))

  // CLAUDE_PROJECTS_DIR drives claudeHome and the config file too, so nothing reads the real ~/.claude.
  const projectsDir = join(profile.dir, 'fake-home', '.claude', 'projects')
  const sessionDir = join(projectsDir, '-shop-api')
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(
    join(sessionDir, 'ses-e2e-aaaa1111.jsonl'),
    transcript(
      'ses-e2e-aaaa1111',
      repo,
      SESSION_TITLE,
      `The release codeword is ${CODEWORD}. Next: tag the build and update the changelog.`,
    ),
  )
  writeFileSync(
    join(sessionDir, 'ses-e2e-bbbb2222.jsonl'),
    transcript(
      'ses-e2e-bbbb2222',
      repo,
      'Tidy the changelog',
      'Grouped the entries by area and fixed two typos.',
    ),
  )
  // Past sessions: files last written on T0, so the live tailer leaves them alone (it follows only
  // recently modified transcripts) and the import treats them as finished history.
  for (const f of readdirSync(sessionDir))
    utimesSync(join(sessionDir, f), new Date(T0 + 60_000), new Date(T0 + 60_000))

  const { app, win, errors } = await launch(profile, {
    env: {
      AGENT_OFFICE_MOCK: undefined,
      AGENT_OFFICE_CLAUDE: '1',
      CLAUDE_PROJECTS_DIR: projectsDir,
    },
    waitForAgents: false,
  })
  await stubDialogs(app, repo)

  await test.step('a project owns the repo the sessions ran in', async () => {
    await win.locator('#sb-new-project').click()
    await expect(win.locator('#np-dialog')).toBeVisible()
    await win.locator('#np-name').fill('Shop API')
    await win.locator('#np-repo-add').click()
    await expect(win.locator('#np-folders')).toContainText('shop-api')
    await win.locator('#np-create').click()
    await expect(win.locator('#np-dialog')).toBeHidden({ timeout: 15_000 })
    await expect(win.locator('#sb-project-list li[data-project-id]')).toHaveCount(1)
  })

  await test.step('Settings: checking the box asks first; Cancel reverts it', async () => {
    await win.locator('#settings-btn').click()
    await expect(win.locator('#settings')).toBeVisible()
    const box = win.locator('#s-autoImportHistory')
    await expect(box).not.toBeChecked()
    // click(), not check(): the box stays unchecked until the confirm is accepted.
    await box.click()
    await expect(win.locator('#s-autoimport-confirm')).toBeVisible()
    await expect(win.locator('#s-autoimport-confirm-text')).toContainText('approved memory')
    await win.locator('#s-autoimport-cancel').click()
    await expect(win.locator('#s-autoimport-confirm')).toBeHidden()
    await expect(box).not.toBeChecked()
  })

  await test.step('Settings: confirming turns automatic import on', async () => {
    const box = win.locator('#s-autoImportHistory')
    await box.click()
    await win.locator('#s-autoimport-ok').click()
    await expect(win.locator('#s-autoimport-confirm')).toBeHidden()
    await expect(box).toBeChecked()
    await win.locator('#s-close').click()
    await expect(win.locator('#settings')).toBeHidden()
  })

  await test.step('Memory: the imported summary shows with the auto-imported badge (polls up to 20 s)', async () => {
    await win.locator('#sb-memory').click()
    await expect(win.locator('#ws-memory')).toBeVisible()
    const imported = win.locator('#mem-list li[data-memory-id]', { hasText: 'auto-imported' })
    await expect(imported.first()).toBeVisible({ timeout: 20_000 })
    await expect(imported).toHaveCount(2)
    // The one with the codeword: its detail names the session by title, never by id.
    const row = win.locator('#mem-list li[data-memory-id]', { hasText: SESSION_TITLE })
    await row.click()
    await expect(win.locator('#mem-detail')).toContainText(CODEWORD)
    await expect(win.locator('#mem-detail .prov-list')).toContainText(
      `Imported automatically from session “${SESSION_TITLE}” (claude-code)`,
    )
    // Auto-imported chip counts the live imports.
    await expect(win.locator('button.filter[data-filter="auto-imported"]')).toContainText('2')
  })

  await test.step('Session Vault: the one-shot button is replaced by the status line', async () => {
    await win.locator('#sb-sessions').click()
    await expect(win.locator('#sv-import')).toHaveText('Automatic import is on')
    await expect(win.locator('#sv-import')).toBeDisabled()
    await expect(win.locator('#sv-import-status')).toContainText('Last run', { timeout: 20_000 })
  })

  await test.step('Memory: Remove imported memory asks, then clears the badged items', async () => {
    await win.locator('#sb-memory').click()
    await expect(win.locator('#mem-remove-imported')).toBeEnabled()
    await win.locator('#mem-remove-imported').click()
    await expect(win.locator('#mem-remove-confirm')).toBeVisible()
    // Cancel keeps everything.
    await win.locator('#mem-remove-cancel').click()
    await expect(win.locator('#mem-remove-confirm')).toBeHidden()
    await expect(
      win.locator('#mem-list li[data-memory-id]', { hasText: 'auto-imported' }),
    ).toHaveCount(2)
    // OK removes them and reports the count.
    await win.locator('#mem-remove-imported').click()
    await win.locator('#mem-remove-ok').click()
    await expect(win.locator('#mem-remove-confirm')).toBeHidden()
    await expect(win.locator('#mem-notice')).toContainText('Removed 2 imported items')
    // Removed items are rejected: the Auto-imported chip is empty and the list under it is too.
    await win.locator('button.filter[data-filter="auto-imported"]').click()
    await expect(win.locator('#mem-list li[data-memory-id]')).toHaveCount(0)
    await expect(win.locator('#mem-remove-imported')).toBeDisabled()
  })

  expect(errors, 'no page errors or console errors').toEqual([])
  await app.close()
})
