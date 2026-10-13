import { describe, expect, it } from 'vitest'
import { CODEX_RELIES_ON } from './codex-protocol.ts'
import { checkCodexSchema, type CodexSchemaBundle, unionMethods } from './codex-schema-check.ts'

const union = (methods: string[]) => ({
  oneOf: methods.map((m) => ({ properties: { method: { enum: [m] } } })),
})
const obj = (fields: string[]) => ({
  type: 'object',
  properties: Object.fromEntries(fields.map((f) => [f, {}])),
})
const tagged = (variants: Record<string, string[]>) => ({
  oneOf: Object.entries(variants).map(([t, f]) => ({
    properties: { type: { enum: [t] }, ...obj(f).properties },
  })),
})

/** A minimal schema that has exactly what codex-protocol.ts relies on. */
function complete(): CodexSchemaBundle {
  const r = CODEX_RELIES_ON
  const definitions: Record<string, Record<string, unknown>> = {}
  for (const [n, f] of Object.entries(r.definitions)) definitions[n] = obj(f)
  for (const [n, v] of Object.entries(r.enums))
    definitions[n] = { oneOf: v.map((x) => ({ enum: [x] })) }
  const variants: Record<string, Record<string, string[]>> = {}
  for (const [k, f] of Object.entries(r.variants)) {
    const [n, t] = k.split('.') as [string, string]
    ;(variants[n] ??= {})[t] = f
  }
  for (const [n, v] of Object.entries(variants)) {
    const all = Object.fromEntries((r.enums[n] ?? []).map((t) => [t, [] as string[]]))
    definitions[n] = tagged({ ...all, ...v })
  }
  return {
    clientRequest: union(r.clientRequests),
    clientNotification: union(r.clientNotifications),
    serverRequest: union(r.serverRequests),
    serverNotification: union(r.serverNotifications),
    definitions,
  }
}

describe('checkCodexSchema', () => {
  it('passes a schema with everything we rely on', () => {
    const r = checkCodexSchema(complete())
    expect(r.rows.filter((x) => !x.ok)).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('reports a missing method, field, enum value and variant', () => {
    const b = complete()
    b.clientRequest = union(CODEX_RELIES_ON.clientRequests.filter((m) => m !== 'turn/interrupt'))
    b.definitions.TurnStartParams = obj(['threadId', 'input'])
    b.definitions.AskForApproval = { enum: ['untrusted', 'never'] }
    b.definitions.ThreadItem = tagged({ agentMessage: ['text'] })
    delete b.definitions.Thread
    const r = checkCodexSchema(b)
    expect(r.ok).toBe(false)
    const bad = Object.fromEntries(r.rows.filter((x) => !x.ok).map((x) => [x.name, x.missing]))
    expect(bad['turn/interrupt']).toEqual(['turn/interrupt'])
    expect(bad.TurnStartParams).toEqual(['model', 'approvalPolicy', 'sandboxPolicy'])
    expect(bad.AskForApproval).toEqual(['on-request'])
    expect(bad['ThreadItem.commandExecution']).toEqual(['(variant commandExecution)'])
    expect(bad.Thread).toEqual(['(definition Thread)'])
  })

  // MCP injection (docs/projects.md §5) relies on thread/start's free-form `config` map.
  it('relies on ThreadStartParams.config and reports it when missing', () => {
    expect(CODEX_RELIES_ON.definitions.ThreadStartParams).toContain('config')
    const b = complete()
    b.definitions.ThreadStartParams = obj([
      'cwd',
      'model',
      'approvalPolicy',
      'sandbox',
      'developerInstructions',
    ])
    const bad = checkCodexSchema(b).rows.find((x) => x.name === 'ThreadStartParams')!
    expect(bad).toMatchObject({ ok: false, missing: ['config'] })
  })

  // Harness instructions (docs/harness.md §3) go in `developerInstructions`, never `baseInstructions`.
  it('relies on ThreadStartParams.developerInstructions and reports it when missing', () => {
    expect(CODEX_RELIES_ON.definitions.ThreadStartParams).toContain('developerInstructions')
    expect(CODEX_RELIES_ON.definitions.ThreadStartParams).not.toContain('baseInstructions')
    const b = complete()
    b.definitions.ThreadStartParams = obj(['cwd', 'model', 'approvalPolicy', 'sandbox', 'config'])
    const bad = checkCodexSchema(b).rows.find((x) => x.name === 'ThreadStartParams')!
    expect(bad).toMatchObject({ ok: false, missing: ['developerInstructions'] })
  })

  it('reads method names from a union', () => {
    expect([...unionMethods(union(['a', 'b']))]).toEqual(['a', 'b'])
    expect([...unionMethods({})]).toEqual([])
  })
})
