// HS-10 (plan §5.4): `SceneHost.initAsync` creates the first scene asynchronously (a lazy-loaded
// mode), and switches use the async factory when one is given; failures keep the old scene.
import { describe, expect, it, vi } from 'vitest'
import type { ViewMode } from '@agent-office/shared'
import type { SceneAssets, SceneView } from '../ports.ts'
import { SceneHost } from './scene-host.ts'

function fake(mode: ViewMode) {
  const assets: SceneAssets = { manifest: { hash: mode } as unknown as SceneAssets['manifest'] }
  const noop = () => {}
  return {
    mode,
    load: vi.fn(async () => assets),
    setBuilding: noop,
    direct: vi.fn(),
    setLinks: noop,
    setSurfaces: noop,
    onPickCapability: noop,
    focusCapability: noop,
    highlightLinks: noop,
    select: vi.fn(),
    setQuality: noop,
    onPick: vi.fn(),
    goTo: noop,
    cameraIdleMs: () => 0,
    setTheme: noop,
    setGraphics: noop,
    stats: () => ({ fps: 1 }) as ReturnType<SceneView['stats']>,
    onContextLost: noop,
    onContextRestored: noop,
    onHoverSurface: noop,
    onViews: noop,
    dispose: vi.fn(),
  } satisfies SceneView & { mode: ViewMode }
}

describe('SceneHost.initAsync (HS-10)', () => {
  it('awaits the async factory for the first scene, then forwards to it', async () => {
    const made: ReturnType<typeof fake>[] = []
    const factory = vi.fn((m: ViewMode) => fake(m))
    const factoryAsync = vi.fn(async (m: ViewMode) => {
      const s = fake(m)
      made.push(s)
      return s
    })
    const host = await SceneHost.initAsync({
      mode: 'minimal',
      factory,
      factoryAsync,
      resync: () => new Map(),
    })
    expect(host.mode).toBe('minimal')
    expect(factoryAsync).toHaveBeenCalledWith('minimal')
    expect(factory).not.toHaveBeenCalled()
    expect((host.active as ReturnType<typeof fake>).mode).toBe('minimal')
    await host.load('m.json')
    expect(made[0]!.load).toHaveBeenCalledWith('m.json')
  })

  it('without an async factory, wraps the sync one', async () => {
    const factory = vi.fn((m: ViewMode) => fake(m))
    const host = await SceneHost.initAsync({ mode: '3d', factory, resync: () => new Map() })
    expect(factory).toHaveBeenCalledTimes(1)
    expect(host.mode).toBe('3d')
  })

  it('rejects when the first scene cannot be created (the caller shows the failure card)', async () => {
    const boom = new Error('no WebGL')
    await expect(
      SceneHost.initAsync({
        mode: 'minimal',
        factory: () => {
          throw boom
        },
        factoryAsync: async () => {
          throw boom
        },
        resync: () => new Map(),
      }),
    ).rejects.toBe(boom)
  })

  it('switches through the async factory (a lazy chunk) and disposes the old scene', async () => {
    const factoryAsync = vi.fn(async (m: ViewMode) => fake(m))
    const host = await SceneHost.initAsync({
      mode: '3d',
      factory: (m) => fake(m),
      factoryAsync,
      resync: () => new Map(),
    })
    const old = host.active as ReturnType<typeof fake>
    await host.load('m.json')
    await host.switchTo('minimal')
    expect(factoryAsync).toHaveBeenLastCalledWith('minimal')
    expect(old.dispose).toHaveBeenCalled()
    expect(host.mode).toBe('minimal')
    expect((host.active as ReturnType<typeof fake>).load).toHaveBeenCalledWith('m.json')
  })

  it('a failing lazy switch keeps the old scene and rethrows', async () => {
    const host = await SceneHost.initAsync({
      mode: '3d',
      factory: (m) => fake(m),
      factoryAsync: async (m) => {
        if (m === 'minimal') throw new Error('chunk failed')
        return fake(m)
      },
      resync: () => new Map(),
    })
    const old = host.active
    await expect(host.switchTo('minimal')).rejects.toThrow('chunk failed')
    expect(host.active).toBe(old)
    expect(host.mode).toBe('3d')
  })
})
