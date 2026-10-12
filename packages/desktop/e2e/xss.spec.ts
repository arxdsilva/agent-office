import { expect, test } from '@playwright/test'
import { launch, PORT } from './app.ts'

test('agent-provided text from the HTTP API renders as text, never HTML', async () => {
  const { app, win, profile } = await launch()
  const payload = '<img src=x onerror="window.__xss=1">'
  // An external producer reports an agent whose name and activity contain markup.
  const res = await fetch(`http://127.0.0.1:${PORT}/api/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${profile.token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      agentId: 'xss',
      name: payload,
      provider: 'custom',
      status: 'tool',
      tool: 'Bash',
      text: payload,
    }),
  })
  expect(res.status).toBe(202)
  await expect(win.locator('.tag[data-agent-id="xss"]')).toContainText(payload)
  await expect(win.locator('.label-stack img')).toHaveCount(0)
  expect(await win.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
  await app.close()
})
