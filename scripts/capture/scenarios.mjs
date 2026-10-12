// Capture scenarios for the README gallery (plan §11.2). Each one launches the built app with an
// isolated profile and no mock agents, seeds agents and capabilities through the HTTP API, drives
// the camera through the renderer's debug hook, and saves stills and clips. All names, topics and
// capabilities are invented; there are no third-party logos or product names in what is seeded.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { apiClient } from './api.mjs'
import { launchApp } from './app.mjs'
import { saveSideBySide, saveSplit } from './composites.mjs'
import { saveClip, saveStill } from './media.mjs'
import { loadWorld } from './world.mjs'

const CC = 'wing:claude-code:0'
const LG = 'wing:langgraph:0'
const OA = 'wing:openai-agents:0'

// ── capabilities (docs/capabilities.md) ─────────────────────────────────────────────────────────
const adapter = (id, kind, label, extra = {}) => ({
  id,
  category: 'adapter',
  kind,
  label,
  ...extra,
})
const skill = (name, summary, scope = 'project') => ({
  id: `skill:${name}`,
  category: 'skill',
  kind: 'skill',
  label: name,
  summary,
  scope,
})
const rule = (file, summary, scope = 'project') => {
  const root = file === 'CLAUDE.md' || file === 'AGENTS.md'
  return {
    id: `rule:${scope}:${file}`,
    category: 'rule',
    kind: root ? (scope === 'user' ? 'user-rules' : 'project-rules') : 'rule',
    label: root ? `${file} (${scope === 'user' ? 'you' : 'shop-api'})` : file,
    summary,
    scope,
  }
}
const memory = (slug, label) => ({ id: `memory:${slug}`, category: 'rule', kind: 'memory', label })

export const DECLS = {
  'claude-code': [
    adapter('fs', 'filesystem', 'Filesystem', {
      sees: ['project: shop-api'],
      tools: ['Read', 'Edit', 'Grep'],
    }),
    adapter('shell', 'shell', 'Shell', { sees: ['cmd: git', 'cmd: pnpm'], tools: ['Bash'] }),
    adapter('web', 'web', 'Web', {
      sees: ['host: docs.example.com'],
      tools: ['WebFetch', 'WebSearch'],
    }),
    adapter('subagents', 'subagents', 'Subagents', { tools: ['Agent'] }),
    adapter('mcp:mail', 'mcp', 'Mail', {
      sees: ['inbox: support'],
      tools: ['search_threads', 'send_draft'],
    }),
    adapter('mcp:tickets', 'mcp', 'Tickets', { tools: ['search_issues', 'create_issue'] }),
    adapter('mcp:warehouse_db', 'database', 'Warehouse Db', {
      sees: ['db: analytics'],
      tools: ['query'],
    }),
    adapter('mcp:calendar', 'mcp', 'Calendar', { tools: ['list_events'] }),
    skill('run-office', 'Launch the app locally and verify a change with a screenshot.'),
    skill('write-tests', 'Write the failing test first, then the minimum code.'),
    skill('review-pr', 'Review a diff for bugs, then for simplifications.'),
    skill('release-notes', 'Draft release notes from merged changes.'),
    skill('db-migration', 'Add a reversible schema migration with a test.'),
    skill('add-endpoint', 'Add an HTTP endpoint with validation and an E2E test.'),
    skill('perf-profile', 'Profile a slow path and report the hot spots.', 'user'),
    skill('triage-bugs', 'Sort new bug reports by severity and owner.', 'user'),
    rule('CLAUDE.md', 'Which rules and skills apply when.'),
    rule('AGENTS.md', 'The architecture, glossary and definition of done.'),
    rule('TESTING.md', 'Write a failing test first.'),
    rule('ARCHITECTURE.md', 'Dependencies point inward.'),
    rule('SECURITY.md', 'Fail closed on auth.'),
    rule('CLAUDE.md', 'Short answers, no filler.', 'user'),
    memory('shop-api-project', 'shop-api project'),
    memory('deploy-checklist', 'Deploy checklist'),
    memory('team-preferences', 'Team preferences'),
  ],
  langgraph: [
    adapter('mcp:warehouse_db', 'database', 'Warehouse Db', {
      sees: ['db: events'],
      tools: ['query'],
    }),
    adapter('web', 'web', 'Web'),
    adapter('api:chat', 'api', 'Chat', { tools: ['post_message'] }),
    skill('summarize-run', 'Summarize a pipeline run for the team channel.'),
    rule('AGENTS.md', 'How the data agents hand work to each other.'),
  ],
  'openai-agents': [
    adapter('web', 'web', 'Web'),
    adapter('api:code_interpreter', 'api', 'Code Interpreter'),
    adapter('api:vector_store', 'api', 'Vector Store'),
    skill('refund-policy', 'Answer refund questions from the policy text.'),
  ],
}

