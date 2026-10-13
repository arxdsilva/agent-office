// Small text hygiene helpers shared by the projects domain.

// Control characters except tab and newline (C0, DEL, C1), plus bidi overrides.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g

/** Strips control characters (keeps \n and \t) and truncates to `max` chars (with "…"). */
export function cleanText(s: string, max: number): string {
  const t = s.replace(CONTROL, '')
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`
}

/** One line: control chars and newlines collapsed. */
export function oneLine(s: string, max: number): string {
  return cleanText(s.replace(/\s+/g, ' ').trim(), max)
}
