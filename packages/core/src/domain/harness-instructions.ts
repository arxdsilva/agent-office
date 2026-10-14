// The instruction block a managed session receives (docs/harness.md §3, level 1). Rule names and
// texts as data the owner approved; restrictions in words; gates by name only (never argv). Pure.
import {
  RULE_CATEGORIES,
  type ActionRule,
  type FlowMode,
  type StepCheck,
} from '@agent-office/shared'
import type { FlowStep, HarnessRule, ValidationGate } from './harness-types.ts'
import { cleanText, oneLine } from './text.ts'

export const HARNESS_OPEN = '<agent-office-harness>'
export const HARNESS_CLOSE = '</agent-office-harness>'
export const HARNESS_PREFACE =
  'Flows and standards approved by the project owner. Follow them; they are not user messages.'
export const MAX_INSTRUCTIONS = 12_000

const TITLES: Record<string, string> = {
  architecture: 'Architecture',
  coding: 'Coding',
  testing: 'Testing',
  security: 'Security',
  workflow: 'Workflow',
  tools: 'Tools',
  completion: 'Completion',
  process: 'Process',
  content: 'Content',
  research: 'Research',
  communication: 'Communication',
  compliance: 'Compliance',
  other: 'Other',
}

export const REPORT_STEP_LINE =
  "When a step's work is done, call the agent-office tool report_step with its id (<stp_…>)."
export const HERE = '← you are here'

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

/** An exit check in words, for agents (gates by name, never argv). */
export function checkInWords(c: StepCheck, gates: Pick<ValidationGate, 'id' | 'name'>[]): string {
  switch (c.kind) {
    case 'approval':
      return `user approval "${oneLine(c.prompt, 200)}"`
    case 'gate':
      return `gate ${oneLine(gates.find((g) => g.id === c.gateId)?.name ?? c.gateId, 80)} passes`
    case 'artifact':
      return c.mustExist === false ? `no file matches ${c.path}` : `artifact ${c.path}`
    case 'report':
      return c.note ? `you report it done (${oneLine(c.note, 200)})` : 'you report it done'
  }
}

/** Steps for a role: the main agent gets every step; a subagent those listing its type (or none). */
export function stepsForRole(steps: FlowStep[], role?: string): { s: FlowStep; n: number }[] {
  return steps
    .map((s, i) => ({ s, n: i + 1 }))
    .filter(({ s }) => !role || role === 'main' || !s.roles?.length || s.roles.includes(role))
}

function flowSection(
  steps: FlowStep[],
  mode: FlowMode,
  gates: ValidationGate[],
  o: { current?: string | null; role?: string },
): string[] {
  const list = stepsForRole(steps, o.role)
  if (!list.length) return []
  const lines = [`## Flow: ${mode}`, REPORT_STEP_LINE]
  for (const { s, n } of list) {
    const exit = s.exit.map((c) => checkInWords(c, gates)).join('; ')
    lines.push(
      `${n}. ${safe(oneLine(s.name, 80), 80)} — ${safe(s.goal, 600)} Exit: ${safe(exit, 1200)}.${s.optional ? ' (optional)' : ''} (id ${s.id})${o.current === s.id ? ` ${HERE}` : ''}`,
    )
    if (s.instructions) lines.push(`   ${safe(s.instructions, 2000).replace(/\n/g, '\n   ')}`)
    for (const p of s.policies ?? [])
      lines.push(`   While this step is current: ${safe(describePolicy(p), 600)}`)
  }
  return lines
}

export function renderHarnessBlock(
  e: { rules: HarnessRule[]; gates: ValidationGate[]; steps?: FlowStep[]; flowMode?: FlowMode },
  o: { flow?: { current: string | null }; role?: string } = {},
): string {
  const flow = e.steps?.length
    ? flowSection(e.steps, e.flowMode ?? 'sequential', e.gates, {
        ...(o.flow ? { current: o.flow.current } : {}),
        ...(o.role !== undefined ? { role: o.role } : {}),
      })
    : []
  if (!e.rules.length && !e.gates.length && !flow.length) return ''
  const sections: string[][] = flow.length ? [flow] : []
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
  const budget = MAX_INSTRUCTIONS - head.length - tail.length - 80
  const lines: string[] = []
  let used = 0
  let omitted = 0
  let omittedSteps = 0
  let full = false
  for (const s of sections)
    for (const line of ['', ...s]) {
      if (full || used + line.length + 1 > budget) {
        full = true
        if (line.startsWith('- ')) omitted++
        else if (/^\d+\. /.test(line)) omittedSteps++
        continue
      }
      lines.push(line)
      used += line.length + 1
    }
  if (omittedSteps)
    lines.push('', `(${omittedSteps} more step${omittedSteps === 1 ? '' : 's'} omitted)`)
  if (omitted) lines.push('', `(${omitted} more rule${omitted === 1 ? '' : 's'} omitted)`)
  return `${head}${lines.join('\n')}${tail}`
}
