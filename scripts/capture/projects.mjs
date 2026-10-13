// Projects-first workspace capture (docs/projects.md): dashboard, memory, context, sessions,
// handoff, palette and the project directory in 3D and 2D → docs/screenshots.
// Everything is invented and lives in an isolated temp profile (launchApp). Managed sessions use
// the scripted Claude runner and the fake Codex app-server, so no real CLI, login or transcript
// is touched. Run `make build` first, then `make screenshots-projects`.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import sharp from 'sharp'
import { apiClient } from './api.mjs'
import { launchApp } from './app.mjs'
import { loadWorld } from './world.mjs'

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: new URL('../../docs/screenshots/', import.meta.url).pathname },
    only: { type: 'string' },
  },
})
const only = args.only ? new Set(args.only.split(',')) : null
const want = (n) => !only || only.has(n)
mkdirSync(args.out, { recursive: true })

const SIZE = { width: 1600, height: 1000 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A real git repository with one commit, in the profile's temp dir (basename = the label shown). */
function makeRepo(dir) {
  mkdirSync(dir, { recursive: true })
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Demo',
    GIT_AUTHOR_EMAIL: 'demo@example.com',
    GIT_COMMITTER_NAME: 'Demo',
    GIT_COMMITTER_EMAIL: 'demo@example.com',
  }
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore', env })
  git('init', '-q')
  writeFileSync(join(dir, 'README.md'), `# ${dir.split('/').pop()}\n`)
  git('add', 'README.md')
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial commit')
  return dir
}

async function shot(win, name, { clip } = {}) {
  const buf = await win.screenshot(clip ? { clip } : {})
  const path = join(args.out, name)
  await sharp(buf)
    .resize(SIZE.width, SIZE.height, { fit: 'cover' })
    .png({ palette: true, quality: 92, effort: 10, dither: 0.5 })
    .toFile(path)
  console.log(`  still ${path}`)
}

// ── invented content ────────────────────────────────────────────────────────────────────────────
const MEMORIES = [
  // instructions
  [
    'instruction',
    'Pagination uses cursors',
    'List endpoints paginate with opaque cursors (base64 of created_at and id), never offsets. Keep ?offset working for one release, then remove it.',
  ],
  [
    'instruction',
    'Run the contract tests before opening a PR',
    'Run `pnpm test:contract` in checkout-api before every pull request. A red contract test blocks the merge.',
  ],
  // constraints
  [
    'constraint',
    'Never log card data',
    'Card numbers, CVV and full names never reach logs, traces or error messages. Log the last four digits and the payment id only.',
  ],
  [
    'constraint',
    'Money is integer minor units',
    'Amounts are integers in minor units (cents) with an ISO currency code. Floats are rejected at the API boundary.',
  ],
  // facts and notes
  [
    'fact',
    'Staging uses the sandbox gateway',
    'Staging talks to the payment sandbox. Test cards from the sandbox list work there; production keys never do.',
  ],
  [
    'note',
    'Peak load is 1.2k orders per minute',
    'The Black Friday load test peaked at 1.2k orders/min before the queue backed up. Plan capacity against that number.',
  ],
]
const DECISIONS = [
  [
    'Settle payments from gateway webhooks',
    'Settlement is driven by signed gateway webhooks, not by polling. Polling stays as a nightly reconciliation job.',
    'accepted',
  ],
  [
    'Idempotency keys expire after 24 hours',
    'POST /payments accepts an Idempotency-Key header; keys are kept for 24 hours and replays return the first response.',
    'proposed',
  ],
  [
    'Retire the legacy /v1/cart route',
    'The old cart route is deprecated: new clients use /v2/carts. Remove it after the mobile app ships 4.2.',
    'deprecated',
  ],
]
const PROPOSALS = [
  [
    'decision',
    'Retry webhooks with exponential backoff',
    'Failed webhook deliveries retry with exponential backoff (1 min, 5 min, 30 min, 2 h) and then land in a dead-letter queue.',
  ],
  [
    'constraint',
    'Refunds need a reason code',
    'Every refund request carries a reason code from the fixed list. Free text is stored separately and never used for routing.',
  ],
  [
    'note',
    'Cart totals are recomputed on the server',
    'The web client shows a preview total, but the server recomputes totals from line items at checkout.',
  ],
  [
    'fact',
    'Tax rates come from the nightly tax table',
    'Tax rates are read from the tax table loaded each night at 02:00 UTC; a missing region falls back to the default rate.',
  ],
]
const GLOBAL_MEMORY = [
  [
    'instruction',
    'Write the failing test first',
    'Every behavior change starts with a failing test. Bug fixes start with a test that reproduces the bug.',
  ],
]

