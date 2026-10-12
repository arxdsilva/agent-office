// Shapes verified against the official references on 2026-10-12:
// - Cursor (https://cursor.com/docs/agent/hooks): `{version:1, hooks:{<event>:[{command, type?,
//   timeout (seconds), failClosed (default false), matcher?}]}}`. Blocking events: preToolUse,
//   subagentStart (allow/deny!), beforeShellExecution, beforeMCPExecution, beforeReadFile,
//   beforeSubmitPrompt, beforeTabFileRead. So `subagentStart` is NOT subscribed (docs §6 listed it).
// - Gemini CLI (https://geminicli.com/docs/hooks/reference/): `hooks` in settings.json;
//   `{<Event>:[{matcher?, sequential?, hooks:[{type:'command', command, name?, timeout (ms),
//   description?}]}]}`. We omit `matcher` (absent = every tool / lifecycle event).
// - Copilot CLI (https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference):
//   `~/.copilot/hooks/*.json` = `{version:1, hooks:{<event>:[{type:'command', bash?, powershell?,
//   command? (cross-platform fallback), cwd?, env?, timeoutSec (default 30)}]}}`. preToolUse fails
//   closed; permissionRequest and userPromptTransformed can deny/rewrite. agentStop/subagentStop can
//   only "block" with an explicit decision in stdout; our script prints nothing (= no block).
import { describe, expect, it } from 'vitest'
import { ValidationError } from './errors.ts'
import {
  BLOCKING_EVENTS,
  HOOK_FORMATS,
  OBSERVE_MARKER,
  SUBSCRIBED,
  addHooks,
  hookStatus,
  removeHooks,
} from './provider-hooks.ts'

const CMD = '"/x/agent-office-observe-cursor.sh"'
const NEW = '"/y/agent-office-observe-cursor.sh"'
type Json = Record<string, unknown>
const hooksOf = (j: Json | null) => (j?.hooks ?? {}) as Record<string, unknown[]>

describe('event sets', () => {
  it('PH-1 never subscribes a blocking event; uses the marker distinct from the Claude hook', () => {
    for (const f of HOOK_FORMATS) {
      expect(SUBSCRIBED[f].length).toBeGreaterThan(0)
      expect(SUBSCRIBED[f].filter((e) => BLOCKING_EVENTS[f].includes(e))).toEqual([])
    }
    expect(BLOCKING_EVENTS['cursor-json']).toContain('subagentStart')
    expect(BLOCKING_EVENTS['copilot-file']).toContain('preToolUse')
    expect(SUBSCRIBED['gemini-settings']).toEqual([
      'SessionStart',
      'AfterModel',
      'AfterTool',
      'AfterAgent',
      'Notification',
      'SessionEnd',
    ])
    expect(OBSERVE_MARKER).toBe('agent-office-observe')
    expect(OBSERVE_MARKER.includes('agent-office-hook')).toBe(false)
  })
})

describe('cursor-json', () => {
  const foreign = { command: './audit.sh', timeout: 3 }
  it('PH-2 adds one entry per subscribed event, idempotently, keeping foreign entries', () => {
    const start = { version: 1, hooks: { stop: [foreign], beforeShellExecution: [foreign] } }
    const once = addHooks('cursor-json', start, CMD)
    const twice = addHooks('cursor-json', once, CMD)
    expect(twice).toEqual(once)
    const h = hooksOf(once)
    expect(h.stop).toEqual([foreign, { command: CMD, timeout: 5, failClosed: false }])
    expect(h.beforeShellExecution).toEqual([foreign])
    for (const e of SUBSCRIBED['cursor-json'])
      expect(h[e]).toContainEqual(expect.objectContaining({ command: CMD }))
    expect(addHooks('cursor-json', {}, CMD).version).toBe(1)
    expect(start.hooks.stop).toEqual([foreign]) // input not mutated
  })

  it('PH-3 removes only ours; status installed → outdated → not-installed', () => {
    const json = addHooks('cursor-json', { version: 1, hooks: { stop: [foreign] } }, CMD)
    expect(hookStatus('cursor-json', json, CMD)).toBe('installed')
    expect(hookStatus('cursor-json', json, NEW)).toBe('outdated')
    expect(hookStatus('cursor-json', addHooks('cursor-json', json, NEW), NEW)).toBe('installed')
    const removed = removeHooks('cursor-json', json)
    expect(removed).toEqual({ version: 1, hooks: { stop: [foreign] } })
    expect(hookStatus('cursor-json', removed!, CMD)).toBe('not-installed')
    expect(hookStatus('cursor-json', undefined, CMD)).toBe('not-installed')
  })
})

