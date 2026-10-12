#!/usr/bin/env node
// agent-office observation hook for Cursor, Gemini CLI and Copilot CLI
// (docs/provider-integrations.md §6). Usage: agent-office-observe.mjs --provider <cursor|gemini|copilot>
//
// Maps a hook's stdin to a metadata-only AgentEvent and posts it to /api/events. It FAILS OPEN:
// it always exits 0 and prints NOTHING on stdout (empty output = allow in all three formats).
// Only non-blocking events are ever subscribed. Never forwarded: prompts, tool input/output,
// commands, paths, transcript_path, user_email.
//
// stdin field names (checked 2026-10-12):
// - Cursor https://cursor.com/docs/agent/hooks: conversation_id, model, hook_event_name,
//   workspace_roots, postToolUse.tool_name. subagentStop has no child id, so it is ignored.
// - Gemini https://geminicli.com/docs/hooks/reference/: session_id, cwd, hook_event_name,
//   AfterTool.tool_name, AfterModel.llm_request.model.
// - Copilot https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference:
//   sessionId, cwd, postToolUse.toolName, subagentStart/Stop.agentName (event names are not in the
//   payload for Copilot; the wrapper passes them via the config, see hook_event_name fallback below).
//
// Env: AGENT_OFFICE_URL, AGENT_OFFICE_TOKEN_FILE; AGENT_OFFICE_MANAGED=1 = do nothing.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_STDIN = 256 * 1024
const ID = /^[A-Za-z0-9._-]{1,160}$/
const TOOL = /^[A-Za-z0-9._:-]{1,100}$/

const PROVIDERS = {
  cursor: {
    prefix: 'cu:',
    session: (i) => i.conversation_id,
    event: (i) => i.hook_event_name,
    events: {
      sessionStart: { status: 'idle' },
      afterAgentThought: { status: 'thinking' },
      postToolUse: { status: 'tool', tool: (i) => i.tool_name },
      afterShellExecution: { status: 'tool', tool: () => 'Bash' },
      afterFileEdit: { status: 'tool', tool: () => 'Edit' },
      afterMCPExecution: { status: 'tool', tool: () => 'mcp' },
      stop: { status: 'waiting' },
      sessionEnd: { status: 'done' },
    },
    dir: (i) => (Array.isArray(i.workspace_roots) ? i.workspace_roots[0] : undefined) ?? i.cwd,
    model: (i) => i.model,
  },
  gemini: {
    prefix: 'gm:',
    session: (i) => i.session_id,
    event: (i) => i.hook_event_name,
    events: {
      SessionStart: { status: 'idle' },
      AfterModel: { status: 'thinking' },
      AfterTool: { status: 'tool', tool: (i) => i.tool_name },
      AfterAgent: { status: 'waiting' },
      Notification: { status: 'waiting' },
      SessionEnd: { status: 'done' },
    },
    dir: (i) => i.cwd,
    model: (i) => i.llm_request?.model,
  },
  copilot: {
    prefix: 'gh:',
    session: (i) => i.sessionId,
    // Copilot's documented payloads carry no event name and all our entries share one command, so
    // the event is the explicit name when present (VS Code-compatible mode, or an `env` set in the
    // config entry) and otherwise inferred from the payload's shape.
    event: (i, env) =>
      i.hook_event_name ?? i.hookEventName ?? env?.AGENT_OFFICE_HOOK_EVENT ?? copilotEvent(i),
    events: {
      sessionStart: { status: 'idle' },
      userPromptSubmitted: { status: 'thinking' },
      postToolUse: { status: 'tool', tool: (i) => i.toolName },
      postToolUseFailure: { status: 'tool', tool: (i) => i.toolName },
      errorOccurred: { status: 'error' },
      agentStop: { status: 'waiting' },
      subagentStart: { status: 'thinking', child: (i) => i.agentName },
      subagentStop: { status: 'done', child: (i) => i.agentName },
      sessionEnd: { status: 'done' },
    },
    dir: (i) => i.cwd,
    model: () => undefined,
  },
}

