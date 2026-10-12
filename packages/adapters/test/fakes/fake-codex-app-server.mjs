#!/usr/bin/env node
// A protocol-accurate fake of `codex app-server` (codex-cli 0.162.1, v2 API) for tests: NDJSON on
// stdio, JSON-RPC without the "jsonrpc" field. Scenarios are keyed on the turn's prompt text:
//   (default) reasoning → commandExecution + approval → agentMessage deltas → completed
//   /slow   stays in progress until turn/interrupt → interrupted
//   /fail   → failed          /crash → exit 1          /long → a 5000-char reply
//   /file   fileChange + item/fileChange/requestApproval
//   /ask    item/tool/requestUserInput (expects an error reply)
// Env: FAKE_CODEX_AUTH=none (needs login) · FAKE_CODEX_THREAD (thread id) · FAKE_CODEX_HANG=1
// (never answers) · FAKE_LOG (append every received message, as JSON lines).
import { appendFileSync } from 'node:fs'

const argv = process.argv.slice(2)
if (argv.includes('--version')) {
  process.stdout.write('codex-cli 0.162.1\n')
  process.exit(0)
}
if (argv.includes('--help')) {
  process.stdout.write(
    '[experimental] Run the app server or related tooling\n\nCommands:\n' +
      '  generate-ts           Generate TypeScript bindings\n' +
      '  generate-json-schema  Generate JSON Schema for the app server protocol\n',
  )
  process.exit(0)
}

const env = process.env
const log = (m) => {
  if (env.FAKE_LOG) appendFileSync(env.FAKE_LOG, JSON.stringify(m) + '\n')
}
log({ pid: process.pid })
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const notify = (method, params) => send({ method, params })

let nextServerId = 1000
const waiting = new Map()
/** Server→client request; resolves with the client's response message ({result} or {error}). */
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextServerId++
    waiting.set(id, resolve)
    send({ id, method, params })
  })

const threadId = env.FAKE_CODEX_THREAD || 'thr_fake1'
let initialized = false
let turnSeq = 0
let active // { id, prompt, interrupted: () => void }
let itemSeq = 0
const now = () => Date.now()

function completeTurn(turn, status, extra = {}) {
  if (active && active.id === turn.id) active = undefined
  notify('turn/completed', {
    threadId,
    turn: { id: turn.id, items: [], status, error: null, ...extra },
  })
}

