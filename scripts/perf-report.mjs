// Pure parts of scripts/perf.mjs (plan §8): the run plan, frame statistics, pass bars and the table.
// Unit-tested in perf-report.test.ts; types in perf-report.d.mts.

export const PRESETS = ['auto', 'minimal', 'low', 'medium', 'high', 'ultra']
const DEFAULT_PRESETS = ['minimal', 'low', 'medium', 'high']
const LOW_END_PRESETS = ['minimal', 'low']

/** §8 pass bars: [avg fps, 1% low fps]; a missing preset is report only. */
const BARS = { minimal: [30, 25], low: [55, 45], medium: [55, 45] }
/** `--low-end` (SwiftShader, 60 agents): only Minimal has a bar, on the average. */
const LOW_END_BARS = { minimal: [20, undefined] }

function count(value, name) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} needs a positive number`)
  return n
}

/** Turns parsed CLI options into what to launch. */
export function perfPlan(o) {
  const lowEnd = o['low-end'] === true
  const presets = o.presets
    ? o.presets
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    : lowEnd
      ? LOW_END_PRESETS
      : DEFAULT_PRESETS
  for (const p of presets) if (!PRESETS.includes(p)) throw new Error(`unknown preset: ${p}`)
  return {
    presets: [...presets],
    agents: count(o.agents ?? (lowEnd ? 60 : 150), 'agents'),
    seconds: count(o.seconds ?? 10, 'seconds'),
    lowEnd,
    // CPU rendering through the main process's test seam (startup-flags.ts), at DPR 1.
    env: lowEnd ? { AGENT_OFFICE_FORCE_SOFTWARE_GL: '1' } : {},
    args: lowEnd ? ['--force-device-scale-factor=1'] : [],
  }
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length

/**
 * rAF intervals (ms; the first is a warm-up and dropped) and the scene's own rendered-fps samples
 * (0.5 s windows; zeros mean "not measured yet"). Frame pacing skips rAF callbacks on capped
 * presets, so the rendered rate is the truth there; rAF gives the 1% low (hitches).
 */
export function summarize(intervals, renderedSamples) {
  const ms = intervals.slice(1).sort((a, b) => a - b)
  const worst = ms.slice(Math.floor(ms.length * 0.99))
  const rendered = renderedSamples.filter((x) => x > 0)
  return {
    frames: ms.length,
    rafFps: 1000 / mean(ms),
    low1: 1000 / mean(worst.length ? worst : ms),
    ...(rendered.length
      ? { renderedFps: mean(rendered), renderedMin: Math.min(...rendered) }
      : { renderedFps: undefined }),
  }
}

/** The bar for this preset and whether the run meets it (`pass` undefined = report only). */
export function verdict(preset, r, lowEnd) {
  const bar = (lowEnd ? LOW_END_BARS : BARS)[preset]
  if (!bar) return { bar: 'report only', pass: undefined }
  const [avgBar, lowBar] = bar
  const avg = r.renderedFps === undefined ? r.rafFps : Math.min(r.rafFps, r.renderedFps)
  if (lowBar === undefined) return { bar: `≥ ${avgBar} avg`, pass: avg >= avgBar }
  return { bar: `≥ ${avgBar} / ${lowBar}`, pass: avg >= avgBar && r.low1 >= lowBar }
}

const NA = 'n/a'
const fixed = (x, d = 1) => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : NA)
const int = (x) => (typeof x === 'number' ? String(Math.round(x)) : NA)
const tris = (x) =>
  typeof x !== 'number' ? NA : x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : `${Math.round(x / 1e3)}k`
const mb = (x) => (typeof x === 'number' ? `${Math.round(x)} MB` : NA)
const secs = (x) => (typeof x === 'number' ? `${(x / 1000).toFixed(1)} s` : NA)

const COLUMNS = [
  ['preset', (r) => r.preset],
  ['avg fps', (r) => fixed(r.rafFps)],
  ['1% low', (r) => fixed(r.low1)],
  ['rendered', (r) => fixed(r.renderedFps)],
  ['draw calls', (r) => int(r.drawCalls)],
  ['triangles', (r) => tris(r.triangles)],
  ['textureMB', (r) => mb(r.textureMB)],
  ['first frame', (r) => secs(r.firstFrameMs)],
  ['JS heap', (r) => mb(r.heapMB)],
]

/** One aligned row per preset, ending in the bar and PASS/MISS. */
export function formatTable(rows) {
  const cells = rows.map((r) => COLUMNS.map(([, f]) => f(r)))
  const widths = COLUMNS.map(([h], i) => Math.max(h.length, ...cells.map((c) => c[i].length)))
  const line = (cols, last) => [...cols.map((c, i) => c.padEnd(widths[i])), last].join('  ')
  return [
    line(
      COLUMNS.map(([h]) => h),
      'bar',
    ),
    ...rows.map((r, i) =>
      line(cells[i], r.pass === undefined ? r.bar : `${r.bar} ${r.pass ? 'PASS' : 'MISS'}`),
    ),
  ].join('\n')
}
