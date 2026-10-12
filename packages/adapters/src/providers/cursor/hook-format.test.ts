import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CURSOR_HOOK_FORMAT, cursorHooksPath } from './hook-format.ts'

describe('cursor hook format', () => {
  it('uses the shared format id', () => expect(CURSOR_HOOK_FORMAT).toBe('cursor-json'))
  it('defaults under the home directory', () => {
    expect(cursorHooksPath({}, '/home/u')).toBe(join('/home/u', '.cursor', 'hooks.json'))
  })
  it('honours CURSOR_HOOKS_FILE', () => {
    expect(cursorHooksPath({ CURSOR_HOOKS_FILE: '/t/x' }, '/home/u')).toBe('/t/x')
  })
})
