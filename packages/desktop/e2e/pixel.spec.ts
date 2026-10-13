import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launch, newProfile, PORT, type Profile } from './app.ts'

// The optional 2D RPG mode (2D plan §1 P1–P14, §12 X1–X12). Mock mode with AGENT_OFFICE_DEBUG=1:
// `__aoDebug.pixel()` reports the player, the NPC entities, the room and the dialogue state, and
// `__aoDebug.pixelGoTo()` puts the player in front of an agent or an object, facing it. Assertions
// are on DOM, data attributes and that debug state, never on pixels.
test.setTimeout(240_000)

interface PixelEntity {
  id: string
  x: number
  z: number
  activity: string
  anim: string
  icon: 'thinking' | 'tool' | 'waiting' | 'error' | null
}
interface PixelDebug {
  player: { x: number; z: number; dir: 'n' | 'e' | 's' | 'w' }
  room: string
  entities: PixelEntity[]
  dialogue: { open: boolean; agentId?: string }
}
type GoToTarget = { agentId: string } | { object: 'book' | 'station' }
interface AoDebug {
  pixel?: () => PixelDebug
  pixelGoTo?: (t: GoToTarget) => void
  three?: unknown
  sceneBackground?: unknown
}
type DebugWindow = { __aoDebug?: AoDebug }

const pixel = (win: Page) =>
  win.evaluate(() => (window as unknown as DebugWindow).__aoDebug!.pixel!())
const entity = async (win: Page, id: string) =>
  (await pixel(win)).entities.find((e) => e.id === id) ?? null
const goTo = (win: Page, t: GoToTarget) =>
  win.evaluate((t) => (window as unknown as DebugWindow).__aoDebug!.pixelGoTo!(t), t)
/** True when the 3D scene's debug API is gone (disposed) and the 2D one is installed. */
const onlyPixelDebug = (win: Page) =>
  win.evaluate(() => {
    const d = (window as unknown as DebugWindow).__aoDebug
    return (
      typeof d?.pixel === 'function' && d.three === undefined && d.sceneBackground === undefined
    )
  })
/** Holds a key down for `ms` (the player moves while it is held). */
async function hold(win: Page, key: string, ms: number): Promise<void> {
  await win.keyboard.down(key)
  await win.waitForTimeout(ms)
  await win.keyboard.up(key)
}
/** Moves focus off any button so key presses go to the 2D player input. */
const blur = (win: Page) => win.evaluate(() => (document.activeElement as HTMLElement)?.blur())

/** CI renders with software GL: start the 3D office on the Low preset. */
function profileWith(settings: object = {}): Profile {
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  writeFileSync(
    join(profile.userData, 'settings.json'),
    JSON.stringify({ graphicsQuality: 'low', ...settings }),
  )
  return profile
}

function poster(profile: Profile) {
  return async (body: object) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${profile.token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(r.status).toBeLessThan(300)
  }
}

