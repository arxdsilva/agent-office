// Opt-in observation of an OpenCode server the user runs (`opencode serve`), off by default
// (settings.openCodeObserve). Read-only: one GET of /global/event on 127.0.0.1:<port>, no
// credentials sent. Each frame becomes at most one metadata-only AgentEvent for `oc:<sessionId>`:
// status, a shared tool name, the model, and the project basename as name/topic. Prompts, message
// text, tool input/output, titles, paths, URLs and env values never leave this file.
import type { ReportActivity } from '@agent-office/core'
import type { AgentEvent } from '@agent-office/shared'
import { openSse, type SseState, type SseStream } from '../common/http/sse.ts'
import { GlobalEventFrame, OPENCODE_SESSION_ID, toolName } from './opencode-protocol.ts'

const PROVIDER = 'opencode'
const PREFIX = 'oc:'
const MAX_SESSIONS = 2000
const NAME = /^[^\u0000-\u001f]{1,100}$/
const MODEL = /^[A-Za-z0-9._:/@-]{1,100}$/

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** The last segment of an absolute path (POSIX or Windows), or undefined. Never the path. */
function projectBase(dir: unknown): string | undefined {
  const d = str(dir)
  if (!d || d.length > 4096) return undefined
  if (!d.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(d) && !d.startsWith('\\\\')) return undefined
  const segs = d.split(/[\\/]+/).filter(Boolean)
  const last = segs.at(-1)
  if (!last || /^[A-Za-z]:$/.test(last)) return undefined
  return NAME.test(last) ? last : undefined
}

export interface ObserverContext {
  /** sessionId → what was last emitted for it (dedupe) and whether name/topic was sent. */
  sessions: Map<string, SessionSeen>
}
interface SessionSeen {
  status?: string
  tool?: string
  model?: string
  modelProvider?: string
  parentId?: string
  named: boolean
}
export const newObserverContext = (): ObserverContext => ({ sessions: new Map() })

type Patch = Omit<AgentEvent, 'agentId' | 'provider' | 'source' | 'ts'>

function patchOf(type: string, p: Obj): { sid: unknown; patch: Patch; info?: Obj } | undefined {
  switch (type) {
    case 'session.created':
    case 'session.updated': {
      const info = obj(p.info)
      if (!info) return undefined
      const t = obj(info.time)
      const patch: Patch = {}
      if (type === 'session.created') patch.status = 'idle'
      if (t && t.archived !== undefined) patch.status = 'done'
      const parent = str(info.parentID)
      if (parent && OPENCODE_SESSION_ID.test(parent)) patch.parentId = `${PREFIX}${parent}`
      return { sid: info.id, patch, info }
    }
    case 'session.deleted':
      return { sid: p.sessionID ?? obj(p.info)?.id, patch: { status: 'done' } }
    case 'session.status': {
      const s = str(obj(p.status)?.type)
      if (s === 'busy' || s === 'retry') return { sid: p.sessionID, patch: { status: 'thinking' } }
      if (s === 'idle') return { sid: p.sessionID, patch: { status: 'waiting' } }
      return undefined
    }
    case 'session.idle':
      return { sid: p.sessionID, patch: { status: 'waiting' } }
    case 'session.error':
      return { sid: p.sessionID, patch: { status: 'error' } }
    case 'permission.asked':
    case 'permission.v2.asked':
    case 'question.asked':
    case 'question.v2.asked':
      return { sid: p.sessionID, patch: { status: 'waiting' } }
    case 'message.updated': {
      const info = obj(p.info)
      if (!info || info.role !== 'assistant') return undefined
      const patch: Patch = {}
      const model = str(info.modelID)
      const provider = str(info.providerID)
      if (model && MODEL.test(model)) patch.model = model
      if (provider && MODEL.test(provider)) patch.modelProvider = provider
      if (info.error !== undefined && info.error !== null) patch.status = 'error'
      if (Object.keys(patch).length === 0) return undefined
      return { sid: p.sessionID ?? info.sessionID, patch }
    }
    case 'message.part.updated': {
      const part = obj(p.part)
      if (!part) return undefined
      const sid = p.sessionID ?? part.sessionID
      if (part.type === 'step-start' || part.type === 'reasoning')
        return { sid, patch: { status: 'thinking' } }
      if (part.type !== 'tool') return undefined
      const st = str(obj(part.state)?.status)
      if (st === 'pending' || st === 'running') {
        const tool = toolName(part.tool)
        return { sid, patch: tool ? { status: 'tool', tool } : { status: 'tool' } }
      }
      if (st === 'completed' || st === 'error') return { sid, patch: { status: 'thinking' } }
      return undefined
    }
  }
  return undefined
}

