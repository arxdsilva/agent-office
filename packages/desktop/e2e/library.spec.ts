import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, newProfile, PORT } from './app.ts'

// The Library: skills are books, rules are boards. Invoking a skill links the agent to its book;
// two different skill/rule uses within a minute send the agent to read in the Library.
test.setTimeout(120_000)

/** CI renders with software GL: start on the Low preset. */
function lowQualityProfile() {
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  // Low for software GL in CI, but with animated links (Low defaults to static lines) so the
  // dash and page-particle styles are what's tested here.
  writeFileSync(
    join(profile.userData, 'settings.json'),
    JSON.stringify({ graphicsQuality: 'low', graphicsAdvanced: { links: 'animated' } }),
  )
  return profile
}

test('skills and rules fill the Library; using them links and then visits', async () => {
  const { app, win, profile, errors } = await launch(lowQualityProfile())
  const api = async (path: string, body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${profile.token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(r.status).toBeLessThan(300)
  }
  const book = win.locator('#capability-list button[data-capability-id="skill:e2e-skill"]')
  const board = win.locator('#capability-list button[data-capability-id="rule:project:E2E.md"]')
  const tag = win.locator('.tag[data-agent-id="e2e-reader"]')

  // A provider declares a skill (a book on the shelf) and a rule (a framed board).
  await api('/api/providers/e2e/capabilities', [
    {
      id: 'skill:e2e-skill',
      category: 'skill',
      kind: 'skill',
      label: 'e2e-skill',
      summary: 'Drives the app end to end.',
      scope: 'project',
    },
    {
      id: 'rule:project:E2E.md',
      category: 'rule',
      kind: 'rule',
      label: 'E2E rule',
      summary: 'Every behavior change ships an end-to-end test.',
      scope: 'project',
    },
  ])
  const reader = { agentId: 'e2e-reader', name: 'Reader', provider: 'e2e', topic: 'Docs' }
  await api('/api/events', { ...reader, status: 'thinking' })
  await expect(book).toHaveText('e2e-skill', { timeout: 20_000 })
  await expect(book).toHaveAttribute('data-surface', 'book')
  await expect(board).toHaveText('E2E rule')
  await expect(board).toHaveAttribute('data-surface', 'board')

  // Invoking the skill: a page-particle link to its book while the agent stays put.
  await api('/api/events', { ...reader, status: 'tool', tool: 'Skill', target: 'skill:e2e-skill' })
  const link = win.locator('#link-list li[data-agent-id="e2e-reader"]')
  await expect(link.first()).toHaveAttribute('data-style', 'particles', { timeout: 20_000 })
  expect(Number(await link.first().getAttribute('data-span'))).toBeGreaterThan(1)

  // A second, different use (reading the rule) within 60 s → the agent goes to read in the Library.
  await api('/api/events', {
    ...reader,
    status: 'tool',
    tool: 'Read',
    target: 'rule:project:E2E.md',
  })
  await expect(tag).toHaveAttribute('data-activity', 'library-visit', { timeout: 30_000 })

  // Clicking the board opens the Capability panel with the rule's summary.
  await board.dispatchEvent('click')
  await expect(win.locator('#c-title')).toHaveText('E2E rule')
  await expect(win.locator('#c-summary')).toHaveText(
    'Every behavior change ships an end-to-end test.',
  )

  // "Show links" highlights only this capability's links (the reader's link to the board).
  await win.locator('#c-links').click()
  await expect(win.locator('#c-links')).toHaveAttribute('aria-pressed', 'true')
  await expect(
    win.locator('#link-list li[data-capability-id="rule:project:E2E.md"]').first(),
  ).toHaveAttribute('data-highlighted', 'true')

  expect(errors).toEqual([])
  await app.close()
})