test('2D RPG: switch, walk, talk, alerts, team, objects, leave, back to 3D, relaunch', async () => {
  const profile = profileWith()
  const debugEnv = { env: { AGENT_OFFICE_DEBUG: '1' } }
  const first = await launch(profile, debugEnv)
  const { win, errors } = first
  const post = poster(profile)
  const team = { provider: 'e2e', topic: 'Team work', source: 'e2e' }
  const toggle = (mode: '3d' | 'pixel') => win.locator(`#mode-toggle [data-mode="${mode}"]`)

  await test.step('X1: the toggle swaps the 3D office for the pixel world', async () => {
    // The switch is in #actions in 3D, with 3D Office checked (the default).
    await expect(toggle('3d')).toHaveAttribute('aria-checked', 'true')
    await toggle('pixel').click()
    // body carries the mode; the 2D canvas and HUD show; 3D-only controls hide.
    await expect(win.locator('body')).toHaveAttribute('data-mode', 'pixel')
    await expect(win.locator('#pixel')).toBeVisible({ timeout: 20_000 })
    await expect(win.locator('#pixel-hud')).toBeVisible()
    await expect(win.locator('#walk')).toBeHidden()
    await expect(win.locator('#fit')).toBeHidden()
    // The 3D scene was disposed: its debug API and its WebGL canvas are gone.
    await expect.poll(() => onlyPixelDebug(win)).toBe(true)
    await expect(win.locator('canvas:not(#pixel):not(#minimap-canvas)')).toHaveCount(0)
    // Mock agents appear as NPCs.
    await expect.poll(async () => (await pixel(win)).entities.length).toBeGreaterThan(0)
  })

  await test.step('X2: D moves the player right; walking into a wall stops at the wall', async () => {
    // Start in the middle of the atrium plaza, so walking east has room (the spawn sits next to
    // atrium furniture that can block the first metre).
    const plaza = (await rooms(win)).find((r) => r.placement === 'atrium' && r.name === 'Plaza')
    const s0 = await state(win)
    if (plaza && s0.originM)
      await teleport(
        win,
        s0.originM.x + (plaza.rect.tx + plaza.rect.tw / 2) * tileM(s0),
        s0.originM.z + (plaza.rect.ty + plaza.rect.th / 2) * tileM(s0),
      )
    await blur(win)
    const start = (await pixel(win)).player
    // Holding D for 1 s at 1.4 m/s moves the player at least 1 m to the right (+x).
    await hold(win, 'd', 1000)
    const moved = (await pixel(win)).player
    expect(moved.x - start.x).toBeGreaterThanOrEqual(1)
    // Holding W keeps pushing north until a wall stops the player: the position settles.
    await win.keyboard.down('w')
    let last = moved
    await expect
      .poll(
        async () => {
          const p = (await pixel(win)).player
          const still = Math.hypot(p.x - last.x, p.z - last.z) < 0.02
          last = p
          return still
        },
        { timeout: 30_000, intervals: [500] },
      )
      .toBe(true)
    await win.keyboard.up('w')
  })

  await test.step('X3: the directory travels to Ada; E opens her dialogue box', async () => {
    // J opens the directory; search narrows it to Ada; "Go there" moves the player next to her.
    await blur(win)
    await win.keyboard.press('j')
    await expect(win.locator('#directory')).toBeVisible()
    await win.locator('#dir-search').fill('Ada')
    const row = win.locator('#directory .dir-agent[data-agent-id="mock:ada"]')
    await row.locator('.dir-go').click()
    await expect(win.locator('#directory')).toBeHidden()
    await expect
      .poll(async () => {
        const [p, ada] = [(await pixel(win)).player, await entity(win, 'mock:ada')]
        return ada ? Math.hypot(p.x - ada.x, p.z - ada.z) : Infinity
      })
      .toBeLessThan(4)
    // Face Ada from her approach point (debug), then E talks to her.
    await goTo(win, { agentId: 'mock:ada' })
    await blur(win)
    await win.keyboard.press('e')
    await expect(win.locator('#dialogue')).toBeVisible()
    await expect(win.locator('#dlg-title')).toHaveText(/ada/i)
    await expect(win.locator('#dlg-sub')).toContainText('Refactor auth')
    await expect(win.locator('#dlg-actions [data-action="talk"]')).toBeVisible()
    await expect(win.locator('#dlg-actions [data-action="details"]')).toBeVisible()
    await expect(win.locator('#dlg-actions [data-action="follow"]')).toBeVisible()
    expect((await pixel(win)).dialogue).toMatchObject({ open: true, agentId: 'mock:ada' })
  })

  await test.step('X4: Talk opens the existing chat panel; Esc gives control back', async () => {
    await win.locator('#dlg-actions [data-action="talk"]').click()
    await expect(win.locator('#panel')).toBeVisible()
    await expect(win.locator('#p-name')).toHaveText('Ada')
    // Sending works exactly as in 3D: the mock agent claims the message and replies.
    await win.locator('#p-input').fill('hi from 2D')
    await win.locator('#p-input').press('Enter')
    await expect(win.locator('#p-thread li.user .state').last()).toContainText('✓', {
      timeout: 10_000,
    })
    await expect(win.locator('#p-thread li.agent').last()).toHaveText('(mock) got it: hi from 2D', {
      timeout: 10_000,
    })
    // Esc closes the panel; the player walks again (input is no longer suspended).
    await win.locator('#p-input').press('Escape')
    await expect(win.locator('#panel')).toBeHidden()
    await expect(win.locator('#dialogue')).toBeHidden()
    await blur(win)
    const before = (await pixel(win)).player
    await hold(win, 's', 600)
    const after = (await pixel(win)).player
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeGreaterThan(0.2)
  })

  await test.step('X5: a waiting agent shows "!" at once, a HUD alert, and takes a booth', async () => {
    await post({ agentId: 'e2e-wait', name: 'Waiter', status: 'tool', ...team })
    await expect.poll(() => entity(win, 'e2e-wait'), { timeout: 15_000 }).not.toBeNull()
    await post({ agentId: 'e2e-wait', status: 'waiting' })
    // The icon comes from the business status, even while the NPC is still walking.
    await expect
      .poll(async () => (await entity(win, 'e2e-wait'))?.icon, { timeout: 3_000 })
      .toBe('waiting')
    const alert = win.locator('.pixel-alert[data-agent-id="e2e-wait"]')
    await expect(alert).toHaveAttribute('data-kind', 'waiting')
    await expect(alert).toContainText('Waiter is waiting')
    // After a few seconds of waiting it walks to a phone booth.
    await expect
      .poll(async () => (await entity(win, 'e2e-wait'))?.activity, { timeout: 30_000 })
      .toBe('booth')
    // Clicking the alert opens the chat panel on that agent.
    await alert.click()
    await expect(win.locator('#p-name')).toHaveText('Waiter')
    await win.locator('#p-input').press('Escape')
    await expect(win.locator('#panel')).toBeHidden()
  })

  await test.step('X6: an error shows the ✖ icon and the confused animation', async () => {
    await post({ agentId: 'e2e-err', name: 'Oops', status: 'tool', ...team })
    await post({ agentId: 'e2e-err', status: 'error', text: 'tests failed' })
    // The business status shows at once, even while the new agent is still walking in.
    await expect
      .poll(async () => (await entity(win, 'e2e-err'))?.icon, { timeout: 5_000 })
      .toBe('error')
    // The confused animation plays once it reaches its desk (a walk of up to ~60 s from the
    // elevator, as in 3D), so speed the office clock up for this check.
    await win.evaluate(() =>
      (window as unknown as { __aoDebug: { timeScale(n: number): void } }).__aoDebug.timeScale(8),
    )
    await expect
      .poll(async () => (await entity(win, 'e2e-err'))?.anim, { timeout: 20_000 })
      .toBe('confused')
    await win.evaluate(() =>
      (window as unknown as { __aoDebug: { timeScale(n: number): void } }).__aoDebug.timeScale(1),
    )
    await expect(win.locator('.pixel-alert[data-agent-id="e2e-err"]')).toHaveAttribute(
      'data-kind',
      'error',
    )
  })

  await test.step('X7: a subagent dialogue points to its parent instead of Talk', async () => {
    // A parent with a subagent books a meeting room; wait until the team sits there.
    await post({ agentId: 'e2e-lead', name: 'Lead', status: 'tool', tool: 'Task', ...team })
    await post({ agentId: 'e2e-sub', name: 'Sub', parentId: 'e2e-lead', status: 'tool', ...team })
    await expect
      .poll(async () => (await entity(win, 'e2e-lead'))?.activity, { timeout: 30_000 })
      .toBe('meeting')
    // E talks to the nearest agent in front of the player; a mock agent can wander in between, so
    // step up to Sub again until its own dialogue opens.
    await expect
      .poll(
        async () => {
          if (await win.locator('#dialogue').isVisible()) await win.keyboard.press('Escape')
          await goTo(win, { agentId: 'e2e-sub' })
          await blur(win)
          await win.keyboard.press('e')
          await expect(win.locator('#dialogue')).toBeVisible()
          return win.locator('#dlg-title').textContent()
        },
        { timeout: 20_000 },
      )
      .toMatch(/Sub/)
    await expect(win.locator('#dlg-actions [data-action="go-parent"]')).toHaveText(/Go to Lead/)
    await expect(win.locator('#dlg-actions [data-action="talk"]')).toHaveCount(0)
    await win.locator('#dialogue').press('Escape')
    await expect(win.locator('#dialogue')).toBeHidden()
  })

  await test.step('X9: E at a book opens the Library; E at a station opens its panel', async () => {
    // A skill book in the claude-code Library → the dialogue → "Open in Library".
    await goTo(win, { object: 'book' })
    await blur(win)
    await win.keyboard.press('e')
    await expect(win.locator('#dialogue')).toBeVisible()
    await win.locator('#dlg-actions [data-action="open-library"]').click()
    await expect(win.locator('#library')).toBeVisible()
    await win.locator('#lib-close').click()
    await expect(win.locator('#library')).toBeHidden()
    // A station in the Adapters room → the dialogue → "Open" → the Capability panel.
    await goTo(win, { object: 'station' })
    await blur(win)
    await win.keyboard.press('e')
    await expect(win.locator('#dialogue')).toBeVisible()
    await win.locator('#dlg-actions [data-action="open"]').click()
    await expect(win.locator('#cap-panel')).toBeVisible()
    await win.locator('#c-close').click()
    await expect(win.locator('#cap-panel')).toBeHidden()
  })

  await test.step('X10: a finished agent heads to the elevator', async () => {
    await post({ agentId: 'e2e-wait', status: 'done' })
    await expect
      .poll(async () => (await entity(win, 'e2e-wait'))?.activity ?? 'leaving', {
        timeout: 15_000,
      })
      .toBe('leaving')
  })

  await test.step('X11: back to 3D: same agents, chat intact, Walk works', async () => {
    await toggle('3d').click()
    await expect(win.locator('body')).toHaveAttribute('data-mode', '3d')
    await expect(win.locator('#pixel')).toHaveCount(0, { timeout: 20_000 })
    await expect(win.locator('#pixel-hud')).toBeHidden()
    // Name tags are back for the agents, Ada included.
    await expect(win.locator('.tag[data-agent-id="mock:ada"]')).toBeAttached({ timeout: 20_000 })
    expect(await win.locator('.tag').count()).toBeGreaterThanOrEqual(8)
    // The chat thread still has the message sent from 2D. Pick Ada the way a tag click does
    // (she may be walking, so her tag is never "stable" for a real click on slow software GL).
    await win.evaluate(() =>
      (window as unknown as { __aoDebug: { focus(id: string): void } }).__aoDebug.focus('mock:ada'),
    )
    await expect(win.locator('#p-name')).toHaveText('Ada')
    await expect(win.locator('#p-thread li.user').last()).toContainText('hi from 2D')
    await win.locator('#p-input').press('Escape')
    await expect(win.locator('#panel')).toBeHidden()
    // Back to 2D once more, so the saved mode is 2D for the relaunch.
    await toggle('pixel').click()
    await expect(win.locator('#pixel')).toBeVisible({ timeout: 20_000 })
    expect(errors).toEqual([])
  })
  await first.app.close()

  await test.step('X12: a relaunch comes back in 2D without starting WebGL; 3D walk still works', async () => {
    const second = await launch(profile, { ...debugEnv, waitForAgents: false })
    await expect(second.win.locator('body')).toHaveAttribute('data-mode', 'pixel')
    await expect(second.win.locator('#pixel')).toBeVisible({ timeout: 20_000 })
    await expect(second.win.locator('#mode-toggle [data-mode="pixel"]')).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect.poll(() => onlyPixelDebug(second.win)).toBe(true)
    await expect(second.win.locator('canvas:not(#pixel):not(#minimap-canvas)')).toHaveCount(0)
    // Last: switch to 3D and check its walk mode still starts after 2D was used. (Leaving walk
    // mode needs a real pointer-lock release, which Playwright never grants, even in plain 3D.)
    await second.win.locator('#mode-toggle [data-mode="3d"]').click()
    await expect(second.win.locator('body')).toHaveAttribute('data-mode', '3d')
    await expect(second.win.locator('.tag').first()).toBeAttached({ timeout: 20_000 })
    await second.win.locator('#walk').click()
    await expect(second.win.locator('#walk-help')).toBeVisible()
    expect(second.errors).toEqual([])
    await second.app.close()
  })
})

