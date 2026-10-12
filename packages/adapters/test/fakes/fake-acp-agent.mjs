#!/usr/bin/env node
// A protocol-accurate fake ACP agent (Agent Client Protocol v1, @agentclientprotocol/sdk 1.8.0
// shapes) for tests: JSON-RPC 2.0, newline-delimited, over stdio. `--profile cursor|gemini|copilot`
// picks the auth methods, modes and model surface the real CLI advertised (Cursor agent
// 2026.10.01, Gemini CLI 0.63.0, Copilot CLI 1.0.96). Scenarios are keyed on the prompt text:
//   (default) agent_thought_chunk → tool_call(execute) → session/request_permission →
//             tool_call_update completed|failed → agent_message_chunk ×2 → end_turn
//   /quick    one agent_message_chunk ("ok: <prompt>") → end_turn
//   /slow     stays in the turn until session/cancel → cancelled
//   /refuse   → refusal          /crash → exit 1          /long → a 5000-char reply
//   /fs       sends fs/read_text_file (expects an error), then end_turn
//   /ext      sends a cursor/* extension request + unknown notifications/updates, then end_turn
//   /partial  writes one message line split across two stdout chunks, then end_turn
// Env: FAKE_ACP_AUTH=required (session/new → auth_required until authenticate) | fail (authenticate
// fails too) · FAKE_ACP_VERSION (answer another protocolVersion) · FAKE_ACP_SESSION (session id) ·
// FAKE_ACP_ADDDIRS=1 (advertise additionalDirectories) · FAKE_ACP_NOMODELS=1 · FAKE_ACP_NOFLAG=1
// (help without the ACP flag) · FAKE_ACP_HANG=1 (--version never returns) · FAKE_LOG (append
// every received message, as JSON lines).
import { appendFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const env = process.env
const pi = argv.indexOf('--profile')
const profile = pi >= 0 ? argv[pi + 1] : 'cursor'

const VERSIONS = {
  cursor: '2026.10.01-e373342\n',
  gemini: '0.63.0\n',
  copilot: "GitHub Copilot CLI 1.0.96.\nRun 'copilot update' to check for updates.\n",
}
if (argv.includes('--version')) {
  if (env.FAKE_ACP_HANG) setInterval(() => {}, 1000)
  else {
    process.stdout.write(VERSIONS[profile])
    process.exit(0)
  }
}
if (argv.includes('--help')) {
  const flag = !env.FAKE_ACP_NOFLAG
  const help = {
    cursor: argv.includes('acp')
      ? `Usage: agent acp [options]\n\n${flag ? 'Start the Cursor Agent as an ACP (Agent Client Protocol) server\n' : ''}`
      : 'Usage: agent [options] [command] [prompt...]\n',
    gemini: `Usage: gemini [options]\n${flag ? '      --acp                       Starts the agent in ACP mode  [boolean]\n' : ''}`,
    // Longer than 4 KB before the flag, like the real Copilot help (14 KB).
    copilot:
      'Usage: copilot [OPTIONS] [COMMAND]\n' +
      '      --some-option\n          A long description of an option.\n'.repeat(120) +
      (flag ? '      --acp\n          Start as Agent Client Protocol server\n' : ''),
  }[profile]
  process.stdout.write(help)
  process.exit(0)
}

const log = (m) => {
  if (env.FAKE_LOG) appendFileSync(env.FAKE_LOG, JSON.stringify(m) + '\n')
}
log({ pid: process.pid })
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
const notify = (method, params) => send({ method, params })
const reply = (id, result) => send({ id, result })
const fail = (id, code, message, data) =>
  send({ id, error: { code, message, ...(data ? { data } : {}) } })

let nextServerId = 5000
const waiting = new Map()
/** Agent→client request; resolves with the client's response message ({result} or {error}). */
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextServerId++
    waiting.set(id, resolve)
    send({ id, method, params })
  })

