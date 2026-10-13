import { describe, expect, it } from 'vitest'
import { redactOutput } from './redact.ts'

describe('redactOutput', () => {
  const home = '/Users/alice'

  it('strips ANSI and control characters but keeps newlines and tabs', () => {
    expect(redactOutput('\u001b[31mred\u001b[0m\tok\r\nnext\u0007', { home })).toBe('red\tok\nnext')
  })

  it('abbreviates the home directory', () => {
    expect(redactOutput('at /Users/alice/repo/x.ts:3', { home })).toBe('at ~/repo/x.ts:3')
  })

  it.each([
    ['sk-abcdefghijklmnop', 'sk-'],
    ['ghp_abcdefABCDEF123456', 'ghp_'],
    ['github_pat_11ABCDEF_xyz', 'github_pat_'],
    ['xoxb-1234-abcd-efgh', 'xoxb-'],
    ['AKIAABCDEFGHIJKLMNOP', 'AKIA'],
    ['eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl', 'eyJ'],
  ])('masks the secret-looking token %s', (secret, prefix) => {
    const out = redactOutput(`value ${secret} end`, { home })
    expect(out).not.toContain(secret)
    expect(out).toContain('***')
    expect(out.startsWith('value ')).toBe(true)
    void prefix
  })

  it('masks PEM blocks, URL credentials and key=value secrets', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOg\n-----END RSA PRIVATE KEY-----'
    const out = redactOutput(
      `${pem}\nhttps://bob:hunter2@example.com/x\ntoken=ABCDEF\nAPI_KEY: zzz123\npassword = p4ss`,
      { home },
    )
    expect(out).not.toContain('MIIBOg')
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('ABCDEF')
    expect(out).not.toContain('zzz123')
    expect(out).not.toContain('p4ss')
    expect(out).toContain('https://***@example.com/x')
    expect(out).toContain('token=***')
  })

  it('keeps only the last 8 KB', () => {
    const out = redactOutput('a'.repeat(10_000) + 'END', { home })
    expect(out.length).toBeLessThanOrEqual(8192)
    expect(out.endsWith('END')).toBe(true)
  })

  it('leaves ordinary output alone', () => {
    expect(redactOutput('Tests: 12 passed\nDone in 1.2s', { home })).toBe(
      'Tests: 12 passed\nDone in 1.2s',
    )
  })
})