test('X8: in 2D, a managed session asking for approval raises an alert that opens the card', async () => {
  // Starts in 2D (saved mode) with the scripted runner: "/perm" asks for Bash `pnpm test`.
  const profile = profileWith({ viewMode: 'pixel' })
  const folder = join(profile.dir, 'shop-api')
  mkdirSync(folder)
  const { app, win, errors } = await launch(profile, {
    env: { AGENT_OFFICE_DEBUG: '1', AGENT_OFFICE_FAKE_RUNNER: '1', AGENT_OFFICE_MOCK: undefined },
    waitForAgents: false,
  })
  await expect(win.locator('body')).toHaveAttribute('data-mode', 'pixel')
  // Every folder pick returns the temp folder.
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as never
  }, folder)

  // ⊕ New session works from 2D: folder, first message, Start → the panel opens on the agent.
  await win.locator('#new-session-btn').click()
  await win.locator('#ns-choose').click()
  await expect(win.locator('#ns-folder')).toContainText('shop-api')
  await win.locator('#ns-text').fill('Plan the logout flow')
  await win.locator('#ns-start').click()
  await expect(win.locator('#p-badge')).toHaveText('managed', { timeout: 25_000 })
  await expect(win.locator('#p-thread li.agent').last()).toHaveText('ok', { timeout: 15_000 })

  // "/perm" makes the run ask for approval; close the panel so only the HUD alert is left.
  await win.locator('#p-input').fill('/perm')
  await win.locator('#p-input').press('Enter')
  await expect(win.locator('#p-perm')).toBeVisible({ timeout: 10_000 })
  await win.locator('#p-input').press('Escape')
  await expect(win.locator('#panel')).toBeHidden()
  const alert = win.locator('.pixel-alert[data-kind="approval"]')
  await expect(alert).toContainText('needs approval', { timeout: 10_000 })

  // The alert opens the panel at the existing permission card (Allow/Deny live only there).
  await alert.click()
  await expect(win.locator('#p-perm')).toBeVisible()
  await expect(win.locator('#p-perm')).toContainText('Bash · pnpm test')
  await win.locator('#p-perm [data-decision="allow"]').click()
  await expect(win.locator('#p-perm')).toBeHidden()
  await expect(alert).toHaveCount(0, { timeout: 10_000 })
  expect(errors).toEqual([])
  // The session is still running, so quitting asks "managed sessions will stop": answer Quit.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as never
  })
  await app.close()
})

