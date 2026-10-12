#!/usr/bin/env node
// Verifies that the installed Codex CLI's app-server protocol still has every method, field and
// enum value the Codex adapter relies on (packages/adapters/src/providers/codex/codex-protocol.ts).
// Read-only and harmless: it only runs `codex --version` and `codex app-server generate-json-schema`.
// Usage: node scripts/codex-schema-check.mjs [--codex <bin>]   (exit 1 on any mismatch)
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkCodexSchema } from '../packages/adapters/src/providers/codex/codex-schema-check.ts'

const i = process.argv.indexOf('--codex')
const bin = i > 0 ? process.argv[i + 1] : process.env.CODEX_BIN || 'codex'
const out = mkdtempSync(join(tmpdir(), 'codex-schema-'))
try {
  const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim()
  execFileSync(bin, ['app-server', 'generate-json-schema', '--out', out], { stdio: 'ignore' })
  const read = (f) => JSON.parse(readFileSync(join(out, f), 'utf8'))
  const bundle = {
    clientRequest: read('ClientRequest.json'),
    clientNotification: read('ClientNotification.json'),
    serverRequest: read('ServerRequest.json'),
    serverNotification: read('ServerNotification.json'),
    definitions: {
      ...read('codex_app_server_protocol.schemas.json').definitions,
      ...read('codex_app_server_protocol.v2.schemas.json').definitions,
    },
  }
  const { ok, rows } = checkCodexSchema(bundle)
  console.log(`Codex: ${version}`)
  const w = Math.max(...rows.map((r) => r.name.length))
  for (const r of rows)
    console.log(
      `${r.ok ? 'ok  ' : 'FAIL'}  ${r.kind.padEnd(7)}  ${r.name.padEnd(w)}${r.ok ? '' : `  missing: ${r.missing.join(', ')}`}`.trimEnd(),
    )
  console.log(
    ok ? `\nAll ${rows.length} checks passed.` : '\nSchema mismatch: update codex-protocol.ts.',
  )
  process.exitCode = ok ? 0 : 1
} catch (err) {
  console.error(`codex-schema-check: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
} finally {
  rmSync(out, { recursive: true, force: true })
}
