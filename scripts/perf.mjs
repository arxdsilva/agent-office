#!/usr/bin/env node
// Frame-rate matrix (plan §8). For each preset: launch the built app with that graphicsQuality,
// add mock agents, let them settle, sample frames in the renderer, then print one table row.
// Run `make build` first. `make perf` = the default matrix; `make perf-low` = --low-end.
import { parseArgs } from 'node:util'
import { formatTable, perfPlan, summarize, verdict } from './perf-report.mjs'
import { launchApp } from './screenshots.mjs'

const HELP = `Usage: node scripts/perf.mjs [options]

  --presets <list>   comma-separated presets (default minimal,low,medium,high;
                     --low-end: minimal,low)
  --agents <n>       mock agents (default 150; --low-end: 60)
  --seconds <n>      sampling window per preset (default 10)
  --settle <n>       seconds to wait after adding agents (default 8)
  --view <id>        camera bookmark while sampling (default overview)
  --low-end          CPU rendering (SwiftShader via AGENT_OFFICE_FORCE_SOFTWARE_GL=1), DPR 1
  --mode <3d|pixel|special>  view mode (default 3d; pixel = the 2D RPG mode, sampled at the
                     claude-code wing; special = Night City: presets low–ultra, 30 NPCs, plus load
                     time, switch time and GPU MB; report only)
  --zoom-out         2D only: sample at the most zoomed-out level (the most on screen)
  -h, --help         this text

Columns: avg fps (rAF), 1% low (rAF), rendered (the scene's own fps; frame pacing caps it),
draw calls, triangles, textureMB (n/a until the scene reports it), first frame (launch → first
rendered layout), JS heap. Bars (§8): Minimal ≥ 30/25, Low and Medium ≥ 55/45, High and Ultra
report only; --low-end: Minimal ≥ 20 avg. Exits 1 when a bar is missed.`

const { values: args } = parseArgs({
  options: {
    presets: { type: 'string' },
    agents: { type: 'string' },
    seconds: { type: 'string' },
    settle: { type: 'string', default: '8' },
    view: { type: 'string', default: 'overview' },
    'low-end': { type: 'boolean', default: false },
    mode: { type: 'string', default: '3d' },
    'zoom-out': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})
if (args.help) {
  console.log(HELP)
  process.exit(0)
}
const special = args.mode === 'special'
const plan = perfPlan({
  ...args,
  ...(special && !args.presets && { presets: 'low,medium,high,ultra' }),
  ...(special && !args.agents && { agents: '30' }),
})

/** One preset: a fresh app (graphicsQuality written to its profile), so startup is measured too. */
async function measure(preset) {
  const started = Date.now()
  const { win, port, token, close } = await launchApp({
    quality: preset,
    viewMode: args.mode === 'pixel' ? 'pixel' : undefined,
    env: plan.env,
    args: plan.args,
  })
  // launchApp resolves once the renderer has a layout (window.__aoDebug.ready()).
  const firstFrameMs = Date.now() - started
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/mock?n=${plan.agents}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token()}` },
    })
    if (res.status !== 202) throw new Error(`POST /api/mock → ${res.status}`)
    // Let everyone arrive and the wings stream in.
    await win.waitForTimeout(Number(args.settle) * 1000)
    // 3D frames a camera view; 2D (no camera views) pans to the busiest wing instead.
    await win.evaluate(
      (v) =>
        window.__aoDebug.view
          ? window.__aoDebug.view(v)
          : window.__aoDebug.bookmark('wing:claude-code:0'),
      args.view,
    )
    // 2D: step all the way out (- clamps at one device px per art px).
    if (args['zoom-out']) for (let i = 0; i < 8; i++) await win.keyboard.press('-')
    await win.waitForTimeout(2000)

    const sample = await win.evaluate(async (seconds) => {
      const frames = []
      const rendered = []
      let last = performance.now()
      const end = last + seconds * 1000
      const poll = setInterval(() => rendered.push(window.__aoDebug.stats().fps ?? 0), 250)
      await new Promise((done) => {
        const tick = (t) => {
          frames.push(t - last)
          last = t
          if (t < end) requestAnimationFrame(tick)
          else done()
        }
        requestAnimationFrame(tick)
      })
      clearInterval(poll)
      const heap = performance.memory?.usedJSHeapSize
      return { frames, rendered, stats: window.__aoDebug.stats(), heap }
    }, plan.seconds)

    const summary = summarize(sample.frames, sample.rendered)
    const s = sample.stats
    console.log(
      `${preset.padEnd(8)}: ${s.total ?? '?'} agents (${s.animated ?? '?'} animated, ` +
        `${s.impostors ?? '?'} impostors), ${summary.frames} frames over ${plan.seconds} s`,
    )
    return {
      preset,
      ...summary,
      drawCalls: s.drawCalls,
      triangles: s.triangles,
      textureMB: typeof s.textureMB === 'number' ? s.textureMB : undefined,
      firstFrameMs,
      ...(typeof sample.heap === 'number' ? { heapMB: sample.heap / 2 ** 20 } : {}),
      ...verdict(preset, summary, plan.lowEnd),
    }
  } finally {
    await close()
  }
}

/** Samples rAF intervals and the scene's own fps for `seconds` (shared by every mode). */
async function sampleFrames(win, seconds) {
  return win.evaluate(async (seconds) => {
    const frames = []
    const rendered = []
    let last = performance.now()
    const end = last + seconds * 1000
    const poll = setInterval(() => rendered.push(window.__aoDebug.stats().fps ?? 0), 250)
    await new Promise((done) => {
      const tick = (t) => {
        frames.push(t - last)
        last = t
        if (t < end) requestAnimationFrame(tick)
        else done()
      }
      requestAnimationFrame(tick)
    })
    clearInterval(poll)
    return { frames, rendered, stats: window.__aoDebug.stats() }
  }, seconds)
}

/** Night City (plan §8 perf): one launch per preset straight into the mode. */
async function measureSpecial(preset) {
  const started = Date.now()
  const { win, port, token, close } = await launchApp({
    quality: preset,
    viewMode: 'special',
    env: plan.env,
    args: plan.args,
  })
  const loadMs = Date.now() - started
  try {
    const intro = win.locator('#special-intro [data-action="continue"]')
    if (await intro.isVisible().catch(() => false)) await intro.click()
    const res = await fetch(`http://127.0.0.1:${port}/api/mock?n=${plan.agents}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token()}` },
    })
    if (res.status !== 202) throw new Error(`POST /api/mock → ${res.status}`)
    await win.waitForTimeout(Number(args.settle) * 1000)
    await win.evaluate(() => window.__aoDebug.view('atrium'))
    await win.waitForTimeout(2000)
    const sample = await sampleFrames(win, plan.seconds)
    const summary = summarize(sample.frames, sample.rendered)
    const gpuMB = sample.stats.textureMB + sample.stats.geometryMB
    // Switch time: Night City → Classic 3D → Night City, until the special scene is ready again.
    await win.locator('#mode-toggle [data-mode="3d"]').click()
    await win.waitForFunction(() => typeof window.__aoDebug?.sceneBackground === 'function', null, {
      timeout: 60_000,
    })
    const t0 = Date.now()
    await win.locator('#mode-toggle [data-mode="special"]').click()
    await win.waitForFunction(() => window.__aoDebug?.special?.ready() === true, null, {
      timeout: 90_000,
    })
    const switchMs = Date.now() - t0
    return {
      preset,
      ...summary,
      drawCalls: sample.stats.drawCalls,
      triangles: sample.stats.triangles,
      gpuMB,
      loadMs,
      switchMs,
    }
  } finally {
    await close()
  }
}