// ── the busy office roster (40 agents, 3 providers, every status) ───────────────────────────────
const a = (id, name, provider, topic, status, extra = {}) => ({
  agentId: id,
  name,
  provider,
  topic,
  status,
  ...extra,
})
const work = (tool) => ({ status: 'tool', tool })

export const OFFICE = [
  // claude-code (terracotta wing)
  a('cc:maya', 'Maya', 'claude-code', 'Refactor auth', 'thinking', { model: 'opus' }),
  a('cc:maya-explore', 'Explore', 'claude-code', 'Refactor auth', 'tool', {
    parentId: 'cc:maya',
    kind: 'Explore',
    tool: 'TodoWrite',
  }),
  a('cc:maya-plan', 'Plan', 'claude-code', 'Refactor auth', 'thinking', {
    parentId: 'cc:maya',
    kind: 'Plan',
  }),
  a('cc:omar', 'Omar', 'claude-code', 'Checkout page', 'thinking'),
  a('cc:lena', 'Lena', 'claude-code', 'Checkout page', 'tool', { tool: 'TodoWrite' }),
  a('cc:ivo', 'Ivo', 'claude-code', 'Checkout page', 'thinking'),
  a('cc:sana', 'Sana', 'claude-code', 'Checkout page', 'waiting'),
  a('cc:theo', 'Theo', 'claude-code', 'Release notes', 'error', { text: 'tests failed' }),
  a('cc:nia', 'Nia', 'claude-code', 'Release notes', 'tool', { tool: 'TodoWrite' }),
  a('cc:raf', 'Raf', 'claude-code', 'Release notes', 'thinking'),
  a('cc:june', 'June', 'claude-code', 'Docs site', 'idle'),
  a('cc:kai', 'Kai', 'claude-code', 'Docs site', 'idle'),
  a('cc:eli', 'Eli', 'claude-code', 'Docs site', 'idle'),
  a('cc:zoe', 'Zoe', 'claude-code', 'Perf budget', 'waiting'),
  // langgraph (forest wing)
  a('lg:dara', 'Dara', 'langgraph', 'Data pipeline', 'thinking'),
  a('lg:bo', 'Bo', 'langgraph', 'Data pipeline', 'thinking'),
  a('lg:cy', 'Cy', 'langgraph', 'Data pipeline', 'idle'),
  a('lg:mei', 'Mei', 'langgraph', 'Data pipeline', 'waiting'),
  a('lg:ash', 'Ash', 'langgraph', 'Eval reports', 'thinking'),
  a('lg:ash-grader', 'Grader', 'langgraph', 'Eval reports', 'thinking', {
    parentId: 'lg:ash',
    kind: 'grader',
  }),
  a('lg:ash-judge', 'Judge', 'langgraph', 'Eval reports', 'thinking', {
    parentId: 'lg:ash',
    kind: 'judge',
  }),
  a('lg:tom', 'Tom', 'langgraph', 'Ingest', 'error', { text: 'source timed out' }),
  a('lg:uma', 'Uma', 'langgraph', 'Ingest', 'thinking'),
  a('lg:pia', 'Pia', 'langgraph', 'Ingest', 'idle'),
  a('lg:rex', 'Rex', 'langgraph', 'Forecasts', 'thinking'),
  a('lg:liv', 'Liv', 'langgraph', 'Forecasts', 'idle'),
  a('lg:ned', 'Ned', 'langgraph', 'Forecasts', 'thinking'),
  // openai-agents (nordic wing)
  a('oa:ken', 'Ken', 'openai-agents', 'Support triage', 'thinking'),
  a('oa:ava', 'Ava', 'openai-agents', 'Support triage', 'thinking'),
  a('oa:joe', 'Joe', 'openai-agents', 'Support triage', 'waiting'),
  a('oa:ida', 'Ida', 'openai-agents', 'Support triage', 'idle'),
  a('oa:max', 'Max', 'openai-agents', 'Billing bot', 'thinking'),
  a('oa:fay', 'Fay', 'openai-agents', 'Billing bot', 'idle'),
  a('oa:gus', 'Gus', 'openai-agents', 'Billing bot', 'thinking'),
  a('oa:hal', 'Hal', 'openai-agents', 'Research', 'thinking'),
  a('oa:amy', 'Amy', 'openai-agents', 'Research', 'error', { text: 'rate limited' }),
  a('oa:lou', 'Lou', 'openai-agents', 'Research', 'idle'),
  a('oa:viv', 'Viv', 'openai-agents', 'Research', 'thinking'),
  a('oa:sam', 'Sam', 'openai-agents', 'Onboarding', 'idle'),
  a('oa:bea', 'Bea', 'openai-agents', 'Onboarding', 'waiting'),
]
/** One agent per provider: enough to plan the same three wings in every scenario. */
const ANCHORS = [
  a('cc:anchor', 'Rin', 'claude-code', 'Backlog', 'thinking'),
  a('lg:anchor', 'Oli', 'langgraph', 'Backlog', 'thinking'),
  a('oa:anchor', 'Pax', 'openai-agents', 'Backlog', 'thinking'),
]