const COPILOT_MODE = 'https://agentclientprotocol.com/protocol/session-modes#'
const PROFILES = {
  cursor: {
    authMethods: [
      {
        id: 'cursor_login',
        name: 'Cursor Login',
        description:
          "Authenticate using existing Cursor login credentials. Run 'agent login' first.",
      },
    ],
    modes: [
      { id: 'agent', name: 'Agent' },
      { id: 'plan', name: 'Plan' },
      { id: 'ask', name: 'Ask' },
    ],
    models: 'both',
    authMessage: "Authentication required. Please run 'agent login' first.",
  },
  gemini: {
    authMethods: [
      { id: 'oauth-personal', name: 'Log in with Google' },
      {
        id: 'gemini-api-key',
        name: 'Gemini API key',
        _meta: { 'api-key': { provider: 'google' } },
      },
    ],
    modes: [
      { id: 'default', name: 'Default' },
      { id: 'autoEdit', name: 'Auto Edit' },
      { id: 'yolo', name: 'YOLO' },
      { id: 'plan', name: 'Plan' },
    ],
    models: 'models',
    authMessage: 'Gemini API key is missing or not configured.',
  },
  copilot: {
    authMethods: [
      {
        id: 'copilot-login',
        name: 'Log in with Copilot CLI',
        _meta: { 'terminal-auth': { command: 'copilot', args: ['login'], label: 'Copilot Login' } },
      },
    ],
    modes: [
      { id: `${COPILOT_MODE}agent`, name: 'Agent' },
      { id: `${COPILOT_MODE}plan`, name: 'Plan' },
      { id: `${COPILOT_MODE}autopilot`, name: 'Autopilot' },
    ],
    models: 'config',
    authMessage: 'Authentication required',
  },
}
const P = PROFILES[profile]
const MODELS = [
  { modelId: 'auto', name: 'Auto' },
  { modelId: 'fast-1', name: 'Fast One', description: 'A quick model' },
]

const sessionId = env.FAKE_ACP_SESSION || 'sess_fake1'
let authenticated = env.FAKE_ACP_AUTH !== 'required' && env.FAKE_ACP_AUTH !== 'fail'
let currentMode = P.modes[0].id
let currentModel = 'auto'
let active // { id, cancel: () => void }
let toolSeq = 0

const update = (u) => notify('session/update', { sessionId, update: u })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const configOptions = () => [
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: currentMode,
    options: P.modes.map((m) => ({ value: m.id, name: m.name })),
  },
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: currentModel,
    options: MODELS.map((m) => ({ value: m.modelId, name: m.name })),
  },
]

function endTurn(id, stopReason) {
  if (active?.id === id) active = undefined
  reply(id, { stopReason })
}

async function prompt(m) {
  const text = m.params?.prompt?.find((b) => b.type === 'text')?.text ?? ''
  let cancelled = false
  let wake = () => {}
  active = {
    id: m.id,
    cancel: () => {
      cancelled = true
      wake()
    },
  }
  const cancelledNow = () => {
    if (!cancelled) return false
    endTurn(m.id, 'cancelled')
    return true
  }
  const say = (chunks) => {
    const messageId = `msg_${m.id}`
    for (const c of chunks)
      update({
        sessionUpdate: 'agent_message_chunk',
        messageId,
        content: { type: 'text', text: c },
      })
  }

  if (text.startsWith('/crash')) process.exit(1)
  if (text.startsWith('/quick')) {
    say([`ok: ${text}`])
    return endTurn(m.id, 'end_turn')
  }
  if (text.startsWith('/slow')) {
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'pondering' } })
    await new Promise((r) => (wake = r))
    return cancelledNow()
  }
  if (text.startsWith('/refuse')) return endTurn(m.id, 'refusal')
  if (text.startsWith('/long')) {
    say(['z'.repeat(2500), 'z'.repeat(2500)])
    return endTurn(m.id, 'end_turn')
  }
  if (text.startsWith('/fs')) {
    const r = await ask('fs/read_text_file', { sessionId, path: '/etc/hosts' })
    say([r.error ? `fs error ${r.error.code}` : 'fs answered'])
    return endTurn(m.id, 'end_turn')
  }
  if (text.startsWith('/ext')) {
    notify('cursor/update_todos', { sessionId, todos: [] })
    update({ sessionUpdate: 'brand_new_kind', anything: 1 })
    const r = await ask('cursor/ask_question', { sessionId, question: 'which?' })
    say([r.error ? `ext error ${r.error.code}` : 'ext answered'])
    return endTurn(m.id, 'end_turn')
  }
  if (text.startsWith('/partial')) {
    const line = JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'split reply' },
        },
      },
    })
    const half = Math.floor(line.length / 2)
    process.stdout.write(line.slice(0, half))
    await sleep(30)
    process.stdout.write(line.slice(half) + '\n')
    return endTurn(m.id, 'end_turn')
  }

  // Default: think → run a command (with approval) → answer.
  update({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'secret thought' },
  })
  update({
    sessionUpdate: 'plan',
    entries: [{ content: 'secret plan step', priority: 'high', status: 'pending' }],
  })
  const toolCallId = `call_${++toolSeq}`
  update({
    sessionUpdate: 'tool_call',
    toolCallId,
    title: 'Run ls -la /Users/secret/project',
    kind: 'execute',
    status: 'pending',
    rawInput: { command: 'ls -la /Users/secret/project' },
  })
  const pending = ask('session/request_permission', {
    sessionId,
    toolCall: {
      toolCallId,
      title: 'Run ls -la /Users/secret/project',
      kind: 'execute',
      rawInput: { command: 'ls -la /Users/secret/project' },
    },
    options: [
      { optionId: 'allow-always', name: 'Always Allow', kind: 'allow_always' },
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      { optionId: 'reject-always', name: 'Never', kind: 'reject_always' },
    ],
  })
  const r = await Promise.race([pending, new Promise((res) => (wake = () => res(null)))])
  if (r === null) {
    // Cancelled while asking: the client must still answer the request (with cancelled).
    await pending
    return cancelledNow()
  }
  const outcome = r.result?.outcome
  if (outcome?.outcome === 'cancelled' || cancelled) return endTurn(m.id, 'cancelled')
  const allowed = outcome?.optionId === 'allow' || outcome?.optionId === 'allow-always'
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: allowed ? 'completed' : 'failed',
  })
  say(allowed ? ['Here are ', 'the files.'] : ['I was not allowed ', 'to run it.'])
  return endTurn(m.id, 'end_turn')
}

