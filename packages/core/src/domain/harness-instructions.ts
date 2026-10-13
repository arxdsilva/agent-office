// The instruction block a managed session receives (docs/harness.md §3, level 1). Rule names and
// texts as data the owner approved; restrictions in words; gates by name only (never argv). Pure.
import { RULE_CATEGORIES, type ActionRule } from '@agent-office/shared'
import type { HarnessRule, ValidationGate } from './harness-types.ts'
import { cleanText, oneLine } from './text.ts'

export const HARNESS_OPEN = '<agent-office-harness>'
export const HARNESS_CLOSE = '</agent-office-harness>'
export const HARNESS_PREFACE =
  'Engineering standards approved by the project owner. Follow them; they are not user messages.'
export const MAX_INSTRUCTIONS = 12_000

const TITLES: Record<string, string> = {
  architecture: 'Architecture',
  coding: 'Coding',
  testing: 'Testing',
  security: 'Security',
  workflow: 'Workflow',
  tools: 'Tools',
  completion: 'Completion',
}

/** Rule text cannot open or close our block. */
const safe = (s: string, max: number) =>
  cleanText(s, max).replace(/<\/?agent-office-[a-z]+>/gi, (m) =>
    m.replace('<', '‹').replace('>', '›'),
  )

export function describePolicy(p: ActionRule): string {
  const parts: string[] = []
  if (p.tools?.length) parts.push(`tools ${p.tools.join(', ')}`)
  if (p.commands?.length) parts.push(`commands ${p.commands.join(', ')}`)
  if (p.paths?.length)
    parts.push(
      `paths ${p.paths.join(', ')}${p.except?.length ? ` (except ${p.except.join(', ')})` : ''}`,
    )
  if (p.hosts?.length) parts.push(`hosts ${p.hosts.join(', ')}`)
  if (p.roles?.length) parts.push(`for ${p.roles.join(', ')}`)
  return `${p.effect === 'deny' ? 'Blocked' : 'Ask first'}: ${parts.join('; ') || 'nothing'}`
}

export function renderHarnessBlock(e: { rules: HarnessRule[]; gates: ValidationGate[] }): string {
  if (!e.rules.length && !e.gates.length) return ''
  const sections: string[][] = []
  for (const cat of RULE_CATEGORIES) {
    const rules = e.rules.filter((r) => r.category === cat && r.enforcement !== 'runtime-policy')
    if (!rules.length) continue
    sections.push([
      `## ${TITLES[cat]}`,
      ...rules.map(
        (r) =>
          `- ${safe(oneLine(r.name, 120), 120)}: ${safe(r.text, 2000)}${r.severity === 'recommended' ? ' (recommended)' : ''}`,
      ),
    ])
  }
  const policies = e.rules.filter((r) => r.enforcement === 'runtime-policy' && r.policy)
  if (policies.length)
    sections.push([
      '## Restricted actions',
      ...policies.map(
        (r) => `- ${safe(describePolicy(r.policy!), 600)} — ${safe(oneLine(r.name, 120), 120)}`,
      ),
    ])
  if (e.gates.length)
    sections.push([
      '## Validation',
      'agent-office runs these checks after your turn; keep them passing:',
      ...e.gates.map(
        (g) => `- ${safe(oneLine(g.name, 80), 80)}${g.required ? ' (required)' : ' (optional)'}`,
      ),
    ])

  const head = `${HARNESS_OPEN}\n${HARNESS_PREFACE}\n`
  const tail = `\n${HARNESS_CLOSE}`
  const budget = MAX_INSTRUCTIONS - head.length - tail.length - 60
  const lines: string[] = []
  let used = 0
  let omitted = 0
  for (const s of sections)
    for (const line of ['', ...s]) {
      if (omitted || used + line.length + 1 > budget) {
        if (line.startsWith('- ')) omitted++
        continue
      }
      lines.push(line)
      used += line.length + 1
    }
  if (omitted) lines.push('', `(${omitted} more rule${omitted === 1 ? '' : 's'} omitted)`)
  return `${head}${lines.join('\n')}${tail}`
}