function agentReply(turn, chunks) {
  const id = `msg_${++itemSeq}`
  notify('item/started', {
    threadId,
    turnId: turn.id,
    startedAtMs: now(),
    item: { type: 'agentMessage', id, text: '', phase: 'final_answer' },
  })
  for (const delta of chunks)
    notify('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: id, delta })
  notify('item/completed', {
    threadId,
    turnId: turn.id,
    completedAtMs: now(),
    item: { type: 'agentMessage', id, text: chunks.join(''), phase: 'final_answer' },
  })
}

async function runTurn(turn, prompt, cwd) {
  notify('turn/started', { threadId, turn: { id: turn.id, items: [], status: 'inProgress' } })
  if (prompt.includes('/crash')) {
    process.stderr.write('thread main panicked\n', () => process.exit(1))
    return
  }
  if (prompt.includes('/fail')) return completeTurn(turn, 'failed', { error: { message: 'boom' } })
  if (prompt.includes('/slow')) {
    notify('item/started', {
      threadId,
      turnId: turn.id,
      startedAtMs: now(),
      item: { type: 'reasoning', id: `rs_${++itemSeq}`, summary: [], content: [] },
    })
    turn.onInterrupt = () => completeTurn(turn, 'interrupted')
    return
  }
  if (prompt.includes('/long')) {
    agentReply(
      turn,
      Array.from({ length: 10 }, () => 'z'.repeat(500)),
    )
    return completeTurn(turn, 'completed')
  }
  if (prompt.includes('/ask')) {
    const r = await ask('item/tool/requestUserInput', {
      threadId,
      turnId: turn.id,
      itemId: `ui_${++itemSeq}`,
      questions: [],
    })
    log({ askReply: r.error ? r.error.code : 'result' })
    agentReply(turn, ['asked'])
    return completeTurn(turn, 'completed')
  }
  if (prompt.includes('/file')) {
    const id = `fc_${++itemSeq}`
    const item = {
      type: 'fileChange',
      id,
      status: 'inProgress',
      changes: [
        {
          path: `${cwd}/src/app.ts`,
          kind: { type: 'update', move_path: null },
          diff: '+SENTINEL_DIFF',
        },
      ],
    }
    notify('item/started', { threadId, turnId: turn.id, startedAtMs: now(), item })
    const r = await ask('item/fileChange/requestApproval', {
      threadId,
      turnId: turn.id,
      itemId: id,
      reason: null,
      grantRoot: null,
      startedAtMs: now(),
    })
    const decision = r.result?.decision
    if (decision === 'cancel') return completeTurn(turn, 'interrupted')
    notify('item/completed', {
      threadId,
      turnId: turn.id,
      completedAtMs: now(),
      item: { ...item, status: decision === 'accept' ? 'completed' : 'declined' },
    })
    agentReply(turn, [decision === 'accept' ? 'Edited.' : 'Skipped.'])
    return completeTurn(turn, 'completed')
  }
  // Default scenario.
  notify('item/started', {
    threadId,
    turnId: turn.id,
    startedAtMs: now(),
    item: {
      type: 'reasoning',
      id: `rs_${++itemSeq}`,
      summary: ['SENTINEL_REASONING'],
      content: [],
    },
  })
  const id = `cmd_${++itemSeq}`
  const item = {
    type: 'commandExecution',
    id,
    command: "/bin/zsh -lc 'git status SENTINEL_CMD'",
    cwd,
    status: 'inProgress',
    commandActions: [],
  }
  notify('item/started', { threadId, turnId: turn.id, startedAtMs: now(), item })
  const r = await ask('item/commandExecution/requestApproval', {
    threadId,
    turnId: turn.id,
    itemId: id,
    command: 'git status SENTINEL_CMD',
    cwd,
    startedAtMs: now(),
  })
  const decision = r.result?.decision
  if (decision === 'cancel' || turn.cancelled) return completeTurn(turn, 'interrupted')
  notify('item/completed', {
    threadId,
    turnId: turn.id,
    completedAtMs: now(),
    item: { ...item, status: decision === 'accept' ? 'completed' : 'declined' },
  })
  agentReply(turn, ['Hel', 'lo ', decision === 'accept' ? 'world' : 'declined'])
  completeTurn(turn, 'completed')
}

let cwd = process.cwd()
function handle(m) {
  log(m)
  if (env.FAKE_CODEX_HANG) return
  if (m.id !== undefined && m.method === undefined) {
    const w = waiting.get(m.id)
    waiting.delete(m.id)
    w?.(m)
    return
  }
  const reply = (result) => send({ id: m.id, result })
  const fail = (code, message) => send({ id: m.id, error: { code, message } })
  if (m.method === 'initialized') return
  if (m.method !== 'initialize' && !initialized) return fail(-32002, 'Not initialized')
  switch (m.method) {
    case 'initialize':
      initialized = true
      return reply({
        codexHome: '/fake/.codex',
        platformFamily: 'unix',
        platformOs: 'macos',
        userAgent: 'fake/0.162.1',
      })
    case 'account/read':
      return reply(
        env.FAKE_CODEX_AUTH === 'none'
          ? { requiresOpenaiAuth: true, account: null }
          : {
              requiresOpenaiAuth: true,
              account: { type: 'chatgpt', email: null, planType: 'plus' },
            },
      )
    case 'model/list':
      return reply({
        data: [
          {
            id: 'gpt-5.5-codex',
            model: 'gpt-5.5-codex',
            displayName: 'GPT-5.5 Codex',
            description: 'Coding model',
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [],
          },
          {
            id: 'gpt-5.5-mini',
            model: 'gpt-5.5-mini',
            displayName: 'GPT-5.5 Mini',
            description: '',
            hidden: false,
            isDefault: false,
            defaultReasoningEffort: 'low',
            supportedReasoningEfforts: [],
          },
          {
            id: 'internal',
            model: 'internal',
            displayName: 'Internal',
            description: 'x',
            hidden: true,
            isDefault: false,
            defaultReasoningEffort: 'low',
            supportedReasoningEfforts: [],
          },
        ],
        nextCursor: null,
      })
    case 'thread/start': {
      cwd = m.params?.cwd ?? cwd
      const thread = {
        id: threadId,
        cwd,
        preview: '',
        ephemeral: false,
        modelProvider: 'openai',
        createdAt: 0,
        updatedAt: 0,
        status: { type: 'idle' },
        turns: [],
        sessionId: 's',
        source: 'appServer',
        projectId: null,
        cliVersion: '0.162.1',
      }
      reply({
        thread,
        model: m.params?.model ?? 'gpt-5.5-codex',
        modelProvider: 'openai',
        cwd,
        approvalPolicy: m.params?.approvalPolicy ?? 'on-request',
        approvalsReviewer: 'user',
        sandbox: { type: 'workspaceWrite' },
      })
      return notify('thread/started', { thread })
    }
    case 'turn/start': {
      if (active) return fail(-32600, 'A turn is already running')
      const prompt = (m.params?.input ?? []).map((i) => i.text ?? '').join('')
      const turn = { id: `turn_${++turnSeq}` }
      active = turn
      reply({ turn: { id: turn.id, items: [], status: 'inProgress', error: null } })
      void runTurn(turn, prompt, cwd)
      return
    }
    case 'turn/interrupt': {
      reply({})
      if (active && active.id === m.params?.turnId) {
        active.cancelled = true
        active.onInterrupt?.()
      }
      return
    }
    default:
      return fail(-32601, 'Method not found')
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    try {
      handle(JSON.parse(line))
    } catch {
      /* ignore garbage */
    }
  }
})
process.stdin.on('end', () => process.exit(0))
