// Horizon's scene: the Classic `ThreeScene` with the Horizon flavor (docs/horizon/rendering.md),
// plus the first-visit intro once the office has loaded. Same rooms, anchors, director, labels,
// Library, Adapters, kiosk, wall cutaway and walk mode as Classic 3D.
import type { Settings, SettingsPatch } from '@agent-office/shared'
import { HORIZON_ASSET_BASE } from '../../app/horizon/flavor.ts'
import { HORIZON_APPEARANCE } from '../../app/motion.ts'
import type { SimClock } from '../../app/sim-clock.ts'
import type { Effective } from '../../app/graphics-types.ts'
import type { SceneAssets } from '../../ports.ts'
import { ThreeScene, type SceneElements, type SceneFlavor } from '../../adapters/three/scene.ts'
import { showHorizonFailure } from '../failure.ts'
import { HORIZON_LIGHTMAP_SCALE, HorizonEnvironment } from './environment.ts'
import { HorizonIntro } from './intro.ts'

/** Emissive ceiling: neon only where it has a purpose, never glare (art direction). */
export const HORIZON_EMISSIVE_MAX = 1.5

/** A fresh flavor per scene: its environment owns GPU objects that the scene disposes. */
export function horizonFlavor(): SceneFlavor {
  return {
    id: 'horizon',
    assetBase: HORIZON_ASSET_BASE,
    environment: new HorizonEnvironment(),
    appearance: HORIZON_APPEARANCE,
    emissiveMax: HORIZON_EMISSIVE_MAX,
    lightmapScale: HORIZON_LIGHTMAP_SCALE,
  }
}

export interface HorizonSettings {
  get(): Promise<Settings>
  set(patch: SettingsPatch): Promise<unknown>
}

export class HorizonScene extends ThreeScene {
  private intro: HorizonIntro | null = null

  constructor(
    el: SceneElements,
    clock: SimClock,
    private settings: HorizonSettings,
    opts: { powerPreference?: Effective['powerPreference'] } = {},
  ) {
    super(el, clock, { ...opts, flavor: horizonFlavor() })
  }

  /** Loads the Horizon set; when it can't (assets missing…), the failure card offers the others. */
  override async load(manifestUrl: string): Promise<SceneAssets> {
    let assets: SceneAssets
    try {
      assets = await super.load(manifestUrl)
    } catch (err) {
      showHorizonFailure(err, (mode) => void this.settings.set({ viewMode: mode }).catch(() => {}))
      throw err
    }
    void this.showIntro()
    return assets
  }

  override dispose(): void {
    this.intro?.dispose()
    this.intro = null
    super.dispose()
  }

  /** The first visit explains the mode once (`special.introSeen`); Back returns to Classic. */
  private async showIntro(): Promise<void> {
    let s: Settings
    try {
      s = await this.settings.get()
    } catch {
      return
    }
    if (s.special.introSeen || this.intro) return
    const intro = new HorizonIntro(document.body)
    this.intro = intro
    intro.onContinue = () =>
      void this.settings.set({ special: { ...s.special, introSeen: true } }).catch(() => {})
    intro.onBack = () => void this.settings.set({ viewMode: '3d' }).catch(() => {})
    intro.open()
  }
}
