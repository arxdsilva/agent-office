// HS-1..5 (plan §12): the scene host forwards to the active scene, re-attaches listeners, replays
// the cached state into a new scene, disposes the old one and hands it the resynced plans.
import { describe, expect, it, vi } from 'vitest'
import type { ViewMode } from '@agent-office/shared'
import type { Effective } from '../app/graphics-types.ts'
import type { ViewEntry } from '../app/library-types.ts'
import type { AgentPlan, BuildingLayout, Link } from '../app/office-types.ts'
import type { ProjectLibraryVM } from '../app/project-library.ts'
import type { InteractTarget } from '../app/pixel/types.ts'
import type { CapabilityRef, SceneAssets, SceneSurfaces, SceneView } from '../ports.ts'
import { SceneHost } from './scene-host.ts'

type Calls = { name: string; args: unknown[] }[]

/** A SceneView that records every call and lets the test fire its listeners. */
function fakeScene(mode: ViewMode) {
  const calls: Calls = []
  const fns: Record<string, ((...a: never[]) => void) | undefined> = {}
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args })
    }
  const on =
    (name: string) =>
    (fn: (...a: never[]) => void): void => {
      calls.push({ name, args: [] })
      fns[name] = fn
    }
  const assets: SceneAssets = { manifest: { hash: mode } as unknown as SceneAssets['manifest'] }
  const scene: SceneView & { hardwareInfo?: () => null; onFrameStats?: (fn: never) => void } = {
    load: vi.fn(async (url: string) => {
      calls.push({ name: 'load', args: [url] })
      return assets
    }),
    setBuilding: rec('setBuilding'),
    direct: rec('direct'),
    setLinks: rec('setLinks'),
    setSurfaces: rec('setSurfaces'),
    onPickCapability: on('onPickCapability'),
    focusCapability: rec('focusCapability'),
    highlightLinks: rec('highlightLinks'),
    select: rec('select'),
    setQuality: rec('setQuality'),
    onPick: on('onPick'),
    goTo: rec('goTo'),
    cameraIdleMs: () => (mode === '3d' ? 111 : 222),
    setTheme: rec('setTheme'),
    setGraphics: rec('setGraphics'),
    stats: () => ({ fps: mode === '3d' ? 60 : 30 }) as ReturnType<SceneView['stats']>,
    onContextLost: on('onContextLost'),
    onContextRestored: on('onContextRestored'),
    onHoverSurface: on('onHoverSurface'),
    onViews: on('onViews'),
    dispose: rec('dispose'),
    setInputSuspended: rec('setInputSuspended'),
    follow: rec('follow'),
    travelTo: rec('travelTo'),
    focusAgents: rec('focusAgents'),
    setProjectLibrary: rec('setProjectLibrary'),
    onPickFixture: on('onPickFixture'),
    ...(mode === 'pixel'
      ? { onInteract: on('onInteract'), onRoom: on('onRoom') }
      : { hardwareInfo: () => null, onFrameStats: on('onFrameStats') }),
  }
  const fire = (name: string, ...args: unknown[]) =>
    (fns[name] as ((...a: unknown[]) => void) | undefined)?.(...args)
  const names = () => calls.map((c) => c.name)
  return { scene, calls, fire, names }
}

const layout = { key: 'L1' } as unknown as BuildingLayout
const gfx = { preset: 'low' } as unknown as Effective
const surfaces: SceneSurfaces = { byProvider: new Map(), bubbles: new Map() }
const links: Link[] = [{ id: 'a>web' } as Link]
const plan = (id: string, steps?: AgentPlan['steps']): AgentPlan =>
  ({ agent: { id, status: 'idle' }, intent: { target: 'x' }, steps }) as unknown as AgentPlan

function setup(resync = () => new Map<string, AgentPlan>()) {
  const made: ReturnType<typeof fakeScene>[] = []
  const factory = vi.fn((mode: ViewMode) => {
    const f = fakeScene(mode)
    made.push(f)
    return f.scene
  })
  const host = new SceneHost({ factory, resync, mode: '3d' })
  return { host, made, factory }
}