/** Shape-based event detection for Copilot payloads (see the field table in the reference). */
function copilotEvent(i) {
  if ('toolName' in i) return typeof i.error === 'string' ? 'postToolUseFailure' : 'postToolUse'
  if (typeof i.error === 'object' && i.error) return 'errorOccurred'
  if ('source' in i) return 'sessionStart'
  if ('agentId' in i || 'agentType' in i) return 'subagentStop'
  if ('agentName' in i) return 'subagentStart'
  if ('stopReason' in i) return 'agentStop'
  if ('reason' in i) return 'sessionEnd'
  if ('prompt' in i) return 'userPromptSubmitted'
  return undefined
}

const str = (v, max = 100) => (typeof v === 'string' && v ? v.slice(0, max) : undefined)
const safeBase = (p) => {
  const s = str(p, 1000)
  return s ? str(basename(s.replace(/[\\/]+$/, '').replace(/\\/g, '/'))) : undefined
}

/**
 * Pure mapping of one hook payload to an AgentEvent (or null to ignore it).
 * @param {string} provider cursor | gemini | copilot
 * @param {any} input parsed stdin
 * @param {Record<string, string | undefined>} [env]
 */
export function mapEvent(provider, input, env) {
  const p = PROVIDERS[provider]
  if (!p || !input || typeof input !== 'object' || Array.isArray(input)) return null
  const spec = p.events[p.event(input, env)]
  if (!spec) return null
  const sid = p.session(input)
  if (typeof sid !== 'string' || !ID.test(sid)) return null
  const parentId = `${p.prefix}${sid}`
  let agentId = parentId
  let child = false
  if (spec.child) {
    const c = spec.child(input)
    agentId = `${parentId}.${c}`
    if (typeof c !== 'string' || !ID.test(c) || !ID.test(agentId.slice(p.prefix.length)))
      return null
    child = true
  }
  const proj = safeBase(p.dir(input))
  const event = { agentId, provider, source: 'hook', status: spec.status }
  if (proj) {
    event.name = proj
    event.topic = proj
  }
  const model = str(p.model(input))
  if (model && TOOL.test(model)) event.model = model
  if (spec.tool) {
    const t = spec.tool(input)
    if (typeof t === 'string' && TOOL.test(t)) event.tool = t
  }
  if (child) event.parentId = parentId
  return event
}

function readToken(file) {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Full run minus process I/O. Never throws, returns nothing.
 * @param {string} provider
 * @param {string} raw stdin contents
 * @param {Record<string, string | undefined>} env
 * @param {typeof fetch} fetchImpl
 */
export async function fromStdin(provider, raw, env, fetchImpl) {
  try {
    if (env.AGENT_OFFICE_MANAGED === '1') return
    if (raw.length > MAX_STDIN) return
    const event = mapEvent(provider, JSON.parse(raw), env)
    if (!event) return
    const token = readToken(
      env.AGENT_OFFICE_TOKEN_FILE || join(homedir(), '.agent-office', 'token'),
    )
    if (!token) return
    const url = env.AGENT_OFFICE_URL || 'http://127.0.0.1:4317'
    await fetchImpl(`${url}/api/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(1500),
    })
  } catch {
    // fail open
  }
}

/* v8 ignore start -- process glue; exercised by the child-process tests */
async function main() {
  const i = process.argv.indexOf('--provider')
  const provider = i >= 0 ? process.argv[i + 1] : undefined
  if (!provider || !(provider in PROVIDERS)) return
  let raw = ''
  for await (const chunk of process.stdin) {
    raw += chunk
    if (raw.length > MAX_STDIN) return
  }
  await fromStdin(provider, raw, process.env, fetch)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  )
}
/* v8 ignore stop */
