// The project MCP server's core (docs/projects.md §5): per-session tokens, authorization against
// the token's principal on every call, rate limits, data framing and size caps. The HTTP route
// (adapters/src/mcp) only maps `principal(token)` → 401 and errors → JSON-RPC codes.
import { MEMORY_KINDS, type MemoryKind } from '@agent-office/shared'
import { z } from 'zod'
import { authorize, type Principal } from '../domain/authz.ts'
import { bm25 } from '../domain/context-rank.ts'
import { ForbiddenError, RateLimitedError, ValidationError } from '../domain/errors.ts'
import { DATA_PREFACE } from '../domain/handoff.ts'
import type { MemoryItem } from '../domain/memory.ts'
import { providerAccess } from '../domain/project.ts'
import { cleanText, oneLine } from '../domain/text.ts'
import type { Clock, SecureRandom } from '../ports/driven.ts'
import type { McpMemoryAccess, McpPrincipal, McpToolDecl, McpToolResult } from '../ports/driving.ts'
import type { ContextEngineService } from './context-engine.ts'
import type { ProjectMemoryService } from './memory-service.ts'
import type { ProjectsStore } from './projects-store.ts'

export const MCP_CALLS_PER_MIN = 20
export const MCP_PROPOSALS_PER_HOUR = 10
export const MCP_ITEM_BODY = 2000
export const MCP_RESULT_CHARS = 12_000
const MINUTE = 60_000
const HOUR = 3_600_000
const TOKEN_RE = /^mcp_[A-Za-z0-9_-]{16,200}$/

const SearchArgs = z.object({
  query: z.string().trim().min(1).max(200),
  kinds: z.array(z.enum(MEMORY_KINDS)).max(5).optional(),
  limit: z.number().int().min(1).max(8).default(5),
})
const ContextArgs = z.object({ objective: z.string().max(4000).optional() })
const DecisionArgs = z.object({ status: z.enum(['proposed', 'accepted', 'deprecated']).optional() })
const ProposeArgs = z.object({
  kind: z.enum(MEMORY_KINDS),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(MCP_ITEM_BODY),
  rationale: z.string().trim().max(500).optional(),
})

const TOOLS: McpToolDecl[] = [
  {
    name: 'search_memory',
    description: "Search this project's approved notes, decisions, constraints and instructions.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 200 },
        kinds: { type: 'array', items: { type: 'string', enum: [...MEMORY_KINDS] } },
        limit: { type: 'integer', minimum: 1, maximum: 8 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_project_context',
    description:
      "The project's ranked context bundle (approved items), optionally for an objective.",
    inputSchema: {
      type: 'object',
      properties: { objective: { type: 'string', maxLength: 4000 } },
      additionalProperties: false,
    },
  },
  {
    name: 'list_decisions',
    description: "This project's approved decisions.",
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['proposed', 'accepted', 'deprecated'] } },
      additionalProperties: false,
    },
  },
  {
    name: 'propose_memory',
    description:
      'Propose a note or decision for this project. The user reviews it before anyone can read it.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...MEMORY_KINDS] },
        title: { type: 'string', maxLength: 120 },
        body: { type: 'string', maxLength: MCP_ITEM_BODY },
        rationale: { type: 'string', maxLength: 500 },
      },
      required: ['kind', 'title', 'body'],
      additionalProperties: false,
    },
  },
]

interface TokenEntry {
  token: string
  tokenId: string
  projectId: string
  provider: string
  access: McpPrincipal['access']
  agentId?: string
  revoked: boolean
  calls: number[]
  proposals: number[]
}

export interface McpDeps {
  store: ProjectsStore
  memory: ProjectMemoryService
  context: ContextEngineService
  clock: Clock
  /** Without it no token is ever minted (tokens must be unguessable). */
  random?: SecureRandom
  /** A real retrieval happened (pulses the Context Hub capability). */
  onRetrieval?: (provider: string) => void
}

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const r = schema.safeParse(args ?? {})
  if (!r.success) throw new ValidationError('invalid arguments')
  return r.data
}

