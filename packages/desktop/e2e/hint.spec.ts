import { expect, test } from '@playwright/test'
import { launch, PORT } from './app.ts'

// The reported bug (plan §2.5, J1/J4): with the hook installed, the agent panel must not say
// "hook not installed". Subagents point at their parent and can't be messaged.
test.setTimeout(90_000)

test('H1: the agent hint follows the hook status; subagents point at their parent', async () => {
  const { app, win, profile } = await launch()

  // Install the hook through Settings (isolated CLAUDE_SETTINGS_FILE from the profile).
  await win.locator('#settings-btn').click()
  await win.locator('#s-hook-btn').click()
  await expect(win.locator('#s-hook-label')).toHaveText('Installed ✓')
  await win.locator('#s-close').click()

  // A Claude Code session that hasn't checked in since the install (it never reads its inbox).
  const r = await fetch(`http://127.0.0.1:${PORT}/api/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${profile.token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      agentId: 'cc:h1-session',
      name: 'Checkout',
      provider: 'claude-code',
      topic: 'Checkout flow',
      status: 'thinking',
    }),
  })
  expect(r.status).toBeLessThan(300)

  // Its panel says the hook is installed and offers no install button. The agent is still walking in
  // from the elevator (its tag moves), so the click is dispatched rather than aimed.
  await win.locator('.tag[data-agent-id="cc:h1-session"]').dispatchEvent('click')
  await expect(win.locator('#p-hint')).toContainText('Hook installed ✓')
  await expect(win.locator('#p-hint button')).toHaveCount(0)

  // A subagent: "Subagents can't read messages", with Open parent, and the composer disabled.
  await win.locator('.tag[data-agent-id^="mock:sub"]').first().dispatchEvent('click')
  await expect(win.locator('#p-hint')).toContainText("Subagents can't read messages")
  await expect(win.locator('#p-input')).toBeDisabled()
  // Open parent selects the parent agent.
  await win.locator('#p-hint button').click()
  await expect(win.locator('#p-name')).toHaveText('Ada')
  await app.close()
})