// 2D polish (plan §2–§2d): the player walks in every view, the M minimap is a real map, Main
// Street has no invisible barriers, meeting tables use their vertical art and kitchens sit inside
// their walls. Debug state only (`__aoDebug.pixel()`, its `objects()` and `rooms()`), no pixels.
interface TileRect {
  tx: number
  ty: number
  tw: number
  th: number
}
interface PixelMapDebug {
  player: { x: number; z: number }
  overview: boolean
  camera: 'player' | 'overview' | 'follow' | 'pan'
  following: string | null
  view: { cx: number; cz: number; w: number; h: number } | null
  originM: { x: number; z: number } | null
  tiles: { w: number; h: number } | null
  entities: { id: string; visible: boolean }[]
  /** 16 at GBA scale: tiles are 16 px, so one tile is 16 / pxPerMetre metres. */
  pxPerMetre?: number
  zoom?: number
  run?: boolean
}
interface PxRect {
  x: number
  y: number
  w: number
  h: number
}
interface DebugObject {
  id: string
  kind: string
  rect: TileRect
  room?: string
  orientation?: 'h' | 'v'
  /** The footprint in map px (drawn base = solid box). */
  box?: PxRect
}
interface DebugRoom {
  id: string
  name: string
  rect: TileRect
  box?: PxRect
  placement: string
}
type MapWindow = {
  __aoDebug: {
    pixel(): PixelMapDebug & { objects(): DebugObject[]; rooms(): DebugRoom[] }
    pixelTeleport(x: number, z: number, dir?: string): boolean
    focus(agentId: string): void
  }
}
const state = (win: Page) =>
  win.evaluate(() => {
    const { objects: _o, rooms: _r, ...rest } = (window as unknown as MapWindow).__aoDebug.pixel()
    return rest as PixelMapDebug
  })
