// Pure rules for managed sessions and composed messages: the prompt preamble, permission summaries
// and mode narrowing. No host APIs (paths and URLs are parsed by hand).
import { PERMISSION_MODES, type ContextChip, type PermissionMode } from '@agent-office/shared'
import type { ComposedMessage } from '../ports/driving.ts'

export const MAX_CONTEXT = 10
export const MAX_USE = 5
const MAX_CHIPS = 15
const SUMMARY = 120

/** Display labels for system lines ("Mode → Plan"); same words as the renderer's copy deck. */
export const MODE_LABELS: Record<PermissionMode, string> = {
  default: 'Default',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  auto: 'Auto',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass permissions',
}

/** How a capability id is named to the agent (it knows tools, not our ids). */
export function toolHint(u: { id: string; label: string }): string {
  if (u.id.startsWith('mcp:')) {
    const server = u.id.slice(4)
    return `${server} (mcp__${server}__*)`
  }
  if (u.id.startsWith('skill:')) return `skill ${u.id.slice(6)}`
  if (u.id.startsWith('api:')) return `${u.label} API`
  if (u.id === 'shell') return `${u.label} (Bash)`
  if (u.id === 'web') return `${u.label} (WebFetch, WebSearch)`
  if (u.id === 'subagents') return `${u.label} (Task)`
  return u.label
}

/** The text the agent receives: the user's text, then attached paths and tool hints. */
export function composePrompt(m: ComposedMessage): string {
  const lines = m.context.slice(0, MAX_CONTEXT).map((c) => `- ${c.kind}: ${c.path}`)
  const tools = m.use.slice(0, MAX_USE).map(toolHint)
  if (!lines.length && !tools.length) return m.text
  return [
    m.text,
    '',
    '---',
    ...(lines.length
      ? ['Context from agent-office (the user attached these; read them as needed):', ...lines]
      : []),
    ...(tools.length ? [`Use these tools for this request: ${tools.join(', ')}.`] : []),
  ].join('\n')
}

/** Display-only chips for the thread (labels and '~' hints; never absolute paths). */
export function contextChips(m: ComposedMessage): ContextChip[] | undefined {
  const chips: ContextChip[] = [
    ...m.context.slice(0, MAX_CONTEXT).map((c) => ({ kind: c.kind, label: c.label, hint: c.hint })),
    ...m.use.slice(0, MAX_USE).map((u) => ({
      kind: 'capability' as const,
      label: u.label,
      hint: u.id,
    })),
  ].slice(0, MAX_CHIPS)
  return chips.length ? chips : undefined
}

const CONTROL = /[\u0000-\u001f\u007f]/g
const clean = (s: string, max = SUMMARY) => s.replace(CONTROL, '').slice(0, max)
const isAbsolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? ''
const HOST = /^[a-z0-9.-]{1,253}$/

function relativePath(file: string, cwd: string): string {
  if (!isAbsolute(file)) return file
  const root = cwd.replace(/[\\/]+$/, '')
  for (const sepChar of ['/', '\\']) {
    if (file.startsWith(root + sepChar)) return file.slice(root.length + 1)
  }
  return baseName(file)
}

function hostOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(url)
  const host = m?.[1]?.toLowerCase()
  return host && HOST.test(host) ? host : ''
}

/**
 * A short, privacy-safe description of a tool call for the permission card. Never the raw input:
 * Bash shows its first line, file tools a cwd-relative path (basename outside cwd), WebFetch the host.
 */
export function summarizeToolRequest(
  tool: string,
  input: unknown,
  cwd: string,
): { tool: string; summary: string } {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '')
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp) return { tool: 'MCP', summary: clean(`${mcp[1]} · ${mcp[2]}`) }
  const name = clean(tool, 100)
  let summary = ''
  switch (tool) {
    case 'Bash':
      summary = str('command').trim().split('\n')[0] ?? ''
      break
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      summary = relativePath(str('file_path') || str('notebook_path'), cwd)
      break
    case 'Glob':
    case 'Grep':
      summary = str('pattern')
      break
    case 'WebFetch':
      summary = hostOf(str('url'))
      break
    case 'WebSearch':
      summary = str('query')
      break
    case 'AskUserQuestion': {
      // The first question only; options and answers stay on the question card.
      const qs = Array.isArray(o.questions) ? (o.questions as unknown[]) : []
      const first = qs[0] && typeof qs[0] === 'object' ? (qs[0] as Record<string, unknown>) : {}
      summary = typeof first.question === 'string' ? first.question.trim() : ''
      break
    }
  }
  return { tool: name, summary: clean(summary) }
}

/**
 * "Always allow this session" key: Bash by its first word, everything else by tool name. Never used for
 * question cards (`AskUserQuestion`): the session service skips the allow-set for them.
 */
export function allowKey(tool: string, input: unknown): string {
  if (tool !== 'Bash') return tool
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const cmd = typeof o.command === 'string' ? o.command : ''
  return `Bash:${cmd.trim().split(/\s+/)[0] ?? ''}`
}

/** Narrows anything to a known permission mode (unknown future modes are ignored). */
export function modeOf(x: unknown): PermissionMode | undefined {
  return (PERMISSION_MODES as readonly unknown[]).includes(x) ? (x as PermissionMode) : undefined
}
