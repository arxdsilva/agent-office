// Conflicts inside a set of harness rules (docs/harness.md §2): reported for review, never merged.
// Pure.
import type { ActionRule, ConflictView } from '@agent-office/shared'
import { oneLine } from './text.ts'

export interface ConflictInput {
  id: string
  text: string
  name?: string
  policy?: ActionRule
}

/** Lowercase, punctuation stripped (apostrophes vanish: "don't" → "dont"), whitespace collapsed. */
export function normalizeRuleText(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const NEG = '\u0000neg'
const POS = '\u0000pos'
const NEG_PHRASES: string[][] = [
  ['do', 'not'],
  ['must', 'not'],
  ['dont'],
  ['never'],
  ['no'],
  ['avoid'],
]
const POS_WORDS = new Set(['always', 'must', 'prefer', 'do'])

function polarity(text: string): { neg: boolean; pos: boolean; words: Set<string> } {
  const toks = normalizeRuleText(text).split(' ').filter(Boolean)
  const out: string[] = []
  for (let i = 0; i < toks.length;) {
    const p = NEG_PHRASES.find((ph) => ph.every((w, j) => toks[i + j] === w))
    if (p) {
      out.push(NEG)
      i += p.length
    } else {
      out.push(POS_WORDS.has(toks[i]!) ? POS : toks[i]!)
      i++
    }
  }
  return {
    neg: out.includes(NEG),
    pos: out.includes(POS),
    words: new Set(out.filter((w) => w !== NEG && w !== POS)),
  }
}

const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x))

const label = (r: ConflictInput) => `“${oneLine(r.name ?? r.text, 60)}”`

function target(p: ActionRule): string {
  const s = (a?: string[]) => [...(a ?? [])].sort()
  return JSON.stringify([
    s(p.tools),
    s(p.paths),
    s(p.except),
    s(p.commands),
    s(p.hosts),
    s(p.roles),
  ])
}

export function detectConflicts(rules: ConflictInput[]): ConflictView[] {
  const out: ConflictView[] = []
  const groups = new Map<string, ConflictInput[]>()
  for (const r of rules) {
    const k = normalizeRuleText(r.text)
    if (!k) continue
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  for (const [k, g] of groups)
    if (g.length > 1)
      out.push({
        kind: 'duplicate',
        ruleIds: g.map((r) => r.id),
        text: `Same rule ${g.length} times: “${oneLine(k, 80)}”`,
      })

  const pol = rules.map((r) => ({ r, ...polarity(r.text) }))
  for (let i = 0; i < pol.length; i++)
    for (let j = i + 1; j < pol.length; j++) {
      const a = pol[i]!
      const b = pol[j]!
      if (a.neg === b.neg || !a.words.size || !sameSet(a.words, b.words)) continue
      out.push({
        kind: 'negation',
        ruleIds: [a.r.id, b.r.id],
        text: `${label(a.r)} and ${label(b.r)} say opposite things; review them.`,
      })
    }

  const withPolicy = rules.filter((r) => r.policy)
  for (const d of withPolicy.filter((r) => r.policy!.effect === 'deny'))
    for (const a of withPolicy.filter((r) => r.policy!.effect === 'ask'))
      if (target(d.policy!) === target(a.policy!))
        out.push({
          kind: 'policy-opposite',
          ruleIds: [d.id, a.id],
          text: `${label(d)} denies and ${label(a)} asks for the same actions; deny wins.`,
        })
  return out
}