if (special) {
  console.log(
    `perf (Night City): ${plan.presets.join(', ')} · ${plan.agents} agents · ${plan.seconds} s`,
  )
  const rows = []
  for (const preset of plan.presets)
    try {
      rows.push(await measureSpecial(preset))
    } catch (err) {
      console.error(
        `${preset.padEnd(8)}: failed: ${err instanceof Error ? err.message.split('\n')[0] : err}`,
      )
    }
  const f = (n, d = 0) => (typeof n === 'number' ? n.toFixed(d) : 'n/a')
  console.log('\npreset    avg fps  1% low  rendered  calls  tris(k)  GPU MB  load s  switch s')
  for (const r of rows)
    console.log(
      `${r.preset.padEnd(9)} ${f(r.rafFps, 1).padStart(7)} ${f(r.low1, 1).padStart(7)} ${f(r.renderedFps, 1).padStart(9)} ` +
        `${f(r.drawCalls).padStart(6)} ${f(r.triangles / 1000).padStart(8)} ${f(r.gpuMB).padStart(7)} ` +
        `${f(r.loadMs / 1000, 1).padStart(7)} ${f(r.switchMs / 1000, 1).padStart(9)}`,
    )
  process.exit(rows.length === plan.presets.length ? 0 : 1)
}

console.log(
  `perf: ${plan.presets.join(', ')} · ${plan.agents} agents · ${plan.seconds} s` +
    (plan.lowEnd ? ' · software GL (SwiftShader), DPR 1' : ''),
)
const rows = []
for (const preset of plan.presets) {
  try {
    rows.push(await measure(preset))
  } catch (err) {
    // Usually no WebGL (e.g. SwiftShader unavailable on this host): the scene never becomes ready.
    console.error(
      `${preset.padEnd(8)}: failed: ${err instanceof Error ? err.message.split('\n')[0] : err}`,
    )
    rows.push({
      preset,
      bar: verdict(preset, { rafFps: 0, low1: 0, frames: 0 }, plan.lowEnd).bar,
      pass: false,
    })
  }
}
console.log(`\n${formatTable(rows)}`)
if (rows.some((r) => r.pass === false)) process.exitCode = 1