function handle(m) {
  log(m)
  if (m.method === undefined) {
    const w = waiting.get(m.id)
    if (w) {
      waiting.delete(m.id)
      w(m)
    }
    return
  }
  const isRequest = m.id !== undefined
  switch (m.method) {
    case 'initialize':
      return reply(m.id, {
        protocolVersion: env.FAKE_ACP_VERSION ? Number(env.FAKE_ACP_VERSION) : 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: {
            list: {},
            ...(env.FAKE_ACP_ADDDIRS ? { additionalDirectories: {} } : {}),
          },
        },
        authMethods: P.authMethods,
        agentInfo: { name: `fake-${profile}`, version: '1.0.0' },
      })
    case 'authenticate':
      if (env.FAKE_ACP_AUTH === 'fail') return fail(m.id, -32000, 'Authentication failed')
      if (!P.authMethods.some((a) => a.id === m.params?.methodId))
        return fail(m.id, -32602, 'Invalid params')
      authenticated = true
      return reply(m.id, {})
    case 'session/new': {
      if (!authenticated) return fail(m.id, -32000, P.authMessage)
      const noModels = !!env.FAKE_ACP_NOMODELS
      return reply(m.id, {
        sessionId,
        modes: { currentModeId: currentMode, availableModes: P.modes },
        ...(!noModels && P.models !== 'config'
          ? { models: { currentModelId: currentModel, availableModels: MODELS } }
          : {}),
        ...(!noModels && P.models !== 'models' ? { configOptions: configOptions() } : {}),
      })
    }
    case 'session/set_mode': {
      if (!P.modes.some((x) => x.id === m.params?.modeId)) return fail(m.id, -32602, 'Invalid mode')
      currentMode = m.params.modeId
      reply(m.id, {})
      return update({ sessionUpdate: 'current_mode_update', currentModeId: currentMode })
    }
    case 'session/set_config_option':
      if (P.models === 'models') return fail(m.id, -32601, 'Method not found')
      if (m.params?.configId === 'model') currentModel = m.params.value
      return reply(m.id, { configOptions: configOptions() })
    case 'session/set_model':
      if (P.models === 'config') return fail(m.id, -32601, 'Method not found')
      currentModel = m.params?.modelId
      return reply(m.id, {})
    case 'session/prompt':
      if (m.params?.sessionId !== sessionId) return fail(m.id, -32602, 'Unknown session')
      if (active) return fail(m.id, -32600, 'A prompt is already running')
      void prompt(m)
      return
    case 'session/cancel':
      active?.cancel()
      return
    default:
      if (isRequest) fail(m.id, -32601, 'Method not found')
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  for (;;) {
    const nl = buf.indexOf('\n')
    if (nl < 0) break
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    try {
      handle(JSON.parse(line))
    } catch {
      /* malformed input is ignored, like the real agents */
    }
  }
})
process.stdin.on('end', () => process.exit(0))
