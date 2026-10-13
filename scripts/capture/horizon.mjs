#!/usr/bin/env node
// Horizon vs Classic stills (`make screenshots-horizon`, needs `make build`): one mock-mode launch,
// the same camera bookmarks in Classic 3D and then in Horizon, saved as pairs
// `<name>-classic.png` / `<name>-horizon.png`. Everything is synthetic (mock agents, temp profile).
// Usage: node scripts/capture/horizon.mjs [--out <dir>] [--quality <preset>]
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { launchApp } from './app.mjs'

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: 'docs/screenshots/horizon' },
    quality: { type: 'string', default: 'high' },
  },
})

/** name → how to frame it: a view bookmark, or an anchor pattern and a distance (m). */
const SHOTS = [
  ['atrium', { view: 'atrium' }],
  ['main-street', { view: 'street' }],
  ['wing-pod', { anchor: '^seat:desk:1:', distance: 7 }],
  ['meeting-room', { anchor: '^seat:meeting:A:0$', distance: 6 }],
  ['kitchen', { anchor: '^spot:kitchen:0$', distance: 6 }],
  ['library', { view: 'library:claude-code:0' }],
  ['project-hub', { anchor: '^console:context:0$', distance: 8 }],
  ['overview', { view: 'overview' }],
]

async function frame(win, how) {
  const ok = await win.evaluate(
    (h) => (h.view ? window.__aoDebug.view(h.view) : window.__aoDebug.anchor(h.anchor, h.distance)),
    how,
  )
  if (!ok) console.warn(`no bookmark for ${JSON.stringify(how)}`)
  await win.waitForTimeout(2500)
}

async function capture(win, flavor) {
  await win.evaluate(() => window.__aoDebug.hideHud(true))
  for (const [name, how] of SHOTS) {
    await frame(win, how)
    const path = join(args.out, `${name}-${flavor}.png`)
    await win.screenshot({ path })
    console.log(path)
  }
  await win.evaluate(() => window.__aoDebug.hideHud(false))
}

mkdirSync(args.out, { recursive: true })
const { win, close } = await launchApp({ quality: args.quality })
try {
  // Let the mock agents arrive and the wings stream in.
  await win.waitForTimeout(8000)
  await capture(win, 'classic')
  await win.locator('#mode-toggle [data-mode="special"]').click()
  const intro = win.locator('#horizon-intro [data-action="continue"]')
  await intro.click({ timeout: 60_000 }).catch(() => {})
  await win.waitForFunction(() => window.__aoDebug?.horizon?.ready() === true, null, {
    timeout: 90_000,
  })
  await win.waitForTimeout(6000)
  await capture(win, 'horizon')
} finally {
  await close()
}