const objects = (win: Page) =>
  win.evaluate(() => (window as unknown as MapWindow).__aoDebug.pixel().objects())
const rooms = (win: Page) =>
  win.evaluate(() => (window as unknown as MapWindow).__aoDebug.pixel().rooms())
const teleport = (win: Page, x: number, z: number) =>
  win.evaluate(
    ([x, z]) => (window as unknown as MapWindow).__aoDebug.pixelTeleport(x!, z!, 's'),
    [x, z],
  )
/** Pixel boxes, with 2 px of slack for rounding. */
const insidePx = (a: PxRect, b: PxRect) =>
  a.x >= b.x - 2 && a.y >= b.y - 2 && a.x + a.w <= b.x + b.w + 2 && a.y + a.h <= b.y + b.h + 2
/** Metres per map tile (1 at GBA scale). */
const tileM = (s: PixelMapDebug) => 16 / (s.pxPerMetre ?? 32)
/** Holds `key` and returns how far the player moved (m). */
async function walked(win: Page, key: string, ms: number): Promise<{ dx: number; dz: number }> {
  const a = (await state(win)).player
  await hold(win, key, ms)
  const b = (await state(win)).player
  return { dx: b.x - a.x, dz: b.z - a.z }
}

/** Tries each direction until the player moves (furniture may block one side); the distance (m). */
async function walkedSomewhere(win: Page, ms: number): Promise<number> {
  for (const key of ['s', 'd', 'a', 'w']) {
    const d = await walked(win, key, ms)
    const m = Math.abs(d.dx) + Math.abs(d.dz)
    if (m > 0.2) return m
  }
  return 0
}

