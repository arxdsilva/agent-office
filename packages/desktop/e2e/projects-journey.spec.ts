import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launch, newProfile } from './app.ts'
import { answerQuitConfirm, makeRepo, projectsApi, stubDialogs } from './projects-helpers.ts'

// The projects-first journey end to end (plan §11 "projects-journey.spec.ts", docs/projects.md):
// project -> managed Claude (fake runner) session -> approved memory -> Codex (fake app-server)
// retrieves it over the real MCP bridge -> Context Inspector -> 3D and 2D Library -> old session
// -> handoff preview -> relaunch with the same profile. The native folder picker is stubbed.
test.setTimeout(420_000)

const TITLE = 'Pagination uses cursors'
const QUERY = 'cursors'

type DebugObject = {
  id: string
  kind: string
  box?: { x: number; y: number; w: number; h: number }
}
type PixelState = { originM: { x: number; z: number } | null; pxPerMetre?: number }
type PixelDebug = {
  __aoDebug: {
    pixel(): PixelState & { objects(): DebugObject[] }
    pixelTeleport(x: number, z: number, dir?: string): boolean
  }
}
const blur = (win: Page) => win.evaluate(() => (document.activeElement as HTMLElement)?.blur())

test('projects journey: project, sessions, memory, MCP retrieval, libraries, handoff, relaunch', async () => {
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  // CI renders with software GL: start on the Low preset.
  writeFileSync(join(profile.userData, 'settings.json'), JSON.stringify({ graphicsQuality: 'low' }))
  const repo = makeRepo(join(profile.dir, 'shop-api'))
  const env = {
    AGENT_OFFICE_FAKE_RUNNER: '1',
    AGENT_OFFICE_FAKE_PROVIDERS: '1',
    AGENT_OFFICE_DEBUG: '1',
    AGENT_OFFICE_MOCK: undefined,
  }
  const first = await launch(profile, { env, waitForAgents: false })
  const { app, win, errors } = first
  await stubDialogs(app, repo)
  const thread = win.locator('#p-thread')

  // The vault needs the OS keychain (safeStorage); without it everything is memory-only.
  const memoryOnly = await win.locator('#tb-vault').isVisible()
  const card = (id: string) => win.locator(`#c-prov-${id}`)
  const projectRow = win.locator('#sb-project-list li[data-project-id]')
  const startAgent = async () => {
    await win.locator('#sb-project-list li[data-project-id] button').first().click()
    await expect(win.locator('#ws-project')).toBeVisible()
    await win.locator('#pd-actions [data-action="start"]').click()
    await expect(win.locator('#new-session')).toBeVisible()
  }

  await test.step('J-0: Codex is enabled first, so the new project’s default policy lets it use MCP', async () => {
    // Default policy = every enabled provider gets read-propose, so enable before creating.
    await win.locator('#connect-btn').click()
    await win.locator('#c-tab-providers').click()
    await card('codex').locator('[data-action="toggle"]').check()
    await expect(card('codex').locator('[data-action="start"]')).toBeVisible({ timeout: 10_000 })
    await win.keyboard.press('Escape')
  })

  await test.step('J-a: create a project from the sidebar with a real git repository', async () => {
    await win.locator('#sb-new-project').click()
    await expect(win.locator('#np-dialog')).toBeVisible()
    await win.locator('#np-name').fill('Shop API')
    // The folder picker is stubbed to the temp repo; it shows up as a folder row (basename only).
    await win.locator('#np-repo-add').click()
    await expect(
      win.locator('#np-folders'),
      'Add folder… should list the picked repo',
    ).toContainText('shop-api')
    await win.locator('#np-create').click()
    await expect(win.locator('#np-dialog')).toBeHidden({ timeout: 15_000 })
    await expect(projectRow).toHaveCount(1)
    await expect(projectRow.first()).toContainText('Shop API')
  })

  await test.step('J-b: Start agent on the project -> Claude Code -> the agent belongs to the project', async () => {
    await startAgent()
    // The New Agent dialog should show the project preselected (docs/projects.md §9: #ns-project).
    await expect(win.locator('#ns-project')).toBeVisible()
    await expect(win.locator('#ns-project option:checked')).toHaveText('Shop API')
    await expect(win.locator('#ns-provider')).toBeVisible()
    await win.locator('#ns-provider').selectOption('claude-code')
    if (!(await win.locator('#ns-folder').innerText()).includes('shop-api'))
      await win.locator('#ns-choose').click()
    await expect(win.locator('#ns-folder')).toContainText('shop-api')
    await win.locator('#ns-text').fill('Plan the pagination work')
    await win.locator('#ns-start').click()
    await expect(win.locator('#new-session')).toBeHidden({ timeout: 25_000 })
    await expect(win.locator('#p-badge')).toHaveText('managed', { timeout: 15_000 })
    await expect(thread.locator('li.agent').last()).toHaveText('ok', { timeout: 15_000 })
    // The dashboard "Who is working?" lists the agent under this project.
    await win.locator('#sb-project-list li[data-project-id] button').first().click()
    await expect(win.locator('#pd-active li[data-row-id]')).toHaveCount(1, { timeout: 15_000 })
  })

  await test.step('J-c: a user-created memory is approved and shows in the Memory browser', async () => {
    const mem = await projectsApi(win, async (p) => {
      const [prj] = await p.list()
      return p.createMemory({
        projectId: prj!.id,
        scope: 'project',
        kind: 'instruction',
        title: 'Pagination uses cursors',
        body: 'List endpoints paginate with opaque cursors, never offsets.',
      })
    })
    expect(mem.state).toBe('approved')
    await win.locator('#sb-project-list li[data-project-id] button').first().click()
    await win.locator('#pd-actions [data-action="memory"]').click()
    await expect(win.locator('#ws-memory')).toBeVisible()
    const row = win.locator('#mem-list li[data-memory-id]', { hasText: TITLE })
    await expect(row).toHaveCount(1)
    await row.click()
    await expect(win.locator('#mem-detail')).toContainText('opaque cursors')
    // Already approved: Approve has nothing to do.
    await expect(win.locator('#mem-approve')).toBeDisabled()
  })

  await test.step('J-d: a Codex agent on the same project retrieves the memory over MCP', async () => {
    await startAgent()
    await win.locator('#ns-provider').selectOption('codex')
    await expect(win.locator('#ns-title')).toHaveText('New OpenAI Codex session')
    if (!(await win.locator('#ns-folder').innerText()).includes('shop-api'))
      await win.locator('#ns-choose').click()
    // The fake app-server calls search_memory through the real bridge and replies "mcp: <titles>".
    await win.locator('#ns-text').fill(`/mcp ${QUERY}`)
    await win.locator('#ns-start').click()
    // Codex asks before using an MCP tool; the card names agent-office's memory tool. Allow once.
    await expect(win.locator('#p-perm')).toBeVisible({ timeout: 20_000 })
    await expect(win.locator('#p-perm')).toContainText('search_memory')
    await win.locator('#p-perm [data-decision="allow"]').click()
    await expect(thread.locator('li.agent').last()).toHaveText(`mcp: ${TITLE}`, {
      timeout: 40_000,
    })
    await expect(win.locator('.tag[data-agent-id^="cx:"]')).toHaveCount(1)
    await win.locator('#p-input').press('Escape')
    // Stop the Claude agent: its session becomes inactive and the Codex agent is the one inspected.
    await win.locator('#sb-project-list li[data-project-id] button').first().click()
    await expect(win.locator('#pd-active li[data-row-id]')).toHaveCount(2, { timeout: 15_000 })
    await win.locator('#pd-active li[data-row-id]', { hasText: 'claude' }).first().click()
    await win.locator('#p-stop').click()
    await win.locator('#p-stop-ok').click()
    await expect(win.locator('.tag[data-agent-id^="cc:"]')).toHaveAttribute(
      'data-activity',
      'leaving',
      { timeout: 15_000 },
    )
    await win.locator('#p-close').click()
    await win.locator('#sb-project-list li[data-project-id] button').first().click()
    await expect(win.locator('#pd-active li[data-row-id]')).toHaveCount(1, { timeout: 15_000 })
    await win.locator('#pd-actions [data-action="context"]').click()
    await expect(win.locator('#ws-context')).toBeVisible()
    await expect(win.locator('#ci-retrieved li[data-entry-id]')).not.toHaveCount(0, {
      timeout: 15_000,
    })
    await expect(win.locator('#ci-retrieved')).toContainText('search_memory')
    await expect(win.locator('#ci-retrieved')).toContainText(TITLE)
  })

  await test.step('J-e1: the 3D Library shows the selected project’s collections', async () => {
    await win.locator('#sb-project-list li[data-project-id] button').first().click()
    await win.locator('#sb-office').click()
    await expect(win.locator('#stage')).toBeVisible()
    // With a project selected, notebooks become its collections (Instructions has 1 approved item).
    // Soft: the controller never calls SceneView.setProjectLibrary yet (see report), so these fail.
    const list = win.locator('#capability-list')
    await expect(list.locator('button[data-surface="notebook"]').first()).toBeAttached({
      timeout: 10_000,
    })
    await expect(list).toContainText('Instructions')
    // World labels carry counts and collection names only, never the memory title.
    await expect(list).not.toContainText(TITLE)
  })

  await test.step('J-e2: in 2D the reception Project Directory leads to the same memory', async () => {
    await win.locator('#mode-toggle [data-mode="pixel"]').click()
    await expect(win.locator('body')).toHaveAttribute('data-mode', 'pixel')
    await expect(win.locator('#pixel')).toBeVisible({ timeout: 20_000 })
    // Stand in front of the Project Directory kiosk, facing it, and press E.
    const dlg = win.locator('#dialogue')
    // The map loads asynchronously after the switch: wait for its objects.
    await expect
      .poll(
        () =>
          win.evaluate(() => (window as unknown as PixelDebug).__aoDebug.pixel().objects().length),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0)
    const desk = await win.evaluate(() => {
      const d = (window as unknown as PixelDebug).__aoDebug.pixel()
      // The Project Hub's kiosk hosts the directory; older maps keep it at the reception desk.
      const o =
        d.objects().find((x) => x.kind === 'kiosk') ??
        d.objects().find((x) => x.kind === 'reception-desk')
      return o?.box && d.originM
        ? { box: o.box, originM: d.originM, ppm: d.pxPerMetre ?? 32 }
        : null
    })
    expect(desk, 'a Project Directory exists in the 2D map').not.toBeNull()
    const cx = desk!.originM.x + (desk!.box.x + desk!.box.w / 2) / desk!.ppm
    const cz = desk!.originM.z + (desk!.box.y + desk!.box.h / 2) / desk!.ppm
    const hw = desk!.box.w / 2 / desk!.ppm
    const hh = desk!.box.h / 2 / desk!.ppm
    const spots: [number, number, string][] = [
      [cx, cz + hh + 0.6, 'n'],
      [cx, cz - hh - 0.6, 's'],
      [cx - hw - 0.6, cz, 'e'],
      [cx + hw + 0.6, cz, 'w'],
    ]
    for (const [x, z, dir] of spots) {
      if (await dlg.isVisible()) break
      await win.evaluate(
        ([x, z, dir]) =>
          (window as unknown as PixelDebug).__aoDebug.pixelTeleport(
            x as number,
            z as number,
            dir as string,
          ),
        [x, z, dir] as const,
      )
      await blur(win)
      await win.keyboard.press('e')
      await win.waitForTimeout(300)
    }
    await expect(dlg).toBeVisible()
    // The directory lists the project; choosing it offers the project panels.
    await expect(win.locator('#dlg-actions [data-action="project-select"]')).toContainText(
      'Shop API',
    )
    await win.locator('#dlg-actions [data-action="project-select"]').first().click()
    // Choosing the project makes it current in the shell (same command as the sidebar).
    await expect(win.locator('#tb-project')).toContainText('Shop API', { timeout: 10_000 })
    // The project's own dialogue follows (docs/projects.md §10): Memory opens its memory.
    const memoryAction = win.locator('#dlg-actions [data-action="project-memory"]')
    await expect(memoryAction, 'project dialogue offers Memory').toBeVisible({ timeout: 3_000 })
    await memoryAction.click()
    await expect(win.locator('#ws-memory')).toBeVisible()
    await expect(win.locator('#mem-list li[data-memory-id]', { hasText: TITLE })).toHaveCount(1)
    // Back to 3D for the rest of the journey.
    await win.locator('#mode-toggle [data-mode="3d"]').click()
    await expect(win.locator('body')).toHaveAttribute('data-mode', '3d')
  })

  await test.step('J-f: the earlier Claude session opens in Sessions with its messages', async () => {
    await win.locator('#sb-sessions').click()
    await expect(win.locator('#ws-sessions')).toBeVisible()
    const claude = win.locator('#sv-list li[data-session-id]', { hasText: /claude/i })
    await expect(claude.first()).toBeVisible({ timeout: 15_000 })
    await claude.first().click()
    await expect(win.locator('#sv-messages [data-msg-id]').first()).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('#sv-messages')).toContainText('Plan the pagination work')
  })

  await test.step('J-g: preparing a handoff to Codex lists the memory in the bundle preview', async () => {
    await win.locator('#sv-continue').click()
    await expect(win.locator('#ho-dialog')).toBeVisible()
    // Codex was enabled in J-0, so it is a handoff target (providers reload when the dialog opens).
    const codexOption = win.locator('#ho-provider option[value="codex"]')
    await expect(codexOption, 'Codex offered as a handoff target').toHaveCount(1, {
      timeout: 3_000,
    })
    await win.locator('#ho-provider').selectOption('codex')
    // Preview needs an objective; the bundle then lists the project's approved memory.
    await win.locator('#ho-objective').fill('Finish the pagination work')
    await win.locator('#ho-prepare').click()
    // "Preview context" lists the approved memory, included by default.
    await expect(win.locator('#ho-preview'), 'Preview lists the memory').toContainText(TITLE, {
      timeout: 5_000,
    })
    // Not launched: just close.
    await win.locator('#ho-cancel').click()
    await expect(win.locator('#ho-dialog')).toBeHidden()
  })

  expect(errors).toEqual([])
  await answerQuitConfirm(app)
  await app.close()

  await test.step('J-h: relaunching with the same profile keeps the project, session and memory', async () => {
    test.skip(memoryOnly, 'vault is memory-only (no OS keychain): nothing persists across restarts')
    const second = await launch(profile, { env, waitForAgents: false })
    await stubDialogs(second.app, repo)
    const w = second.win
    // One project exists and startView auto opens on the Overview.
    await expect(w.locator('body')).toHaveAttribute('data-view', 'overview')
    await expect(w.locator('#sb-project-list li[data-project-id]')).toHaveCount(1)
    await w.locator('#sb-sessions').click()
    const claude = w.locator('#sv-list li[data-session-id]', { hasText: /claude/i })
    await expect(claude.first()).toBeVisible({ timeout: 15_000 })
    await expect(claude.first()).toContainText('Inactive')
    await w.locator('#sb-memory').click()
    await w.locator('#sb-project-list li[data-project-id] button').first().click()
    await w.locator('#pd-actions [data-action="memory"]').click()
    await expect(w.locator('#mem-list li[data-memory-id]', { hasText: TITLE })).toHaveCount(1)
    expect(second.errors).toEqual([])
    await answerQuitConfirm(second.app)
    await second.app.close()
  })
})
