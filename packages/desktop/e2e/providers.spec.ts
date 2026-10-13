import { PROVIDER_IDS } from '@agent-office/shared'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, newProfile, PORT } from './app.ts'

// Multi-provider platform end to end (plan "multi-provider platform" §8 PW; docs/provider-integrations.md).
// AGENT_OFFICE_FAKE_PROVIDERS=1 runs protocol-accurate fakes instead of the real CLIs: a Codex
// app-server (default turn: command approval → "Hello world") and an ACP agent per profile
// (default prompt: command approval → "Here are the files."; "/quick x" → "ok: /quick x").
// Hook config paths point at temp files; the real ~/.cursor, ~/.gemini, ~/.copilot are never touched.
test.setTimeout(240_000)

const REPO = join(import.meta.dirname, '..', '..', '..')
type DebugWindow = { __aoDebug: { focus(agentId: string): void } }

test('providers: Codex + Cursor managed side by side, an observed Gemini agent, hooks, isolation', async () => {
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  // CI renders with software GL: start on the Low preset.
  writeFileSync(join(profile.userData, 'settings.json'), JSON.stringify({ graphicsQuality: 'low' }))
  const folder = join(profile.dir, 'shop-api')
  mkdirSync(folder)
  // A Cursor hooks file that already holds the user's own hook (it must survive install/remove).
  const cursorHooks = join(profile.dir, 'cursor', 'hooks.json')
  mkdirSync(join(profile.dir, 'cursor'))
  writeFileSync(
    cursorHooks,
    JSON.stringify({ version: 1, hooks: { stop: [{ command: 'my-own-hook' }] } }),
  )
  const { app, win, errors } = await launch(profile, {
    env: {
      AGENT_OFFICE_FAKE_PROVIDERS: '1',
      AGENT_OFFICE_DEBUG: '1',
      AGENT_OFFICE_MOCK: undefined,
      CURSOR_HOOKS_FILE: cursorHooks,
      GEMINI_SETTINGS_FILE: join(profile.dir, 'gemini', 'settings.json'),
      COPILOT_HOOKS_DIR: join(profile.dir, 'copilot-hooks'),
    },
    waitForAgents: false,
  })
  // Every folder pick returns the temp folder.
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as never
  }, folder)
  const thread = win.locator('#p-thread')
  const card = (id: string) => win.locator(`#c-prov-${id}`)

  await test.step('PV-1: Connect → Providers lists six providers; enabling Codex and Cursor makes them ready', async () => {
    await win.locator('#connect-btn').click()
    await win.locator('#c-tab-providers').click()
    // Every runtime has a card: the six built-in providers plus the open-source runtimes.
    await expect(win.locator('#c-prov-list article')).toHaveCount(PROVIDER_IDS.length)
    // The open-source runtimes appear like any other provider (off until the user enables them).
    for (const id of ['opencode', 'goose', 'kilo', 'qwen', 'cline', 'openhands'] as const)
      await expect(card(id)).toBeVisible()
    // Roo Code has no CLI: its card says so instead of offering a toggle that can't work.
    await expect(card('roo')).toContainText('Roo Code')
    // New providers start disabled; ChatGPT can't be enabled at all (informational card).
    await expect(card('codex')).toContainText('Off')
    await expect(card('chatgpt').locator('[data-action="toggle"]')).toHaveCount(0)
    await card('codex').locator('[data-action="toggle"]').check()
    await card('cursor').locator('[data-action="toggle"]').check()
    // With the fakes installed and logged in, both become startable.
    await expect(card('codex').locator('[data-action="start"]')).toBeVisible({ timeout: 10_000 })
    await expect(card('cursor').locator('[data-action="start"]')).toBeVisible()
  })

  await test.step('PV-2: Cursor hooks install into the configured file and keep the user’s own hook', async () => {
    await card('cursor').locator('[data-action="hooks"]').click()
    await expect(card('cursor')).toContainText('Installed', { timeout: 10_000 })
    const json = JSON.parse(readFileSync(cursorHooks, 'utf8')) as {
      hooks: Record<string, { command: string }[]>
    }
    expect(json.hooks.stop!.map((h) => h.command)).toContain('my-own-hook')
    expect(json.hooks.stop!.some((h) => h.command.includes('agent-office-observe'))).toBe(true)
    // Blocking events are never subscribed.
    expect(json.hooks.preToolUse).toBeUndefined()
    // Remove takes out only our entries.
    await card('cursor').locator('[data-action="hooks"]').click()
    await expect(card('cursor')).toContainText('Not installed', { timeout: 10_000 })
    const after = JSON.parse(readFileSync(cursorHooks, 'utf8')) as typeof json
    expect(after.hooks.stop!.map((h) => h.command)).toEqual(['my-own-hook'])
    await win.keyboard.press('Escape')
  })

  await test.step('PV-3: a managed Codex session: activity, permission card, reply, follow-up', async () => {
    await win.locator('#new-session-btn').click()
    await win.locator('#ns-provider').selectOption('codex')
    await expect(win.locator('#ns-title')).toHaveText('New OpenAI Codex session')
    // Codex has no Chrome option.
    await expect(win.locator('#ns-chrome-row')).toBeHidden()
    await win.locator('#ns-choose').click()
    await win.locator('#ns-text').fill('List the files')
    await win.locator('#ns-start').click()
    await expect(win.locator('#p-badge')).toHaveText('managed', { timeout: 25_000 })
    // The fake asks to run a command: the existing permission card, Allow once.
    await expect(win.locator('#p-perm')).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('#p-perm')).toContainText('Bash')
    await win.locator('#p-perm [data-decision="allow"]').click()
    await expect(thread.locator('li.agent').last()).toHaveText('Hello world', { timeout: 15_000 })
    // Send works for a managed Codex session (send-message cap).
    await win.locator('#p-input').fill('Again please')
    await win.locator('#p-input').press('Enter')
    await expect(win.locator('#p-perm')).toBeVisible({ timeout: 15_000 })
    await win.locator('#p-perm [data-decision="deny"]').click()
    await expect(thread.locator('li.agent').last()).toHaveText('Hello declined', {
      timeout: 15_000,
    })
    await win.locator('#p-input').press('Escape')
  })

  await test.step('PV-4: a managed Cursor (ACP) session runs at the same time, in its own wing', async () => {
    await win.locator('#new-session-btn').click()
    await win.locator('#ns-provider').selectOption('cursor')
    await win.locator('#ns-choose').click()
    await win.locator('#ns-text').fill('/quick hello')
    await win.locator('#ns-start').click()
    await expect(thread.locator('li.agent').last()).toHaveText('ok: /quick hello', {
      timeout: 25_000,
    })
    // Both providers are live, each in its own wing (one zone per provider).
    await expect(win.locator('.tag[data-agent-id^="cx:"]')).toHaveCount(1)
    await expect(win.locator('.tag[data-agent-id^="cu:"]')).toHaveCount(1)
    await expect(win.locator('#views')).toContainText('codex')
    await expect(win.locator('#views')).toContainText('cursor')
    await win.locator('#p-input').press('Escape')
  })

  await test.step('PV-5: an observed Gemini agent (real observe hook script) is read-only', async () => {
    // Run the real hook script as Gemini would, with a SessionStart then an AfterTool payload.
    const run = (payload: object) =>
      spawnSync(
        process.execPath,
        [join(REPO, 'hooks', 'agent-office-observe.mjs'), '--provider', 'gemini'],
        {
          input: JSON.stringify(payload),
          env: {
            PATH: process.env.PATH,
            AGENT_OFFICE_URL: `http://127.0.0.1:${PORT}`,
            AGENT_OFFICE_TOKEN_FILE: join(profile.home, 'token'),
          },
          encoding: 'utf8',
        },
      )
    const start = run({
      hook_event_name: 'SessionStart',
      session_id: 'obs-1',
      cwd: '/tmp/garden-app',
    })
    // Hooks fail open: always exit 0 and print nothing.
    expect(start.status).toBe(0)
    expect(start.stdout).toBe('')
    run({
      hook_event_name: 'AfterTool',
      session_id: 'obs-1',
      cwd: '/tmp/garden-app',
      tool_name: 'read_file',
    })
    await expect(win.locator('.tag[data-agent-id="gm:obs-1"]')).toHaveCount(1, { timeout: 10_000 })
    await win.evaluate(() => (window as unknown as DebugWindow).__aoDebug.focus('gm:obs-1'))
    // Observation only: no managed badge and the composer says where to reply instead.
    await expect(win.locator('#panel')).toBeVisible()
    await expect(win.locator('#p-badge')).toBeHidden()
    await expect(win.locator('#p-input')).toBeDisabled()
    await expect(win.locator('#p-input')).toHaveAttribute('placeholder', /Observation only/)
    await win.locator('#p-close').click()
  })

  await test.step('PV-6: the Codex runtime dies; the Cursor session keeps working', async () => {
    // Kill the fake Codex app-server process from outside (like a crash).
    execFileSync('pkill', ['-f', 'fake-codex-app-server.mjs'])
    // Its session ends: the agent shows the error (or is done and walks out; removed later by the sweep).
    const codexTag = win.locator('.tag[data-agent-id^="cx:"]')
    await expect
      .poll(
        async () =>
          (await codexTag.count()) === 0
            ? 'gone'
            : ((await codexTag.getAttribute('data-status')) ?? ''),
        { timeout: 30_000 },
      )
      .toMatch(/^(gone|error|done)$/)
    // Cursor still answers.
    const cursorId = await win.locator('.tag[data-agent-id^="cu:"]').getAttribute('data-agent-id')
    await win.evaluate((id) => (window as unknown as DebugWindow).__aoDebug.focus(id!), cursorId)
    await win.locator('#p-input').fill('/quick still here')
    await win.locator('#p-input').press('Enter')
    await expect(thread.locator('li.agent').last()).toHaveText('ok: /quick still here', {
      timeout: 15_000,
    })
  })

  expect(errors).toEqual([])
  // Sessions are still running: answer the "managed sessions will stop" quit confirm with Quit.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as never
  })
  await app.close()
})