test('2D polish: walk in every view, the minimap, Main Street, meeting tables, kitchens', async () => {
  // A collapsed sidebar and a 1440×900 window keep the stage ≥ 960 device px wide even at 1×
  // (CI Macs): the integer fit scale is then ≥ 2, so ZM-1 has a crisp level to zoom out to.
  const profile = profileWith({
    viewMode: 'pixel',
    layout: { sidebarCollapsed: true },
    windowBounds: { x: 0, y: 0, width: 1440, height: 900 },
  })
  // 2D has no 3D name tags to wait for; the canvas and the debug entities say it's ready.
  const { app, win, errors } = await launch(profile, {
    env: { AGENT_OFFICE_DEBUG: '1' },
    waitForAgents: false,
  })
  await expect(win.locator('#pixel')).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => (await state(win)).entities.length).toBeGreaterThan(0)
  // Start in the middle of the atrium's open floor, so walking east has room.
  const lobby = (await rooms(win)).find((r) => r.placement === 'atrium' && r.name === 'Plaza')
  const s0 = await state(win)
  if (lobby && s0.originM)
    await teleport(
      win,
      s0.originM.x + (lobby.rect.tx + lobby.rect.tw / 2) * tileM(s0),
      s0.originM.z + (lobby.rect.ty + lobby.rect.th / 2) * tileM(s0),
    )

  await test.step('MV-1: the player walks while the overview stays open', async () => {
    await blur(win)
    // O opens the overview; D walks east inside it; the overview doesn't close.
    await win.keyboard.press('o')
    await expect.poll(async () => (await state(win)).overview).toBe(true)
    const d = await walked(win, 'd', 800)
    expect(d.dx).toBeGreaterThan(0.5)
    expect((await state(win)).overview).toBe(true)
    // Space brings the camera back to the player.
    await win.keyboard.press('Space')
    await expect.poll(async () => (await state(win)).camera).toBe('player')
  })

  await test.step('MV-2: the player walks while the camera follows Ada', async () => {
    // Follow from Ada's dialogue box, then walk away: the camera keeps following her.
    await win.evaluate(() =>
      (window as unknown as { __aoDebug: { pixelGoTo(t: object): void } }).__aoDebug.pixelGoTo({
        agentId: 'mock:ada',
      }),
    )
    await blur(win)
    await win.keyboard.press('e')
    await expect(win.locator('#dialogue')).toBeVisible()
    await win.locator('#dlg-actions [data-action="follow"]').click()
    await expect.poll(async () => (await state(win)).following).toBe('mock:ada')
    await blur(win)
    expect(await walkedSomewhere(win, 600)).toBeGreaterThan(0.2)
    expect((await state(win)).following).toBe('mock:ada')
    // Esc returns the camera to the player.
    await win.keyboard.press('Escape')
    await expect.poll(async () => (await state(win)).camera).toBe('player')
  })

  await test.step('MV-3: the player walks with an agent selected (panel open) and the Library open', async () => {
    // Selecting Ada opens the chat panel; with focus off the composer, the player still walks.
    await win.evaluate(() => (window as unknown as MapWindow).__aoDebug.focus('mock:ada'))
    await expect(win.locator('#panel')).toBeVisible()
    await blur(win)
    expect(await walkedSomewhere(win, 600)).toBeGreaterThan(0.2)
    // Typing in the composer never moves the player.
    const before = (await state(win)).player
    await win.locator('#p-input').press('s')
    await win.locator('#p-input').press('d')
    const after = (await state(win)).player
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeLessThan(0.05)
    await win.locator('#p-input').press('Escape')
    await expect(win.locator('#panel')).toBeHidden()
    // The Library drawer open, focus back on the page: the player walks.
    await win.locator('#library-btn').click()
    await expect(win.locator('#library')).toBeVisible()
    await blur(win)
    expect(await walkedSomewhere(win, 600)).toBeGreaterThan(0.2)
    await win.locator('#lib-close').click()
    await expect(win.locator('#library')).toBeHidden()
  })

  await test.step('MAP-1: M shows a 320 px map with labels and one dot per agent; a click pans', async () => {
    await blur(win)
    await win.keyboard.press('m')
    const map = win.locator('#minimap')
    await expect(map).toBeVisible()
    const box = (await win.locator('#minimap-canvas').boundingBox())!
    expect(Math.round(box.width)).toBe(320)
    await expect
      .poll(async () => Number(await map.getAttribute('data-labels')), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(3)
    // One dot per visible agent (both refresh at 2 Hz; agents may walk in or out meanwhile).
    await expect
      .poll(async () => {
        const visible = (await state(win)).entities.filter((e) => e.visible).length
        return Math.abs(Number(await map.getAttribute('data-dots')) - visible)
      })
      .toBeLessThanOrEqual(1)
    await expect(map).toHaveAttribute('data-base', 'true')
    // Click the map's centre: the camera pans to the map's centre (± the clamp at the edges).
    const s = await state(win)
    await win.locator('#minimap-canvas').click({ position: { x: 160, y: 140 } })
    const cx = s.originM!.x + (s.tiles!.w / 2) * tileM(s)
    const cz = s.originM!.z + (s.tiles!.h / 2) * tileM(s)
    await expect
      .poll(async () => {
        const v = (await state(win)).view!
        return Math.hypot(v.cx - cx, v.cz - cz)
      })
      .toBeLessThan(3)
    expect((await state(win)).camera).toBe('pan')
    // A movement key returns the camera to the player.
    await blur(win)
    await hold(win, 'a', 200)
    await expect.poll(async () => (await state(win)).camera).toBe('player')
    await win.keyboard.press('m')
    await expect(map).toBeHidden()
  })

  await test.step('PC-1: the player walks the length of Main Street from its north end', async () => {
    // The northernmost street bay; start 1 m inside its north edge, on its centre line.
    const streets = (await rooms(win))
      .filter((r) => r.placement.startsWith('street'))
      .sort((a, b) => a.rect.ty - b.rect.ty)
    expect(streets.length).toBeGreaterThan(0)
    const north = streets[0]!
    const st = await state(win)
    const o = st.originM!
    await teleport(
      win,
      o.x + (north.rect.tx + north.rect.tw / 2) * tileM(st),
      o.z + north.rect.ty * tileM(st) + 1,
    )
    await blur(win)
    // 6 s of S at walking speed (3 m/s): at least 12 m south, no invisible barriers.
    const d = await walked(win, 's', 6000)
    expect(d.dz).toBeGreaterThanOrEqual(12)
  })

  await test.step('PC-2: vertical meeting tables use their vertical art', async () => {
    const tables = (await objects(win)).filter((o) => o.kind === 'meeting-table')
    expect(tables.length).toBeGreaterThan(0)
    // A table taller than wide is drawn with the 'v' variant (its box is the drawn base).
    for (const t of tables) if (t.box!.h > t.box!.w) expect(t.orientation, t.id).toBe('v')
    expect(tables.some((t) => t.orientation === 'v')).toBe(true)
  })

  await test.step('PC-3: kitchen counters sit inside the kitchen in every wing', async () => {
    const kitchens = (await rooms(win)).filter((r) => r.id.endsWith('/kitchen'))
    expect(kitchens.length).toBeGreaterThan(0)
    const counters = (await objects(win)).filter((o) => o.kind === 'kitchen-counter')
    for (const k of kitchens) {
      const mine = counters.filter((c) => c.room === k.id)
      expect(mine.length, k.id).toBeGreaterThan(0)
      for (const c of mine) expect(insidePx(c.box!, k.box!), `${c.id} in ${k.id}`).toBe(true)
    }
  })

  await test.step('ZM-1: - zooms out in crisp steps; the player still walks; ⌂ returns to the default', async () => {
    await blur(win)
    const s0 = await state(win)
    const before = s0.view!
    await win.keyboard.press('-')
    await win.keyboard.press('-')
    if (s0.zoom! > 1) {
      // Two steps out: fewer device px per art px (crisp integer levels), and a much wider view
      // (the view stops growing once the whole office fits, so ≥ 1.5×, not 2×).
      await expect.poll(async () => (await state(win)).zoom!).toBeLessThan(s0.zoom!)
      await expect
        .poll(async () => (await state(win)).view!.w / before.w)
        .toBeGreaterThanOrEqual(1.5)
    } else {
      // A small 1× screen (CI Macs are 1024×768) starts at 1 device px per art px, the smallest
      // crisp level: - stays there rather than blurring the art.
      await win.waitForTimeout(300)
      expect((await state(win)).zoom).toBe(1)
    }
    expect(await walkedSomewhere(win, 600)).toBeGreaterThan(0.2)
    // The HUD's ⌂ button returns to the default zoom.
    await win.locator('#pixel-zoom [data-zoom="0"]').click()
    await expect.poll(async () => Math.round((await state(win)).view!.w)).toBe(Math.round(before.w))
  })

  await test.step('RUN-1: walking covers 2.5 m/s; R makes running the default (≥ 4 m/s)', async () => {
    // Back to the middle of the plaza, which has room to walk east and west.
    const s1 = await state(win)
    const cx = s1.originM!.x + (lobby!.rect.tx + lobby!.rect.tw / 2) * tileM(s1)
    const cz = s1.originM!.z + (lobby!.rect.ty + lobby!.rect.th / 2) * tileM(s1)
    await teleport(win, cx, cz)
    await blur(win)
    expect((await walked(win, 'd', 1000)).dx).toBeGreaterThanOrEqual(2.5)
    // R toggles running on; the same second of A now covers at least 4 m.
    await teleport(win, cx, cz)
    await win.keyboard.press('r')
    await expect.poll(async () => (await state(win)).run).toBe(true)
    expect(-(await walked(win, 'a', 1000)).dx).toBeGreaterThanOrEqual(4)
    await win.keyboard.press('r')
  })

  expect(errors).toEqual([])
  await app.close()
})
