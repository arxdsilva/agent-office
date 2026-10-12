#!/usr/bin/env node
// In-app screenshots from fixed camera bookmarks → docs/screenshots/ (run `make build` first).
// Launches the built app through Playwright's Electron support with an isolated profile and mock
// agents, turns on the renderer's debug hook (window.__aoDebug) and jumps the camera to each shot.
//   node scripts/screenshots.mjs [--only atrium,overview] [--quality high] [--settle 20]
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const require = createRequire(new URL('../packages/desktop/package.json', import.meta.url))
const { _electron } = require('@playwright/test')

/** Each shot: a bookmark id, an anchor pattern (centroid of matching anchors), or an explicit camera. */
const SHOTS = [
  { name: 'atrium', view: 'atrium' },
  {
    name: 'main-street',
    look: [
      [0.4, 1.7, -3],
      [0, 1.5, 30],
    ],
  },
  { name: 'wing-claude-code', view: 'wing:claude-code:0' },
  { name: 'wing-langgraph', view: 'wing:langgraph:0' },
  { name: 'wing-openai-agents', view: 'wing:openai-agents:0' },
  { name: 'meeting-room', anchor: '^seat:meeting:A:', distance: 6 },
  { name: 'phone-booths', anchor: '^spot:booth:', distance: 6 },
  { name: 'lounge', anchor: '^seat:lounge:', distance: 7 },
  { name: 'kitchen', anchor: '^spot:kitchen:', distance: 7 },
  { name: 'cafe', anchor: '^seat:cafe:', distance: 9 },
  { name: 'overview', view: 'overview' },
]

export async function launchApp({ quality, port = 4319, width = 1600, height = 1000 }) {
  const dir = mkdtempSync(join(tmpdir(), 'ao-shots-'))
  const userData = join(dir, 'userData')
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ graphicsQuality: quality }))
  // Drop inherited ELECTRON_* vars (ELECTRON_RUN_AS_NODE would start plain Node).
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => !k.startsWith('ELECTRON_') && v !== undefined),
  )
  const app = await _electron.launch({
    args: ['.'],
    cwd: new URL('../packages/desktop/', import.meta.url).pathname,
    env: {
      ...env,
      AGENT_OFFICE_USER_DATA: userData,
      AGENT_OFFICE_HOME: join(dir, 'home'),
      CLAUDE_SETTINGS_FILE: join(dir, 'claude', 'settings.json'),
      AGENT_OFFICE_MOCK: '1',
      AGENT_OFFICE_CLAUDE: '0',
      PORT: String(port),
    },
  })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      const bw = BrowserWindow.getAllWindows()[0]
      bw.setContentSize(w, h)
      bw.center()
    },
    [width, height],
  )
  // The debug hook is opt-in: set the flag, reload, wait for the building and characters.
  await win.evaluate(() => localStorage.setItem('ao-debug', '1'))
  await win.reload()
  await win.waitForFunction(() => window.__aoDebug?.ready(), null, { timeout: 60_000 })
  const close = async () => {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return {
    app,
    win,
    dir,
    errors,
    close,
    token: () => readFileSync(join(dir, 'home', 'token'), 'utf8').trim(),
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const { values: args } = parseArgs({
    options: {
      only: { type: 'string' },
      quality: { type: 'string', default: 'high' },
      settle: { type: 'string', default: '20' },
      out: { type: 'string', default: new URL('../docs/screenshots/', import.meta.url).pathname },
      width: { type: 'string', default: '1600' },
      height: { type: 'string', default: '1000' },
    },
  })
  const only = args.only ? new Set(args.only.split(',')) : null
  mkdirSync(args.out, { recursive: true })
  const { win, errors, close } = await launchApp({
    quality: args.quality,
    width: Number(args.width),
    height: Number(args.height),
  })
  try {
    // Let mock agents arrive, sit down, and teams walk to meeting rooms.
    await win.waitForTimeout(Number(args.settle) * 1000)
    for (const shot of SHOTS) {
      if (only && !only.has(shot.name)) continue
      const ok = await win.evaluate((s) => {
        const d = window.__aoDebug
        if (s.view) return d.view(s.view)
        if (s.anchor) return d.anchor(s.anchor, s.distance)
        d.look(s.look[0], s.look[1])
        return true
      }, shot)
      if (!ok) {
        console.warn(`skipped ${shot.name} (no such view in this layout)`)
        continue
      }
      await win.waitForTimeout(1200) // a few frames for streaming wings, AO and label fades
      const path = join(args.out, `${shot.name}.png`)
      await win.screenshot({ path })
      console.log(`saved ${path}`)
    }
    const stats = await win.evaluate(() => window.__aoDebug.stats())
    console.log(`stats: ${JSON.stringify(stats)}`)
    if (errors.length) console.warn(`console errors:\n  ${errors.join('\n  ')}`)
  } finally {
    await close()
  }
}
