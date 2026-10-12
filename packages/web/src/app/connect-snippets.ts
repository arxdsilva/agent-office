// Copy-ready snippets for the Connect panel (plan §4.2). Pure strings. They only ever name the
// token *file*; the token itself is read by the snippet at run time and never reaches the renderer.
import type { SnippetLang } from './connect-types.ts'

export interface SnippetApi {
  host: string
  port: number
  /** '~'-abbreviated token path, e.g. '~/.agent-office/token' (or '~\.agent-office\token'). */
  tokenFile: string
}

const EVENT = {
  agentId: 'my-bot',
  provider: 'my-framework',
  topic: 'hello world',
  status: 'thinking',
}

export function snippet(lang: SnippetLang, a: SnippetApi): string {
  const url = `http://${a.host}:${a.port}/api/events`
  // Forward slashes work everywhere (Node and Python on Windows too) and avoid escape surprises.
  const file = a.tokenFile.replaceAll('\\', '/')
  switch (lang) {
    case 'curl':
      return [
        `TOKEN=$(cat ${file})`,
        `curl -s -X POST ${url} \\`,
        '  -H "Authorization: Bearer $TOKEN" \\',
        "  -H 'Content-Type: application/json' \\",
        `  -d '${JSON.stringify(EVENT)}'`,
      ].join('\n')
    case 'python':
      return [
        'import json, pathlib, urllib.request',
        `token = pathlib.Path("${file}").expanduser().read_text().strip()`,
        `event = {${Object.entries(EVENT)
          .map(([k, v]) => `"${k}": "${v}"`)
          .join(', ')}}`,
        `req = urllib.request.Request("${url}", data=json.dumps(event).encode(),`,
        '    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})',
        'urllib.request.urlopen(req, timeout=2)',
      ].join('\n')
    case 'js': {
      const path = file.startsWith('~/') ? `\`\${homedir()}${file.slice(1)}\`` : `'${file}'`
      return [
        "import { readFileSync } from 'node:fs'",
        "import { homedir } from 'node:os'",
        `const token = readFileSync(${path}, 'utf8').trim()`,
        `await fetch('${url}', {`,
        "  method: 'POST',",
        "  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },",
        `  body: JSON.stringify({ ${Object.entries(EVENT)
          .map(([k, v]) => `${k}: '${v}'`)
          .join(', ')} }),`,
        '})',
      ].join('\n')
    }
  }
}
