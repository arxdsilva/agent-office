import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { HOME } from '../playwright.config.ts'

const token = () => readFileSync(join(HOME, 'token'), 'utf8').trim()

test('renders the office grouped by provider, with live agents', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto('/')

  // Mock mode seeds agents in three providers → three zone signs.
  await expect(page.locator('#count')).not.toHaveText('0 agents')
  await expect(page.locator('.zone-sign')).toHaveText(
    ['claude-code', 'langgraph', 'openai-agents'],
    { ignoreCase: true },
  )
  await expect(page.locator('canvas')).toBeVisible()
  await expect(page.locator('#conn')).toHaveClass(/open/)
  expect(errors).toEqual([])
})

test('chatting with an agent: send a message and see the reply', async ({ page }) => {
  await page.goto('/')
  // Clicking an agent's name tag opens the chat panel for it.
  await page.locator('.tag[data-agent-id="mock:ada"]').click()
  await expect(page.locator('#panel')).toBeVisible()
  await expect(page.locator('#p-name')).toHaveText('Ada')

  // Enter sends; mock agents claim their inbox and answer after ~2s.
  await page.locator('#p-input').fill('hello')
  await page.keyboard.press('Enter')
  await expect(page.locator('#p-thread li.user')).toContainText('hello')
  await expect(page.locator('#p-thread li.agent')).toHaveText('(mock) got it: hello', {
    timeout: 10_000,
  })
  await expect(page.locator('#p-thread li.user .state')).toHaveText('✓✓ replied')

  // Escape inside the textarea closes the panel.
  await page.locator('#p-input').press('Escape')
  await expect(page.locator('#panel')).toBeHidden()
})

test('agent-provided text is rendered as text, never as HTML', async ({ page, request }) => {
  await page.goto('/')
  const payload = '<img src=x onerror="window.__xss=1">'
  // An external producer reports an agent whose name and activity contain markup.
  const res = await request.post('/api/events', {
    headers: { authorization: `Bearer ${token()}` },
    data: {
      agentId: 'xss',
      name: payload,
      provider: 'custom',
      status: 'tool',
      tool: 'Bash',
      text: payload,
    },
  })
  expect(res.status()).toBe(202)

  const tag = page.locator('.tag[data-agent-id="xss"]')
  await expect(tag).toContainText(payload)
  await expect(page.locator('.label-stack img')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
})