const CONVOS = {
  pagination: [
    [
      'user',
      'Plan the cursor pagination for the orders endpoint. What changes in the API and what stays?',
    ],
    [
      'agent',
      'Plan:\n1. The cursor is an opaque string: base64 of (created_at, id) of the last row.\n2. GET /orders accepts ?cursor and ?limit (default 25, max 100) and returns next_cursor.\n3. ?offset keeps working for one release and logs a deprecation warning.\n4. The contract tests gain a page-boundary case with equal timestamps.',
    ],
    ['user', 'Good. Does the web client need changes too?'],
    [
      'agent',
      'Yes, but small: checkout-web only calls /orders from the order history page. It needs to store next_cursor instead of a page number. I would do the API first, then that page.',
    ],
    ['user', 'Do the API first and keep the diff small.'],
    [
      'agent',
      'Done in checkout-api: the cursor codec, the handler change and four tests (first page, middle page, last page, equal timestamps). Contract tests are green. The history page change is next.',
    ],
  ],
  totals: [
    ['user', 'Order totals are off by one cent on some carts. Find out why.'],
    [
      'agent',
      'Found it: the discount is applied per line item and rounded each time, so three items can lose a cent. Rounding once on the order total fixes it.',
    ],
    ['user', 'Fix it and add a regression test with the failing cart.'],
    [
      'agent',
      'Fixed. totals.ts now sums line items in minor units and rounds the discount once. The regression test uses the three-item cart from the bug report and passes.',
    ],
  ],
  retries: [
    ['user', 'Draft the retry policy for failed webhook deliveries.'],
    [
      'agent',
      'Proposed policy: retry after 1 min, 5 min, 30 min and 2 h, then move the event to a dead-letter queue and alert. Deliveries carry a stable event id so receivers can deduplicate.',
    ],
  ],
  mdx: [
    ['user', 'Migrate the guides from Markdown to MDX without changing the URLs.'],
    [
      'agent',
      'Migrated 38 guides. Redirects are not needed because the slugs are unchanged. Two pages used raw HTML tables; I converted them to the Table component.',
    ],
  ],
  onboarding: [
    ['user', 'Rebuild the onboarding flow with three steps instead of five.'],
    [
      'agent',
      'The new flow is welcome, permissions, first project. Analytics events are renamed in one place, and the old step screens are removed.',
    ],
  ],
}