describe('SceneHost', () => {
  it('HS-1 forwards every call to the active scene', async () => {
    const { host, made } = setup()
    const s = made[0]!
    await host.load('assets/manifest.json')
    host.setBuilding(layout)
    host.direct(new Map([['a', plan('a')]]), [])
    host.setLinks(links)
    host.setSurfaces(surfaces)
    host.focusCapability({ provider: 'p', id: 'web' })
    host.highlightLinks('web')
    host.select('a')
    host.setQuality('high')
    host.goTo('atrium')
    host.setTheme('light')
    host.setGraphics(gfx)
    host.setInputSuspended(true)
    host.follow('a')
    host.travelTo({ agentId: 'a' })
    expect(s.names()).toEqual(
      expect.arrayContaining([
        'load',
        'setBuilding',
        'direct',
        'setLinks',
        'setSurfaces',
        'focusCapability',
        'highlightLinks',
        'select',
        'setQuality',
        'goTo',
        'setTheme',
        'setGraphics',
        'setInputSuspended',
        'follow',
        'travelTo',
      ]),
    )
    expect(host.cameraIdleMs()).toBe(111)
    expect(host.stats().fps).toBe(60)
    expect(host.mode).toBe('3d')
    expect(host.hardwareInfo()).toBeNull()
  })

  it('HS-2 re-attaches every listener to the new scene after a switch', async () => {
    const { host, made } = setup()
    const picks: (string | null)[] = []
    const caps: CapabilityRef[] = []
    const views: ViewEntry[][] = []
    const interacts: InteractTarget[] = []
    const rooms: string[] = []
    const lost = vi.fn()
    const restored = vi.fn()
    const hover = vi.fn()
    host.onPick((id) => picks.push(id))
    host.onPickCapability((r) => caps.push(r))
    host.onViews((v) => views.push(v))
    host.onContextLost(lost)
    host.onContextRestored(restored)
    host.onHoverSurface(hover)
    host.onInteract((t) => interacts.push(t))
    host.onRoom((r) => rooms.push(r))
    await host.load('m.json')
    made[0]!.fire('onPick', 'a')
    await host.switchTo('pixel')
    const p = made[1]!
    p.fire('onPick', 'b')
    p.fire('onPickCapability', { provider: 'p', id: 'web' })
    p.fire('onViews', [{ id: 'atrium', label: 'Atrium' }])
    p.fire('onContextLost')
    p.fire('onContextRestored')
    p.fire('onHoverSurface', null, 1, 2)
    p.fire('onInteract', { kind: 'agent', id: 'b' })
    p.fire('onRoom', 'Lobby')
    expect(picks).toEqual(['a', 'b'])
    expect(caps).toEqual([{ provider: 'p', id: 'web' }])
    expect(views).toEqual([[{ id: 'atrium', label: 'Atrium' }]])
    expect(lost).toHaveBeenCalledOnce()
    expect(restored).toHaveBeenCalledOnce()
    expect(hover).toHaveBeenCalledWith(null, 1, 2)
    expect(interacts).toEqual([{ kind: 'agent', id: 'b' }])
    expect(rooms).toEqual(['Lobby'])
  })

  it('HS-2b a listener registered after the switch still reaches the active scene', async () => {
    const { host, made } = setup()
    await host.load('m.json')
    await host.switchTo('pixel')
    const fn = vi.fn()
    host.onPick(fn)
    made[1]!.fire('onPick', 'z')
    expect(fn).toHaveBeenCalledWith('z')
  })

  it('HS-3 replays building, theme, graphics, links, surfaces, highlight and selection', async () => {
    const { host, made } = setup()
    await host.load('m.json')
    host.setBuilding(layout)
    host.setTheme('light')
    host.setGraphics(gfx)
    host.setLinks(links)
    host.setSurfaces(surfaces)
    host.highlightLinks('web')
    host.direct(new Map([['a', plan('a')]]), [])
    host.select('a')
    host.setInputSuspended(true)
    await host.switchTo('pixel')
    const p = made[1]!
    expect(p.calls.find((c) => c.name === 'load')?.args).toEqual(['m.json'])
    const after = (name: string) => p.calls.find((c) => c.name === name)?.args
    expect(after('setBuilding')).toEqual([layout])
    expect(after('setTheme')).toEqual(['light'])
    expect(after('setGraphics')).toEqual([gfx])
    expect(after('setLinks')).toEqual([links])
    expect(after('setSurfaces')).toEqual([surfaces])
    expect(after('highlightLinks')).toEqual(['web'])
    expect(after('select')).toEqual(['a'])
    expect(after('setInputSuspended')).toEqual([true])
    // Building before everything that draws on it; load before any replay.
    const n = p.names()
    expect(n.indexOf('load')).toBeLessThan(n.indexOf('setBuilding'))
    expect(n.indexOf('setBuilding')).toBeLessThan(n.indexOf('direct'))
  })

  it('HS-3b a quality preset is replayed when no effective graphics were set', async () => {
    const { host, made } = setup()
    await host.load('m.json')
    host.setQuality('medium')
    await host.switchTo('pixel')
    expect(made[1]!.calls.find((c) => c.name === 'setQuality')?.args).toEqual(['medium'])
  })

  it('HS-4 creates and loads the new scene, then disposes the old one; same mode is a no-op', async () => {
    const { host, made, factory } = setup()
    await host.load('m.json')
    await host.switchTo('3d')
    expect(factory).toHaveBeenCalledTimes(1)
    const order: string[] = []
    made[0]!.scene.dispose = () => order.push('dispose')
    factory.mockImplementationOnce((mode: ViewMode) => {
      order.push('create')
      const f = fakeScene(mode)
      made.push(f)
      return f.scene
    })
    await host.switchTo('pixel')
    expect(order).toEqual(['create', 'dispose'])
    expect(host.mode).toBe('pixel')
    // Calls after the switch reach only the new scene.
    host.goTo('atrium')
    expect(made[0]!.names()).not.toContain('goTo')
    expect(made[1]!.names()).toContain('goTo')
    expect(host.cameraIdleMs()).toBe(222)
  })

  it('HS-4b a failing factory or load keeps the old scene and rethrows', async () => {
    const { host, made, factory } = setup()
    await host.load('m.json')
    factory.mockImplementationOnce(() => {
      throw new Error('no WebGL')
    })
    await expect(host.switchTo('pixel')).rejects.toThrow('no WebGL')
    expect(host.mode).toBe('3d')
    expect(made[0]!.names()).not.toContain('dispose')
    factory.mockImplementationOnce((mode: ViewMode) => {
      const f = fakeScene(mode)
      f.scene.load = async () => {
        throw new Error('load failed')
      }
      made.push(f)
      return f.scene
    })
    await expect(host.switchTo('pixel')).rejects.toThrow('load failed')
    expect(host.mode).toBe('3d')
    expect(made[1]!.names()).toContain('dispose')
    expect(made[0]!.names()).not.toContain('dispose')
    host.goTo('atrium')
    expect(made[0]!.names()).toContain('goTo')
    // The host still switches afterwards.
    await host.switchTo('pixel')
    expect(host.mode).toBe('pixel')
  })

  it('HS-5 hands the new scene the resynced plans (remaining steps from now)', async () => {
    const resynced = new Map([['a', plan('a', [{ kind: 'face', heading: 1, duration: 0.2 }])]])
    const resync = vi.fn(() => resynced)
    const { host, made } = setup(resync)
    await host.load('m.json')
    host.direct(new Map([['a', plan('a')]]), [])
    await host.switchTo('pixel')
    const d = made[1]!.calls.find((c) => c.name === 'direct')
    expect(resync).toHaveBeenCalledOnce()
    expect(d?.args).toEqual([resynced, []])
  })

  it('HS-5b without resync data, the cached plans are replayed (steps stripped, departed dropped)', async () => {
    const { host, made } = setup()
    await host.load('m.json')
    host.direct(
      new Map([
        ['a', plan('a', [{ kind: 'face', heading: 1, duration: 0.2 }])],
        ['b', plan('b')],
      ]),
      [],
    )
    host.direct(new Map([['a', plan('a')]]), ['b'])
    await host.switchTo('pixel')
    const d = made[1]!.calls.find((c) => c.name === 'direct')
    const plans = d?.args[0] as Map<string, AgentPlan>
    expect([...plans.keys()]).toEqual(['a'])
    expect(plans.get('a')?.steps).toBeUndefined()
  })

  it('serializes overlapping switches and ends on the last requested mode', async () => {
    const { host, made } = setup()
    await host.load('m.json')
    const a = host.switchTo('pixel')
    const b = host.switchTo('3d')
    await Promise.all([a, b])
    expect(host.mode).toBe('3d')
    expect(made.map((m) => m.scene === made[0]!.scene)).toEqual([true, false, false])
    expect(made[1]!.names()).toContain('dispose')
  })

  it('a switch before the first load creates the scene without loading it', async () => {
    const { host, made } = setup()
    await host.switchTo('pixel')
    expect(made[1]!.names()).not.toContain('load')
    await host.load('m.json')
    expect(made[1]!.names()).toContain('load')
  })

  it('forwards adapter-level frame stats to the scene that supports them', async () => {
    const { host, made } = setup()
    const fn = vi.fn()
    host.onFrameStats(fn)
    made[0]!.fire('onFrameStats', 50, 'high')
    expect(fn).toHaveBeenCalledWith(50, 'high')
    await host.switchTo('pixel')
    expect(host.hardwareInfo()).toBeNull()
  })

  it('dispose releases the active scene', () => {
    const { host, made } = setup()
    host.dispose()
    expect(made[0]!.names()).toContain('dispose')
  })
})

