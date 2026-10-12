import { describe, expect, it } from 'vitest'
import { formatTable, perfPlan, summarize, verdict } from './perf-report.mjs'

describe('perfPlan', () => {
  it('defaults to the minimal/low/medium/high matrix with 150 agents on the GPU', () => {
    expect(perfPlan({})).toEqual({
      presets: ['minimal', 'low', 'medium', 'high'],
      agents: 150,
      seconds: 10,
      lowEnd: false,
      env: {},
      args: [],
    })
  })

  it('--low-end: SwiftShader through the env seam, DPR 1, 60 agents, Minimal and Low only', () => {
    expect(perfPlan({ 'low-end': true })).toEqual({
      presets: ['minimal', 'low'],
      agents: 60,
      seconds: 10,
      lowEnd: true,
      env: { AGENT_OFFICE_FORCE_SOFTWARE_GL: '1' },
      args: ['--force-device-scale-factor=1'],
    })
  })

  it('explicit options win; unknown presets are refused', () => {
    expect(perfPlan({ presets: 'low, ultra', agents: '20', seconds: '2' })).toMatchObject({
      presets: ['low', 'ultra'],
      agents: 20,
      seconds: 2,
    })
    expect(() => perfPlan({ presets: 'low,fancy' })).toThrow(/unknown preset: fancy/)
    expect(() => perfPlan({ agents: 'many' })).toThrow(/--agents/)
  })
})

describe('summarize', () => {
  it('averages rAF intervals, takes the 1% low from the slowest frames, and averages rendered fps', () => {
    // 99 frames at 10 ms and one at 50 ms (the first interval is dropped as a warm-up).
    const frames = [999, ...Array(99).fill(10), 50]
    const s = summarize(frames, [30, 30, 28])
    expect(s.frames).toBe(100)
    expect(s.rafFps).toBeCloseTo(1000 / 10.4, 1)
    expect(s.low1).toBeCloseTo(20, 5)
    expect(s.renderedFps).toBeCloseTo(29.33, 1)
    expect(s.renderedMin).toBe(28)
  })

  it('rendered fps is undefined when the scene reported none', () => {
    expect(summarize([0, 16, 16], [0, 0]).renderedFps).toBeUndefined()
    expect(summarize([0, 16, 16], []).renderedFps).toBeUndefined()
  })
})

describe('verdict', () => {
  const r = (avg: number, low1: number, renderedFps?: number) => ({
    rafFps: avg,
    low1,
    frames: 100,
    ...(renderedFps === undefined ? {} : { renderedFps, renderedMin: renderedFps }),
  })

  it('applies §8 bars: Minimal ≥ 30/25, Low and Medium ≥ 55/45, High report only', () => {
    expect(verdict('minimal', r(60, 40, 30), false)).toEqual({ bar: '≥ 30 / 25', pass: true })
    expect(verdict('low', r(56, 44), false)).toEqual({ bar: '≥ 55 / 45', pass: false })
    expect(verdict('medium', r(58, 50), false)).toEqual({ bar: '≥ 55 / 45', pass: true })
    expect(verdict('high', r(10, 5), false)).toEqual({ bar: 'report only', pass: undefined })
  })

  it('a capped preset is judged on rendered frames, not rAF callbacks', () => {
    // rAF runs at 60 but the scene only renders 18 of them per second.
    expect(verdict('minimal', r(60, 50, 18), false).pass).toBe(false)
  })

  it('--low-end: Minimal ≥ 20 avg; Low is report only', () => {
    expect(verdict('minimal', r(60, 5, 21), true)).toEqual({ bar: '≥ 20 avg', pass: true })
    expect(verdict('minimal', r(60, 5, 19), true).pass).toBe(false)
    expect(verdict('low', r(9, 5), true)).toEqual({ bar: 'report only', pass: undefined })
  })
})

describe('formatTable', () => {
  it('prints one aligned row per preset; missing numbers read n/a', () => {
    const out = formatTable([
      {
        preset: 'minimal',
        rafFps: 59.94,
        low1: 41.2,
        renderedFps: 30,
        drawCalls: 120,
        triangles: 210_000,
        textureMB: undefined,
        firstFrameMs: 4210,
        heapMB: 85.4,
        bar: '≥ 30 / 25',
        pass: true,
      },
      {
        preset: 'high',
        rafFps: 50,
        low1: 30,
        drawCalls: 300,
        triangles: 1_200_000,
        textureMB: 512.3,
        firstFrameMs: 6000,
        bar: 'report only',
        pass: undefined,
      },
    ])
    const lines = out.split('\n')
    expect(lines[0]).toMatch(
      /^preset\s+avg fps\s+1% low\s+rendered\s+draw calls\s+triangles\s+textureMB\s+first frame\s+JS heap\s+bar/,
    )
    expect(lines[1]).toMatch(
      /^minimal\s+59\.9\s+41\.2\s+30\.0\s+120\s+210k\s+n\/a\s+4\.2 s\s+85 MB\s+≥ 30 \/ 25 PASS$/,
    )
    expect(lines[2]).toMatch(
      /^high\s+50\.0\s+30\.0\s+n\/a\s+300\s+1\.20M\s+512 MB\s+6\.0 s\s+n\/a\s+report only$/,
    )
    // Columns line up: every row is as long as the header up to the bar column.
    expect(lines[1]!.indexOf('59.9')).toBe(lines[0]!.indexOf('avg fps'))
  })

  it('a miss reads MISS', () => {
    expect(
      formatTable([{ preset: 'low', rafFps: 1, low1: 1, bar: '≥ 55 / 45', pass: false }]),
    ).toMatch(/MISS$/)
  })
})
