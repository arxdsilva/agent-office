import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COPILOT_HOOK_FORMAT, copilotHooksPath } from './hook-format.ts'

describe('copilot hook format', () => {
  it('uses the shared format id', () => expect(COPILOT_HOOK_FORMAT).toBe('copilot-file'))
  it('defaults under the home directory', () => {
    expect(copilotHooksPath({}, '/home/u')).toBe(
      join('/home/u', '.copilot', 'hooks', 'agent-office.json'),
    )
  })
  it('honours COPILOT_HOOKS_DIR', () => {
    expect(copilotHooksPath({ COPILOT_HOOKS_DIR: '/t/x' }, '/home/u')).toBe(
      join('/t/x', 'agent-office.json'),
    )
  })
})
