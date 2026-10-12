// Pure check: does a Codex `generate-json-schema` output still have every method, field and enum
// value that codex-protocol.ts relies on? Driven by scripts/codex-schema-check.mjs.
import { CODEX_RELIES_ON } from './codex-protocol.ts'

type Json = Record<string, unknown>

/** The generated files we read (`<out>/ClientRequest.json`, … and the merged definitions). */
export interface CodexSchemaBundle {
  clientRequest: Json
  clientNotification: Json
  serverRequest: Json
  serverNotification: Json
  /** `definitions` of codex_app_server_protocol.schemas.json and .v2.schemas.json, merged. */
  definitions: Record<string, Json>
}

export interface SchemaCheckRow {
  kind: 'method' | 'fields' | 'enum' | 'variant'
  name: string
  ok: boolean
  missing: string[]
}

/** The method names a top-level union (ClientRequest.json, …) declares. */
export function unionMethods(union: Json): Set<string> {
  const out = new Set<string>()
  for (const v of (union.oneOf as Json[] | undefined) ?? []) {
    const m = ((v.properties as Json | undefined)?.method as Json | undefined)?.enum
    if (Array.isArray(m)) for (const x of m) if (typeof x === 'string') out.add(x)
  }
  return out
}

/** Every string inside an `enum` anywhere in a definition (refs are not followed). */
function enumValues(def: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(def)) for (const x of def) enumValues(x, out)
  else if (def && typeof def === 'object')
    for (const [k, v] of Object.entries(def)) {
      if (k === 'enum' && Array.isArray(v)) {
        for (const x of v) if (typeof x === 'string') out.add(x)
      } else enumValues(v, out)
    }
  return out
}

function variant(def: Json | undefined, type: string): Json | undefined {
  for (const v of (def?.oneOf as Json[] | undefined) ?? []) {
    const e = ((v.properties as Json | undefined)?.type as Json | undefined)?.enum
    if (Array.isArray(e) && e.includes(type)) return v
  }
  return undefined
}

const props = (def: Json | undefined) => Object.keys((def?.properties as Json | undefined) ?? {})

export function checkCodexSchema(
  b: CodexSchemaBundle,
  relies = CODEX_RELIES_ON,
): { ok: boolean; rows: SchemaCheckRow[] } {
  const rows: SchemaCheckRow[] = []
  const methodSets: [string[], Set<string>][] = [
    [relies.clientRequests, unionMethods(b.clientRequest)],
    [relies.clientNotifications, unionMethods(b.clientNotification)],
    [relies.serverRequests, unionMethods(b.serverRequest)],
    [relies.serverNotifications, unionMethods(b.serverNotification)],
  ]
  for (const [want, have] of methodSets)
    for (const m of want)
      rows.push({ kind: 'method', name: m, ok: have.has(m), missing: have.has(m) ? [] : [m] })
  for (const [name, fields] of Object.entries(relies.definitions)) {
    const have = new Set(props(b.definitions[name]))
    const missing = b.definitions[name]
      ? fields.filter((f) => !have.has(f))
      : [`(definition ${name})`]
    rows.push({ kind: 'fields', name, ok: missing.length === 0, missing })
  }
  for (const [name, values] of Object.entries(relies.enums)) {
    const have = enumValues(b.definitions[name])
    const missing = values.filter((v) => !have.has(v))
    rows.push({ kind: 'enum', name, ok: missing.length === 0, missing })
  }
  for (const [key, fields] of Object.entries(relies.variants)) {
    const [name, type] = key.split('.') as [string, string]
    const v = variant(b.definitions[name], type)
    const have = new Set(props(v))
    const missing = v ? fields.filter((f) => !have.has(f)) : [`(variant ${type})`]
    rows.push({ kind: 'variant', name: key, ok: missing.length === 0, missing })
  }
  return { ok: rows.every((r) => r.ok), rows }
}
