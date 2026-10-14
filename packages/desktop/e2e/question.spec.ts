import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, newProfile, PORT } from './app.ts'
import { answerQuitConfirm } from './projects-helpers.ts'

// The agent's question card (docs/harness.md §5.17, plan Part 3). A managed session (scripted runner,
// AGENT_OFFICE_FAKE_RUNNER=1) asks "Which colour?" with the prompt "/ask": the person picks an answer
// and the agent replies "chose: <label>". An agent agent-office only observes asks through
// `POST /api/events` with a `question`: the card is read-only there, because the answer is typed in
// the agent's own terminal. Assertions are on data attributes and text.
test.setTimeout(180_000)

test('question card: managed answer, observed read-only, cleared by a null question', async () => {
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  // Minimal mode needs no WebGL; its agent cards open the same panel as a name tag does.
  writeFileSync(
    join(profile.userData, 'settings.json'),
    JSON.stringify({ graphicsQuality: 'low', viewMode: 'minimal' }),
  )
  const folder = join(profile.dir, 'shop-api')
  mkdirSync(folder)
  const { app, win, errors } = await launch(profile, {
    env: { AGENT_OFFICE_FAKE_RUNNER: '1', AGENT_OFFICE_MOCK: undefined },
    waitForAgents: false,
  })
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as never
  }, folder)
  const card = win.locator('#p-question')
  const thread = win.locator('#p-thread')
  const post = (body: object) =>
    fetch(`http://127.0.0.1:${PORT}/api/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${profile.token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  await test.step('Q-1: a managed session asks; the card shows two options', async () => {
    await win.locator('#new-session-btn').click()
    await expect(win.locator('#new-session')).toBeVisible()
    await win.locator('#ns-choose').click()
    await expect(win.locator('#ns-folder')).toContainText('shop-api')
    // "/ask" makes the scripted agent call AskUserQuestion.
    await win.locator('#ns-text').fill('/ask')
    await win.locator('#ns-start').click()
    await expect(win.locator('#new-session')).toBeHidden({ timeout: 25_000 })
    await expect(win.locator('#p-badge')).toHaveText('managed', { timeout: 15_000 })
    await expect(card).toBeVisible({ timeout: 15_000 })
    await expect(card).toHaveAttribute('data-source', 'managed')
    await expect(card.locator('.pq-prompt')).toHaveCount(1)
    await expect(card.locator('.pq-prompt[data-index="0"]')).toContainText('Which colour?')
    await expect(card.locator('input[name="pq-0"][value="Blue"]')).toBeVisible()
    await expect(card.locator('input[name="pq-0"][value="Green"]')).toBeVisible()
    // Answer stays disabled until every prompt has a choice.
    await expect(win.locator('#pq-answer')).toBeDisabled()
  })

  await test.step('Q-2: pick Green and Answer: the agent replies with it and the card goes away', async () => {
    await card.locator('input[name="pq-0"][value="Green"]').check()
    await expect(win.locator('#pq-answer')).toBeEnabled()
    await win.locator('#pq-answer').click()
    await expect(thread.locator('li.agent').last()).toContainText('chose: Green', {
      timeout: 15_000,
    })
    await expect(card).toBeHidden()
  })

  await test.step('Q-3: an observed agent asks: read-only card with the terminal hint', async () => {
    const res = await post({
      agentId: 'ob:1',
      name: 'Observer',
      provider: 'claude-code',
      status: 'waiting',
      tool: 'AskUserQuestion',
      question: {
        prompts: [
          {
            question: 'Deploy now?',
            header: 'Deploy',
            options: [{ label: 'Yes' }, { label: 'No' }],
            multiSelect: false,
          },
        ],
      },
    })
    expect(res.status).toBe(202)
    await win.locator('#sb-office').click()
    await win.locator('.mm-agent', { hasText: 'Observer' }).first().click()
    await expect(card).toBeVisible({ timeout: 15_000 })
    await expect(card).toHaveAttribute('data-source', 'observed')
    await expect(card).toContainText('Deploy now?')
    // Nothing to press: the answer is given in the agent's own terminal.
    await expect(win.locator('#pq-answer')).toHaveCount(0)
    await expect(win.locator('#pq-decline')).toHaveCount(0)
    await expect(card.locator('.pq-hint')).toContainText('Answer in the Claude Code terminal')
  })

  await test.step('Q-4: an event with question: null clears the card', async () => {
    const res = await post({
      agentId: 'ob:1',
      provider: 'claude-code',
      status: 'thinking',
      question: null,
    })
    expect(res.status).toBe(202)
    await expect(card).toBeHidden({ timeout: 15_000 })
  })

  expect(errors).toEqual([])
  // A managed session may still be running: answer the quit confirmation so the app can close.
  await answerQuitConfirm(app)
  await app.close()
})