// ── context: what every scenario gets ───────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Capture-only CSS: hide the debug stats readout, and drop name tags that recede behind walls
 * (opacity ≤ 0.3) so tags from the next room never float over the subject of a shot.
 */
const CAPTURE_CSS = `#stats{display:none!important}
.label-stack[style*="opacity: 0.0"],.label-stack[style*="opacity: 0.1"],
.label-stack[style*="opacity: 0.2"],.label-stack[style*="opacity: 0.3"]{visibility:hidden}`

async function context({ out, quality, port, launch = {} }) {
  const world = loadWorld()
  const app = await launchApp({ mock: false, quality, port, ...launch })
  const { win } = app
  const api = apiClient(app.port, app.token())
  // Isolation guard: a fresh profile starts empty. Anything else means real sessions leaked in.
  const before = await api.agents()
  if (before.length) {
    await app.close()
    throw new Error(`isolated profile is not empty (${before.length} agents); refusing to capture`)
  }
  await win.addStyleTag({ content: CAPTURE_CSS })
  for (const [p, decls] of Object.entries(DECLS)) await api.declare(p, decls)
  const dbg = (fn, ...args) => win.evaluate(([f, xs]) => window.__aoDebug[f](...xs), [fn, args])
  /** Keeps agents in thinking/tool from reverting to idle (60 s without events). */
  const keep = new Map()
  const beat = setInterval(() => {
    if (keep.size) api.events([...keep.values()]).catch(() => {})
  }, 20_000)
  const ctx = {
    app,
    win,
    api,
    world,
    dbg,
    sleep,
    out,
    /** Posts events; `keepAlive: false` agents are not re-sent by the heartbeat (tool calls). */
    async post(events, { keepAlive = true } = {}) {
      const list = Array.isArray(events) ? events : [events]
      for (const e of list) {
        const next = { ...(keep.get(e.agentId) ?? {}), ...e }
        if (keepAlive && (next.status === 'thinking' || next.status === 'tool'))
          keep.set(e.agentId, next)
        else keep.delete(e.agentId)
      }
      await api.events(list)
    },
    scale: (n) => dbg('timeScale', n),
    /** Module-local camera → world, then jump. */
    async look(placement, cam, target) {
      const v = world.view(placement, cam, target)
      await dbg('look', v.pos, v.target)
    },
    hud: (show) => dbg('hideHud', !show),
    /** Opens the Capability panel the way clicking a station, spine or board does. */
    async openCapability(provider, id) {
      await win
        .locator(`#capability-list button[data-provider="${provider}"][data-capability-id="${id}"]`)
        .dispatchEvent('click')
      await win.locator('#cap-panel').waitFor({ state: 'visible', timeout: 5000 })
      await sleep(1200) // the camera eases to the surface; scenarios re-frame afterwards
    },
    /**
     * Fast-forward the director's clock by `simSeconds` of office time. The renderer caps a frame's
     * step at 0.5 s, so on a busy GPU (≈10 fps) more than 5× would silently run slower.
     */
    async fastForward(simSeconds, speed = 5) {
      await ctx.scale(speed)
      await sleep((simSeconds / speed) * 1000)
      await ctx.scale(1)
    },
    async still(name, { hud = false, settle = 1200, bloom = true } = {}) {
      await ctx.hud(hud)
      if (!bloom) await dbg('pass', 'bloom', false)
      await sleep(settle)
      await saveStill(await win.screenshot(), join(out, `${name}.png`))
      if (!bloom) await dbg('pass', 'bloom', true)
    },
    /**
     * Records frames and writes an animated WebP. `simPerFrame` (office seconds per frame) adapts
     * the clock to the capture rate so motion plays at an even speed; `before(i, n)` runs ahead of
     * each frame (camera moves, events).
     */
    async clip(name, { frames, fps = 12, simPerFrame, before, hud = false, bloom = true }) {
      await ctx.hud(hud)
      if (!bloom) await dbg('pass', 'bloom', false)
      const shots = []
      let interval = 0.2
      for (let i = 0; i < frames; i++) {
        const t = performance.now()
        if (simPerFrame) await ctx.scale(Math.max(0.05, Math.min(60, simPerFrame / interval)))
        if (before) await before(i, frames)
        shots.push(await win.screenshot({ type: 'jpeg', quality: 90, scale: 'css' }))
        interval = interval * 0.7 + ((performance.now() - t) / 1000) * 0.3
      }
      await ctx.scale(1)
      if (!bloom) await dbg('pass', 'bloom', true)
      await saveClip(shots, join(out, `${name}.webp`), { fps })
    },
    async close() {
      clearInterval(beat)
      if (app.errors.length) console.warn(`  console errors:\n    ${app.errors.join('\n    ')}`)
      await app.close()
    },
  }
  return ctx
}

