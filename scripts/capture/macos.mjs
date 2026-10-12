#!/usr/bin/env node
// Real macOS captures for the README (plan §11.2): the tray menu and a native notification banner.
// Manual and macOS only (`make screenshots-macos`), never in CI. It packages the app, launches the
// packaged binary with an isolated profile and mock agents, then drives it with AppleScript and
// `screencapture`. Needs two permissions for the terminal you run it from (System Settings →
// Privacy & Security): Screen Recording (for screencapture) and Accessibility (for System Events).
//   node scripts/capture/macos.mjs [--skip-package] [--only tray,notification]
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import sharp from 'sharp'
import { apiClient } from './api.mjs'
import { cleanEnv } from './app.mjs'
import { png } from './media.mjs'

const ROOT = new URL('../../', import.meta.url).pathname
const OUT = join(ROOT, 'docs', 'screenshots')
const PORT = 4321
const APP_NAME = 'agent-office'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { values: args } = parseArgs({
  options: {
    'skip-package': { type: 'boolean', default: false },
    only: { type: 'string', default: 'tray,notification' },
  },
})
const only = new Set(args.only.split(','))

const HELP = {
  screen: `Screen Recording is not granted to this terminal.
  1. Open System Settings → Privacy & Security → Screen Recording.
  2. Turn it on for the app you ran this from (Terminal, iTerm or Visual Studio Code).
  3. Quit and reopen that app, then run \`make screenshots-macos\` again.`,
  accessibility: `Accessibility (or Automation of System Events) is not granted to this terminal.
  1. Open System Settings → Privacy & Security → Accessibility and turn it on for the app you ran
     this from (Terminal, iTerm or Visual Studio Code).
  2. If macOS asked "… wants access to control System Events" (or Finder), allow it (Privacy &
     Security → Automation → your terminal → System Events and Finder).
  3. Quit and reopen that app, then run \`make screenshots-macos\` again.`,
  notification: `No notification banner appeared.
  1. System Settings → Notifications → agent-office: allow notifications, style "Banners".
  2. Turn off Focus / Do Not Disturb for a minute.
  3. Run \`node scripts/capture/macos.mjs --skip-package --only notification\` again.`,
}

class PermissionError extends Error {
  constructor(kind, detail = '') {
    super(`${HELP[kind]}${detail ? `\n\n(${detail})` : ''}`)
    this.kind = kind
  }
}

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', ...opts })
  if (r.error) throw r.error
  return r
}

/** Runs AppleScript; maps the authorization errors (-1743, -25211, -25204) to instructions. */
function osascript(script) {
  const r = run('osascript', ['-e', script])
  if (r.status !== 0) {
    const err = `${r.stderr}`.trim()
    if (/-1743|-25211|-25204|not allowed assistive|not authori[sz]ed/i.test(err))
      throw new PermissionError('accessibility', err)
    throw new Error(`osascript failed: ${err}`)
  }
  return r.stdout.trim()
}

/** True when the two captures are (nearly) the same image. */
async function same(a, b) {
  const diff = await sharp(a)
    .composite([{ input: b, blend: 'difference' }])
    .stats()
  return diff.channels.slice(0, 3).every((c) => c.mean <= 6)
}

/** screencapture of a region (points) → PNG buffer; a uniform image means no Screen Recording. */
async function capture(x, y, w, h) {
  const file = join(tmpdir(), `ao-cap-${process.pid}-${Date.now()}.png`)
  const r = run('screencapture', [
    '-x',
    '-R',
    `${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}`,
    file,
  ])
  if (r.status !== 0 || !existsSync(file)) throw new PermissionError('screen', `${r.stderr}`.trim())
  const buf = readFileSync(file)
  rmSync(file, { force: true })
  const { channels } = await sharp(buf).stats()
  if (channels.slice(0, 3).every((c) => c.stdev < 2))
    throw new PermissionError('screen', 'blank capture')
  return buf
}

async function save(buf, name) {
  const path = join(OUT, name)
  mkdirSync(OUT, { recursive: true })
  await png(sharp(buf)).toFile(path)
  console.log(`saved ${path}`)
}

function findApp() {
  const dist = join(ROOT, 'packages', 'desktop', 'dist')
  const dirs = existsSync(dist) ? readdirSync(dist).filter((d) => d.startsWith('mac')) : []
  for (const d of dirs) {
    const bin = join(dist, d, `${APP_NAME}.app`, 'Contents', 'MacOS', APP_NAME)
    if (existsSync(bin)) return bin
  }
  throw new Error(`no packaged app in ${dist}/mac*/; run \`make package\``)
}

/** The main display's size in points (screencapture -R uses points). */
function screenSize() {
  const b = osascript('tell application "Finder" to get bounds of window of desktop')
  const [, , w, h] = b.split(',').map((n) => Number(n.trim()))
  return { w, h }
}