describe('SceneHost: 2D camera, minimap base and travel (HS-6)', () => {
  it('HS-6 forwards onCamera/onMinimapBase across a switch and panTo/travelTo({pos}) to the active scene', async () => {
    const made: ReturnType<typeof fakeScene>[] = []
    const factory = vi.fn((mode: ViewMode) => {
      const f = fakeScene(mode)
      const on =
        (name: string) =>
        (fn: (...a: never[]) => void): void => {
          f.calls.push({ name, args: [] })
          ;(f as unknown as { fns?: Record<string, unknown> }).fns ??= {}
          ;(f as unknown as { fns: Record<string, unknown> }).fns[name] = fn
        }
      Object.assign(f.scene, {
        onCamera: on('onCamera'),
        onMinimapBase: on('onMinimapBase'),
        panTo: (pos: unknown) => void f.calls.push({ name: 'panTo', args: [pos] }),
      })
      made.push(f)
      return f.scene
    })
    const host = new SceneHost({ factory, resync: () => new Map(), mode: '3d' })
    const views: unknown[] = []
    const bases: unknown[][] = []
    host.onCamera((v) => views.push(v))
    host.onMinimapBase((img, w, h) => bases.push([img, w, h]))
    await host.load('m.json')
    await host.switchTo('pixel')
    const p = made[1]!
    const fns = (p as unknown as { fns: Record<string, (...a: unknown[]) => void> }).fns
    // The listeners reached the new 2D scene.
    fns.onCamera!({ tx: 1, ty: 2, tw: 3, th: 4 })
    fns.onMinimapBase!('img', 10, 20)
    expect(views).toEqual([{ tx: 1, ty: 2, tw: 3, th: 4 }])
    expect(bases).toEqual([['img', 10, 20]])
    // Pan and travel to a point reach the active scene.
    host.panTo({ x: 1, z: 2 })
    host.travelTo({ pos: { x: 3, z: 4 } })
    expect(p.calls.find((c) => c.name === 'panTo')?.args).toEqual([{ x: 1, z: 2 }])
    expect(p.calls.find((c) => c.name === 'travelTo')?.args).toEqual([{ pos: { x: 3, z: 4 } }])
  })
})

