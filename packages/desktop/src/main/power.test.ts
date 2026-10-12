import { IPC, type PowerState } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { createPowerBridge, type PowerMonitorLike } from './power.ts'

/** A stand-in for Electron's powerMonitor: flip the source and emit the matching event. */
class FakePowerMonitor implements PowerMonitorLike {
  onBattery = false
  private listeners = new Map<string, Set<() => void>>()
  isOnBatteryPower() {
    return this.onBattery
  }
  on(event: 'on-battery' | 'on-ac', fn: () => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(fn)
    return this
  }
  removeListener(event: 'on-battery' | 'on-ac', fn: () => void) {
    this.listeners.get(event)?.delete(fn)
    return this
  }
  emit(event: 'on-battery' | 'on-ac') {
    this.onBattery = event === 'on-battery'
    for (const fn of this.listeners.get(event) ?? []) fn()
  }
  count() {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0)
  }
}

function setup() {
  const monitor = new FakePowerMonitor()
  const sent: [string, PowerState][] = []
  const bridge = createPowerBridge(monitor, (channel, payload) => sent.push([channel, payload]))
  return { monitor, sent, bridge }
}

describe('createPowerBridge', () => {
  it('PW-1 pushes app:power when the laptop goes on battery and back on AC', () => {
    const { monitor, sent } = setup()
    monitor.emit('on-battery')
    monitor.emit('on-ac')
    expect(sent).toEqual([
      [IPC.appPower, { onBattery: true }],
      [IPC.appPower, { onBattery: false }],
    ])
  })

  it('PW-2 state() reports the current power source (the app:power-get answer)', () => {
    const { monitor, bridge } = setup()
    expect(bridge.state()).toEqual({ onBattery: false })
    monitor.onBattery = true
    expect(bridge.state()).toEqual({ onBattery: true })
  })

  it('stop() removes its listeners: no pushes afterwards', () => {
    const { monitor, sent, bridge } = setup()
    bridge.stop()
    monitor.emit('on-battery')
    expect(sent).toEqual([])
    expect(monitor.count()).toBe(0)
  })

  it('a monitor that throws reads as on AC (never breaks the renderer)', () => {
    const monitor = new FakePowerMonitor()
    monitor.isOnBatteryPower = () => {
      throw new Error('unsupported')
    }
    expect(createPowerBridge(monitor, () => {}).state()).toEqual({ onBattery: false })
  })
})
