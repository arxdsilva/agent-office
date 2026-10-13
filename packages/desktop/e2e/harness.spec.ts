import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, newProfile } from './app.ts'
import { answerQuitConfirm, makeRepo, projectsApi, stubDialogs } from './projects-helpers.ts'

// The Harness Builder end to end (docs/harness.md): import a repo's rule files into a draft, publish and
// attach it, start a managed session (scripted runner, AGENT_OFFICE_FAKE_RUNNER=1) that tries to edit a
// protected file, then read the Compliance Inspector, run a failing gate and see it in Minimal mode.
// Assertions are on DOM text and data attributes, never pixels. The native folder picker is stubbed.
test.setTimeout(240_000)

test('harness: import, publish, attach, coverage, denied action, failing gate, Minimal badge', async () => {
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  // Start in Minimal mode: the DOM-only view needs no WebGL (CI and headless machines may have none), and
  // it is where the harness badge (.mm-harness) lives.
  writeFileSync(
    join(profile.userData, 'settings.json'),
    JSON.stringify({ graphicsQuality: 'low', viewMode: 'minimal' }),
  )
  // A real repo with two rule files the importer understands (one holds a fenced `make check`).
  const repo = makeRepo(join(profile.dir, 'shop-api'))
  writeFileSync(
    join(repo, 'AGENTS.md'),
    '# Rules\n\n- Always write a failing test before the code.\n- Never commit secrets to the repository.\n',
  )
  mkdirSync(join(repo, '.claude', 'rules'), { recursive: true })
  writeFileSync(
    join(repo, '.claude', 'rules', 'x.md'),
    '# Checks\n\n- Run the full check before you stop working.\n\n```sh\nmake check\n```\n',
  )
  const { app, win, errors } = await launch(profile, {
    env: { AGENT_OFFICE_FAKE_RUNNER: '1', AGENT_OFFICE_MOCK: undefined },
    waitForAgents: false,
  })
  await stubDialogs(app, repo)
  const dialog = win.locator('#harness')
  const card = win.locator('.hb-card[data-harness-id]')
  const thread = win.locator('#p-thread')

  await test.step('H-1: create a project from the sidebar and open its dashboard', async () => {
    // The sidebar wires up after the projects load, so retry the click until the dialog opens.
    await expect(async () => {
      await win.locator('#sb-new-project').click()
      await expect(win.locator('#np-dialog')).toBeVisible({ timeout: 2_000 })
    }).toPass({ timeout: 30_000 })
    await win.locator('#np-name').fill('Shop API')
    // The folder picker is stubbed to the temp repo.
    await win.locator('#np-repo-add').click()
    await expect(win.locator('#np-folders')).toContainText('shop-api')
    await win.locator('#np-create').click()
    await expect(win.locator('#np-dialog')).toBeHidden({ timeout: 15_000 })
    // Open the project: the Harness Builder reads the repositories of the open project.
    await win.locator('#sb-project-list li[data-project-id] button').first().click()
    await expect(win.locator('#ws-project')).toBeVisible()
  })

  await test.step('H-2: the palette command "Harnesses…" opens the Harness Builder', async () => {
    await win.keyboard.press('ControlOrMeta+k')
    await win.locator('#pal-input').fill('Harnesses')
    await expect(win.locator('#pal-list')).toContainText('Harnesses…')
    await win.keyboard.press('Enter')
    await expect(dialog).toBeVisible()
    // Nothing exists yet.
    await expect(card).toHaveCount(0)
  })

  await test.step('H-3: Import tab: detect rule files, preview candidates, create a draft', async () => {
    await win.locator('#hb-tab-import').click()
    await win.locator('#hb-detect').click()
    // Detection lists the files by repo-relative path (never an absolute path).
    await expect(win.locator('.hb-sources')).toContainText('AGENTS.md')
    await expect(win.locator('.hb-sources')).toContainText('.claude/rules/x.md')
    await win.locator('#hb-preview').click()
    await expect(win.locator('.hb-cand')).toHaveCount(3)
    // The fenced command is only a gate suggestion; it was not executed.
    await expect(win.locator('.hb-gate-cand')).toHaveCount(1)
    await expect(win.locator('.hb-gate-cand')).toContainText('make check')
    await win.locator('#hb-import-name').fill('Shop standards')
    // Leave the field so its change is saved (the pane re-renders) before the button is pressed.
    await win.locator('#hb-import-name').press('Tab')
    await expect(win.locator('#hb-import-name')).toHaveValue('Shop standards')
    await win.locator('#hb-commit').click()
    // Back in the Library the imported harness is a draft.
    await win.locator('#hb-tab-library').click()
    await expect(card).toHaveCount(1, { timeout: 15_000 })
    await expect(card.first()).toHaveAttribute('data-status', 'draft')
  })

  await test.step('H-4: seed a deny rule and a failing gate on the draft, then Publish', async () => {
    // Adding rules through the editor forms is covered by unit tests; the bridge is the same path the UI uses.
    // The deny rule makes the scripted "/perm-protected" Edit of packages/shared/src/protocol.ts blocked.
    await projectsApi(win, async (api) => {
      const h = (
        api as unknown as {
          harness: {
            list(): Promise<{ id: string }[]>
            get(id: string): Promise<Record<string, unknown>>
            update(a: { harnessId: string; draft: object }): Promise<unknown>
          }
        }
      ).harness
      const [s] = await h.list()
      const d = (await h.get(s!.id)) as {
        name: string
        scope: string
        launchPolicy: string
        gateTrigger: string
        fsIsolation: string
        retryBudget: number
        rules: Record<string, unknown>[]
        gates: Record<string, unknown>[]
      }
      const keep = (o: Record<string, unknown>, keys: string[]) =>
        Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]))
      return h.update({
        harnessId: s!.id,
        draft: {
          name: d.name,
          scope: d.scope,
          launchPolicy: d.launchPolicy,
          gateTrigger: d.gateTrigger,
          fsIsolation: d.fsIsolation,
          retryBudget: d.retryBudget,
          rules: [
            ...d.rules.map((r) =>
              keep(r, ['id', 'name', 'text', 'category', 'enforcement', 'severity', 'policy']),
            ),
            {
              name: 'Do not edit shared contracts',
              text: 'Never edit files under packages/shared.',
              category: 'security',
              enforcement: 'runtime-policy',
              severity: 'required',
              policy: { effect: 'deny', tools: ['Edit', 'Write'], paths: ['packages/shared/**'] },
            },
          ],
          // Replace the suggested `make check` (no make target here) by a gate that always fails.
          gates: [
            { name: 'Always fails', argv: ['node', '-e', 'process.exit(1)'], required: true },
          ],
        },
      })
    })
    await card.first().locator('button[data-action="publish"]').click()
    // Publishing asks for confirmation: a published version can no longer be changed.
    await win.locator('#hb-confirm-ok').click()
    await expect(card.first()).toHaveAttribute('data-status', 'published', { timeout: 15_000 })
  })

  await test.step('H-5: Attach to this project', async () => {
    await card.first().locator('button[data-action="attach"]').click()
    await win.locator('#hb-confirm-ok').click()
    await expect(card.first().locator('.hb-attached')).toContainText('Shop API', {
      timeout: 15_000,
    })
    await win.locator('#hb-close').click()
    await expect(dialog).toBeHidden()
  })

  await test.step('H-6: New Session shows what Claude Code really enforces for this harness', async () => {
    await win.locator('#pd-actions [data-action="start"]').click()
    await expect(win.locator('#new-session')).toBeVisible()
    // Claude Code is the only enabled provider, so it is already selected (the picker stays hidden).
    const box = win.locator('#ns-harness')
    await expect(box).toHaveAttribute('data-state', 'ready', { timeout: 15_000 })
    await expect(box.locator('.hb-cov[data-capability="instructions"]')).toHaveAttribute(
      'data-level',
      'enforced',
    )
    await expect(box.locator('.hb-cov[data-capability="tool-deny"]')).toHaveAttribute(
      'data-level',
      'enforced',
    )
    // The first message makes the scripted agent try to edit the protected file.
    if (!(await win.locator('#ns-folder').innerText()).includes('shop-api'))
      await win.locator('#ns-choose').click()
    await win.locator('#ns-text').fill('/perm-protected')
    await win.locator('#ns-start').click()
    await expect(win.locator('#new-session')).toBeHidden({ timeout: 25_000 })
    await expect(win.locator('#p-badge')).toHaveText('managed', { timeout: 15_000 })
    // The harness answers for the user: the agent was told no, and no permission card appeared.
    await expect(thread.locator('li.agent').last()).toContainText('denied', { timeout: 15_000 })
    await expect(win.locator('#p-perm')).toBeHidden()
  })

  await test.step('H-7: Compliance Inspector: the blocked action and its count', async () => {
    await expect(win.locator('#p-tabs')).toBeVisible()
    await win.locator('#p-tab-harness').click()
    await expect(win.locator('#panel')).toHaveAttribute('data-tab', 'harness')
    await expect(win.locator('#p-harness .ih-deny')).toHaveCount(1, { timeout: 15_000 })
    await expect(win.locator('#p-harness .ih-deny')).toContainText(
      'packages/shared/src/protocol.ts',
    )
    await expect(win.locator('#p-harness [data-role="counts"]')).toContainText('1 blocked')
  })

  await test.step('H-8: Run validation: the failing gate shows as failed', async () => {
    await win.locator('#p-harness button[data-action="run-gates"]').click()
    await expect(win.locator('#p-harness .ih-gate')).toHaveCount(1)
    await expect(win.locator('#p-harness [data-role="verification"]')).toHaveText(
      'Validation failed',
      { timeout: 30_000 },
    )
    await expect(win.locator('#p-harness [data-role="completion"]')).toHaveText('Validation failed')
  })

  await test.step('H-9: Minimal mode marks the agent with the same verification state', async () => {
    // The app started in Minimal mode; the office view shows the agent card with its harness badge.
    await win.locator('#sb-office').click()
    await expect(win.locator('body')).toHaveAttribute('data-view-mode', 'minimal')
    // The badge arrives by a `harness` push after the gate finished (no reload, no polling).
    const badge = win.locator('.mm-agent .mm-harness')
    await expect(badge).toHaveCount(1, { timeout: 15_000 })
    await expect(badge).toHaveAttribute('data-verification', 'failed')
    await expect(badge).toHaveAttribute('data-completion', 'validation-failed')
  })

  expect(errors).toEqual([])
  // A managed session is still running: answer the quit confirmation so the app can close.
  await answerQuitConfirm(app)
  await app.close()
})
