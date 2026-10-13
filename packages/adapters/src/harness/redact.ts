// Redaction of validation-gate output before it is stored or shown (docs/harness.md §4, §6).
// Pure: no I/O. The result is ≤ 8 KB, has no terminal control sequences, abbreviates the home
// directory and masks anything that looks like a credential.
import { homedir } from 'node:os'

export const OUTPUT_TAIL_MAX = 8192
const MASK = '***'

// CSI / OSC escape sequences, then every remaining C0/C1 control character except \n and \t.
const ANSI =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

const SECRETS: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  [/-----BEGIN [A-Z0-9 ]*-----[\s\S]*?(?:-----END [A-Z0-9 ]*-----|$)/g, MASK],
  [/\beyJ[\w-]*\.[\w-]+\.[\w-]+/g, MASK],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, MASK],
  [/\bgithub_pat_\w+/g, MASK],
  [/\bghp_\w+/g, MASK],
  [/\bxox[abp]-[\w-]+/g, MASK],
  [/\bAKIA[A-Z0-9]{12,}/g, MASK],
  [/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, (_m, scheme: string) => `${scheme}${MASK}@`],
  [
    /\b((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)\S+/gi,
    (_m, head: string) => `${head}${MASK}`,
  ],
]

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function redactOutput(raw: string, o: { home?: string } = {}): string {
  let out = raw.replace(/\r\n?/g, '\n').replace(ANSI, '').replace(CONTROL, '')
  const home = o.home ?? homedir()
  if (home && home.length > 1)
    out = out.replace(new RegExp(`${escapeRegExp(home)}(?=[/\\\\]|\\b|$)`, 'g'), '~')
  for (const [re, by] of SECRETS) out = out.replace(re, by as string)
  return out.length > OUTPUT_TAIL_MAX ? out.slice(-OUTPUT_TAIL_MAX) : out
}
