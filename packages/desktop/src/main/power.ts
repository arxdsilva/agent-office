// Power source for the renderer's battery preset (plan §2.3, §5.7). Pure: Electron's powerMonitor is
// injected, so this is unit-tested with a fake and wired in composition.ts.
import { IPC, type PowerState } from '@agent-office/shared'

type PowerEvent = 'on-battery' | 'on-ac'

/** The slice of Electron's `powerMonitor` this needs (overloads so the real one is assignable). */
export interface PowerMonitorLike {
  isOnBatteryPower(): boolean
  on(event: 'on-battery', fn: () => void): unknown
  on(event: 'on-ac', fn: () => void): unknown
  removeListener(event: 'on-battery', fn: () => void): unknown
  removeListener(event: 'on-ac', fn: () => void): unknown
}

export interface PowerBridge {
  /** The current state (answers `app:power-get`). */
  state(): PowerState
  stop(): void
}

/** Pushes `app:power` to the renderer whenever the power source changes. */
export function createPowerBridge(
  monitor: PowerMonitorLike,
  send: (channel: string, payload: PowerState) => void,
): PowerBridge {
  const state = (): PowerState => {
    try {
      return { onBattery: monitor.isOnBatteryPower() === true }
    } catch {
      return { onBattery: false }
    }
  }
  const handlers: Record<PowerEvent, () => void> = {
    'on-battery': () => send(IPC.appPower, { onBattery: true }),
    'on-ac': () => send(IPC.appPower, { onBattery: false }),
  }
  monitor.on('on-battery', handlers['on-battery'])
  monitor.on('on-ac', handlers['on-ac'])
  return {
    state,
    stop: () => {
      monitor.removeListener('on-battery', handlers['on-battery'])
      monitor.removeListener('on-ac', handlers['on-ac'])
    },
  }
}
