import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launch, newProfile } from './app.ts'

// Sims-style walls (graphics contract §13) against the real scene: hover fades the wall under the
// pointer, Cutaway fades the walls between the camera and the selected agent, Up keeps them, Down
// lowers every wall. Picking and walk-mode collision are unchanged. AGENT_OFFICE_DEBUG=1 installs
// `__aoDebug` (walls(), wallScreenPos(), wallBoxes(), setWallMode(), agentPos(), cameraPos()).
test.setTimeout(150_000)

type XZ = { x: number; z: number }
type V3 = { x: number; y: number; z: number }
type Box = { id: number; module: string; a: XZ; b: XZ; h: number }
type Walls = { total: number; alpha: number[]; lowered: number[]; mode: string }
type Debug = {
  ready(): boolean
  view(id: string): boolean
  views(): string[]
  look(pos: [number, number, number], target: [number, number, number]): void
  focus(id: string): void
  walls(): Walls
  wallBoxes(): Box[]
  wallScreenPos(id: number): { x: number; y: number } | null
  setWallMode(m: 'up' | 'cutaway' | 'down'): void
  agentPos(id: string): V3 | null
  agentScreenPos(id: string): { x: number; y: number } | null
  cameraPos(): V3
  sightBlockers(
    id: string,
    dy?: number,
  ): { name: string; wall: number; x: number; y: number; z: number }[] | null
  walkTo(pos: [number, number, number], heading: number): void
}
type W = { __aoDebug: Debug }

/** CI renders with software GL: start on the Low preset. */
function lowQualityProfile() {
  const profile = newProfile()
  mkdirSync(profile.userData, { recursive: true })
  writeFileSync(join(profile.userData, 'settings.json'), JSON.stringify({ graphicsQuality: 'low' }))
  return profile
}

const dbg = <T>(win: Page, fn: (d: Debug, arg: unknown) => T, arg?: unknown) =>
  win.evaluate(
    ([src, a]) => {
      const f = new Function('d', 'a', `return (${src})(d, a)`) as (d: Debug, a: unknown) => T
      return f((window as unknown as W).__aoDebug, a)
    },
    [fn.toString(), arg] as const,
  )
/** WALL_SHOTS=<dir>: save review screenshots (local visual check only). */
const shot = async (win: Page, name: string) => {
  const dir = process.env.WALL_SHOTS
  if (dir) await win.screenshot({ path: join(dir, `wall-${name}.png`) })
}
const walls = (win: Page) => dbg(win, (d) => d.walls())
const alphaOf = async (win: Page, id: number) => (await walls(win)).alpha[id] ?? 1

/** Closest point of segment a→b to p (XZ). */
function closest(p: XZ, a: XZ, b: XZ): XZ & { d: number } {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz)))
  const x = a.x + t * dx
  const z = a.z + t * dz
  return { x, z, d: Math.hypot(p.x - x, p.z - z) }
}

