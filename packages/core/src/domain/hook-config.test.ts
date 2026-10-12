import { describe, expect, it } from 'vitest'
import { addHooks, hookStatus, removeHooks } from './hook-config.ts'

const CMD = '"/data/hook/agent-office-hook.sh"'

describe('addHooks / removeHooks', () => {
  it('adds Stop and UserPromptSubmit entries and keeps foreign hooks', () => {
    const existing = {
      model: 'opus',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
    }
    const out = addHooks(existing, CMD) as any
    expect(out.model).toBe('opus')
    expect(out.hooks.Stop).toHaveLength(2)
    expect(out.hooks.Stop[0].hooks[0].command).toBe('say done')
    expect(out.hooks.Stop[1].hooks[0]).toEqual({ type: 'command', command: CMD, timeout: 5 })
    expect(out.hooks.UserPromptSubmit[0].hooks[0].command).toBe(CMD)
    expect(existing.hooks.Stop).toHaveLength(1)
  })

  it('is idempotent and replaces an outdated command', () => {
    const once = addHooks({}, CMD)
    expect(addHooks(once, CMD)).toEqual(once)
    const moved = addHooks(once, '"/new/agent-office-hook.sh"') as any
    expect(moved.hooks.Stop).toHaveLength(1)
    expect(moved.hooks.Stop[0].hooks[0].command).toBe('"/new/agent-office-hook.sh"')
  })

  it('removes only its own entries', () => {
    const s = addHooks(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } },
      CMD,
    )
    const out = removeHooks(s) as any
    expect(out.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'say done' }] }])
    expect(out.hooks.UserPromptSubmit).toBeUndefined()
    expect(removeHooks({})).toEqual({})
    expect(removeHooks(addHooks({}, CMD))).toEqual({})
  })
})

describe('hookStatus', () => {
  it('reports installed, outdated and not-installed', () => {
    expect(hookStatus(undefined, CMD)).toBe('not-installed')
    expect(hookStatus({}, CMD)).toBe('not-installed')
    expect(hookStatus(addHooks({}, CMD), CMD)).toBe('installed')
    expect(hookStatus(addHooks({}, 'node "/old/agent-office-hook.mjs"'), CMD)).toBe('outdated')
  })
})
