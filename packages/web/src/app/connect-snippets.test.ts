import { describe, expect, it } from 'vitest'
import { snippet } from './connect-snippets.ts'

const api = { host: '127.0.0.1', port: 4317, tokenFile: '~/.agent-office/token' }

describe('snippet', () => {
  it('curl: reads the token at run time and posts one event', () => {
    expect(snippet('curl', api)).toBe(
      [
        'TOKEN=$(cat ~/.agent-office/token)',
        'curl -s -X POST http://127.0.0.1:4317/api/events \\',
        '  -H "Authorization: Bearer $TOKEN" \\',
        "  -H 'Content-Type: application/json' \\",
        `  -d '{"agentId":"my-bot","provider":"my-framework","topic":"hello world","status":"thinking"}'`,
      ].join('\n'),
    )
  })

  it('python: stdlib only (urllib.request)', () => {
    expect(snippet('python', api)).toBe(
      [
        'import json, pathlib, urllib.request',
        'token = pathlib.Path("~/.agent-office/token").expanduser().read_text().strip()',
        'event = {"agentId": "my-bot", "provider": "my-framework", "topic": "hello world", "status": "thinking"}',
        'req = urllib.request.Request("http://127.0.0.1:4317/api/events", data=json.dumps(event).encode(),',
        '    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})',
        'urllib.request.urlopen(req, timeout=2)',
      ].join('\n'),
    )
  })

  it('javascript: Node 18+ fetch, token path derived from the home directory', () => {
    expect(snippet('js', api)).toBe(
      [
        "import { readFileSync } from 'node:fs'",
        "import { homedir } from 'node:os'",
        "const token = readFileSync(`${homedir()}/.agent-office/token`, 'utf8').trim()",
        "await fetch('http://127.0.0.1:4317/api/events', {",
        "  method: 'POST',",
        "  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },",
        "  body: JSON.stringify({ agentId: 'my-bot', provider: 'my-framework', topic: 'hello world', status: 'thinking' }),",
        '})',
      ].join('\n'),
    )
  })

  it('substitutes the live host and port', () => {
    const other = { ...api, host: 'localhost', port: 4320 }
    for (const lang of ['curl', 'python', 'js'] as const)
      expect(snippet(lang, other)).toContain('http://localhost:4320/api/events')
  })

  it('follows a custom token location (and Windows-style separators)', () => {
    const custom = { ...api, tokenFile: '~/custom/ao/token' }
    expect(snippet('curl', custom)).toContain('TOKEN=$(cat ~/custom/ao/token)')
    expect(snippet('python', custom)).toContain('pathlib.Path("~/custom/ao/token")')
    expect(snippet('js', custom)).toContain('`${homedir()}/custom/ao/token`')
    const win = { ...api, tokenFile: '~\\.agent-office\\token' }
    expect(snippet('python', win)).toContain('pathlib.Path("~/.agent-office/token")')
    expect(snippet('js', win)).toContain('`${homedir()}/.agent-office/token`')
    // A path outside the home directory (only its basename is ever shown) is used as is.
    expect(snippet('js', { ...api, tokenFile: 'token' })).toContain("readFileSync('token', 'utf8')")
  })

  it('never contains anything but the token *path*', () => {
    for (const lang of ['curl', 'python', 'js'] as const)
      expect(snippet(lang, api)).not.toMatch(/Bearer [a-f0-9]{16,}/)
  })
})
