import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, newProfile, PORT } from './app.ts'

// Connecting agents from an empty office (plan §5.1): the empty card, the Connect panel, live
// status, copy-ready snippets without the token, the self-test, the demo and the port-busy fix.
test.setTimeout(120_000)

/** CI renders with software GL: start on the Low preset (plus any extra saved settings). */
function profileWith(settings: object = {}) {
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  writeFileSync(
    join(profile.userData, 'settings.json'),
    JSON.stringify({ graphicsQuality: 'low', ...settings }),
  )
  return profile
}

test('an empty office explains the ways in, and every path connects', async () => {
  const profile = profileWith()
  // No demo agents (AGENT_OFFICE_MOCK removed); Claude Code stays off (AGENT_OFFICE_CLAUDE=0).
  const { app, win } = await launch(profile, {
    env: { AGENT_OFFICE_MOCK: undefined },
    waitForAgents: false,
  })
  const postEvent = async (body: object) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${profile.token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(r.status).toBeLessThan(300)
  }

  // 1. First run with nothing connected: the empty card explains the ways in (Claude Code, HTTP,
  //    demo, and more AI providers), and the 🔌 button carries a badge.
  await expect(win.locator('#empty')).toBeVisible()
  await expect(win.locator('#empty .tile')).toHaveCount(4)
  await expect(win.locator('#empty .tile[data-tile="providers"]')).toBeVisible()
  await expect(win.locator('#connect-btn .badge')).toBeVisible()

  // 2. "Show me how" opens the HTTP tab with the live port and a waiting line.
  await win.getByRole('button', { name: 'Show me how →' }).click()
  await expect(win.locator('#connect [role=tabpanel]:visible')).toContainText(`127.0.0.1:${PORT}`)
  await expect(win.locator('#c-http-live')).toHaveText('◌ Waiting for the first event…')

  // 3. Copying the curl snippet puts the port on the clipboard but never the token.
  //    (xvfb's clipboard is unreliable on Linux CI; that one check is skipped there.)
  await win.locator('#c-copy-snippet').click()
  await expect(win.locator('#c-copy-snippet')).toHaveText('Copied ✓')
  if (!(process.platform === 'linux' && process.env.CI)) {
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText())
    expect(clip).toContain(`:${PORT}/api/events`)
    expect(clip).not.toContain(profile.token())
  }

  // 4. A real event over HTTP: the empty card goes away and the panel names the provider.
  await postEvent({ agentId: 'e2e-1', provider: 'e2e-framework', status: 'thinking' })
  await expect(win.locator('#empty')).toBeHidden()
  await expect(win.locator('#c-http-live')).toContainText('Received from e2e-framework')
  await expect(win.locator('#connect-btn .badge')).toBeHidden()

  // 5. "Send a test agent" proves the API path end to end from inside the app.
  await win.locator('#c-test').click()
  await expect(win.locator('#c-http-live')).toHaveText('✓ Test agent received')
  await expect(win.locator('.tag[data-agent-id="agent-office-test"]')).toBeAttached({
    timeout: 15_000,
  })

  // 6. The Demo toggle fills the office with the 9 sample agents.
  await win.getByRole('tab', { name: /Demo/ }).click()
  await win.locator('#c-demo-toggle').check()
  await expect
    .poll(() => win.locator('.tag').count(), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(9)

  // 7. Connected lists every provider with how it connected.
  await win.getByRole('tab', { name: /Connected/ }).click()
  await expect(win.locator('#c-rows')).toContainText('e2e-framework')
  await expect(win.locator('#c-rows')).toContainText('via HTTP')
  await expect(win.locator('#c-rows')).toContainText('via demo')
  await app.close()
})

test('a busy port: the banner leads to Connect, where a free port fixes it', async () => {
  const BUSY = PORT + 1
  // Another process holds the saved port before the app starts.
  const blocker = createServer()
  await new Promise<void>((resolve) => blocker.listen(BUSY, '127.0.0.1', resolve))
  try {
    // PORT is removed so the saved setting (the busy port) is used and can be changed.
    const { app, win } = await launch(profileWith({ port: BUSY }), {
      env: { AGENT_OFFICE_MOCK: undefined, PORT: undefined },
      waitForAgents: false,
    })

    // The banner names the problem and offers "Fix in Connect", which opens the HTTP tab.
    await expect(win.locator('#banner')).toContainText(`Port ${BUSY} is busy`)
    await win.locator('#banner').getByRole('button', { name: 'Fix in Connect' }).click()
    await expect(win.locator('#c-http-pill')).toHaveText(`✗ Port ${BUSY} busy`)

    // Applying a free port restarts the API there; the pill and the snippet follow.
    await win.locator('#c-port').fill(String(PORT))
    await win.getByRole('button', { name: 'Apply' }).click()
    await expect(win.locator('#c-http-pill')).toHaveText(`● Listening on 127.0.0.1:${PORT}`, {
      timeout: 15_000,
    })
    await expect(win.locator('#connect pre.snippet')).toContainText(`:${PORT}/api/events`)
    await app.close()
  } finally {
    blocker.close()
  }
})
