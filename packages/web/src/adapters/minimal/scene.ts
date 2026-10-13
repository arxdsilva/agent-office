// MinimalScene: the DOM-only SceneView of Minimal mode (docs/minimal-mode.md). No canvas, no
// WebGL, no render loop: the DOM is patched once per animation frame after a roster change, and
// nothing is scheduled while idle.
import type { Agent } from '@agent-office/shared'
import { rememberFinished } from '../../app/finished.ts'
import { buildHierarchy } from '../../app/hierarchy.ts'
import type { FinishedStore, HierarchyOpts, RosterInput } from '../../app/hierarchy-types.ts'
import { parseManifest } from '../../app/manifest.ts'
import type { GraphicsStats } from '../../app/graphics-types.ts'
import type { SceneAssets, SceneView } from '../../ports.ts'
import { MinimalView } from './view.ts'

const ZERO_STATS: GraphicsStats = {
  fps: 0,
  drawCalls: 0,
  triangles: 0,
  textureMB: 0,
  geometryMB: 0,
  width: 0,
  height: 0,
}

/**
 * Recently finished is view state that outlives the scene: switching to 3D and back recreates the
 * scene, but agents the core already dropped must stay listed (docs/minimal-mode.md).
 */
const memory: { finished: FinishedStore; prev: Agent[] } = { finished: new Map(), prev: [] }

export class MinimalScene implements SceneView {
  private view: MinimalView
  private roster: RosterInput | null = null
  private opts: HierarchyOpts = { activeOnly: false, showFinished: true }
  private frame = 0
  private pickFn: (id: string | null) => void = () => {}
  private selected: string | null = null

  constructor(
    mount: HTMLElement,
    private loading?: HTMLElement,
  ) {
    this.view = new MinimalView(mount, {
      onOpts: (o) => {
        this.opts = o
        this.schedule()
      },
      onPick: (id) => this.pickFn(id),
    })
  }

  async load(manifestUrl: string): Promise<SceneAssets> {
    const res = await fetch(manifestUrl)
    if (!res.ok) throw new Error(`manifest: HTTP ${res.status}`)
    const manifest = parseManifest(await res.json())
    // Nothing to load: the loading screen has no work left.
    if (this.loading) this.loading.hidden = true
    return { manifest }
  }

  setRoster(roster: RosterInput): void {
    memory.finished = rememberFinished(memory.finished, memory.prev, roster.agents, roster.now)
    memory.prev = roster.agents
    this.roster = roster
    this.schedule()
  }

  private schedule(): void {
    if (this.frame || !this.roster) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      if (!this.roster) return
      this.view.update(buildHierarchy(this.roster, memory.finished, this.opts))
      this.view.select(this.selected)
    })
  }

  select(id: string | null): void {
    this.selected = id
    this.view.select(id)
  }

  onPick(fn: (id: string | null) => void): void {
    this.pickFn = fn
  }

  cameraIdleMs(): number {
    return Infinity
  }

  stats(): GraphicsStats {
    return { ...ZERO_STATS }
  }

  dispose(): void {
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = 0
    this.view.dispose()
  }

  // ── No-ops: nothing spatial to draw ──
  setBuilding(): void {}
  direct(): void {}
  setLinks(): void {}
  setSurfaces(): void {}
  onPickCapability(): void {}
  focusCapability(): void {}
  highlightLinks(): void {}
  setQuality(): void {}
  goTo(): void {}
  setTheme(): void {}
  setGraphics(): void {}
  onContextLost(): void {}
  onContextRestored(): void {}
  onHoverSurface(): void {}
  onViews(): void {}
}

/** Mounts the Minimal view into the stage container. */
export function createMinimalScene(stage: HTMLElement, loading?: HTMLElement): SceneView {
  return new MinimalScene(stage, loading)
}
