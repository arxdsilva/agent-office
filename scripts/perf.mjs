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
  --mode <3d|pixel>  view mode (default 3d; pixel = the 2D RPG mode, sampled at the claude-code wing)
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
    help: { type: 'boolean', short: 'h', default: false },
  },
})
if (args.help) {
  console.log(HELP)
  process.exit(0)
}
const plan = perfPlan(args)

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
