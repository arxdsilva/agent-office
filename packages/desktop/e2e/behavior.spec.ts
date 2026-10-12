import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, newProfile, PORT } from './app.ts'

// Agents act out their state in the building: teams meet, waiting agents take a booth, finished
// agents leave. Each name tag carries the director's activity in `data-activity`.
test.setTimeout(120_000)

/** CI renders with software GL: start on the Low preset. */
function lowQualityProfile() {
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  writeFileSync(join(profile.userData, 'settings.json'), JSON.stringify({ graphicsQuality: 'low' }))
  return profile
}

test('a team meets, a waiting agent takes a booth, a finished agent leaves', async () => {
  const { app, win, profile, errors } = await launch(lowQualityProfile())
  const post = async (body: object) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${profile.token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(r.status).toBeLessThan(300)
  }
  const tag = (id: string) => win.locator(`.tag[data-agent-id="${id}"]`)

  // A parent that spawns a subagent books a meeting room for its team (5 s of teamwork + the walk).
  const team = { provider: 'e2e', topic: 'Team work', source: 'e2e' }
  await post({ agentId: 'e2e-lead', name: 'Lead', status: 'tool', tool: 'Task', ...team })
  await post({ agentId: 'e2e-sub', name: 'Sub', parentId: 'e2e-lead', status: 'tool', ...team })
  await expect(tag('e2e-lead')).toHaveAttribute('data-activity', 'meeting', { timeout: 30_000 })

  // An agent waiting for the user walks to a phone booth (after 4 s of waiting).
  await post({ agentId: 'e2e-wait', name: 'Waiter', status: 'tool', ...team })
  await expect(tag('e2e-wait')).toHaveAttribute('data-activity', /^(arriving|desk-work)$/)
  await post({ agentId: 'e2e-wait', status: 'waiting' })
  await expect(tag('e2e-wait')).toHaveAttribute('data-activity', 'booth', { timeout: 30_000 })

  // A finished agent heads back to the elevator.
  await post({ agentId: 'e2e-wait', status: 'done' })
  await expect(tag('e2e-wait')).toHaveAttribute('data-activity', 'leaving', { timeout: 15_000 })

  expect(errors).toEqual([])
  await app.close()
})
