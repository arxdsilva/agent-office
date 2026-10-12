import type { UpdateState } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { fakePlatform, ManualScheduler, ScriptedUpdater } from '../../test/fakes/index.ts'
import { UpdateService } from './update-service.ts'

const RELEASES = 'https://github.com/arxdsilva/agent-office/releases/latest'
function setup(platform = fakePlatform(), next: ConstructorParameters<typeof ScriptedUpdater>[0] = null, enabled = true) {
  const updater = new ScriptedUpdater(next)
  const scheduler = new ManualScheduler()
  const svc = new UpdateService({ updater, platform, scheduler, enabled, releaseUrl: RELEASES })
  const states: UpdateState['status'][] = []
  svc.onChange((s) => states.push(s.status))
  return { updater, scheduler, svc, states }
}

describe('UpdateService', () => {
  it('auto policy: checks on start, downloads and becomes ready; install restarts', async () => {
    const { svc, updater, states, scheduler } = setup(fakePlatform(), { version: '2.0.0' })
    await svc.start()
    expect(states).toEqual(['checking', 'available', 'downloading', 'ready'])
    expect(svc.state()).toMatchObject({ policy: 'auto', status: 'ready', version: '2.0.0' })
    expect(updater.downloads).toBe(1)
    expect(scheduler.jobs[0]!.ms).toBe(6 * 60 * 60 * 1000)
    svc.install()
    expect(updater.restarted).toBe(true)
  })

  it('notify-only policy (unsigned macOS): reports availability with a link, never downloads', async () => {
    const { svc, updater } = setup(fakePlatform({ platform: 'darwin' }), { version: '2.0.0' })
    await svc.start()
    expect(svc.state()).toMatchObject({ policy: 'notify-only', status: 'available', url: RELEASES })
    expect(updater.downloads).toBe(0)
    svc.install()
    expect(updater.restarted).toBe(false)
  })

  it('up to date and error states', async () => {
    const fresh = setup(fakePlatform(), null)
    expect((await fresh.svc.check()).status).toBe('up-to-date')
    const broken = setup(fakePlatform(), new Error('offline'))
    expect(await broken.svc.check()).toMatchObject({ status: 'error', error: 'offline' })
  })

  it('off in development: no checks, no schedule', async () => {
    const { svc, updater, scheduler } = setup(fakePlatform({ packaged: false }), { version: '9' })
    await svc.start()
    expect(await svc.check()).toMatchObject({ policy: 'off', status: 'idle' })
    expect(updater.checks).toBe(0)
    expect(scheduler.jobs).toHaveLength(0)
  })

  it('can be re-enabled/disabled at runtime', async () => {
    const { svc } = setup(fakePlatform(), null, false)
    expect(svc.state().policy).toBe('off')
    svc.setEnabled(true)
    expect(svc.state().policy).toBe('auto')
    svc.stop()
  })
})