const lerp = (p, q, t) => p.map((v, i) => v + (q[i] - v) * t)
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/** Piecewise camera path through keyframes [{pos, target}] with eased segments. */
function path(keys) {
  return (u) => {
    const n = keys.length - 1
    const k = Math.min(n - 1, Math.floor(u * n))
    const t = ease(u * n - k)
    return {
      pos: lerp(keys[k].pos, keys[k + 1].pos, t),
      target: lerp(keys[k].target, keys[k + 1].target, t),
    }
  }
}

// ── scenarios ───────────────────────────────────────────────────────────────────────────────────
// Claude-code wing (terracotta, module-local metres): door at x = 0, desks x 8–17 in pods
// 1–3 (z ≈ −4.6) and 4–6 (z ≈ +4.6), booths along z = −8.1, meeting room A at (21.2, −5.7),
// Adapters room x 24–30 / z −9…0 (stations 0–3 on the back wall, 4–7 on the front wall),
// Library x 24–30 / z 0…9. Pods fill in topic order, and every scenario posts ANCHORS first, so
// the first scenario topic sits in pod 2 (12.6, −4.6) and the second in pod 3 (16.2, −4.6).
const team = (topic, provider, names, status = 'thinking', extra = {}) =>
  names.map((n) =>
    a(`${provider.slice(0, 2)}:${n.toLowerCase()}`, n, provider, topic, status, extra),
  )
const tool = (id, toolName, target) => ({
  agentId: id,
  status: 'tool',
  tool: toolName,
  ...(target ? { target } : {}),
})

