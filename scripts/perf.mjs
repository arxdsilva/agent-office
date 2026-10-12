#!/usr/bin/env node
// Frame-rate check (plan §6): 150 mock agents at the Medium preset, 10 s of frames sampled in the
// renderer, then average FPS, 1% low, draw calls and triangles. Run `make build` first.
//   node scripts/perf.mjs [--agents 150] [--quality medium] [--seconds 10]
import { parseArgs } from 'node:util'
import { launchApp } from './screenshots.mjs'

const { values: args } = parseArgs({
  options: {
    agents: { type: 'string', default: '150' },
    quality: { type: 'string', default: 'medium' },
    seconds: { type: 'string', default: '10' },
    view: { type: 'string', default: 'overview' },
  },
})
const PORT = 4320

const { win, token, close } = await launchApp({ quality: args.quality, port: PORT })
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/mock?n=${Number(args.agents)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token()}` },
  })
  if (r.status !== 202) throw new Error(`POST /api/mock → ${r.status}`)
  // Let everyone arrive, wings stream in and the governor-free preset settle.
  await win.waitForTimeout(8000)
  await win.evaluate((v) => window.__aoDebug.view(v), args.view)
  await win.waitForTimeout(2000)

  const sample = await win.evaluate(async (seconds) => {
    const frames = []
    let last = performance.now()
    const end = last + seconds * 1000
    await new Promise((done) => {
      const tick = (t) => {
        frames.push(t - last)
        last = t
        if (t < end) requestAnimationFrame(tick)
        else done()
      }
      requestAnimationFrame(tick)
    })
    return { frames, stats: window.__aoDebug.stats() }
  }, Number(args.seconds))

  const ms = sample.frames.slice(1).sort((a, b) => a - b)
  const avg = 1000 / (ms.reduce((s, x) => s + x, 0) / ms.length)
  const worst = ms.slice(Math.floor(ms.length * 0.99))
  const low1 = 1000 / (worst.reduce((s, x) => s + x, 0) / Math.max(1, worst.length))
  const s = sample.stats
  console.log(`agents in scene : ${s.total} (${s.animated} animated, ${s.impostors} impostors)`)
  console.log(`preset          : ${s.preset}`)
  console.log(`frames sampled  : ${ms.length} over ${args.seconds} s (view: ${args.view})`)
  console.log(`average fps     : ${avg.toFixed(1)}`)
  console.log(`1% low fps      : ${low1.toFixed(1)}`)
  console.log(`draw calls      : ${s.drawCalls}`)
  console.log(`triangles       : ${s.triangles}`)
  console.log(
    `target          : avg ≥ 55, 1% low ≥ 45 → ${avg >= 55 && low1 >= 45 ? 'PASS' : 'MISS'}`,
  )
} finally {
  await close()
}