test('walls fade on hover and in Cutaway, stay in Up, lower in Down; picking and collision hold', async () => {
  const { app, win, errors } = await launch(lowQualityProfile(), {
    env: { AGENT_OFFICE_DEBUG: '1' },
  })
  await expect.poll(() => dbg(win, (d) => d.ready())).toBe(true)
  await expect.poll(async () => (await walls(win)).total).toBeGreaterThan(0)
  const boxes = await dbg(win, (d) => d.wallBoxes())

  await test.step('1: hovering a wall fades it within 500 ms; moving away brings it back', async () => {
    // A wing view: walls are large on screen. Pick a solid wall whose middle is on screen.
    const wing = (await dbg(win, (d) => d.views())).find((v) => v.startsWith('wing:'))!
    expect(await dbg(win, (d, v) => d.view(v as string), wing)).toBe(true)
    await win.mouse.move(5, 5)
    let target: { id: number; pos: { x: number; y: number } } | null = null
    for (const b of boxes) {
      const pos = await dbg(win, (d, id) => d.wallScreenPos(id as number), b.id)
      if (pos && b.h >= 3) {
        target = { id: b.id, pos }
        break
      }
    }
    expect(target).not.toBeNull()
    const { id, pos } = target!
    // The pointer over the wall's middle: the 10 Hz hover finds it, the fader takes 200 ms.
    await win.mouse.move(pos.x, pos.y)
    await expect
      // The 200 ms fade is unit-tested with a fake clock; here only the state matters (software
      // GL on CI renders a few frames per second, so give it time).
      .poll(() => alphaOf(win, id), { timeout: 6000, intervals: [100] })
      .toBeLessThanOrEqual(0.1)
    await shot(win, 'hover')
    // Away from every wall (the top-left corner of the stage): back to solid.
    await win.mouse.move(2, 60)
    await expect.poll(() => alphaOf(win, id), { timeout: 2000 }).toBe(1)
  })

  // A view of Ada from behind the wall nearest her: the sight line crosses that wall.
  await dbg(win, (d) => d.focus('mock:ada'))
  await expect(win.locator('#p-name')).toHaveText('Ada')
  await expect
    .poll(() => dbg(win, (d) => d.agentPos('mock:ada')), { timeout: 20_000 })
    .not.toBeNull()
  // Wait until she is seated (not moving).
  let ada = (await dbg(win, (d) => d.agentPos('mock:ada')))!
  await expect
    .poll(
      async () => {
        const p = (await dbg(win, (d) => d.agentPos('mock:ada')))!
        const still = Math.hypot(p.x - ada.x, p.z - ada.z) < 0.01
        ada = p
        return still
      },
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe(true)
  const near = boxes
    .filter((b) => b.h >= 3)
    .map((b) => ({ b, c: closest(ada, b.a, b.b) }))
    .filter(({ c }) => c.d > 0.6 && c.d < 8)
    .sort((p, q) => p.c.d - q.c.d)[0]!
  expect(near).toBeDefined()
  const wid = near.b.id
  const dir = { x: (near.c.x - ada.x) / near.c.d, z: (near.c.z - ada.z) / near.c.d }
  const cam: [number, number, number] = [near.c.x + dir.x * 3, 2.2, near.c.z + dir.z * 3]
  /**
   * Opaque surfaces on the sight line (camera → Ada's head) that belong to the wall or hang on it:
   * tagged wall pieces, and anything else within 0.6 m of the wall's line (wall-mounted decor that
   * missed its tag). Freestanding furniture by her desk (pod dividers) is not the wall's business.
   */
  const wallBlockers = async () => {
    const hits = (await dbg(win, (d) => d.sightBlockers('mock:ada', 1.5)))!
    return hits.filter((h) => h.wall > 0 || closest(h, near.b.a, near.b.b).d < 0.6)
  }
  const look = (d: Debug, a: unknown) => {
    const { cam, ada } = a as { cam: [number, number, number]; ada: V3 }
    d.look(cam, [ada.x, 1.0, ada.z])
  }

  await test.step('2: Cutaway fades the wall between the camera and the selected agent', async () => {
    await dbg(win, (d) => d.setWallMode('cutaway'))
    await dbg(win, look, { cam, ada })
    await expect.poll(() => alphaOf(win, wid), { timeout: 3000 }).toBeLessThanOrEqual(0.1)
    expect((await walls(win)).mode).toBe('cutaway')
    // Nothing opaque is left on the sight line: the wall and everything mounted on it (shelves,
    // tiles, screens) fade together (a raycast that reads the same per-wall table as the shader).
    await expect.poll(wallBlockers, { timeout: 3000 }).toEqual([])
    await shot(win, 'cutaway')
    if (process.env.WALL_SHOTS) {
      // A higher orbit angle for the visual review.
      const high: [number, number, number] = [near.c.x + dir.x * 7, 5.5, near.c.z + dir.z * 7]
      await dbg(win, look, { cam: high, ada })
      await win.waitForTimeout(800)
      await shot(win, 'cutaway-high')
    }
  })

  await test.step('5: with the wall faded, clicking Ada through it still picks her', async () => {
    const at = await dbg(win, (d) => d.agentScreenPos('mock:ada'))
    expect(at).not.toBeNull()
    // Close the panel, then click the canvas at Ada's body with the faded wall in front of her: an
    // agent there is picked again (Ada, or her subagent Explore, who sits right beside her).
    await win.keyboard.press('Escape')
    await expect(win.locator('#panel')).toBeHidden()
    await win.mouse.click(at!.x, at!.y)
    await expect(win.locator('#panel')).toBeVisible()
    await expect(win.locator('#p-name')).toHaveText(/^(Ada|Explore)$/)
  })

  await test.step('3: Up keeps that wall solid from the same view', async () => {
    await dbg(win, (d) => d.setWallMode('up'))
    await dbg(win, look, { cam, ada })
    await win.mouse.move(2, 60)
    await expect.poll(() => alphaOf(win, wid), { timeout: 3000 }).toBe(1)
    expect((await walls(win)).mode).toBe('up')
    // ... and the solid wall blocks the sight line again.
    expect((await wallBlockers()).some((b) => b.wall === wid)).toBe(true)
    await shot(win, 'up')
  })

  await test.step('4: Down lowers every wall', async () => {
    await dbg(win, (d) => d.setWallMode('down'))
    await expect
      .poll(async () => {
        const w = await walls(win)
        return w.lowered.length === w.total && w.total > 0
      })
      .toBe(true)
    await dbg(win, (d) => d.view('overview'))
    await win.waitForTimeout(500)
    await shot(win, 'down')
    if (process.env.WALL_SHOTS) {
      await dbg(win, (d) => d.setWallMode('up'))
      await win.waitForTimeout(500)
      await shot(win, 'overview-up')
    }
    await dbg(win, look, { cam, ada })
    await dbg(win, (d) => d.setWallMode('cutaway'))
    await expect.poll(async () => (await walls(win)).lowered.length).toBe(0)
  })

  await test.step('6: walking into a wall stops at it (colliders unchanged)', async () => {
    // Stand 1.5 m in front of the wall, facing it, and walk forward for 2 s.
    const start: [number, number, number] = [
      ada.x + (near.c.x - ada.x) * 0.3,
      0,
      ada.z + (near.c.z - ada.z) * 0.3,
    ]
    const heading = Math.atan2(dir.x, dir.z)
    await dbg(
      win,
      (d, a) => {
        const { start, heading } = a as { start: [number, number, number]; heading: number }
        d.walkTo(start, heading)
      },
      { start, heading },
    )
    await win.keyboard.down('KeyW')
    await win.waitForTimeout(2500)
    await win.keyboard.up('KeyW')
    const p = await dbg(win, (d) => d.cameraPos())
    // Still on Ada's side of the wall line.
    const side = (q: XZ) =>
      (near.b.b.x - near.b.a.x) * (q.z - near.b.a.z) -
      (near.b.b.z - near.b.a.z) * (q.x - near.b.a.x)
    expect(Math.sign(side(p))).toBe(Math.sign(side(ada)))
  })

  await test.step('7: in the 2D mode the walls button does nothing and raises no errors', async () => {
    await win.locator('#mode-toggle [data-mode="pixel"]').click()
    await expect(win.locator('#pixel')).toBeVisible({ timeout: 20_000 })
    const btn = win.locator('#wall-mode-btn')
    if (await btn.count()) await btn.dispatchEvent('click')
    await win.waitForTimeout(500)
  })

  expect(errors).toEqual([])
  await app.close()
})