describe('SceneHost: 2D zoom and run (HS-7)', () => {
  it('HS-7 forwards onZoom/onRun across a switch and zoomBy to the active scene', async () => {
    const made: ReturnType<typeof fakeScene>[] = []
    const factory = vi.fn((mode: ViewMode) => {
      const f = fakeScene(mode)
      const fns: Record<string, (...a: unknown[]) => void> = {}
      Object.assign(f.scene, {
        onZoom: (fn: (...a: unknown[]) => void) => void (fns.onZoom = fn),
        onRun: (fn: (...a: unknown[]) => void) => void (fns.onRun = fn),
        zoomBy: (d: number) => void f.calls.push({ name: 'zoomBy', args: [d] }),
        fns,
      })
      made.push(f)
      return f.scene
    })
    const host = new SceneHost({ factory, resync: () => new Map(), mode: '3d' })
    const zooms: unknown[] = []
    const runs: boolean[] = []
    host.onZoom((z) => zooms.push(z))
    host.onRun((on) => runs.push(on))
    await host.load('m.json')
    await host.switchTo('pixel')
    const fns = (made[1]!.scene as unknown as { fns: Record<string, (...a: unknown[]) => void> })
      .fns
    // The listeners registered before the switch reach the new 2D scene.
    fns.onZoom!({ level: 2, levels: 4, atDefault: true })
    fns.onRun!(true)
    expect(zooms).toEqual([{ level: 2, levels: 4, atDefault: true }])
    expect(runs).toEqual([true])
    host.zoomBy(-1)
    expect(made[1]!.calls.find((c) => c.name === 'zoomBy')?.args).toEqual([-1])
  })

  // HS-9: project focus, library and fixture picks forward, replay after a switch and re-attach.
  it('HS-9 forwards project focus and library, replays them, and re-attaches onPickFixture', async () => {
    const { host, made } = setup()
    const fixtures: unknown[] = []
    host.onPickFixture((f) => fixtures.push(f))
    await host.load('m.json')
    const lib = { projectId: 'prj_a' } as unknown as ProjectLibraryVM
    host.focusAgents(['a', 'b'], { dim: true, frame: true })
    host.setProjectLibrary(lib)
    expect(made[0]!.calls.find((c) => c.name === 'focusAgents')?.args).toEqual([
      ['a', 'b'],
      { dim: true, frame: true },
    ])
    expect(made[0]!.calls.find((c) => c.name === 'setProjectLibrary')?.args).toEqual([lib])
    await host.switchTo('pixel')
    const p = made[1]!
    expect(p.calls.find((c) => c.name === 'focusAgents')?.args).toEqual([
      ['a', 'b'],
      { dim: true, frame: true },
    ])
    expect(p.calls.find((c) => c.name === 'setProjectLibrary')?.args).toEqual([lib])
    p.fire('onPickFixture', { kind: 'project-directory' })
    expect(fixtures).toEqual([{ kind: 'project-directory' }])
    // Cleared state is not replayed.
    host.focusAgents(null, { dim: true, frame: false })
    host.setProjectLibrary(null)
    await host.switchTo('3d')
    const again = made[2]!.calls.filter((c) => c.name === 'focusAgents')
    expect(again).toEqual([])
  })
})
