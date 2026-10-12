// Launches the built app (packages/desktop/out) through Playwright's Electron support with an
// isolated profile: its own userData, token dir and Claude settings file. Never touches ~/.claude
// or ~/.agent-office. AGENT_OFFICE_DEBUG=1 exposes the renderer's capture hook (window.__aoDebug).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(new URL('../../packages/desktop/package.json', import.meta.url))
const { _electron } = require('@playwright/test')

/** Inherited ELECTRON_* vars are dropped (ELECTRON_RUN_AS_NODE would start plain Node). */
export function cleanEnv(extra = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => !k.startsWith('ELECTRON_') && v !== undefined),
  )
  return { ...env, ...extra }
}

/**
 * @param {object} o
 * @param {string} [o.quality] graphics preset written to the profile's settings
 * @param {number} [o.port] local API port (default: a free one)
 * @param {boolean} [o.mock] start the built-in mock agents
 * @param {boolean} [o.claude] Claude Code adapter on (pointed at empty temp dirs)
 * @param {boolean} [o.notifications] native notifications on
 * @param {number} [o.width] window content width (CSS px)
 * @param {number} [o.height] window content height (CSS px)
 */
/** A free local port, so concurrent runs (another agent, a dev instance) never share an API. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

export async function launchApp({
  quality = 'high',
  port,
  mock = true,
  claude = false,
  notifications = false,
  width = 1440,
  height = 810,
} = {}) {
  port ??= await freePort()
  const dir = mkdtempSync(join(tmpdir(), 'ao-shots-'))
  const userData = join(dir, 'userData')
  mkdirSync(userData, { recursive: true })
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({ graphicsQuality: quality, notifications, claudeAdapter: claude }),
  )
  const app = await _electron.launch({
    args: ['.'],
    cwd: new URL('../../packages/desktop/', import.meta.url).pathname,
    env: cleanEnv({
      AGENT_OFFICE_USER_DATA: userData,
      AGENT_OFFICE_HOME: join(dir, 'home'),
      CLAUDE_SETTINGS_FILE: join(dir, 'claude', 'settings.json'),
      AGENT_OFFICE_MOCK: mock ? '1' : '0',
      // Claude Code discovery (when on) only ever sees these empty temp locations.
      CLAUDE_PROJECTS_DIR: join(dir, 'claude', 'projects'),
      CLAUDE_HOME: join(dir, 'claude'),
      CLAUDE_CONFIG_FILE: join(dir, 'claude.json'),
      ...(claude ? {} : { AGENT_OFFICE_CLAUDE: '0' }),
      AGENT_OFFICE_DEBUG: '1',
      PORT: String(port),
    }),
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
  await win.waitForFunction(() => window.__aoDebug?.ready(), null, { timeout: 90_000 })
  const close = async () => {
    await app.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
  return {
    app,
    win,
    dir,
    port,
    errors,
    close,
    token: () => readFileSync(join(dir, 'home', 'token'), 'utf8').trim(),
  }
}