describe('gemini-settings', () => {
  const foreignGroup = {
    matcher: 'run_shell_command',
    hooks: [{ type: 'command', command: 'lint' }],
  }
  it('PH-4 merges into settings.json hooks without touching other settings or groups', () => {
    const start = { theme: 'GitHub', hooks: { AfterTool: [foreignGroup] } }
    const once = addHooks('gemini-settings', start, CMD)
    expect(addHooks('gemini-settings', once, CMD)).toEqual(once)
    expect(once.theme).toBe('GitHub')
    expect(hooksOf(once).AfterTool).toEqual([
      foreignGroup,
      { hooks: [{ type: 'command', name: OBSERVE_MARKER, command: CMD, timeout: 5000 }] },
    ])
    expect(hookStatus('gemini-settings', once, CMD)).toBe('installed')
    expect(hookStatus('gemini-settings', once, NEW)).toBe('outdated')
    // our entry inside a mixed group: only ours goes
    const mixed = {
      hooks: {
        AfterTool: [
          {
            hooks: [
              { type: 'command', command: 'lint' },
              { type: 'command', command: CMD },
            ],
          },
        ],
      },
    }
    expect(removeHooks('gemini-settings', mixed)).toEqual({
      hooks: { AfterTool: [{ hooks: [{ type: 'command', command: 'lint' }] }] },
    })
    expect(removeHooks('gemini-settings', once)).toEqual({
      theme: 'GitHub',
      hooks: { AfterTool: [foreignGroup] },
    })
    expect(
      removeHooks('gemini-settings', addHooks('gemini-settings', { theme: 'x' }, CMD)),
    ).toEqual({
      theme: 'x',
    })
  })
})

describe('copilot-file', () => {
  it('PH-5 owns its own file: remove → null when nothing foreign is left', () => {
    const json = addHooks('copilot-file', {}, CMD)
    expect(json.version).toBe(1)
    // camelCase payloads carry no event name, so each entry tells the script its event via `env`.
    expect(hooksOf(json).agentStop).toEqual([
      {
        type: 'command',
        command: CMD,
        timeoutSec: 5,
        env: { AGENT_OFFICE_HOOK_EVENT: 'agentStop' },
      },
    ])
    expect(hooksOf(json).preToolUse).toBeUndefined()
    expect(addHooks('copilot-file', json, CMD)).toEqual(json)
    expect(hookStatus('copilot-file', json, CMD)).toBe('installed')
    expect(removeHooks('copilot-file', json)).toBeNull()
    const withForeign = {
      version: 1,
      hooks: { sessionEnd: [{ type: 'command', bash: 'echo bye' }] },
    }
    expect(removeHooks('copilot-file', addHooks('copilot-file', withForeign, CMD))).toEqual(
      withForeign,
    )
    // an entry using `bash` with our marker is still recognized as ours
    expect(
      hookStatus('copilot-file', { version: 1, hooks: { agentStop: [{ bash: CMD }] } }, NEW),
    ).toBe('outdated')
  })
})

describe('invalid configs', () => {
  it('PH-6 refuses to merge into a malformed hooks section; status reads it as not installed', () => {
    for (const f of HOOK_FORMATS) {
      expect(() => addHooks(f, { hooks: 'oops' }, CMD)).toThrow(ValidationError)
      expect(() => addHooks(f, { hooks: { [SUBSCRIBED[f][0]!]: {} } }, CMD)).toThrow(
        ValidationError,
      )
      expect(hookStatus(f, { hooks: 'oops' }, CMD)).toBe('not-installed')
      expect(hookStatus(f, { hooks: { x: [null, 3] } }, CMD)).toBe('not-installed')
      expect(removeHooks(f, { hooks: 'oops' })).toEqual({ hooks: 'oops' })
    }
  })
})