/** Sliding window: drops entries older than `ms`, refuses when `max` remain. */
function take(list: number[], now: number, ms: number, max: number): boolean {
  while (list.length && list[0]! <= now - ms) list.shift()
  if (list.length >= max) return false
  list.push(now)
  return true
}

export class McpMemoryAccessService implements McpMemoryAccess {
  private byToken = new Map<string, TokenEntry>()
  private byId = new Map<string, TokenEntry>()

  constructor(private d: McpDeps) {}

  /** A token for one managed session when its project policy gives the provider read access. */
  mint(o: { projectId: string; provider: string }): { token: string; tokenId: string } | null {
    if (!this.d.random) return null
    const project = this.d.store.projects.get(o.projectId)
    if (!project || project.archivedAt !== undefined) return null
    const access = providerAccess(project, o.provider)
    if (access === 'none') return null
    const token = `mcp_${this.d.random.token(32)}`
    if (!TOKEN_RE.test(token)) throw new Error('SecureRandom must return hex or base64url')
    const e: TokenEntry = {
      token,
      tokenId: this.d.store.newId('tok'),
      projectId: project.id,
      provider: o.provider,
      access,
      revoked: false,
      calls: [],
      proposals: [],
    }
    this.byToken.set(token, e)
    this.byId.set(e.tokenId, e)
    return { token, tokenId: e.tokenId }
  }

  /** The session started: its agent id gives the principal its session id. */
  bind(tokenId: string, agentId: string): void {
    const e = this.byId.get(tokenId)
    if (e && !e.revoked) e.agentId = agentId
  }

  revoke(tokenId: string): void {
    const e = this.byId.get(tokenId)
    if (!e) return
    e.revoked = true
    this.byToken.delete(e.token)
    this.byId.delete(tokenId)
  }

  revokeAll(): void {
    for (const id of [...this.byId.keys()]) this.revoke(id)
  }

  principal(token: string): McpPrincipal | null {
    const e = typeof token === 'string' ? this.byToken.get(token) : undefined
    if (!e || e.revoked) return null
    const sessionId = e.agentId ? (this.d.store.sessionByAgent(e.agentId)?.id ?? '') : ''
    return {
      kind: 'mcp',
      projectId: e.projectId,
      sessionId,
      provider: e.provider,
      tokenId: e.tokenId,
      access: e.access,
    }
  }

  tools(p: McpPrincipal): McpToolDecl[] {
    const e = this.entry(p)
    if (!e) return []
    const project = this.d.store.projects.get(p.projectId)
    if (!authorize(p, 'project.read', { kind: 'project', projectId: p.projectId }, project).ok)
      return []
    const canPropose = authorize(
      p,
      'memory.propose',
      { kind: 'memory', projectId: p.projectId, scope: 'project', state: 'pending' },
      project,
    ).ok
    return TOOLS.filter((t) => t.name !== 'propose_memory' || canPropose).map((t) => ({ ...t }))
  }

