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

test('an agent question with markup renders as text in the question card', async () => {
  const { app, win, profile } = await launch()
  const payload = '<img src=x onerror=alert(1)>'
  // An observed agent asks a question whose text, header, option label and description hold markup.
  const res = await fetch(`http://127.0.0.1:${PORT}/api/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${profile.token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      agentId: 'xss-q',
      name: 'Asker',
      provider: 'custom',
      status: 'waiting',
      tool: 'AskUserQuestion',
      question: {
        prompts: [
          {
            question: `Run ${payload}?`,
            header: 'Run',
            options: [{ label: payload, description: payload }, { label: 'No' }],
            multiSelect: false,
          },
        ],
      },
    }),
  })
  expect(res.status).toBe(202)
  // Open the agent from its name tag; the card shows the question as plain text.
  await win.locator('.tag[data-agent-id="xss-q"]').dispatchEvent('click')
  const card = win.locator('#p-question')
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toContainText(payload)
  await expect(card.locator('img')).toHaveCount(0)
  await expect(win.locator('#panel img')).toHaveCount(0)
  expect(await win.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
  await app.close()
})
