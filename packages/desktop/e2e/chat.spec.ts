import { expect, test } from '@playwright/test'
import { launch } from './app.ts'

test('chat round trip over IPC: send, deliver, reply', async () => {
  const { app, win } = await launch()
  // Clicking a name tag opens the chat panel for that agent.
  await win.locator('.tag[data-agent-id="mock:ada"]').click()
  await expect(win.locator('#p-name')).toHaveText('Ada')
  // Enter sends; mock agents claim their inbox and answer after ~2s.
  await win.locator('#p-input').fill('hello')
  await win.keyboard.press('Enter')
  await expect(win.locator('#p-thread li.agent')).toHaveText('(mock) got it: hello', {
    timeout: 10_000,
  })
  await expect(win.locator('#p-thread li.user .state')).toHaveText('✓✓ replied')
  // Escape closes the panel.
  await win.locator('#p-input').press('Escape')
  await expect(win.locator('#panel')).toBeHidden()
  await app.close()
})