  async call(principal: McpPrincipal, tool: string, args: unknown): Promise<McpToolResult> {
    const e = this.entry(principal)
    if (!e) throw new ForbiddenError()
    // Trust only what the token says, never fields of the object handed back to us.
    const p = this.principal(e.token)!
    const project = this.d.store.projects.get(p.projectId)
    if (!authorize(p, 'project.read', { kind: 'project', projectId: p.projectId }, project).ok)
      throw new ForbiddenError()
    const now = this.d.clock.now()
    if (!take(e.calls, now, MINUTE, MCP_CALLS_PER_MIN)) throw new RateLimitedError()

    switch (tool) {
      case 'search_memory': {
        const a = parse(SearchArgs, args)
        const pool = this.d.memory.readable(p).filter((m) => !a.kinds || a.kinds.includes(m.kind))
        const scores = bm25(
          pool.map((m) => `${m.title} ${m.body}`),
          a.query,
        )
        const hits = pool
          .map((m, i) => ({ m, s: scores[i]! }))
          .filter((x) => x.s > 0)
          .sort((x, y) => y.s - x.s)
          .slice(0, a.limit)
          .map((x) => x.m)
        return this.items(p, e, tool, a.query, hits)
      }
      case 'get_project_context': {
        const a = parse(ContextArgs, args)
        const ranked = this.d.context.bundleFor(p, a.objective)
        const items = ranked.items
          .filter((i) => i.included && i.ref.kind === 'memory')
          .map((i) => this.d.store.memory.get(i.ref.id))
          .filter((m): m is MemoryItem => !!m)
        return this.items(p, e, tool, a.objective, items, {
          project: { id: project!.id, name: project!.name },
        })
      }
      case 'list_decisions': {
        const a = parse(DecisionArgs, args)
        const items = this.d.memory
          .readable(p)
          .filter((m) => m.kind === 'decision' && (!a.status || m.decision?.status === a.status))
        return this.items(p, e, tool, a.status, items)
      }
      case 'propose_memory': {
        const a = parse(ProposeArgs, args)
        const canPropose = authorize(
          p,
          'memory.propose',
          { kind: 'memory', projectId: p.projectId, scope: 'project', state: 'pending' },
          project,
        ).ok
        if (!canPropose) throw new ForbiddenError()
        if (!take(e.proposals, now, HOUR, MCP_PROPOSALS_PER_HOUR)) throw new RateLimitedError()
        const m = await this.d.memory.propose(p, {
          kind: a.kind as MemoryKind,
          title: cleanText(a.title, 120),
          body: cleanText(a.body, MCP_ITEM_BODY),
          ...(a.rationale ? { rationale: cleanText(a.rationale, 500) } : {}),
        })
        // Not a retrieval: memory.propose already logs memory.proposed. The hub still lights up.
        this.d.onRetrieval?.(p.provider)
        return {
          structured: { id: m.id, state: 'pending' },
          text: `${DATA_PREFACE}\n\nProposed ${m.id}. It waits for the user's review and is not visible to agents until approved.`,
        }
      }
      default:
        throw new ValidationError('unknown tool')
    }
  }

  private entry(p: McpPrincipal): TokenEntry | undefined {
    const e = p && typeof p.tokenId === 'string' ? this.byId.get(p.tokenId) : undefined
    if (!e || e.revoked) return undefined
    if (p.projectId !== e.projectId || p.provider !== e.provider || p.access !== e.access)
      return undefined
    return e
  }

  /** Items as structured content + one prefaced text block, capped and control-stripped. */
  private items(
    p: McpPrincipal,
    e: TokenEntry,
    tool: string,
    query: string | undefined,
    list: MemoryItem[],
    extra: Record<string, unknown> = {},
  ): McpToolResult {
    const out: Record<string, unknown>[] = []
    const lines: string[] = []
    let used = DATA_PREFACE.length
    for (const m of list) {
      const title = oneLine(m.title, 120)
      const body = cleanText(m.body, MCP_ITEM_BODY)
      const line = `\n\n[${m.id} v${m.version} ${m.kind}${m.decision ? ` (${m.decision.status})` : ''}] ${title}\n${body}`
      if (used + line.length > MCP_RESULT_CHARS) break
      used += line.length
      lines.push(line)
      out.push({
        id: m.id,
        version: m.version,
        kind: m.kind,
        scope: m.scope,
        title,
        body,
        provenance: {
          origin: m.provenance.origin,
          ...(m.provenance.provider ? { provider: m.provenance.provider } : {}),
          createdAt: m.provenance.createdAt,
          ...(m.provenance.reviewedAt !== undefined ? { approvedAt: m.provenance.reviewedAt } : {}),
        },
        ...(m.decision ? { decision: { ...m.decision } } : {}),
      })
    }
    const returned = out.map((x) => ({ id: x.id as string, version: x.version as number }))
    void this.d.context.recordRetrieval(p, e.agentId, tool, query, returned)
    this.d.onRetrieval?.(p.provider)
    const text = lines.length
      ? `${DATA_PREFACE}${lines.join('')}`
      : `${DATA_PREFACE}\n\nNo matching items.`
    return { structured: { ...extra, items: out }, text }
  }
}
