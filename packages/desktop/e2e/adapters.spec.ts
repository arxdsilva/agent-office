import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, newProfile, PORT } from './app.ts'

// The Adapters room: a provider declares what its agents can use; a tool call links the agent to
// that station, sustained use walks the agent there, and a station opens the Capability panel.
test.setTimeout(120_000)

/** CI renders with software GL: start on the Low preset. */
function lowQualityProfile() {
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  writeFileSync(join(profile.userData, 'settings.json'), JSON.stringify({ graphicsQuality: 'low' }))
  return profile
}

test('declared adapters get stations; calls link to them; sustained use visits', async () => {
  const { app, win, profile, errors } = await launch(lowQualityProfile())
  const api = async (path: string, body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${profile.token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(r.status).toBeLessThan(300)
  }
  const station = win.locator('#capability-list button[data-capability-id="mcp:mailbox"]')
  const tag = win.locator('.tag[data-agent-id="e2e-mail"]')

  // A generic provider declares an MCP-style adapter: its station appears (name in the a11y list).
  await api('/api/providers/e2e/capabilities', [
    {
      id: 'mcp:mailbox',
      category: 'adapter',
      kind: 'mcp',
      label: 'Mailbox',
      sees: ['account: e2e@example.test'],
      tools: ['search'],
    },
  ])

  // An agent of that provider calls one of its tools → a link to the station, a call at the desk.
  const call = { agentId: 'e2e-mail', name: 'Mailer', provider: 'e2e', topic: 'Inbox zero' }
  await api('/api/events', { ...call, status: 'tool', tool: 'mcp__mailbox__search' })
  await expect(station).toHaveText('Mailbox', { timeout: 20_000 })
  await expect(win.locator('#link-list li[data-agent-id="e2e-mail"]')).toHaveCount(1, {
    timeout: 20_000,
  })
  await expect(win.locator('#link-list li[data-agent-id="e2e-mail"]')).toHaveAttribute(
    'data-style',
    'dash',
  )
  // The link is really drawn along the arc (a collapsed tube once made links invisible).
  const span = await win
    .locator('#link-list li[data-agent-id="e2e-mail"]')
    .getAttribute('data-span')
  expect(Number(span)).toBeGreaterThan(1)
  await expect(tag).toHaveAttribute('data-activity', /^(arriving|connection-call)$/)

  // Keep using it (≥ 20 s continuously, or ≥ 4 calls in 60 s) → the agent walks to the station.
  for (let i = 0; i < 5; i++) {
    await api('/api/events', { ...call, status: 'thinking' })
    await api('/api/events', { ...call, status: 'tool', tool: 'mcp__mailbox__search' })
  }
  await expect(tag).toHaveAttribute('data-activity', 'connection-visit', { timeout: 30_000 })

  // Clicking the station (here through its accessible button) opens the Capability panel.
  await station.dispatchEvent('click')
  await expect(win.locator('#cap-panel')).toBeVisible()
  await expect(win.locator('#c-title')).toHaveText('Mailbox')
  await expect(win.locator('#c-sections')).toContainText('account: e2e@example.test')
  await expect(win.locator('#c-used')).toContainText('Mailer')
  // ...and the camera eases to that station (the stage names what it's focused on).
  await expect(win.locator('#stage')).toHaveAttribute('data-focus', 'e2e mcp:mailbox')

  expect(errors).toEqual([])
  await app.close()
})