async function main() {
  const ctx = await launchApp({
    quality: 'high',
    mock: false,
    fakeRunner: true,
    theme: 'light',
    width: SIZE.width,
    height: SIZE.height,
    env: {
      AGENT_OFFICE_FAKE_PROVIDERS: '1',
      FAKE_LOG: join(tmpdir(), `ao-fake-${process.pid}.log`),
    },
  })
  const { app, win, dir } = ctx
  const fakeLog = join(tmpdir(), `ao-fake-${process.pid}.log`)
  const ev = (fn, arg) => win.evaluate(fn, arg)
  const P = (m, ...a) => ev(([m, a]) => window.agentOffice.projects[m](...a), [m, a])
  const log = (...a) => console.log(...a)
  const api = apiClient(ctx.port, ctx.token())
  const dbg = (fn, ...a) => win.evaluate(([f, xs]) => window.__aoDebug[f](...xs), [fn, a])
  /** The real (stubbed) native picker → an opaque ctx_ ref. */
  const pickFolder = async (path) => {
    await app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] })
    }, path)
    const [ref] = await ev(() => window.agentOffice.context.pick('folder'))
    return ref.ref
  }
  let failed = false
  try {
    const cdp = await win.context().newCDPSession(win)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: SIZE.width,
      height: SIZE.height,
      deviceScaleFactor: 1,
      mobile: false,
    })

    // ── providers, projects, repos ──
    for (const p of ['codex', 'cursor', 'gemini', 'copilot'])
      await ev((p) => window.agentOffice.providers.setEnabled(p, true), p)
    const folder = {}
    for (const n of ['checkout-api', 'checkout-web', 'docs-site', 'mobile-app'])
      folder[n] = await pickFolder(makeRepo(join(dir, 'code', n)))
    const mk = (name, folders) =>
      ev(
        ([name, folders]) => window.agentOffice.projects.create({ name, folders }),
        [name, folders],
      )
    const checkout = await mk('Checkout Service', [folder['checkout-api'], folder['checkout-web']])
    const docs = await mk('Docs Site', [folder['docs-site']])
    const mobile = await mk('Mobile App', [folder['mobile-app']])

    // ── memory (approved) ──
    const mem = {}
    for (const [kind, title, body] of MEMORIES)
      mem[title] = await P('createMemory', {
        projectId: checkout.id,
        scope: 'project',
        kind,
        title,
        body,
      })
    for (const [title, body, status] of DECISIONS) {
      const m = await P('createMemory', {
        projectId: checkout.id,
        scope: 'project',
        kind: 'decision',
        title,
        body,
      })
      mem[title] = m
      log('decision', title, m.decision)
    }
    for (const [kind, title, body] of GLOBAL_MEMORY)
      await P('createMemory', { projectId: null, scope: 'global', kind, title, body })
    for (const [kind, title, body] of [
      [
        'instruction',
        'Use the shared MDX components',
        'Guides use the shared Callout, Table and CodeTabs components; no raw HTML.',
      ],
      [
        'decision',
        'Docs deploy from main only',
        'The docs site deploys from main. Preview builds run for every pull request.',
      ],
    ])
      await P('createMemory', { projectId: docs.id, scope: 'project', kind, title, body })
    for (const [kind, title, body] of [
      [
        'constraint',
        'Support the last two OS versions',
        'The app supports the two latest major versions of iOS and Android.',
      ],
      [
        'note',
        'Release train is every second Tuesday',
        'App store submissions go out every second Tuesday; hotfixes skip the train.',
      ],
    ])
      await P('createMemory', { projectId: mobile.id, scope: 'project', kind, title, body })

    // ── agents ──
    const keep = new Map()
    const post = async (e, keepAlive = true) => {
      if (keepAlive) keep.set(e.agentId, e)
      await api.events(e)
    }
    setInterval(() => api.events([...keep.values()]).catch(() => {}), 20_000).unref?.()
    const adopt = async (agentId, projectId) => {
      for (let i = 0; i < 40; i++) {
        const un = await P('sessions', { scope: 'unassigned' })
        const s = un.find((x) => x.agentId === agentId)
        if (s) return P('assign', s.id, projectId).then(() => s.id)
        await sleep(250)
      }
      throw new Error(`no session for ${agentId}`)
    }
    const talk = async (id, turns) => {
      for (const [role, text] of turns) {
        if (role === 'user') await api.send(id, text)
        else await api.reply(id, text)
        await sleep(40)
      }
    }
    const past = async (id, provider, name, topic, projectId, convo, minutes = 25) => {
      await api.events({
        agentId: id,
        provider,
        source: 'http',
        name,
        topic,
        status: 'thinking',
        text: '',
        ts: Date.now() - minutes * 60_000,
      })
      const sid = await adopt(id, projectId)
      await talk(id, convo)
      await api.events({ agentId: id, status: 'done' })
      return sid
    }
    const live = async (e, projectId) => {
      await post({ source: 'http', ...e })
      return adopt(e.agentId, projectId)
    }

    const sessCheckout = {}
    sessCheckout.pagination = await past(
      'cc:ses-pagination',
      'claude-code',
      'pagination',
      'Cursor pagination',
      checkout.id,
      CONVOS.pagination,
    )
    sessCheckout.totals = await past(
      'cc:ses-order-totals',
      'claude-code',
      'order-totals',
      'Order totals',
      checkout.id,
      CONVOS.totals,
    )
    sessCheckout.retries = await past(
      'cc:ses-webhook-retries',
      'claude-code',
      'webhook-retries',
      'Webhook retries',
      checkout.id,
      CONVOS.retries,
    )
    await past('gm:ses-mdx', 'gemini', 'migrate-mdx', 'MDX migration', docs.id, CONVOS.mdx)
    const sessOnboarding = await past(
      'cu:ses-onboarding',
      'cursor',
      'onboarding-flow',
      'Onboarding flow',
      mobile.id,
      CONVOS.onboarding,
    )

    // Handoff Claude -> Codex (completed): reviewed bundle, launched into a managed Codex session.
    const bundleIds = [
      mem['Pagination uses cursors'].id,
      mem['Money is integer minor units'].id,
      mem['Run the contract tests before opening a PR'].id,
    ]
    const h0 = await P('prepareHandoff', {
      sessionId: sessCheckout.pagination,
      toProvider: 'codex',
      objective: 'Finish the orders history page in checkout-web using the new cursors.',
    })
    const h1 = await P('updateHandoff', {
      handoffId: h0.id,
      note: 'The API side is done and green. Only the web client is left.',
      include: bundleIds,
    })
    const launched = await P('launchHandoff', h1.id)
    log('handoff launched', launched)
    await sleep(2500)

    // The launched Codex turn asks to run a command (the fake app-server's default scenario):
    // allow it from the agent panel, as a person would, so later turns can run.
    const codexAgent = launched.agentId
    await dbg('focus', codexAgent)
    await win.locator('#p-perm [data-decision="allow"]').click({ timeout: 10_000 })
    await sleep(1500)
    await win.locator('#p-close').click()

    // A Gemini session (ACP fake) on the project: its MCP token lets it propose memory, like a real
    // agent would. The fake agent logs session/new, which carries the MCP wrapper env.
    const gem = await ev(
      ([p, repo]) =>
        window.agentOffice.sessions.start({
          provider: 'gemini',
          projectId: p,
          repo,
          name: 'webhook-audit',
          text: '/mcp webhooks',
        }),
      [checkout.id, checkout.repos[0].id],
    )
    log('gemini', gem)
    await sleep(4000)
    const lines = readFileSync(fakeLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const sn = lines.find((m) => m.params?.mcpServers?.length)
    const envList = sn.params.mcpServers[0].env
    const mcpEnv = Array.isArray(envList)
      ? Object.fromEntries(envList.map((e) => [e.name, e.value]))
      : envList
    const mcp = async (name, args) => {
      const r = await fetch(mcpEnv.AGENT_OFFICE_MCP_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${mcpEnv.AGENT_OFFICE_MCP_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      })
      return r.json()
    }
    // Agent proposals: pending until a person approves. Two get approved, two stay in the queue.
    for (const [kind, title, body] of PROPOSALS)
      await mcp('propose_memory', {
        kind,
        title,
        body,
        rationale: 'Seen while auditing the webhook handler',
      })
    const pend = await P('memories', { scope: checkout.id, states: ['pending'] })
    log(
      'pending',
      pend.map((m) => m.title),
    )
    for (const m of pend.slice(0, 2)) await P('reviewMemory', m.id, 'approve')

    // The Codex agent retrieves memory over the real bridge (a Codex turn is `/mcp <query>`).
    // Codex asks before each MCP tool call: allow it once from the agent panel, as a person would.
    const ask = (q) =>
      ev(([a, q]) => window.agentOffice.sendMessage(a, q), [codexAgent, `/mcp ${q}`])
    await dbg('focus', codexAgent)
    for (const q of ['cursors', 'money', 'webhooks', 'idempotency', 'contract tests']) {
      await ask(q)
      await win.locator('#p-perm [data-decision="allow"]').click({ timeout: 15_000 })
      await sleep(2500)
    }
    await win.locator('#p-close').click()
    log(
      'codex thread',
      JSON.stringify(
        (
          await P('messages', {
            sessionId: (await P('sessions', { scope: checkout.id })).find(
              (x) => x.agentId === codexAgent,
            ).id,
          })
        ).messages.map((m) => m.text.slice(0, 60)),
      ),
    )

    // ── live agents on projects ──
    const waitingText = ''
    await live(
      {
        agentId: 'cc:ses-contract-tests',
        provider: 'claude-code',
        name: 'contract-tests',
        topic: 'Contract tests',
        status: 'tool',
        tool: 'Bash',
        target: 'cmd:pnpm',
        text: 'Running the contract suite',
        model: 'claude-opus-5-5',
      },
      checkout.id,
    )
    await live(
      {
        agentId: 'cc:ses-idempotency',
        provider: 'claude-code',
        name: 'idempotency',
        topic: 'Idempotency keys',
        status: 'thinking',
        text: 'Designing the key store',
        model: 'claude-opus-5-5',
      },
      checkout.id,
    )
    await live(
      {
        agentId: 'cc:ses-refunds',
        provider: 'claude-code',
        name: 'refund-flow',
        topic: 'Refund flow',
        status: 'error',
        text: 'Refund test failed: reason code missing',
        model: 'claude-sonnet-5',
      },
      checkout.id,
    )
    await live(
      {
        agentId: 'cc:ses-cart-ui',
        provider: 'claude-code',
        name: 'cart-ui',
        topic: 'Cart page',
        status: 'waiting',
        text: waitingText,
        model: 'claude-sonnet-5',
      },
      checkout.id,
    )
    await live(
      {
        agentId: 'gm:ses-api-ref',
        provider: 'gemini',
        name: 'api-reference',
        topic: 'API reference',
        status: 'thinking',
        text: 'Drafting the endpoint tables',
        model: 'gemini-3-pro',
      },
      docs.id,
    )
    await live(
      {
        agentId: 'gm:ses-links',
        provider: 'gemini',
        name: 'link-checker',
        topic: 'Broken links',
        status: 'tool',
        tool: 'Bash',
        target: 'cmd:node',
        text: 'Checking links',
        model: 'gemini-3-pro',
      },
      docs.id,
    )
    await live(
      {
        agentId: 'cu:ses-push',
        provider: 'cursor',
        name: 'push-notifications',
        topic: 'Push notifications',
        status: 'tool',
        tool: 'Edit',
        text: 'Wiring the permission prompt',
      },
      mobile.id,
    )
    await live(
      {
        agentId: 'cu:ses-offline',
        provider: 'cursor',
        name: 'offline-sync',
        topic: 'Offline sync',
        status: 'waiting',
        text: waitingText,
      },
      mobile.id,
    )
    // An unassigned session (attention on the Overview).
    await post({
      agentId: 'cc:ses-scratch',
      provider: 'claude-code',
      source: 'http',
      name: 'scratch-experiments',
      topic: 'Scratch',
      status: 'waiting',
      text: '',
    })

    // ── tasks with evidence ──
    const tk = async (title, sessionId) =>
      P('createTask', { projectId: checkout.id, title, ...(sessionId ? { sessionId } : {}) })
    const t1 = await tk('Ship cursor pagination for /orders', sessCheckout.pagination)
    await P('updateTask', { taskId: t1.id, state: 'done' })
    await P('updateTask', { taskId: t1.id, confirm: true })
    const t2 = await tk('Fix the one-cent rounding bug in order totals', sessCheckout.totals)
    await P('updateTask', { taskId: t2.id, state: 'done' })
    const t3 = await tk('Add idempotency keys to POST /payments')
    await P('updateTask', { taskId: t3.id, state: 'doing' })
    await tk('Document the webhook retry policy', sessCheckout.retries)
    await tk('Contract tests for refunds')
    // An unfinished handoff on Mobile App (prepared, not launched): shows on the Overview.
    await P('prepareHandoff', {
      sessionId: sessOnboarding,
      toProvider: 'codex',
      objective: 'Port the onboarding analytics events to the new three-step flow.',
    })
    log(JSON.stringify(await P('inspect', codexAgent)))
    // A fresh renderer reads everything from main (providers, counts), like opening the app.
    await win.reload()
    await win.waitForFunction(() => window.__aoDebug?.ready(), null, { timeout: 60_000 })
    await win.addStyleTag({ content: '#stats{display:none!important}' })
    const project = (name) =>
      win
        .locator('#sb-project-list li[data-project-id]', { hasText: name })
        .locator('button')
        .first()
    const action = (a) => win.locator(`#pd-actions [data-action="${a}"]`)
    const dashboard = async (name = 'Checkout Service') => {
      await project(name).click()
      await win.locator('#ws-project').waitFor({ state: 'visible' })
      await sleep(900)
    }
    const run = async (name, fn) => {
      if (!want(name)) return
      try {
        await fn()
      } catch (e) {
        console.log(`  FAILED ${name}: ${String(e).split('\n')[0]}`)
        await win.screenshot({ path: join(tmpdir(), `ao-fail-${name}.png`) }).catch(() => {})
      }
    }
    await sleep(3500)

    if (only?.has('_tall'))
      await run('_tall', async () => {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: 1600,
          height: 2000,
          deviceScaleFactor: 1,
          mobile: false,
        })
        await sleep(800)
        await dashboard()
        const buf = await win.screenshot()
        await sharp(buf).png().toFile(join(args.out, '_tall-dashboard.png'))
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: SIZE.width,
          height: SIZE.height,
          deviceScaleFactor: 1,
          mobile: false,
        })
        await sleep(800)
      })
    await run('project-dashboard', async () => {
      await dashboard()
      await shot(win, 'project-dashboard.png')
    })
    await run('project-dashboard-dark', async () => {
      await win.evaluate(() => window.agentOffice.settings.set({ theme: 'dark' }))
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'dark' }],
      })
      await sleep(1500)
      await dashboard()
      await shot(win, 'project-dashboard-dark.png')
      await win.evaluate(() => window.agentOffice.settings.set({ theme: 'light' }))
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'light' }],
      })
      await sleep(1200)
    })
    await run('overview', async () => {
      await win.locator('#sb-overview').click()
      await win.locator('#ws-overview').waitFor({ state: 'visible' })
      await sleep(900)
      await shot(win, 'overview.png')
    })
    await run('project-memory', async () => {
      await dashboard()
      await action('memory').click()
      await win.locator('#ws-memory').waitFor({ state: 'visible' })
      await sleep(600)
      const row = win.locator('#mem-list li[data-memory-id]', { hasText: 'Retry webhooks' })
      await row
        .first()
        .click()
        .catch(() => {})
      await sleep(600)
      await shot(win, 'project-memory.png')
    })
    await run('context-inspector', async () => {
      await dashboard()
      await action('context').click()
      await win.locator('#ws-context').waitFor({ state: 'visible' })
      await sleep(800)
      if (await win.locator('#ci-agent').count()) {
        const v = await win
          .locator('#ci-agent option', { hasText: /codex|handoff/i })
          .first()
          .getAttribute('value')
        if (v) await win.locator('#ci-agent').selectOption(v)
      }
      await sleep(1200)
      await shot(win, 'context-inspector.png')
    })
    await run('session-vault', async () => {
      await win.locator('#sb-sessions').click()
      await win.locator('#ws-sessions').waitFor({ state: 'visible' })
      await sleep(600)
      await win.locator('#sv-list li[data-session-id]', { hasText: 'pagination' }).first().click()
      await win.locator('#sv-messages [data-msg-id]').first().waitFor({ timeout: 10_000 })
      await sleep(800)
      await shot(win, 'session-vault.png')
    })
    await run('handoff', async () => {
      await win.locator('#sb-sessions').click()
      await win.locator('#sv-list li[data-session-id]', { hasText: 'order-totals' }).first().click()
      await sleep(600)
      await win.locator('#sv-continue').click()
      await win.locator('#ho-dialog').waitFor({ state: 'visible' })
      await sleep(500)
      await win.locator('#ho-provider').selectOption('codex')
      await win
        .locator('#ho-objective')
        .fill('Add a regression test for the three-item cart and check the refund totals.')
      await win.locator('#ho-prepare').click()
      await sleep(1200)
      await shot(win, 'handoff.png')
      await win.locator('#ho-cancel').click()
    })
    await run('palette', async () => {
      await win.locator('#sb-overview').click()
      await win.keyboard.press('Meta+k')
      await win.locator('#palette').waitFor({ state: 'visible' })
      await win.locator('#pal-input').fill('cursor')
      await sleep(1500)
      await shot(win, 'palette.png')
      await win.keyboard.press('Escape')
    })
    const world = loadWorld(['claude-code', 'codex', 'gemini', 'cursor'])
    const look = (placement, cam, target) => {
      const v = world.view(placement, cam, target)
      return dbg('look', v.pos, v.target)
    }
    const office = async () => {
      await win.evaluate(() => window.agentOffice.settings.set({ viewMode: '3d' }))
      await win.locator('#sb-office').click()
      await sleep(1500)
    }
    await run('project-directory-3d', async () => {
      // Choosing a project focuses its agents (the rest dims); then frame the reception kiosk.
      await project('Checkout Service').click()
      await office()
      await look('atrium', [-12.6, 3.6, -6.5], [-12.6, 1.5, -14.5])
      await sleep(3500)
      await shot(win, 'project-directory-3d.png')
    })
    /** The provider's wing from above and behind: desks, agents and their labels in frame. */
    const wing = async (id) => {
      await dbg('view', id)
      await sleep(1500)
      const { target: t } = await dbg('orbit')
      await dbg('look', [t.x + 2, t.y + 15, t.z + 13], [t.x, t.y, t.z])
      await sleep(3500)
    }
    await run('office-3d-projects', async () => {
      await office()
      await wing('wing:claude-code:0')
      await shot(win, 'office-3d-projects.png')
    })
    await run('project-directory-2d', async () => {
      await win.evaluate(() => window.agentOffice.settings.set({ viewMode: 'pixel' }))
      await win.locator('#pixel').waitFor({ state: 'visible', timeout: 20_000 })
      await sleep(2500)
      // Stand in front of the Project Directory kiosk, facing it, and press E (see projects-journey.spec).
      const desk = await win.evaluate(() => {
        const d = window.__aoDebug.pixel()
        const o =
          d.objects().find((x) => x.kind === 'kiosk') ??
          d.objects().find((x) => x.kind === 'reception-desk')
        return o?.box && d.originM
          ? { box: o.box, originM: d.originM, ppm: d.pxPerMetre ?? 32 }
          : null
      })
      if (!desk) throw new Error('no kiosk in the 2D map')
      const cx = desk.originM.x + (desk.box.x + desk.box.w / 2) / desk.ppm
      const cz = desk.originM.z + (desk.box.y + desk.box.h / 2) / desk.ppm
      const hw = desk.box.w / 2 / desk.ppm
      const hh = desk.box.h / 2 / desk.ppm
      const spots = [
        [cx, cz + hh + 0.6, 'n'],
        [cx, cz - hh - 0.6, 's'],
        [cx - hw - 0.6, cz, 'e'],
        [cx + hw + 0.6, cz, 'w'],
      ]
      for (const [x, z, dir] of spots) {
        if (await win.locator('#dialogue').isVisible()) break
        await win.evaluate(([x, z, dir]) => window.__aoDebug.pixelTeleport(x, z, dir), [x, z, dir])
        await win.evaluate(() => document.activeElement?.blur())
        await win.keyboard.press('e')
        await sleep(400)
      }
      await win
        .locator('#dlg-actions [data-action="project-select"]')
        .first()
        .waitFor({ timeout: 5000 })
      await sleep(900)
      await shot(win, 'project-directory-2d.png')
      await win.keyboard.press('Escape')
    })
    await run('office-2d-projects', async () => {
      if (!(await win.locator('#pixel').isVisible())) {
        await win.evaluate(() => window.agentOffice.settings.set({ viewMode: 'pixel' }))
        await win.locator('#pixel').waitFor({ state: 'visible', timeout: 20_000 })
        await sleep(2000)
      }
      await dbg('pixelGoTo', { agentId: 'cc:ses-idempotency' })
      await sleep(2500)
      await shot(win, 'office-2d-projects.png')
    })
  } catch (e) {
    // Never report a partial capture as success.
    console.error('capture failed:', e)
    failed = true
  } finally {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
      })
      .catch(() => {})
    await ctx.close()
    process.exit(failed ? 1 : 0)
  }
}
await main()