export const SCENARIOS = [
  {
    name: 'office',
    shots: [
      'hero-overview',
      'wing-terracotta',
      'wing-forest',
      'wing-nordic',
      'desk-pod',
      'walk-mode',
      'quality-compare',
      'settings',
    ],
    clips: ['walkthrough'],
    async run(c, want) {
      await c.post(OFFICE)
      // Arrivals, check-in, seating, teams and booths, then the first idle breaks.
      await c.fastForward(100)
      await c.sleep(1500)
      const { world: w } = c
      if (want('hero-overview')) {
        await c.dbg('look', [26, 40, 52], [0, 0, 5])
        await c.still('hero-overview')
      }
      for (const [file, wing] of [
        ['wing-terracotta', CC],
        ['wing-forest', LG],
        ['wing-nordic', OA],
      ]) {
        if (!want(file)) continue
        await c.look(wing, [-5, 17, 0], [14, 0, 0])
        await c.still(file)
      }
      if (want('desk-pod')) {
        // "Checkout page": typing and thinking agents, monitors in status colors, booths behind.
        await c.look(CC, [13.5, 4.6, 1.2], [16.2, 0.7, -4.6])
        await c.still('desk-pod')
      }
      if (want('walk-mode')) {
        await c.dbg('walkTo', w.at(CC, [5.5, 0, -1]), Math.PI / 2 + 0.25)
        await c.still('walk-mode', { hud: true })
        await c.dbg('view', 'overview')
      }
      if (want('quality-compare')) {
        const shots = {}
        for (const q of ['low', 'ultra']) {
          await c.dbg('setQuality', q)
          await c.look(CC, [11, 5.5, 1.5], [14.5, 0.5, -5])
          await c.hud(false)
          await c.sleep(3000)
          shots[q] = await c.win.screenshot()
        }
        await c.dbg('setQuality', 'high')
        await saveSplit(
          shots.low,
          shots.ultra,
          ['Low', 'Ultra'],
          join(c.out, 'quality-compare.png'),
        )
      }
      if (want('settings')) {
        await c.look(CC, [-5, 17, 0], [14, 0, 0])
        await c.hud(true)
        await c.win.click('#settings-btn')
        await c.sleep(600)
        // As most people run it: sessions, discovery and notifications on. Display only (no change
        // event), so the Claude Code adapter stays off and no real session can appear.
        await c.win.evaluate(() => {
          for (const id of ['s-claudeAdapter', 's-discoverCapabilities', 's-notifications'])
            document.getElementById(id).checked = true
        })
        await c.sleep(600)
        await c.still('settings', { hud: true })
        await c.win.keyboard.press('Escape')
        await c.sleep(400)
      }
      if (want('walkthrough')) {
        const at = (p) => w.at(CC, p)
        const route = path([
          { pos: [0, 30, -50], target: [0, 0, -10] }, // over the entrance: the whole atrium
          { pos: [-9, 8, -19], target: [-18, 1, -5] }, // reception and elevators
          { pos: [7, 6, -20], target: [10, 2, -4] }, // cafe and the LED wall
          { pos: [0, 17, -9], target: [0, 0, 14] }, // rise over the back wall…
          { pos: [0, 9, 2], target: [0, 0.5, 20] }, // …and down Main Street
          { pos: at([-4, 9, 0]), target: at([10, 0.5, 0]) }, // turn into the claude-code wing
          { pos: at([12, 7, 1]), target: at([21, 0.5, -4]) }, // desks, meeting room behind
          { pos: at([21, 8, 0]), target: at([27, 0.5, -1]) }, // the Adapters room and Library
        ])
        const frames = 108
        await c.clip('walkthrough', {
          frames,
          before: async (i) => {
            const v = route(i / (frames - 1))
            await c.dbg('look', v.pos, v.target)
          },
        })
      }
    },
  },
  {
    name: 'idle',
    shots: ['kitchen-lounge', 'game-area', 'atrium-cafe-ledwall'],
    clips: [],
    async run(c, want) {
      await c.post([
        ...team('Docs site', 'claude-code', ['June', 'Kai', 'Eli', 'Mo'], 'idle'),
        ...team('Old tickets', 'claude-code', ['Tess', 'Ugo', 'Wen', 'Yan'], 'idle'),
        ...team('Weekly report', 'claude-code', ['Ben', 'Cleo', 'Dev'], 'idle'),
        ...team('Release notes', 'claude-code', ['Nia', 'Raf'], 'thinking'),
        ...team('Data pipeline', 'langgraph', ['Dara', 'Bo', 'Cy', 'Liv'], 'idle'),
        ...team('Billing bot', 'openai-agents', ['Max', 'Fay', 'Gus', 'Lou'], 'idle'),
        // (These six hash to the cafe on their first break; see idleBreakKind in behavior.ts.)
        ...team('Design review', 'claude-code', ['Bex', 'Cal', 'Rue', 'Xan', 'Sue', 'Ula'], 'idle'),
        ...team('Research', 'openai-agents', ['Hal', 'Amy', 'Viv', 'Sam'], 'idle'),
        ...team('Forecasts', 'langgraph', ['Rex', 'Ned', 'Pia', 'Uma'], 'idle'),
      ])
      // Idle breaks start at 45 s of office time; pairs on a long break (90 s) go to ping-pong.
      await c.fastForward(120)
      await c.sleep(1000)
      if (want('kitchen-lounge')) {
        await c.look(CC, [12, 8.5, 0], [3, 0, 0])
        await c.still('kitchen-lounge')
      }
      await c.fastForward(45)
      if (want('game-area')) {
        await c.look('atrium', [18, 7, -21], [27, 0.5, -12])
        await c.still('game-area')
      }
      if (want('atrium-cafe-ledwall')) {
        await c.look('atrium', [8, 8.5, -19], [10, 0.8, -6])
        await c.still('atrium-cafe-ledwall')
      }
    },
  },
  {
    name: 'team',
    shots: ['meeting-room'],
    clips: ['team-meeting'],
    async run(c, want) {
      // Maya and two helpers already work at the "Refactor auth" pod; the helpers become her
      // subagents (parentId), the team forms and all three walk into meeting room A.
      const helper = (id, name, kind) =>
        a(id, name, 'claude-code', 'Refactor auth', 'thinking', { kind })
      await c.post([
        a('cc:maya', 'Maya', 'claude-code', 'Refactor auth', 'thinking'),
        helper('cc:explore', 'Explore', 'Explore'),
        helper('cc:plan', 'Plan', 'Plan'),
      ])
      await c.fastForward(60)
      const join = [
        { agentId: 'cc:explore', parentId: 'cc:maya', status: 'tool', tool: 'TodoWrite' },
        { agentId: 'cc:plan', parentId: 'cc:maya', status: 'thinking' },
      ]
      await c.look(CC, [14.5, 10.5, 2.5], [17.2, 0, -5.2])
      if (want('team-meeting')) {
        await c.clip('team-meeting', {
          frames: 96,
          simPerFrame: 0.3,
          before: async (i) => {
            if (i === 3) await c.post(join)
          },
        })
      } else await c.post(join)
      await c.fastForward(30)
      if (want('meeting-room')) {
        await c.look(CC, [18.6, 7.5, -2.2], [21.2, 0.4, -5.7])
        await c.still('meeting-room')
      }
    },
  },
  {
    name: 'booth',
    shots: ['phone-booth', 'error-state'],
    clips: ['booth-waiting'],
    async run(c, want) {
      await c.post(team('Checkout page', 'claude-code', ['Sana', 'Omar', 'Ivo']))
      await c.fastForward(60)
      await c.look(CC, [12.6, 6.5, 0.8], [12, 0.6, -6.6])
      if (want('booth-waiting')) {
        await c.clip('booth-waiting', {
          frames: 84,
          simPerFrame: 0.17,
          before: async (i) => {
            if (i === 4) await c.post({ agentId: 'cl:sana', status: 'waiting' })
          },
        })
      } else await c.post({ agentId: 'cl:sana', status: 'waiting' })
      await c.post({ agentId: 'cl:omar', status: 'waiting' })
      await c.fastForward(40)
      if (want('phone-booth')) {
        await c.look(CC, [11.8, 4.4, -3.4], [11.6, 1.1, -8.1])
        await c.still('phone-booth')
      }
      if (want('error-state')) {
        // Ivo's tests fail: he scratches his head at a red monitor.
        await c.post({ agentId: 'cl:ivo', status: 'error', text: 'tests failed' })
        await c.fastForward(10)
        await c.look(CC, [12.9, 3.4, -0.6], [12.6, 0.9, -4.8])
        await c.still('error-state')
      }
    },
  },
  {
    name: 'arrivals',
    shots: ['atrium-reception', 'main-street'],
    clips: ['elevator-arrival'],
    async run(c, want) {
      await c.fastForward(30)
      await c.dbg('look', [-10.5, 5.5, -15.5], [-18.5, 1, -5])
      if (want('elevator-arrival')) {
        await c.clip('elevator-arrival', {
          frames: 96,
          simPerFrame: 0.2,
          before: async (i) => {
            if (i === 2) await c.post(team('Search ranking', 'openai-agents', ['Noa', 'Ari']))
            if (i === 10) await c.post(team('Perf budget', 'claude-code', ['Ivy', 'Jon']))
          },
        })
      }
      if (want('atrium-reception')) {
        await c.post(team('Onboarding', 'langgraph', ['Gil', 'Hana', 'Oz']))
        await c.fastForward(9)
        await c.dbg('look', [-25.5, 4.6, -15.5], [-18.2, 1, -5.5])
        await c.still('atrium-reception')
      }
      if (want('main-street')) {
        await c.post([
          ...team('Pricing page', 'claude-code', ['Uma', 'Vic', 'Wes']),
          ...team('Forecasts', 'openai-agents', ['Xia', 'Yul']),
        ])
        await c.fastForward(24)
        await c.dbg('look', [0, 9.5, -0.5], [0, 0, 15])
        await c.still('main-street')
      }
    },
  },
  {
    name: 'adapters',
    shots: ['adapters-links', 'adapters-room', 'adapters-visit', 'connection-panel'],
    clips: ['adapter-link'],
    async run(c, want) {
      const api = team('Payments API', 'claude-code', ['Ada', 'Bram', 'Cora', 'Dex'])
      const ops = team('Ops runbook', 'claude-code', ['Eva', 'Finn', 'Gia', 'Hugo'])
      await c.post([...api, ...ops])
      await c.fastForward(60)
      if (want('adapters-links')) {
        // One call each: a flowing link from each desk to its station, colored by kind.
        await c.post(
          [
            tool('cl:ada', 'Read', 'project:shop-api'),
            tool('cl:bram', 'Bash', 'cmd:git'),
            tool('cl:cora', 'WebFetch', 'host:docs.example.com'),
            tool('cl:dex', 'mcp__mail__search_threads'),
            tool('cl:eva', 'mcp__tickets__search_issues'),
            tool('cl:finn', 'Agent'),
            tool('cl:gia', 'mcp__warehouse_db__query'),
          ],
          { keepAlive: false },
        )
        await c.look(CC, [14.5, 7.5, 1.8], [22.5, 1, -4.6])
        await c.still('adapters-links', { settle: 1500 })
        await c.post([...api, ...ops].map((x) => ({ agentId: x.agentId, status: 'thinking' })))
        await c.fastForward(10)
      }
      if (want('adapter-link')) {
        await c.look(CC, [14.5, 7.5, 1.8], [22.5, 1, -4.6])
        await c.clip('adapter-link', {
          frames: 96,
          simPerFrame: 0.36,
          before: async (i) => {
            // A web call raises a link; sustained use walks Eva to the Web station.
            if (i === 3) await c.post(tool('cl:eva', 'WebFetch', 'host:docs.example.com'))
          },
        })
      }
      // Sustained use: three agents walk to their stations and work there standing.
      await c.post([
        tool('cl:dex', 'mcp__mail__search_threads'),
        tool('cl:bram', 'Bash', 'cmd:git'),
        tool('cl:eva', 'WebFetch', 'host:docs.example.com'),
        tool('cl:hugo', 'Read', 'project:shop-api'),
      ])
      await c.fastForward(45)
      if (want('adapters-room')) {
        await c.look(CC, [21.8, 7.8, -0.6], [27, 0.6, -5])
        await c.still('adapters-room')
      }
      if (want('adapters-visit')) {
        await c.look(CC, [27.7, 3, -8.5], [24.6, 1.3, -6.6])
        await c.still('adapters-visit')
      }
      if (want('connection-panel')) {
        // Open it like a click on the station (through the station's accessible button).
        await c.openCapability('claude-code', 'web')
        await c.look(CC, [21.8, 6.5, -0.2], [26.5, 0.8, -4.8])
        await c.still('connection-panel', { hud: true })
      }
    },
  },
  {
    name: 'library',
    shots: ['library-call', 'library-room', 'library-reading', 'capability-panel-skill'],
    clips: ['library-visit'],
    async run(c, want) {
      const docs = team('Docs site', 'claude-code', ['Iris', 'Jude', 'Kemi'])
      const tests = team('Test suite', 'claude-code', ['Lars', 'Mina', 'Nils'])
      await c.post([...docs, ...tests])
      await c.fastForward(60)
      if (want('library-call')) {
        await c.post(
          [
            tool('cl:iris', 'Skill', 'skill:run-office'),
            tool('cl:jude', 'Read', 'rule:project:TESTING.md'),
            tool('cl:lars', 'Skill', 'skill:write-tests'),
            tool('cl:mina', 'Read', 'memory:deploy-checklist'),
            tool('cl:nils', 'Read', 'rule:project:ARCHITECTURE.md'),
          ],
          { keepAlive: false },
        )
        // From inside the Library: page streams arrive through the door; spines and boards glow.
        await c.look(CC, [29.6, 6.2, 8.8], [25.2, 0.8, 2])
        await c.still('library-call', { settle: 1600, bloom: false })
        await c.post([...docs, ...tests].map((x) => ({ agentId: x.agentId, status: 'thinking' })))
        await c.fastForward(12)
      }
      if (want('library-visit')) {
        await c.look(CC, [29.6, 6.2, 8.8], [25.2, 0.6, 2])
        await c.clip('library-visit', {
          bloom: false,
          frames: 108,
          simPerFrame: 0.4,
          before: async (i) => {
            // A skill call (gold link, the spine glows), then a rule read: two uses within 60 s
            // send Kemi to the Library to pick the book and read it at the table.
            if (i === 3) await c.post(tool('cl:kemi', 'Skill', 'skill:run-office'))
            if (i === 14) await c.post(tool('cl:kemi', 'Read', 'rule:project:TESTING.md'))
          },
        })
      } else {
        await c.post(tool('cl:kemi', 'Skill', 'skill:run-office'))
        await c.sleep(1500)
        await c.post(tool('cl:kemi', 'Read', 'rule:project:TESTING.md'))
        await c.fastForward(60)
      }
      // A second reader for the room shots.
      await c.post(tool('cl:nils', 'Skill', 'skill:review-pr'))
      await c.sleep(1200)
      await c.post(tool('cl:nils', 'Read', 'rule:project:ARCHITECTURE.md'))
      await c.fastForward(60)
      // Both keep reading; once their turn moves on, the board glow fades (they stay ~10 s).
      await c.post([
        { agentId: 'cl:kemi', status: 'thinking' },
        { agentId: 'cl:nils', status: 'thinking' },
      ])
      await c.sleep(2500)
      if (want('library-room')) {
        await c.look(CC, [29.6, 5.6, 8.7], [25.6, 0.8, 2.8])
        await c.still('library-room', { bloom: false })
      }
      if (want('library-reading')) {
        await c.look(CC, [28.9, 2.9, 7.2], [26.9, 0.8, 4.4])
        await c.still('library-reading', { bloom: false })
      }
      if (want('capability-panel-skill')) {
        await c.openCapability('claude-code', 'skill:run-office')
        await c.look(CC, [29.4, 4.6, 7.6], [25.4, 0.9, 2.2])
        await c.still('capability-panel-skill', { hud: true, bloom: false })
      }
    },
  },
  {
    name: 'chat',
    shots: ['chat-panel'],
    clips: ['chat-roundtrip'],
    async run(c, want) {
      await c.post(team('Refactor auth', 'claude-code', ['Maya', 'Leo', 'Pat']))
      await c.fastForward(60)
      const ID = 'cl:maya'
      const ASK = 'Can you also cover the logout flow?'
      const ANSWER = 'Yes. Added a logout test; the session cookie is now cleared on sign-out.'
      let msg
      const exchange = async (i) => {
        if (i >= 6 && i < 30)
          await c.win.fill('#p-input', ASK.slice(0, Math.ceil(((i - 5) / 24) * ASK.length)))
        if (i === 32) await c.win.press('#p-input', 'Enter')
        if (i === 50) {
          // The Claude Code hook claims the message when Maya's turn ends (✓ delivered)…
          msg = (await c.api.claim(ID)).messages[0]
          await c.post(
            { agentId: ID, status: 'tool', tool: 'Edit', target: 'project:shop-api' },
            { keepAlive: false },
          )
        }
        // …and posts her answer back (✓✓ replied).
        if (i === 80 && msg) {
          await c.api.reply(ID, ANSWER, msg.id)
          await c.post({ agentId: ID, status: 'idle' })
        }
      }
      await c.dbg('focus', ID)
      await c.sleep(2500)
      if (want('chat-roundtrip'))
        await c.clip('chat-roundtrip', { frames: 110, hud: true, before: exchange })
      else for (let i = 0; i <= 80; i++) await exchange(i)
      await c.sleep(1500)
      if (want('chat-panel')) await c.still('chat-panel', { hud: true })
    },
  },
  {
    // First run with nothing connected, then the Connect panel confirming a framework's first event.
    name: 'connect',
    empty: true,
    // Claude on, pointed at an empty temp folder (never the real ~/.claude).
    launch: { claude: true },
    shots: ['empty-state', 'connect-panel'],
    clips: [],
    async run(c, want) {
      // The empty card shows after the 2 s grace period (no agents at all in this profile).
      await c.win.locator('#empty').waitFor({ state: 'visible', timeout: 10_000 })
      if (want('empty-state')) await c.still('empty-state', { hud: true, settle: 1500 })
      // "Show me how" opens the Any framework tab; a LangGraph agent then posts its first event.
      await c.win.getByRole('button', { name: 'Show me how →' }).click()
      await c.win.locator('#connect').waitFor({ state: 'visible', timeout: 5000 })
      await c.post({
        agentId: 'lg:triage-1',
        name: 'Iris',
        provider: 'langgraph',
        topic: 'Ticket triage',
        status: 'thinking',
      })
      await c.win
        .locator('#c-http-live')
        .filter({ hasText: 'Received from' })
        .waitFor({ timeout: 8000 })
      if (want('connect-panel')) await c.still('connect-panel', { hud: true, settle: 1500 })
    },
  },
  {
    // A managed Claude Code session (scripted runner, never the real CLI): the new-session dialog,
    // the panel with mode/model pills and composer chips, a permission card, and both themes.
    name: 'session',
    empty: true,
    launch: { fakeRunner: true },
    shots: ['new-session', 'managed-session', 'permission-card', 'themes'],
    clips: [],
    async run(c, want) {
      const { win } = c
      const folder = join(c.app.dir, 'shop-api')
      mkdirSync(folder, { recursive: true })
      // Every folder pick returns the temp folder (no native dialog in captures).
      await c.app.app.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
      }, folder)
      // ⊕ New session: folder, Plan mode and a first message.
      await win.locator('#new-session-btn').click()
      await win.locator('#ns-choose').click()
      await win.locator('#ns-mode').selectOption('plan')
      await win.locator('#ns-text').fill('Plan the logout flow')
      if (want('new-session')) await c.still('new-session', { hud: true, settle: 800 })
      await win.locator('#ns-start').click()
      await win.locator('#p-badge').waitFor({ state: 'visible', timeout: 20_000 })
      await win.locator('#p-thread li.agent').first().waitFor({ timeout: 15_000 })
      // Composer with a folder chip and the Chrome browser, and the mode menu open.
      await win.locator('#p-add-context').click()
      await win.locator('.menu-item[data-id="folder"]').click()
      await win.locator('#p-use').click()
      await win.locator('.menu-item[data-id="mcp:claude-in-chrome"]').click()
      await win
        .locator('#p-input')
        .fill('Review the auth folder and check the login page in Chrome')
      await win.locator('#p-session .session-pill.mode').click()
      if (want('managed-session')) await c.still('managed-session', { hud: true, settle: 1500 })
      await win.keyboard.press('Escape')
      // A tool call that needs approval.
      // Remove the chips one at a time (each removal re-renders the list).
      while (await win.locator('#p-chips .chip-x').count())
        await win.locator('#p-chips .chip-x').first().click()
      await win.locator('#p-input').fill('/perm')
      await win.locator('#p-input').press('Enter')
      await win.locator('#p-perm').waitFor({ state: 'visible', timeout: 10_000 })
      if (want('permission-card')) await c.still('permission-card', { hud: true, settle: 1200 })
      if (want('themes')) {
        // Playwright pins prefers-color-scheme to light; drop it so the app's theme setting applies.
        await win.emulateMedia({ colorScheme: null })
        const shots = {}
        for (const theme of ['light', 'dark']) {
          await win.evaluate((t) => window.agentOffice.settings.set({ theme: t }), theme)
          await c.sleep(1200)
          shots[theme] = await win.screenshot()
        }
        await saveSideBySide(shots.light, shots.dark, ['Light', 'Dark'], join(c.out, 'themes.png'))
      }
    },
  },
]

export async function runScenarios({ out, quality = 'high', only, clips = true, port }) {
  for (const s of SCENARIOS) {
    const names = [...s.shots, ...(clips ? s.clips : [])]
    const whole = !only || only.has(s.name)
    if (!whole && !names.some((n) => only.has(n))) continue
    const want = (n) => names.includes(n) && (whole || only.has(n))
    console.log(`scenario ${s.name}`)
    const c = await context({ out, quality, port, launch: s.launch })
    try {
      if (!s.empty) await c.post(ANCHORS)
      await s.run(c, want)
    } finally {
      await c.close()
    }
  }
}