export interface MapContextOptions {
  now: number
  /** Sessions agent-office runs itself (they report through their runner). */
  skip?: (sessionId: string) => boolean
}

/** One `/global/event` frame → an AgentEvent, or undefined (ignored, duplicate, or invalid). */
export function mapOpenCodeEvent(
  frame: unknown,
  ctx: ObserverContext,
  o: MapContextOptions,
): AgentEvent | undefined {
  const f = GlobalEventFrame.safeParse(frame)
  if (!f.success) return undefined
  const props = obj(f.data.payload.properties) ?? {}
  const m = patchOf(f.data.payload.type, props)
  if (!m) return undefined
  const sid = str(m.sid)
  if (!sid || !OPENCODE_SESSION_ID.test(sid)) return undefined
  if (o.skip?.(sid)) return undefined
  let s = ctx.sessions.get(sid)
  if (!s) {
    if (ctx.sessions.size >= MAX_SESSIONS) {
      const oldest = ctx.sessions.keys().next().value
      if (oldest !== undefined) ctx.sessions.delete(oldest)
    }
    s = { named: false }
    ctx.sessions.set(sid, s)
  }
  const patch: Patch = { ...m.patch }
  if (!s.named) {
    const base = projectBase(m.info?.directory) ?? projectBase(f.data.directory)
    if (base) {
      patch.name = base
      patch.topic = base
      s.named = true
    }
  }
  if (patch.status !== undefined) {
    if (patch.status === s.status && patch.tool === s.tool) {
      delete patch.status
      delete patch.tool
    } else {
      s.status = patch.status
      s.tool = patch.tool
    }
  }
  if (patch.model !== undefined) {
    if (patch.model === s.model) delete patch.model
    else s.model = patch.model
  }
  if (patch.modelProvider !== undefined) {
    if (patch.modelProvider === s.modelProvider) delete patch.modelProvider
    else s.modelProvider = patch.modelProvider
  }
  if (patch.parentId !== undefined) {
    if (patch.parentId === s.parentId) delete patch.parentId
    else s.parentId = patch.parentId
  }
  if (Object.keys(patch).length === 0) return undefined
  return { agentId: `${PREFIX}${sid}`, provider: PROVIDER, source: PROVIDER, ...patch, ts: o.now }
}

export type OpenCodeObserverState =
  'off' | 'connecting' | 'connected' | 'unreachable' | 'auth-required'

export interface OpenCodeObserverOptions {
  activity: ReportActivity
  skip?: (sessionId: string) => boolean
  onState?: (s: OpenCodeObserverState) => void
  now?: () => number
  backoff?: { initialMs?: number; maxMs?: number }
}

const STATE: Record<SseState, OpenCodeObserverState> = {
  connecting: 'connecting',
  open: 'connected',
  auth: 'auth-required',
  error: 'unreachable',
  closed: 'off',
}

export class OpenCodeObserver {
  private stream: SseStream | undefined
  private port: number | undefined
  private current: OpenCodeObserverState = 'off'

  constructor(private o: OpenCodeObserverOptions) {}

  state(): OpenCodeObserverState {
    return this.current
  }

  /** Applies `settings.openCodeObserve`; a no-op when nothing changed. */
  configure(s: { enabled: boolean; port?: number | undefined }): void {
    const port = s.enabled && s.port ? s.port : undefined
    if (port === this.port && (port === undefined || this.stream)) return
    this.stop()
    if (port === undefined) return
    this.port = port
    const ctx = newObserverContext()
    const stream = openSse({
      url: `http://127.0.0.1:${port}/global/event`,
      backoff: { initialMs: 1000, maxMs: 30_000, ...this.o.backoff },
      onState: (st) => {
        if (this.stream === stream || this.stream === undefined) this.set(STATE[st])
      },
      onEvent: (e) => {
        let frame: unknown
        try {
          frame = JSON.parse(e.data)
        } catch {
          return
        }
        const ev = mapOpenCodeEvent(frame, ctx, {
          now: this.o.now?.() ?? Date.now(),
          ...(this.o.skip ? { skip: this.o.skip } : {}),
        })
        if (ev) this.o.activity.report([ev])
      },
    })
    this.stream = stream
  }

  stop(): void {
    const s = this.stream
    this.stream = undefined
    this.port = undefined
    s?.close()
    this.set('off')
  }

  private set(s: OpenCodeObserverState) {
    if (this.current === s) return
    this.current = s
    this.o.onState?.(s)
  }
}
