import { expect, test } from '@playwright/test'
import { launch } from './app.ts'

test('opens the office window with agents grouped by provider', async () => {
  const { app, win, errors } = await launch()
  // Mock mode seeds three providers → three zone signs.
  await expect(win.locator('.zone-sign')).toHaveText(
    ['claude-code', 'langgraph', 'openai-agents'],
    { ignoreCase: true },
  )
  await expect(win.locator('#count')).not.toHaveText('0 agents')
  expect(await win.title()).toBe('agent-office')
  expect(errors).toEqual([])
  await app.close()
})
