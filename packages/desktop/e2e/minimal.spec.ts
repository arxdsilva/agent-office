import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, newProfile, PORT } from './app.ts'

// Minimal mode (docs/minimal-mode.md): the static agent hierarchy. No canvas, no mock agents;
// every agent here is posted over HTTP. Assertions are on DOM text and data attributes.
test.setTimeout(120_000)

test('Minimal mode shows the live hierarchy: tasks, activity, finished, orphans, mode round trip', async () => {
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  writeFileSync(
    join(profile.userData, 'settings.json'),
    JSON.stringify({ graphicsQuality: 'low', viewMode: 'minimal' }),
  )
  const { app, win, errors } = await launch(profile, {
    env: { AGENT_OFFICE_MOCK: undefined },
    waitForAgents: false,
  })
  const post = async (body: object) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${profile.token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(r.status).toBeLessThan(300)
  }
  const lead = win.locator('article.mm-agent[data-agent-id="e2e-lead"]')
  const subsOf = lead.locator('> ul.mm-children > li.mm-sub')
  const finished = lead.locator('> details.mm-finished')
  const base = { provider: 'claude-code', topic: 'Refactor provider architecture' }

  // Minimal mode has no canvas at all and marks the page so the 3D/2D chrome hides.
  await expect(win.locator('body')).toHaveAttribute('data-view-mode', 'minimal')
  await expect(win.locator('#minimal-root')).toBeVisible()
  await expect(win.locator('#stage canvas')).toHaveCount(0)

  // A main agent appears with its model and conversation topic as the task line.
  await post({
    ...base,
    agentId: 'e2e-lead',
    name: 'Claude Code',
    model: 'claude-opus-5-5',
    status: 'thinking',
  })
  await expect(lead.locator('.mm-name').first()).toHaveText('Claude Code')
  await expect(lead.locator('.mm-task').first()).toContainText('claude-opus-5-5')

  // Three subagents, each with its own assigned task, appear nested under the lead.
  const tasks: Record<string, string> = {
    'e2e-a': 'Implement ACP transport',
    'e2e-b': 'Build provider settings UI',
    'e2e-c': 'Validate provider contracts',
  }
  for (const [id, task] of Object.entries(tasks))
    await post({
      ...base,
      agentId: id,
      name: `Sub ${id}`,
      parentId: 'e2e-lead',
      task,
      status: 'thinking',
    })
  await expect(subsOf).toHaveCount(3)
  for (const [id, task] of Object.entries(tasks))
    await expect(subsOf.and(win.locator(`[data-agent-id="${id}"]`)).locator('.mm-task')).toHaveText(
      task,
    )
  await expect(lead.locator('> .mm-head .mm-toggle')).toContainText('3 active subagents')

  // A tool event changes the activity line only: the assigned task stays.
  await post({
    ...base,
    agentId: 'e2e-b',
    status: 'tool',
    tool: 'Bash',
    text: 'Running integration tests',
  })
  const subB = lead.locator('li.mm-sub[data-agent-id="e2e-b"]')
  await expect(subB.locator('> .mm-head .mm-activity')).toContainText('Running integration tests')
  await expect(subB.locator('> .mm-head .mm-task')).toHaveText(tasks['e2e-b']!)

  // A subagent that completes moves into "Recently finished" and the active count drops.
  await post({ ...base, agentId: 'e2e-c', status: 'done', ended: 'completed' })
  await expect(finished.locator('li.mm-sub[data-agent-id="e2e-c"]')).toContainText('Completed')
  await expect(subsOf).toHaveCount(2)
  await expect(lead.locator('> .mm-head .mm-toggle')).toContainText('2 active subagents')

  // A cancelled subagent is reported as Cancelled (a cause the producer gave, never guessed).
  await post({
    ...base,
    agentId: 'e2e-d',
    name: 'Sub d',
    parentId: 'e2e-lead',
    task: 'Draft release notes',
    status: 'thinking',
  })
  await expect(subsOf).toHaveCount(3)
  await post({ ...base, agentId: 'e2e-d', status: 'done', ended: 'cancelled' })
  await expect(finished.locator('li.mm-sub[data-agent-id="e2e-d"]')).toContainText('Cancelled')

  // A second main agent gets its own card.
  await post({ ...base, agentId: 'e2e-lead2', name: 'Second lead', status: 'thinking' })
  await expect(win.locator('article.mm-agent')).toHaveCount(2)

  // A child whose parent is unknown waits under "Waiting for parent"...
  await post({
    ...base,
    agentId: 'e2e-orphan',
    name: 'Orphan',
    parentId: 'e2e-late',
    task: 'Early work',
    status: 'thinking',
  })
  const waiting = win.locator('.mm-unresolved:not([hidden])')
  await expect(waiting.locator('li.mm-sub[data-agent-id="e2e-orphan"]')).toBeVisible()
  await expect(waiting.locator('.mm-unresolved-title')).toContainText('Waiting for parent (1)')
  // ...and nests under the parent as soon as the parent arrives.
  await post({ ...base, agentId: 'e2e-late', name: 'Late parent', status: 'thinking' })
  await expect(
    win.locator('article[data-agent-id="e2e-late"] li.mm-sub[data-agent-id="e2e-orphan"]'),
  ).toBeVisible()
  await expect(win.locator('.mm-unresolved:not([hidden])')).toHaveCount(0)

  // Clicking a subagent row opens the panel with its assigned task.
  await subB.locator('> .mm-head').click()
  await expect(win.locator('#panel')).toContainText('Assigned task')
  await expect(win.locator('#panel')).toContainText(tasks['e2e-b']!)
  await expect(subB).toHaveAttribute('aria-selected', 'true')

  // Round trip through 3D: the hierarchy, tasks and finished list come back unchanged.
  await win.locator('#mode-toggle [data-mode="3d"]').click()
  await expect(win.locator('body')).toHaveAttribute('data-mode', '3d')
  await expect(win.locator('#minimal-root')).toHaveCount(0)
  await win.locator('#mode-toggle [data-mode="minimal"]').click()
  await expect(win.locator('body')).toHaveAttribute('data-view-mode', 'minimal')
  await expect(subsOf).toHaveCount(2)
  await expect(subsOf.and(win.locator('[data-agent-id="e2e-a"]')).locator('.mm-task')).toHaveText(
    tasks['e2e-a']!,
  )
  await expect(finished.locator('li.mm-sub[data-agent-id="e2e-c"]')).toContainText('Completed')
  await expect(finished.locator('li.mm-sub[data-agent-id="e2e-d"]')).toContainText('Cancelled')

  // Idle: with no events the page does not change at all (no loop, no timers touching the DOM).
  await win.evaluate(() => {
    const w = window as unknown as { __mmMutations: number }
    w.__mmMutations = 0
    new MutationObserver((r) => (w.__mmMutations += r.length)).observe(
      document.getElementById('minimal-root')!,
      { subtree: true, childList: true, attributes: true, characterData: true },
    )
  })
  await win.waitForTimeout(2000)
  expect(
    await win.evaluate(() => (window as unknown as { __mmMutations: number }).__mmMutations),
  ).toBe(0)

  expect(errors).toEqual([])
  await app.close()
})

test('A saved retired "special" view mode opens in Classic 3D with a three-mode toggle', async () => {
  // A profile saved while a retired view mode was active.
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  writeFileSync(
    join(profile.userData, 'settings.json'),
    JSON.stringify({ graphicsQuality: 'low', viewMode: 'special' }),
  )
  const { app, win, errors } = await launch(profile)

  // The unknown mode reads as 3D: the toggle marks it checked and the WebGL canvas exists.
  await expect(win.locator('#mode-toggle [data-mode="3d"]')).toHaveAttribute(
    'aria-checked',
    'true',
    { timeout: 60_000 },
  )
  await expect(win.locator('#stage canvas')).toHaveCount(1)

  // The toggle offers exactly 3D Office, 2D RPG and Minimal.
  await expect(win.locator('#mode-toggle button')).toHaveCount(3)

  expect(errors).toEqual([])
  await app.close()
})