async function launch() {
  const dir = mkdtempSync(join(tmpdir(), 'ao-macos-'))
  const userData = join(dir, 'userData')
  mkdirSync(userData, { recursive: true })
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({ notifications: true, graphicsQuality: 'high' }),
  )
  const child = spawn(findApp(), [], {
    env: cleanEnv({
      AGENT_OFFICE_USER_DATA: userData,
      AGENT_OFFICE_HOME: join(dir, 'home'),
      CLAUDE_SETTINGS_FILE: join(dir, 'claude', 'settings.json'),
      CLAUDE_PROJECTS_DIR: join(dir, 'claude', 'projects'),
      CLAUDE_HOME: join(dir, 'claude'),
      CLAUDE_CONFIG_FILE: join(dir, 'claude.json'),
      AGENT_OFFICE_CLAUDE: '0',
      AGENT_OFFICE_MOCK: '1',
      PORT: String(PORT),
    }),
    stdio: 'ignore',
  })
  const tokenFile = join(dir, 'home', 'token')
  for (let i = 0; i < 120 && !existsSync(tokenFile); i++) await sleep(250)
  for (let i = 0; i < 60; i++) {
    const ok = await fetch(`http://127.0.0.1:${PORT}/api/health`).then(
      (r) => r.ok,
      () => false,
    )
    if (ok) break
    await sleep(250)
  }
  if (!existsSync(tokenFile)) throw new Error('the packaged app did not start (no token file)')
  const api = apiClient(PORT, readFileSync(tokenFile, 'utf8').trim())
  return {
    api,
    close: async () => {
      child.kill('SIGTERM')
      await sleep(800)
      if (child.exitCode === null) child.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const TRAY = `tell application "System Events" to tell process "${APP_NAME}" to tell menu bar item 1 of menu bar 2`

async function trayMenu() {
  osascript(`${TRAY} to click`)
  await sleep(800)
  const item = osascript(`${TRAY} to get {position, size}`).split(',').map(Number)
  const menu = osascript(`${TRAY} to get {position, size} of menu 1`).split(',').map(Number)
  const [ix, iy, iw, ih] = item
  const [mx, my, mw, mh] = menu
  const pad = 12
  const x = Math.max(0, Math.min(ix, mx) - pad)
  const right = Math.max(ix + iw, mx + mw) + pad
  const y = Math.max(0, Math.min(iy, my))
  const bottom = Math.max(iy + ih, my + mh) + pad
  let open
  try {
    open = await capture(x, y, right - x, bottom - y)
  } finally {
    osascript('tell application "System Events" to key code 53') // Escape closes the menu
  }
  // Without Screen Recording, macOS returns only the wallpaper: the open menu wouldn't show.
  await sleep(600)
  if (await same(open, await capture(x, y, right - x, bottom - y)))
    throw new PermissionError('screen', 'the open menu is missing from the capture')
  await save(open, 'tray-menu.png')
}

async function notification(api) {
  // Another app in front, so the banner isn't suppressed for a focused window.
  osascript('tell application "Finder" to activate')
  await sleep(800)
  const { w } = screenSize()
  const region = [w - 420, 0, 420, 170]
  const before = await capture(...region)
  // An invented agent finishes its turn → "waiting for you" notification.
  await api.events({
    agentId: 'macos:demo',
    name: 'Maya',
    provider: 'claude-code',
    topic: 'Refactor auth',
    status: 'thinking',
  })
  await sleep(1500)
  await api.events({ agentId: 'macos:demo', status: 'waiting' })
  for (let i = 0; i < 12; i++) {
    await sleep(500)
    if (!(await same(before, await capture(...region)))) {
      await sleep(400) // let the slide-in animation finish
      return save(await capture(...region), 'notification.png')
    }
  }
  throw new PermissionError('notification')
}

if (process.platform !== 'darwin') {
  console.error('screenshots-macos runs on macOS only.')
  process.exit(1)
}
try {
  if (!args['skip-package']) {
    const r = run('make', ['package'], { cwd: ROOT, stdio: 'inherit', env: cleanEnv() })
    if (r.status !== 0) throw new Error('make package failed')
  }
  // Check Accessibility before launching anything.
  const trusted = run('osascript', [
    '-l',
    'JavaScript',
    '-e',
    "ObjC.import('ApplicationServices'); $.AXIsProcessTrusted()",
  ])
  if (trusted.stdout.trim() === 'false')
    throw new PermissionError('accessibility', 'AXIsProcessTrusted() is false')
  osascript('tell application "System Events" to get name of first process')
  const app = await launch()
  try {
    await sleep(4000) // tray created, mock agents arriving
    if (only.has('tray')) await trayMenu()
    if (only.has('notification')) await notification(app.api)
  } finally {
    await app.close()
  }
} catch (e) {
  if (e instanceof PermissionError) {
    console.error(`\n${e.message}\n`)
    process.exit(2)
  }
  throw e
}
