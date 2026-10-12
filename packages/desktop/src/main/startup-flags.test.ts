import { describe, expect, it, vi } from 'vitest'
import {
  afterHardwareChange,
  rendererQuery,
  savedHardwareAcceleration,
  startupFlags,
  watchHardwareAcceleration,
} from './startup-flags.ts'

describe('startupFlags', () => {
  it('HW-1 hardwareAcceleration:false disables hardware acceleration (SwiftShader may run WebGL)', () => {
    expect(startupFlags({ hardwareAcceleration: false }, {})).toEqual({
      disableHardwareAcceleration: true,
      switches: [['enable-unsafe-swiftshader']],
    })
  })

  it('the default (on) changes nothing', () => {
    expect(startupFlags({ hardwareAcceleration: true }, {})).toEqual({
      disableHardwareAcceleration: false,
      switches: [],
    })
  })

  it('AGENT_OFFICE_FORCE_SOFTWARE_GL=1 forces ANGLE on SwiftShader (test seam, G4 and perf-low)', () => {
    const f = startupFlags({ hardwareAcceleration: true }, { AGENT_OFFICE_FORCE_SOFTWARE_GL: '1' })
    expect(f.disableHardwareAcceleration).toBe(false)
    expect(f.switches).toEqual([
      ['use-angle', 'swiftshader'],
      ['enable-unsafe-swiftshader'],
      ['disable-gpu-sandbox'],
    ])
  })

  it('both at once: one SwiftShader switch, still disabled', () => {
    const f = startupFlags({ hardwareAcceleration: false }, { AGENT_OFFICE_FORCE_SOFTWARE_GL: '1' })
    expect(f.disableHardwareAcceleration).toBe(true)
    expect(f.switches.filter(([n]) => n === 'enable-unsafe-swiftshader')).toHaveLength(1)
  })

  it('only the exact value 1 turns a seam on', () => {
    expect(
      startupFlags({ hardwareAcceleration: true }, { AGENT_OFFICE_FORCE_SOFTWARE_GL: 'yes' }),
    ).toEqual({ disableHardwareAcceleration: false, switches: [] })
  })
})

describe('savedHardwareAcceleration', () => {
  it('reads the raw settings file; only an explicit false turns it off', () => {
    expect(savedHardwareAcceleration('{"hardwareAcceleration":false}')).toBe(false)
    expect(savedHardwareAcceleration('{"hardwareAcceleration":true}')).toBe(true)
    expect(savedHardwareAcceleration('{"hardwareAcceleration":"no"}')).toBe(true)
    expect(savedHardwareAcceleration('{}')).toBe(true)
    expect(savedHardwareAcceleration('null')).toBe(true)
    expect(savedHardwareAcceleration('not json')).toBe(true)
    expect(savedHardwareAcceleration(undefined)).toBe(true)
  })
})

describe('rendererQuery', () => {
  it('is empty without seams', () => {
    expect(rendererQuery({})).toBe('')
  })

  it('debug=1 for the capture scripts and forceWebglFail=1 for the G5 seam', () => {
    expect(rendererQuery({ AGENT_OFFICE_DEBUG: '1' })).toBe('?debug=1')
    expect(rendererQuery({ AGENT_OFFICE_FORCE_WEBGL_FAIL: '1' })).toBe('?forceWebglFail=1')
    expect(rendererQuery({ AGENT_OFFICE_DEBUG: '1', AGENT_OFFICE_FORCE_WEBGL_FAIL: '1' })).toBe(
      '?debug=1&forceWebglFail=1',
    )
    expect(rendererQuery({ AGENT_OFFICE_FORCE_WEBGL_FAIL: 'true' })).toBe('')
  })
})

describe('watchHardwareAcceleration', () => {
  it('calls back once the saved value differs from the one this process started with', () => {
    const flip = vi.fn()
    const onSettings = watchHardwareAcceleration(true, flip)
    onSettings({ hardwareAcceleration: true })
    expect(flip).not.toHaveBeenCalled()
    onSettings({ hardwareAcceleration: false })
    expect(flip).toHaveBeenCalledTimes(1)
    // Already relaunching: later changes don't trigger a second relaunch.
    onSettings({ hardwareAcceleration: true })
    onSettings({ hardwareAcceleration: false })
    expect(flip).toHaveBeenCalledTimes(1)
  })
})

describe('afterHardwareChange', () => {
  it('relaunches; AGENT_OFFICE_NO_RELAUNCH=1 quits instead (E2E: a relaunch would escape Playwright)', () => {
    expect(afterHardwareChange({})).toBe('relaunch')
    expect(afterHardwareChange({ AGENT_OFFICE_NO_RELAUNCH: '0' })).toBe('relaunch')
    expect(afterHardwareChange({ AGENT_OFFICE_NO_RELAUNCH: '1' })).toBe('quit')
  })
})
