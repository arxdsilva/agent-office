export declare const PRESETS: readonly string[]

export interface PerfPlan {
  presets: string[]
  agents: number
  seconds: number
  lowEnd: boolean
  env: Record<string, string>
  args: string[]
}

export interface FrameSummary {
  frames: number
  rafFps: number
  low1: number
  renderedFps?: number | undefined
  renderedMin?: number
}

export interface PerfRow extends Partial<FrameSummary> {
  preset: string
  drawCalls?: number
  triangles?: number
  textureMB?: number | undefined
  firstFrameMs?: number
  heapMB?: number
  bar: string
  pass: boolean | undefined
}

export declare function perfPlan(o: {
  presets?: string
  agents?: string
  seconds?: string
  'low-end'?: boolean
}): PerfPlan
export declare function summarize(intervals: number[], renderedSamples: number[]): FrameSummary
export declare function verdict(
  preset: string,
  r: FrameSummary,
  lowEnd: boolean,
): { bar: string; pass: boolean | undefined }
export declare function formatTable(rows: PerfRow[]): string
